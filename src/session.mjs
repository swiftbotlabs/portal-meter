// Session wire format: pure functions shared by the meter, the client, the verifier, the live page and the Worker.
// A session locks a budget once in MeterSession. Each request then carries a voucher signed by the session key:
//     Voucher(bytes32 session, uint96 cumulative, uint32 count, bytes32 head)
// `head` is a hash chain over everything delivered so far:
//     head[0] = keccak256(abi.encode("portal-meter/session/1", session))
//     head[n] = keccak256(abi.encode(head[n-1], requestHash[n], responseHash[n-1]))
// so the signature for request n acknowledges the exact response received for request n-1.
import { AbiCoder, TypedDataEncoder, keccak256, recoverAddress, toUtf8Bytes, getAddress } from 'ethers';
import { ProtocolError, canonical, checkAddress, checkBytes32 } from './protocol.mjs';

export const SESSION_VERSION = 'portal-meter-session/1';
export const SESSION_SCHEME = 'prepaid-session';
export const HEADER_VOUCHER = 'payment-voucher';
export const ZERO32 = '0x' + '00'.repeat(32);
export const MAX_UINT96 = (1n << 96n) - 1n;
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export const VOUCHER_TYPES = Object.freeze({
  Voucher: [
    { name: 'session', type: 'bytes32' },
    { name: 'cumulative', type: 'uint96' },
    { name: 'count', type: 'uint32' },
    { name: 'head', type: 'bytes32' },
  ],
});

const abi = AbiCoder.defaultAbiCoder();

export function sessionDomain(chainId, verifyingContract) {
  return { name: 'Portal Meter Session', version: '1', chainId, verifyingContract };
}

/** Same as MeterSession.sessionIdFor. */
export function sessionIdFor(chainId, contract, payer, endpointId, nonce) {
  return keccak256(abi.encode(['uint256', 'address', 'address', 'uint32', 'bytes32'], [BigInt(chainId), contract, payer, endpointId, nonce]));
}

export function genesisHead(session) {
  return keccak256(abi.encode(['string', 'bytes32'], ['portal-meter/session/1', session]));
}

export function nextHead(prevHead, requestHash, prevResponseHash) {
  return keccak256(abi.encode(['bytes32', 'bytes32', 'bytes32'], [prevHead, requestHash, prevResponseHash]));
}

/** What the ink! registry stores as the receipt hash of a redeemed batch. */
export function batchHash(session, cumulative, count, head) {
  return keccak256(abi.encode(['bytes32', 'uint96', 'uint32', 'bytes32'], [session, BigInt(cumulative), count, head]));
}

export function voucherDigest(chainId, contract, v) {
  return TypedDataEncoder.hash(sessionDomain(chainId, contract), VOUCHER_TYPES, voucherValue(v));
}

function voucherValue(v) {
  return { session: v.session, cumulative: BigInt(v.cumulative), count: v.count, head: v.head };
}

/** `signer` is an ethers signer: the payer or a capped session key. */
export async function signVoucher(signer, chainId, contract, v) {
  const signature = await signer.signTypedData(sessionDomain(chainId, contract), VOUCHER_TYPES, voucherValue(v));
  return { session: v.session.toLowerCase(), cumulative: String(v.cumulative), count: v.count, head: v.head.toLowerCase(), signature };
}

/** The checksummed address that signed a voucher. Throws ProtocolError on a malformed signature. */
export function voucherSigner(chainId, contract, v) {
  try {
    return getAddress(recoverAddress(voucherDigest(chainId, contract, v), v.signature));
  } catch {
    throw new ProtocolError('unreadable voucher signature', 401);
  }
}

export function validateVoucher(v) {
  if (!v || typeof v !== 'object') throw new ProtocolError('voucher is not an object');
  checkBytes32(v.session, 'session');
  checkBytes32(v.head, 'head');
  if (typeof v.cumulative !== 'string' || !/^[1-9][0-9]{0,28}$/.test(v.cumulative) || BigInt(v.cumulative) > MAX_UINT96) {
    throw new ProtocolError('bad cumulative');
  }
  if (!Number.isInteger(v.count) || v.count < 1 || v.count >= 2 ** 32) throw new ProtocolError('bad count');
  // exactly what the contract accepts: v = 27 or 28, low s. Anything looser recovers fine here and then cannot be redeemed.
  if (typeof v.signature !== 'string' || !/^0x[0-9a-fA-F]{128}1[bBcC]$/.test(v.signature)) throw new ProtocolError('bad signature');
  if (BigInt('0x' + v.signature.slice(66, 130)) > HALF_N) throw new ProtocolError('bad signature');
  return { session: v.session.toLowerCase(), cumulative: v.cumulative, count: v.count, head: v.head.toLowerCase(), signature: v.signature };
}

