// x402-style HTTP seller for Portal Meter.
//   1. request without payment      -> 402 + quote (PAYMENT-REQUIRED header and JSON body)
//   2. buyer pays MeterSettlement.pay(endpointId, nonce, maxPrice) on Portaldot's EVM
//   3. retry with PAYMENT: {requestId, nonce, payer, signature}  (signature by the payer key)
//   4. seller checks the quote, the request binding, the signature and the on-chain payment, claims the
//      request id (served once), produces the response, settles (or refunds) on-chain, and answers with the
//      body plus a provider-signed receipt in PAYMENT-RESPONSE.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { keccak256 } from 'ethers';
import {
  VERSION, HEADER_PAYMENT, HEADER_REQUIRED, HEADER_RESPONSE, ProtocolError, b64json, parseB64json, requestHash,
  makeQuote, validateProof, proofSigner, requestIdFor, receiptCore, receiptCoreHash, receiptMessage, responseHash,
} from './protocol.mjs';
import { readPayment, STATUS } from './evm.mjs';
import { NotFound, BadInput, UpstreamError } from './data.mjs';
import { hashText } from './registry.mjs';

export const REFUND_REASON = Object.freeze({ UPSTREAM_FAILURE: 1, TIMEOUT: 2, NOT_FOUND: 3 });

/** Fixed-window per-key limiter with a bounded key table. */
export class RateLimiter {
  constructor({ limit, windowSec, now = () => Date.now() / 1000, maxKeys = 50_000 }) {
    Object.assign(this, { limit, windowSec, now, maxKeys });
    this.hits = new Map();
  }

  allow(key) {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.windowSec) {
      if (!h && this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
      h = { start: t, n: 0 };
      this.hits.set(key, h);
    }
    h.n += 1;
    return h.n <= this.limit;
  }
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': `${HEADER_REQUIRED}, ${HEADER_RESPONSE}`,
    ...headers,
  });
  res.end(buf);
}

/**
 * @param o.chain     {chainId, settlementAddress, settlement (read-only Contract)}
 * @param o.provider  provider EVM address (signs receipts; must equal the on-chain endpoint provider)
 * @param o.signer    ethers Wallet of the provider (receipt signatures)
 * @param o.settler   EvmSettler | XvmSettler
 * @param o.store     Store
 * @param o.routes    [{endpointId, pattern, price, token, tokenSymbol, decimals, validate(m), handler(m)}]
 * @param o.registry  {kind, address} public info about the ink! registry, put into quotes and receipts
 */
