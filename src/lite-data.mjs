// The paid data of the hosted seller: cross-VM views of Portaldot V3 accounts and native assets, read over plain
// JSON-RPC with no polkadot.js, so it fits in a Cloudflare Worker. Inputs are validated before any upstream call.
import { blake2b } from '@noble/hashes/blake2b';
import { decodeBase58, encodeBase58, getAddress, getBytes, hexlify, keccak256 } from 'ethers';

export class BadInput extends Error {
  constructor(msg) {
    super(msg);
    this.httpStatus = 400;
    this.publicMessage = msg;
  }
}
export class NotFound extends Error {
  constructor(msg) {
    super(msg);
    this.httpStatus = 404;
    this.publicMessage = msg;
  }
}

const ASSETS = '682a59d51ab9e48a8c8cc418ff9708d2';
const ASSET_DETAILS = 'd34371a193a751eea5883e9553457b2e';
const ASSET_METADATA = 'b5f3822e35ca2f31ce3526eab1363fd2';
const SYSTEM_ACCOUNT = '26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9';
const SS58_PREFIX = 42;
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join("");

const blake128 = u8 => blake2b(u8, { dkLen: 16 });

function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function leInt(u8, offset, bytes) {
  let v = 0n;
  for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(u8[offset + i]);
  return v;
}

export function assetId(input) {
  if (typeof input !== 'string' || !/^[0-9]{1,10}$/.test(input)) throw new BadInput('asset id must be a number');
  const id = Number(input);
  if (id > 0xffffffff) throw new BadInput('asset id out of range');
  return id;
}

export function assetKeys(id) {
  const k = u32le(id);
  const tail = hex(blake128(k)) + hex(k);
  return { details: `0x${ASSETS}${ASSET_DETAILS}${tail}`, metadata: `0x${ASSETS}${ASSET_METADATA}${tail}` };
}

export function precompileOf(id) {
  return '0x' + id.toString(16).padStart(8, '0') + '0'.repeat(24) + '00010000';
}

export function decodeAssetDetails(h) {
  const b = getBytes(h);
  const status = ['Live', 'Frozen', 'Destroying'][b[189]] ?? 'Unknown';
  return { supply: leInt(b, 128, 16).toString(), minBalance: leInt(b, 160, 16).toString(), accounts: Number(leInt(b, 177, 4)), status };
}

export function decodeAssetMetadata(h) {
  const b = getBytes(h);
  let o = 16;
  const str = () => {
    const len = b[o] >> 2; // StringLimit 50: always a one-byte compact
    o += 1;
    const s = new TextDecoder().decode(b.slice(o, o + len));
    o += len;
    return s;
  };
  const name = str();
  const symbol = str();
  return { name, symbol, decimals: b[o] };
}

function ss58Checksum(body) {
  const pre = new TextEncoder().encode('SS58PRE');
  const m = new Uint8Array(pre.length + body.length);
  m.set(pre);
  m.set(body, pre.length);
  return blake2b(m, { dkLen: 64 }).slice(0, 2);
}

export function ss58Decode(s) {
  let raw;
  try {
    raw = getBytes('0x' + decodeBase58(s).toString(16).padStart(70, '0'));
  } catch {
    throw new BadInput('not an SS58 or 0x address');
  }
  if (raw.length !== 35 || raw[0] !== SS58_PREFIX) throw new BadInput('not a Portaldot address');
  const sum = ss58Checksum(raw.slice(0, 33));
  if (sum[0] !== raw[33] || sum[1] !== raw[34]) throw new BadInput('invalid SS58 checksum');
  return raw.slice(1, 33);
}

export function ss58Encode(accountId) {
  const body = new Uint8Array(33);
  body[0] = SS58_PREFIX;
  body.set(accountId, 1);
  const sum = ss58Checksum(body);
  const all = new Uint8Array(35);
  all.set(body);
  all.set(sum, 33);
  return encodeBase58(all);
}

/** {accountId, h160, rule} for "5..." or "0x..." input, using pallet-revive's address mapping. */
export function parseAddress(input) {
  if (typeof input !== 'string' || input.length > 64) throw new BadInput('address too long');
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const h160 = getAddress(input);
    const accountId = new Uint8Array(32).fill(0xee);
    accountId.set(getBytes(h160));
    return { accountId, h160, rule: 'H160 ++ 0xEE*12' };
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(input)) throw new BadInput('not an SS58 or 0x address');
  const accountId = ss58Decode(input);
  if (accountId.slice(20).every(b => b === 0xee)) return { accountId, h160: getAddress(hexlify(accountId.slice(0, 20))), rule: 'H160 ++ 0xEE*12' };
  return { accountId, h160: getAddress('0x' + keccak256(accountId).slice(26)), rule: 'keccak256(accountId)[12..]' };
}

export function accountKey(accountId) {
  return `0x${SYSTEM_ACCOUNT}${hex(blake128(accountId))}${hex(accountId)}`;
}

export function decodeAccount(h) {
  if (!h) return { nonce: 0, free: '0', reserved: '0', frozen: '0' };
  const b = getBytes(h);
  return { nonce: Number(leInt(b, 0, 4)), free: leInt(b, 16, 16).toString(), reserved: leInt(b, 32, 16).toString(), frozen: leInt(b, 48, 16).toString() };
}

async function head(sub) {
  const [h, hash] = await Promise.all([sub('chain_getHeader'), sub('chain_getBlockHash')]);
  return { number: parseInt(h.number, 16), hash };
}

/** GET /v1/asset/:id */
export async function assetView({ sub, evm }, input) {
  const id = assetId(input);
  const keys = assetKeys(id);
  const details = await sub('state_getStorage', [keys.details]);
  if (!details) throw new NotFound(`asset ${id} does not exist`);
  const [meta, at, supplyHex] = [await sub('state_getStorage', [keys.metadata]), await head(sub), await evm('eth_call', [{ to: precompileOf(id), data: '0x18160ddd' }, 'latest'])];
  const d = decodeAssetDetails(details);
  const evmSupply = supplyHex && supplyHex.length === 66 ? BigInt(supplyHex).toString() : null;
  return {
    at, assetId: id, ...(meta ? decodeAssetMetadata(meta) : {}), ...d,
    erc20: { precompile: precompileOf(id), totalSupply: evmSupply, matchesSubstrate: evmSupply === d.supply },
  };
}

/** GET /v1/account/:address */
export async function accountView({ sub, evm }, input) {
  const p = parseAddress(input);
  const acct = decodeAccount(await sub('state_getStorage', [accountKey(p.accountId)]));
  const [at, nonce, code] = [await head(sub), await evm('eth_getTransactionCount', [p.h160, 'latest']), await evm('eth_getCode', [p.h160, 'latest'])];
  const codeBytes = (code.length - 2) / 2;
  return {
    at, input,
    substrate: { ss58: ss58Encode(p.accountId), accountId: hexlify(p.accountId), ...acct },
    evm: { address: p.h160, nonce: Number(BigInt(nonce)), codeBytes, isContract: codeBytes > 0 },
    mapping: { rule: p.rule },
  };
}
