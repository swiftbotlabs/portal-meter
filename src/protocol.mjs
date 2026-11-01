// Portal Meter wire protocol (x402-style): 402 quote -> on-chain payment -> retry with a signed proof ->
// served once, with a provider-signed receipt. Pure functions only (no I/O), shared by seller, buyer and verifier.
import { AbiCoder, keccak256, toUtf8Bytes, getAddress, verifyMessage, isHexString } from 'ethers';

export const VERSION = 'portal-meter/1';
export const SCHEME = 'escrow-per-request';
export const HEADER_REQUIRED = 'payment-required';
export const HEADER_PAYMENT = 'payment';
export const HEADER_RESPONSE = 'payment-response';
export const MAX_HEADER_BYTES = 4096;

const abi = AbiCoder.defaultAbiCoder();

/** Same as MeterSettlement.requestIdFor and the ink! registry's request_id_for. */
export function requestIdFor(chainId, settlement, payer, endpointId, nonce) {
  return keccak256(
    abi.encode(['uint256', 'address', 'address', 'uint32', 'bytes32'], [BigInt(chainId), settlement, payer, endpointId, nonce]),
  );
}

/** Canonical JSON: keys sorted recursively, no whitespace. Used for everything that is hashed or signed. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function b64json(obj) {
  return Buffer.from(canonical(obj), 'utf8').toString('base64');
}

/** Decode a base64 JSON header with a size cap. Throws on anything unexpected. */
export function parseB64json(value, maxBytes = MAX_HEADER_BYTES) {
  if (typeof value !== 'string' || value.length === 0) throw new ProtocolError('empty header');
  if (value.length > maxBytes) throw new ProtocolError('header too large');
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) throw new ProtocolError('header is not base64');
  let obj;
  try {
    obj = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new ProtocolError('header is not JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ProtocolError('header is not an object');
  return obj;
}

export class ProtocolError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

/** keccak256 over method + path + sorted query: what the quote and the payment are bound to. */
export function requestHash(method, pathname, searchParams) {
  const q = [...new URLSearchParams(searchParams)].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  return keccak256(toUtf8Bytes(canonical({ m: method.toUpperCase(), p: pathname, q })));
}

export function responseHash(bodyBytes) {
  return keccak256(bodyBytes);
}

// ------------------------------------------------------------------ field checks
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const HEXSIG = /^0x[0-9a-fA-F]{130}$/;
const DEC = /^[0-9]{1,30}$/;

function need(cond, msg) {
  if (!cond) throw new ProtocolError(msg);
}

export function checkAddress(v, name) {
  need(typeof v === 'string' && HEX20.test(v), `${name} must be a 0x address`);
  return getAddress(v);
}

export function checkBytes32(v, name) {
  need(typeof v === 'string' && HEX32.test(v), `${name} must be 32 bytes hex`);
  return v.toLowerCase();
}

// ------------------------------------------------------------------ quote (seller -> buyer, in the 402)
export function makeQuote({ chainId, settlement, registry, endpointId, token, tokenSymbol, decimals, price, nonce,
  resource, reqHash, expiresAt, provider }) {
  return {
    v: VERSION,
    scheme: SCHEME,
    network: `eip155:${chainId}`,
    settlement,
    registry,
    provider,
    endpointId,
    token,
    tokenSymbol,
    decimals,
    price: String(price),
    nonce,
    resource,
    requestHash: reqHash,
    expiresAt,
  };
}

export function validateQuote(q) {
  need(q && q.v === VERSION && q.scheme === SCHEME, 'unsupported quote version or scheme');
  need(typeof q.network === 'string' && /^eip155:[0-9]{1,12}$/.test(q.network), 'bad network');
  checkAddress(q.settlement, 'settlement');
  checkAddress(q.token, 'token');
  checkAddress(q.provider, 'provider');
  need(Number.isInteger(q.endpointId) && q.endpointId > 0 && q.endpointId < 2 ** 32, 'bad endpointId');
  need(typeof q.price === 'string' && DEC.test(q.price) && BigInt(q.price) > 0n, 'bad price');
  checkBytes32(q.nonce, 'nonce');
  checkBytes32(q.requestHash, 'requestHash');
  need(Number.isInteger(q.expiresAt), 'bad expiresAt');
  need(Number.isInteger(q.decimals) && q.decimals >= 0 && q.decimals <= 36, 'bad decimals');
  return q;
}

// ------------------------------------------------------------------ payment proof (buyer -> seller, on retry)
export function proofMessage(requestId, reqHash) {
  return `${VERSION} payment proof\nrequest: ${requestId.toLowerCase()}\nresource: ${reqHash.toLowerCase()}`;
}

export function validateProof(p) {
  need(p && p.v === VERSION, 'unsupported proof version');
  checkBytes32(p.requestId, 'requestId');
  checkBytes32(p.nonce, 'nonce');
  checkAddress(p.payer, 'payer');
  need(typeof p.signature === 'string' && HEXSIG.test(p.signature), 'bad signature');
  if (p.payTx !== undefined) checkBytes32(p.payTx, 'payTx');
  return p;
}

/** Returns the checksummed signer of a proof (throws if the signature is malformed). */
export function proofSigner(p, reqHash) {
  return getAddress(verifyMessage(proofMessage(p.requestId, reqHash), p.signature));
}

// ------------------------------------------------------------------ receipt (seller -> buyer, with the response)
/** The part of a receipt that exists before any transaction is sent; its hash is anchored in the ink! registry. */
export function receiptCore(r) {
  return {
    v: VERSION,
    network: r.network,
    settlement: r.settlement,
    endpointId: r.endpointId,
    requestId: r.requestId.toLowerCase(),
    payer: r.payer,
    amount: String(r.amount),
    requestHash: r.requestHash.toLowerCase(),
    responseHash: r.responseHash ? r.responseHash.toLowerCase() : null,
    outcome: r.outcome,
  };
}

export function receiptCoreHash(r) {
  return keccak256(toUtf8Bytes(canonical(receiptCore(r))));
}

export function receiptMessage(r) {
  const { signature, ...rest } = r; // eslint-disable-line no-unused-vars
  return `${VERSION} receipt\n${canonical(rest)}`;
}

export function validateReceipt(r) {
  need(r && r.v === VERSION, 'unsupported receipt version');
  need(r.outcome === 'served' || r.outcome === 'refunded', 'bad outcome');
  need(typeof r.network === 'string' && /^eip155:[0-9]{1,12}$/.test(r.network), 'bad network');
  checkAddress(r.settlement, 'settlement');
  checkAddress(r.payer, 'payer');
  checkAddress(r.provider, 'provider');
  need(Number.isInteger(r.endpointId) && r.endpointId > 0, 'bad endpointId');
  checkBytes32(r.requestId, 'requestId');
  checkBytes32(r.requestHash, 'requestHash');
  checkBytes32(r.receiptHash, 'receiptHash');
  need(typeof r.amount === 'string' && DEC.test(r.amount), 'bad amount');
  if (r.outcome === 'served') checkBytes32(r.responseHash, 'responseHash');
  need(typeof r.tx === 'string' && HEX32.test(r.tx), 'bad tx');
  need(typeof r.signature === 'string' && HEXSIG.test(r.signature), 'bad signature');
  if (r.nonce !== undefined) checkBytes32(r.nonce, 'nonce');
  return r;
}

export function chainIdOf(network) {
  const m = /^eip155:([0-9]{1,12})$/.exec(network || '');
  if (!m) throw new ProtocolError('bad network');
  return Number(m[1]);
}

export function isHex32(v) {
  return typeof v === 'string' && isHexString(v, 32);
}

/** Format base units with decimals, for display only. */
export function formatUnits(amount, decimals) {
  const a = BigInt(amount);
  const d = 10n ** BigInt(decimals);
  const frac = (a % d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (a / d).toString() + (frac ? '.' + frac : '');
}
