// SCALE encoding of the few runtime calls Portal Meter sends, without polkadot.js, so that a Cloudflare Worker (or any
// small runtime) can settle across both VMs. `scripts/probe.mjs` and test/runtime-calls.test.mjs check the output
// byte for byte against polkadot.js on the live metadata; the call indices are read from that metadata.
import { getBytes, hexlify } from 'ethers';

/** Call indices of portaldot-v3 spec 3002, checked against live metadata by scripts/probe.mjs. */
export const CALLS_SPEC_3002 = Object.freeze({ specVersion: 3002, utilityBatchAll: [1, 2], reviveCall: [80, 1], contractsCall: [21, 6] });
export const INK_RECORD_SELECTOR = '0xad11afc4';
export const OUTCOME_SERVED = 1;

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function le(value, bytes) {
  const out = new Uint8Array(bytes);
  let v = BigInt(value);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError('value does not fit');
  return out;
}

/** SCALE compact integer. */
export function compact(value) {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError('negative compact');
  if (v < 1n << 6n) return le(v << 2n, 1);
  if (v < 1n << 14n) return le((v << 2n) | 1n, 2);
  if (v < 1n << 30n) return le((v << 2n) | 2n, 4);
  const bytes = Math.ceil(v.toString(16).length / 2);
  return concat([Uint8Array.of(((bytes - 4) << 2) | 3), le(v, bytes)]);
}

const vec = u8 => concat([compact(u8.length), u8]);
const weight = w => concat([compact(w.refTime), compact(w.proofSize)]);

/** revive.call(dest, value, weight_limit, storage_deposit_limit, data) */
export function reviveCall(calls, { dest, value = 0n, weight: w, depositLimit, data }) {
  return concat([Uint8Array.from(calls.reviveCall), getBytes(dest), compact(value), weight(w), compact(depositLimit), vec(getBytes(data))]);
}

/** contracts.call(dest: MultiAddress::Id, value, gas_limit, storage_deposit_limit: Option<Compact>, data) */
export function contractsCall(calls, { dest, value = 0n, weight: w, depositLimit = null, data }) {
  const limit = depositLimit === null ? Uint8Array.of(0) : concat([Uint8Array.of(1), compact(depositLimit)]);
  return concat([Uint8Array.from(calls.contractsCall), Uint8Array.of(0), getBytes(dest), compact(value), weight(w), limit, vec(getBytes(data))]);
}

/** utility.batchAll(calls): hex of the Call, ready to be the input of a transaction to the runtime pallets address. */
export function batchAll(calls, encoded) {
  return hexlify(concat([Uint8Array.from(calls.utilityBatchAll), compact(encoded.length), ...encoded]));
}

export const INK_REGISTER_SELECTOR = '0x82079ad5';
export const INK_SET_URI_SELECTOR = '0x5f8e7ffc';
const MAX_URI_BYTES = 96; // MeterRegistry::MAX_URI_LEN

/** Input of MeterRegistry.register_endpoint(endpoint_id, uri) or set_uri(endpoint_id, uri): pass the selector. */
export function inkUriData(selector, endpointId, uri) {
  const u = new TextEncoder().encode(uri);
  if (u.length === 0 || u.length > MAX_URI_BYTES) throw new RangeError(`the URL must be 1 to ${MAX_URI_BYTES} bytes`);
  return hexlify(concat([getBytes(selector), le(endpointId, 4), compact(u.length), u]));
}

/** Input of the ink! message MeterRegistry.record(endpoint_id, request_id, outcome, amount, receipt_hash). */
export function inkRecordData({ endpointId, requestId, outcome = OUTCOME_SERVED, amount, receiptHash }) {
  return hexlify(concat([getBytes(INK_RECORD_SELECTOR), le(endpointId, 4), getBytes(requestId), Uint8Array.of(outcome), le(amount, 16), getBytes(receiptHash)]));
}