export function makeSessionQuote({ chainId, sessionContract, settlement, registry, endpointId, token, tokenSymbol, decimals, price, resource, requestHash, provider }) {
  return {
    v: SESSION_VERSION, scheme: SESSION_SCHEME, network: `eip155:${chainId}`, sessionContract, settlement: settlement ?? null, registry: registry ?? null,
    provider, endpointId, token, tokenSymbol, decimals, price: String(price), resource, requestHash,
  };
}

export function validateSessionQuote(q) {
  if (!q || q.v !== SESSION_VERSION || q.scheme !== SESSION_SCHEME) throw new ProtocolError('unsupported quote version or scheme');
  if (typeof q.network !== 'string' || !/^eip155:[0-9]{1,12}$/.test(q.network)) throw new ProtocolError('bad network');
  checkAddress(q.sessionContract, 'sessionContract');
  checkAddress(q.token, 'token');
  checkAddress(q.provider, 'provider');
  if (!Number.isInteger(q.endpointId) || q.endpointId <= 0 || q.endpointId >= 2 ** 32) throw new ProtocolError('bad endpointId');
  if (typeof q.price !== 'string' || !/^[1-9][0-9]{0,28}$/.test(q.price)) throw new ProtocolError('bad price');
  checkBytes32(q.requestHash, 'requestHash');
  return q;
}

export function sessionReceiptMessage(r) {
  const { signature, ...rest } = r; // eslint-disable-line no-unused-vars
  return `${SESSION_VERSION} receipt\n${canonical(rest)}`;
}

/** Hash of the part of a receipt that identifies one delivered response; useful for logs. */
export function sessionReceiptId(r) {
  return keccak256(toUtf8Bytes(canonical({ session: r.session, count: r.count, head: r.head })));
}

/**
 * Recompute a session's chain from the public log (rows {n, requestHash, responseHash}, n = 1, 2, ...).
 * @returns heads[n] for every n in the log, or throws if the rows do not start at 1 or skip a number.
 */
export function replayLog(session, rows) {
  const heads = [genesisHead(session)];
  let prevResponse = ZERO32;
  rows.forEach((row, i) => {
    if (row.n !== i + 1) throw new ProtocolError(`log row ${i + 1} has n = ${row.n}`);
    heads.push(nextHead(heads[i], checkBytes32(row.requestHash, 'requestHash'), prevResponse));
    prevResponse = checkBytes32(row.responseHash, 'responseHash');
  });
  return heads;
}

/**
 * Check a log against the redeemed batches read from the chain.
 * A voucher commits to the response before it, not its own. So a batch up to request n proves requests 1..n and
 * responses 1..n-1; the response to request n is acknowledged only once a voucher for n+1 exists.
 * @param rows        log rows {n, requestHash, responseHash, cumulative}
 * @param redemptions [{count, head, cumulative}] as emitted by MeterSession.Redeemed
 * @returns {ok, checks: [{name, ok, detail}]}
 */
export function verifyLog(session, rows, redemptions) {
  const checks = [];
  let heads = null;
  try {
    heads = replayLog(session, rows);
    checks.push({ name: 'log replays from the session genesis', ok: true, detail: `${rows.length} request${rows.length === 1 ? '' : 's'}` });
  } catch (e) {
    checks.push({ name: 'log replays from the session genesis', ok: false, detail: e.message });
    return { ok: false, checks };
  }
  for (const r of redemptions) {
    const inLog = heads[r.count];
    const headOk = inLog !== undefined && inLog.toLowerCase() === r.head.toLowerCase();
    const row = rows[r.count - 1];
    const sumOk = r.cumulative === undefined || (row !== undefined && BigInt(row.cumulative ?? -1) === BigInt(r.cumulative));
    const acked = r.count > 2 ? `responses 1 to ${r.count - 1} acknowledged` : r.count === 2 ? 'response 1 acknowledged' : 'no response acknowledged yet';
    checks.push({ name: `batch up to request ${r.count} matches the payer-signed head on-chain (${acked})`, ok: headOk && sumOk, detail: r.head });
  }
  if (redemptions.length === 0) checks.push({ name: 'no redeemed batch yet', ok: true, detail: 'nothing on-chain to compare' });
  return { ok: checks.every(c => c.ok), checks };
}