export function createSeller(o) {
  const now = o.now || (() => Math.floor(Date.now() / 1000));
  const quoteTtl = o.quoteTtl ?? 300;
  const graceSec = o.graceSec ?? 600;
  const quoteLimiter = o.quoteLimiter || new RateLimiter({ limit: 60, windowSec: 60 });
  const paidLimiter = o.paidLimiter || new RateLimiter({ limit: 30, windowSec: 60 });
  const network = `eip155:${o.chain.chainId}`;
  const log = o.log || (() => {});

  async function signReceipt(r) {
    return { ...r, signature: await o.signer.signMessage(receiptMessage(r)) };
  }

  function catalog() {
    return {
      v: VERSION,
      network,
      settlement: o.chain.settlementAddress,
      registry: o.registry,
      provider: o.provider,
      endpoints: o.routes.map(r => ({ endpointId: r.endpointId, path: r.example, price: r.price, token: r.token, tokenSymbol: r.tokenSymbol, decimals: r.decimals, description: r.description })),
    };
  }

  async function handle(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (req.method === 'OPTIONS') {
      return send(res, 204, Buffer.alloc(0), { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': HEADER_PAYMENT });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'only GET is supported' }, { allow: 'GET' });
    if ((req.url || '').length > 2048) return send(res, 414, { error: 'URL too long' });
    let url;
    try {
      url = new URL(req.url, 'http://seller.invalid');
    } catch {
      return send(res, 400, { error: 'bad URL' });
    }
    if (url.pathname === '/health' || url.pathname === '/.well-known/portal-meter') return send(res, 200, catalog());

    let route = null;
    let m = null;
    for (const r of o.routes) {
      m = r.pattern.exec(url.pathname);
      if (m) {
        route = r;
        break;
      }
    }
    if (!route) return send(res, 404, { error: 'no such endpoint', catalog: '/.well-known/portal-meter' });
    try {
      route.validate(m); // free 400 for malformed input: nobody pays for a request that cannot be answered
    } catch (e) {
      if (e instanceof BadInput) return send(res, 400, { error: e.message });
      throw e;
    }
    const reqHash = requestHash('GET', url.pathname, url.searchParams);
    const header = req.headers[HEADER_PAYMENT];

    // ---------------------------------------------------------------- 1. quote
    if (!header) {
      if (!quoteLimiter.allow(ip)) return send(res, 429, { error: 'too many quotes, slow down' }, { 'retry-after': '60' });
      const q = makeQuote({
        chainId: o.chain.chainId, settlement: o.chain.settlementAddress, registry: o.registry,
        endpointId: route.endpointId, token: route.token, tokenSymbol: route.tokenSymbol, decimals: route.decimals,
        price: route.price, nonce: '0x' + randomBytes(32).toString('hex'), resource: `GET ${url.pathname}${url.search}`,
        reqHash, expiresAt: now() + quoteTtl, provider: o.provider,
      });
      o.store.addQuote({ nonce: q.nonce, endpointId: q.endpointId, requestHash: reqHash, price: q.price, expiresAt: q.expiresAt });
      return send(res, 402, { error: 'payment required', accepts: [q] }, { [HEADER_REQUIRED]: b64json(q) });
    }

    // ---------------------------------------------------------------- 3. paid retry
    if (!paidLimiter.allow(ip)) return send(res, 429, { error: 'too many requests' }, { 'retry-after': '60' });
    const proof = validateProof(parseB64json(header));
    const quote = o.store.getQuote(proof.nonce);
    if (!quote) throw new ProtocolError('unknown or already used quote nonce', 409);
    if (quote.endpointId !== route.endpointId || quote.requestHash !== reqHash) throw new ProtocolError('payment was quoted for a different request', 409);
    if (now() > quote.expiresAt + graceSec) throw new ProtocolError('quote expired', 410);
    const rid = requestIdFor(o.chain.chainId, o.chain.settlementAddress, proof.payer, route.endpointId, proof.nonce).toLowerCase();
    if (rid !== proof.requestId) throw new ProtocolError('requestId does not match payer, endpoint and nonce');
    let signer;
    try {
      signer = proofSigner(proof, reqHash);
    } catch {
      throw new ProtocolError('unreadable proof signature', 401);
    }
    if (signer !== proof.payer) throw new ProtocolError('proof is not signed by the payer', 401);

    const pay = await readPayment(o.chain.settlement, rid);
    if (pay.status === STATUS.NONE) {
      return send(res, 402, { error: 'payment not found on-chain yet', requestId: rid }, { 'retry-after': '6' });
    }
    if (pay.status !== STATUS.PAID) throw new ProtocolError(`request already ${pay.status === STATUS.SERVED ? 'served' : 'refunded'}`, 409);
    if (pay.payer !== proof.payer || pay.endpointId !== route.endpointId) throw new ProtocolError('on-chain payment does not match the proof', 409);
    if (BigInt(pay.amount) < BigInt(quote.price)) throw new ProtocolError('paid amount below the quoted price', 409);

    if (!o.store.claim(rid, { nonce: proof.nonce, endpointId: route.endpointId, payer: proof.payer, amount: pay.amount })) {
      throw new ProtocolError('request already served', 409);
    }
    const base = {
      v: VERSION, network, settlement: o.chain.settlementAddress, registry: o.registry, provider: o.provider,
      endpointId: route.endpointId, requestId: rid, nonce: proof.nonce, payer: proof.payer, amount: pay.amount,
      token: route.token, requestHash: reqHash,
    };

    // ---------------------------------------------------------------- 4. serve or refund
    let body = null;
    let failure = null;
    try {
      const out = await route.handler(m);
      body = Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8');
    } catch (e) {
      failure = e instanceof NotFound
        ? { status: 404, reason: REFUND_REASON.NOT_FOUND, message: e.message }
        : e instanceof UpstreamError
          ? { status: 502, reason: REFUND_REASON.UPSTREAM_FAILURE, message: e.message }
          : { status: 502, reason: REFUND_REASON.UPSTREAM_FAILURE, message: 'upstream failure' };
      log('handler failed', rid, e.message);
    }

    if (!failure) {
      const core = { ...base, responseHash: responseHash(body), outcome: 'served' };
      const receiptHash = receiptCoreHash(core);
      let settled;
      try {
        settled = await o.settler.settle({ requestId: rid, responseHash: core.responseHash, endpointId: route.endpointId, amount: pay.amount, receiptHash });
      } catch (e) {
        log('settle failed', rid, e.message);
        o.store.finish(rid, { state: 'settle_failed', error: String(e.message).slice(0, 300) });
        return send(res, 503, { error: 'could not settle the payment on-chain; nothing was delivered and the payment stays refundable', requestId: rid });
      }
      const receipt = await signReceipt({ ...core, receiptHash, tx: settled.tx, block: settled.block, settledVia: settled.mode, issuedAt: now() });
      o.store.finish(rid, { state: 'served', tx: settled.tx, receiptHash });
      return send(res, 200, body, { [HEADER_RESPONSE]: b64json(receipt) });
    }

    const core = { ...base, responseHash: hashText(failure.message), outcome: 'refunded' };
    const receiptHash = receiptCoreHash(core);
    let refunded;
    try {
      refunded = await o.settler.refund({ requestId: rid, reason: failure.reason, endpointId: route.endpointId, amount: pay.amount, receiptHash });
    } catch (e) {
      log('refund failed', rid, e.message);
      o.store.finish(rid, { state: 'refund_failed', error: String(e.message).slice(0, 300) });
      return send(res, 503, { error: 'could not deliver and the on-chain refund failed; the payer can reclaim after the refund delay', requestId: rid });
    }
    const receipt = await signReceipt({ ...core, receiptHash, tx: refunded.tx, block: refunded.block, settledVia: refunded.mode, refundReason: failure.reason, issuedAt: now() });
    o.store.finish(rid, { state: 'refunded', tx: refunded.tx, receiptHash });
    return send(res, failure.status, { error: failure.message, refunded: true, receipt }, { [HEADER_RESPONSE]: b64json(receipt) });
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    req.resume(); // GET only: drop any body
    handle(req, res).catch(e => {
      if (e instanceof ProtocolError) return send(res, e.status, { error: e.message });
      log('internal error', e.stack || e.message);
      return send(res, 500, { error: 'internal error' });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 180_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** keccak of the canonical receipt core, re-exported for the verifier and tests. */
export { receiptCore, receiptCoreHash, keccak256 };
