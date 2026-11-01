// The metering core: put a price on any handler. Framework-neutral (Web standard Request and Response), so the same
// code runs on Node.js 20+, Cloudflare Workers, Bun and Deno.
//
//   const meter = createMeter({ chainId, sessionContract, endpointId, wallet, token, tokenSymbol, decimals, readSession });
//   export default { fetch: req => meter.charge(req, { price: 10_000n }, async () => ({ hello: 'world' })) };
//
// A request without a voucher gets 402 + a quote. A request with a voucher is checked completely before the handler
// runs: session, budget, count, cumulative, chain head and signature. The handler runs once; if it throws, nothing is
// recorded, so the buyer is not charged and signs the same step again for its next request.
import { getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { HEADER_REQUIRED, HEADER_RESPONSE, ProtocolError, b64json, parseB64json, requestHash as hashRequest } from './protocol.mjs';
import {
  HEADER_VOUCHER, SESSION_VERSION, ZERO32, genesisHead, makeSessionQuote, nextHead, sessionReceiptMessage, validateVoucher, voucherSigner,
} from './session.mjs';

/** Keeps session state and the public request log. The meter assumes one writer per session (one process or one Durable Object). */
export class MemoryLedger {
  #sessions = new Map();
  #logs = new Map();
  async get(id) {
    return this.#sessions.get(id) ?? null;
  }
  async put(id, state) {
    this.#sessions.set(id, state);
  }
  async append(id, row) {
    if (!this.#logs.has(id)) this.#logs.set(id, []);
    this.#logs.get(id).push(row);
  }
  async log(id, { from = 1, limit = 1000 } = {}) {
    return (this.#logs.get(id) ?? []).filter(r => r.n >= from).slice(0, limit);
  }
  async all() {
    return [...this.#sessions.values()];
  }
}

export class PaymentError extends ProtocolError {
  constructor(msg, status, extra = {}) {
    super(msg, status);
    this.extra = extra;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2) + '\n', { status, headers: { ...JSON_HEADERS, ...headers } });
}

function toBytes(out) {
  if (out instanceof Uint8Array) return out;
  if (typeof out === 'string') return new TextEncoder().encode(out);
  return new TextEncoder().encode(JSON.stringify(out, null, 2) + '\n');
}

/**
 * @param o.chainId, o.sessionContract, o.endpointId   what the buyer's session must be bound to
 * @param o.wallet        ethers signer of the provider: signs receipts
 * @param o.token, o.tokenSymbol, o.decimals           payment token, for the quote
 * @param o.readSession   async id => decoded session or null (see session-chain.mjs)
 * @param o.ledger        MemoryLedger or a compatible store
 * @param o.settlement, o.registry   optional public pointers put into quotes
 * @param o.refreshSec    how long a session read from the chain stays valid (default 60)
 */
export function createMeter(o) {
  const now = o.now || (() => Math.floor(Date.now() / 1000));
  const ledger = o.ledger || new MemoryLedger();
  const refreshSec = o.refreshSec ?? 60;
  const busy = new Set(); // sessions with a request in flight
  const log = o.log || (() => {});
  const provider = o.wallet.address;
  const network = `eip155:${o.chainId}`;

  async function loadState(id, { force = false } = {}) {
    let st = await ledger.get(id);
    if (st && !force && now() - st.checkedAt < refreshSec) return st;
    const on = await o.readSession(id);
    if (!on) throw new PaymentError('no such session', 404);
    if (on.closed) throw new PaymentError('session is closed', 410);
    if (on.endpointId !== o.endpointId) throw new PaymentError('session belongs to another endpoint', 409);
    if (!st) {
      if (on.count !== 0) throw new PaymentError('session was used with another seller state; open a new one', 409);
      st = {
        session: id, payer: on.payer, count: 0, cumulative: '0', head: genesisHead(id), lastResponseHash: ZERO32,
        lastVoucher: null, redeemedCount: 0, redeemedCum: '0',
      };
    }
    st = { ...st, signer: on.signer, deposit: on.deposit.toString(), expiresAt: on.expiresAt, redeemedCum: on.redeemed.toString(), redeemedCount: on.count, checkedAt: now() };
    await ledger.put(id, st);
    return st;
  }

  function quote(url, reqHash, price) {
    return makeSessionQuote({
      chainId: o.chainId, sessionContract: o.sessionContract, settlement: o.settlement, registry: o.registry, endpointId: o.endpointId,
      token: o.token, tokenSymbol: o.tokenSymbol, decimals: o.decimals, price, resource: `GET ${url.pathname}${url.search}`,
      requestHash: reqHash, provider,
    });
  }

  /** Everything that must hold before the handler runs. Returns the session state. */
  async function check(v, reqHash, price) {
    let st = await loadState(v.session);
    if (now() >= st.expiresAt) throw new PaymentError('session has expired', 410);
    const expected = { count: st.count + 1, cumulative: (BigInt(st.cumulative) + price).toString(), head: nextHead(st.head, reqHash, st.lastResponseHash) };
    const stale = { ...expected, lastResponseHash: st.lastResponseHash };
    if (v.count !== expected.count) throw new PaymentError(`voucher count must be ${expected.count}`, 409, stale);
    if (v.cumulative !== expected.cumulative) throw new PaymentError(`voucher cumulative must be ${expected.cumulative}`, 409, stale);
    if (BigInt(expected.cumulative) > BigInt(st.deposit)) {
      st = await loadState(v.session, { force: true }); // a top-up may have landed
      if (BigInt(expected.cumulative) > BigInt(st.deposit)) throw new PaymentError('session budget is used up', 402, { deposit: st.deposit, cumulative: st.cumulative });
    }
    if (v.head !== expected.head) throw new PaymentError('voucher head does not extend the session chain', 409, stale);
    if (voucherSigner(o.chainId, o.sessionContract, v) !== st.signer) throw new PaymentError('voucher is not signed by the session key', 401);
    return st;
  }

  async function signReceipt(fields) {
    const r = { v: SESSION_VERSION, network, sessionContract: o.sessionContract, provider, endpointId: o.endpointId, ...fields };
    return { ...r, signature: await o.wallet.signMessage(sessionReceiptMessage(r)) };
  }

  /**
   * @param req      Web Request (method, url, headers)
   * @param opt.price  token base units for this request (bigint or string)
   * @param produce  async () => body: object (sent as JSON), string or Uint8Array; or a Response-like {status, body}
   */
  async function charge(req, opt, produce) {
    const price = BigInt(opt.price);
    if (req.method !== 'GET') return json(405, { error: 'only GET is supported' }, { allow: 'GET' });
    const url = new URL(req.url);
    const reqHash = hashRequest('GET', url.pathname, url.searchParams);
    const header = req.headers.get(HEADER_VOUCHER);
    if (!header) {
      const q = quote(url, reqHash, price);
      return json(402, { error: 'payment required', accepts: [q] }, { [HEADER_REQUIRED]: b64json(q) });
    }
    let held = null;
    try {
      const v = validateVoucher(parseB64json(header));
      if (busy.has(v.session)) throw new PaymentError('another request of this session is in flight', 409, { retryAfter: 1 });
      busy.add(v.session);
      held = v.session;
      const st = await check(v, reqHash, price);
      let body;
      try {
        body = toBytes(await produce());
      } catch (e) {
        log('handler failed', v.session, e.message);
        return json(e.httpStatus || 502, { error: e.publicMessage || 'the request could not be served', charged: false });
      }
      const responseHash = keccak256(body);
      const issuedAt = now();
      await ledger.append(v.session, { n: v.count, requestHash: reqHash, responseHash, at: issuedAt });
      await ledger.put(v.session, { ...st, count: v.count, cumulative: v.cumulative, head: v.head, lastResponseHash: responseHash, lastVoucher: v, updatedAt: issuedAt });
      const receipt = await signReceipt({ session: v.session, requestHash: reqHash, responseHash, count: v.count, cumulative: v.cumulative, head: v.head, price: price.toString(), issuedAt });
      return new Response(body, { status: 200, headers: { ...JSON_HEADERS, [HEADER_RESPONSE]: b64json(receipt) } });
    } catch (e) {
      if (e instanceof ProtocolError) return json(e.status, { error: e.message, ...(e.extra || {}) });
      log('meter error', e.stack || e.message);
      return json(500, { error: 'internal error' });
    } finally {
      if (held) busy.delete(held);
    }
  }

  /** Public view of a session, for clients that lost their place and for the live page. No secrets in here. */
  async function sessionView(id) {
    const st = await loadState(id);
    return {
      session: st.session, payer: st.payer, signer: st.signer, endpointId: o.endpointId, deposit: st.deposit, expiresAt: st.expiresAt,
      count: st.count, cumulative: st.cumulative, head: st.head, lastResponseHash: st.lastResponseHash,
      redeemedCount: st.redeemedCount, redeemedCum: st.redeemedCum,
    };
  }

  return { charge, sessionView, ledger, loadState, provider };
}

// ------------------------------------------------------------------ adapters
/** Node.js http.IncomingMessage -> Web Request. GET only: the body is ignored. */
export function nodeRequest(req, base = 'http://localhost') {
  const url = new URL(req.originalUrl || req.url, base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(url, { method: req.method, headers });
}

/** Send a Web Response through a Node.js http.ServerResponse. */
export async function sendNode(res, response) {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, { ...headers, 'content-length': body.length });
  res.end(body);
}

/**
 * Express or Connect handler: app.get('/v1/x/:id', metered(meter, { price: 10_000n }, async req => ({ id: req.params.id })))
 * The handler returns the body instead of writing to `res`, so the meter can hash it before it leaves.
 */
export function metered(meter, opt, handler) {
  return (req, res, next) => {
    meter.charge(nodeRequest(req), opt, () => handler(req)).then(r => sendNode(res, r)).catch(next);
  };
}

export const hashText = s => keccak256(toUtf8Bytes(s));
export const hexBytes = getBytes;
