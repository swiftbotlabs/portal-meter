// Buyer side of a session: request -> 402 quote -> checks -> signed voucher -> body + provider receipt.
// Runs on Node.js and in the browser. The client keeps its own count, cumulative and head, so a seller cannot make
// it sign more than one price per request; `sync()` exists for a key shared between visitors (the public demo).
import { getAddress, keccak256, verifyMessage } from 'ethers';
import { HEADER_REQUIRED, HEADER_RESPONSE, b64json, chainIdOf, parseB64json, requestHash } from './protocol.mjs';
import { HEADER_VOUCHER, SESSION_VERSION, ZERO32, genesisHead, nextHead, sessionReceiptMessage, signVoucher, validateSessionQuote } from './session.mjs';

export class SessionError extends Error {}

/**
 * @param o.signer           ethers signer of the session (payer or capped session key)
 * @param o.session          session id
 * @param o.expect           {chainId, sessionContract, provider?, token?}
 * @param o.maxPrice         bigint: refuse quotes above this
 * @param o.state            optional {count, cumulative, head, lastResponseHash} to resume
 */
export class SessionClient {
  constructor(o) {
    Object.assign(this, { signer: o.signer, session: o.session.toLowerCase(), expect: o.expect, maxPrice: o.maxPrice, fetch: o.fetch || globalThis.fetch.bind(globalThis) });
    this.state = o.state || { count: 0, cumulative: '0', head: genesisHead(this.session), lastResponseHash: ZERO32 };
  }

  checkQuote(q, url) {
    validateSessionQuote(q);
    const { chainId, sessionContract, provider, token } = this.expect;
    if (chainIdOf(q.network) !== chainId) throw new SessionError(`quote is for ${q.network}`);
    if (getAddress(q.sessionContract) !== getAddress(sessionContract)) throw new SessionError('quote names an unexpected session contract');
    if (provider && getAddress(q.provider) !== getAddress(provider)) throw new SessionError('quote names an unexpected provider');
    if (token && getAddress(q.token) !== getAddress(token)) throw new SessionError('quote names an unexpected token');
    if (BigInt(q.price) > this.maxPrice) throw new SessionError(`price ${q.price} above max ${this.maxPrice}`);
    if (q.requestHash !== requestHash('GET', url.pathname, url.searchParams)) throw new SessionError('quote is bound to a different request');
    return q;
  }

  /** One paid GET. `onStep` receives each stage, for the live page. */
  async get(target, { onStep = () => {} } = {}) {
    const url = new URL(target);
    const first = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (first.status !== 402) return { status: first.status, body: new Uint8Array(await first.arrayBuffer()), receipt: null, charged: false };
    const hdr = first.headers.get(HEADER_REQUIRED);
    if (!hdr) throw new SessionError('402 without a PAYMENT-REQUIRED header');
    const q = this.checkQuote(parseB64json(hdr), url);
    onStep('quote', q);

    const s = this.state;
    const head = nextHead(s.head, q.requestHash, s.lastResponseHash);
    const voucher = await signVoucher(this.signer, chainIdOf(q.network), q.sessionContract, {
      session: this.session, cumulative: BigInt(s.cumulative) + BigInt(q.price), count: s.count + 1, head,
    });
    onStep('voucher', voucher);

    const res = await this.fetch(url, { headers: { accept: 'application/json', [HEADER_VOUCHER]: b64json(voucher) } });
    const body = new Uint8Array(await res.arrayBuffer());
    if (res.status !== 200) return { status: res.status, body, receipt: null, charged: false, quote: q, voucher };
    const rh = res.headers.get(HEADER_RESPONSE);
    if (!rh) throw new SessionError('200 without a receipt: stop signing for this provider');
    const receipt = parseB64json(rh, 16_384);
    const problems = checkReceipt(receipt, body, { voucher, quote: q });
    if (problems.length) throw new SessionError(`bad receipt, stop signing for this provider: ${problems.join('; ')}`);
    this.state = { count: voucher.count, cumulative: voucher.cumulative, head: voucher.head, lastResponseHash: receipt.responseHash };
    onStep('served', receipt);
    return { status: 200, body, receipt, charged: true, quote: q, voucher };
  }
}

/** What a buyer checks on every response. Returns a list of problems, empty when the receipt is good. */
export function checkReceipt(r, body, { voucher, quote }) {
  const out = [];
  if (!r || r.v !== SESSION_VERSION) return ['unsupported receipt'];
  if (r.responseHash !== keccak256(body)) out.push('body does not match responseHash');
  for (const k of ['session', 'cumulative', 'count', 'head']) if (r[k] !== voucher[k]) out.push(`${k} differs from the voucher`);
  if (r.requestHash !== quote.requestHash) out.push('requestHash differs from the quote');
  let who = null;
  try {
    who = getAddress(verifyMessage(sessionReceiptMessage(r), r.signature));
  } catch {
    out.push('unreadable receipt signature');
  }
  if (who && who !== getAddress(quote.provider)) out.push('receipt is not signed by the provider');
  return out;
}
