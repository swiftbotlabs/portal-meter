// The paid data the demo seller sells: a cross-VM view of Portaldot V3 accounts and native assets.
// Inputs are validated before any upstream call; every upstream call has a timeout. The seller only ever
// talks to the configured Portaldot nodes (no user-supplied URLs).
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { getAddress } from 'ethers';
import { twinAccountId, h160OfAccount, isEthDerived } from '../scripts/lib/addr.mjs';
import { precompileAddress } from './config.mjs';

export class NotFound extends Error {}
export class BadInput extends Error {}
export class UpstreamError extends Error {}

const TIMEOUT_MS = 10_000;

function withTimeout(p, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new UpstreamError(`${what} timed out`)), TIMEOUT_MS); }),
  ]);
}

/** Parse "5..." (SS58, prefix 42, checksum verified) or "0x" + 40 hex. */
export function parseAccount(input) {
  if (typeof input !== 'string' || input.length > 64) throw new BadInput('address too long');
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const h160 = getAddress(input);
    return { kind: 'evm', h160, accountId: u8aToHex(twinAccountId(h160)) };
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(input)) throw new BadInput('not an SS58 or 0x address');
  let raw;
  try {
    raw = decodeAddress(input, false, 42);
  } catch {
    throw new BadInput('invalid SS58 address or checksum');
  }
  if (raw.length !== 32) throw new BadInput('unsupported account length');
  return { kind: 'substrate', h160: getAddress(h160OfAccount(raw)), accountId: u8aToHex(raw) };
}

export function parseAssetId(input) {
  if (typeof input !== 'string' || !/^[0-9]{1,10}$/.test(input)) throw new BadInput('asset id must be a number');
  const id = Number(input);
  if (id > 0xffffffff) throw new BadInput('asset id out of range');
  return id;
}

/** Live upstream: polkadot.js ApiPromise + ethers provider on the same chain. */
export function portaldotUpstream(api, evm, { assets = [] } = {}) {
  return {
    async head() {
      const h = await withTimeout(api.rpc.chain.getHeader(), 'header');
      return { number: h.number.toNumber(), hash: h.hash.toHex() };
    },
    async account(accountId) {
      const a = await withTimeout(api.query.system.account(accountId), 'system.account');
      return { nonce: a.nonce.toNumber(), free: a.data.free.toString(), reserved: a.data.reserved.toString(), frozen: a.data.frozen.toString() };
    },
    async evmAccount(h160) {
      const [bal, nonce, code] = await withTimeout(Promise.all([
        evm.getBalance(h160), evm.getTransactionCount(h160), evm.getCode(h160),
      ]), 'eth account');
      return { balanceWei: bal.toString(), nonce, codeBytes: (code.length - 2) / 2 };
    },
    async mappedOriginal(h160) {
      const o = await withTimeout(api.query.revive.originalAccount(h160), 'revive.originalAccount');
      return o.isSome ? o.unwrap().toString() : null;
    },
    async assetBalance(assetId, accountId) {
      const b = await withTimeout(api.query.assets.account(assetId, accountId), 'assets.account');
      return b.isSome ? b.unwrap().balance.toString() : '0';
    },
    async asset(id) {
      const [d, m] = await withTimeout(Promise.all([api.query.assets.asset(id), api.query.assets.metadata(id)]), 'assets');
      if (d.isNone) return null;
      const x = d.unwrap();
      return {
        owner: x.owner.toString(), supply: x.supply.toString(), accounts: x.accounts.toNumber(),
        minBalance: x.minBalance.toString(), status: x.status.toString(),
        name: m.name.toUtf8(), symbol: m.symbol.toUtf8(), decimals: m.decimals.toNumber(),
      };
    },
    async erc20TotalSupply(address) {
      const r = await withTimeout(evm.call({ to: address, data: '0x18160ddd' }), 'eth_call');
      return r && r.length === 66 ? BigInt(r).toString() : null;
    },
    trackedAssets: assets,
  };
}

/** GET /v1/account/:address */
export async function accountView(up, input) {
  const p = parseAccount(input);
  const [head, sub, evmSide, original] = await Promise.all([
    up.head(), up.account(p.accountId), up.evmAccount(p.h160), up.mappedOriginal(p.h160),
  ]);
  const assets = [];
  for (const id of up.trackedAssets.slice(0, 8)) assets.push({ assetId: id, balance: await up.assetBalance(id, p.accountId) });
  return {
    at: head,
    input,
    substrate: {
      ss58: encodeAddress(p.accountId, 42),
      accountId: p.accountId,
      ethDerived: isEthDerived(decodeAddress(encodeAddress(p.accountId, 42))),
      ...sub,
    },
    evm: { address: p.h160, ...evmSide, isContract: evmSide.codeBytes > 0 },
    mapping: {
      rule: p.kind === 'evm' ? 'H160 ++ 0xEE*12' : 'keccak256(accountId)[12..]',
      mappedAccount: original,
    },
    nativeAssets: assets,
  };
}

/** GET /v1/asset/:id */
export async function assetView(up, input) {
  const id = parseAssetId(input);
  const [head, a] = await Promise.all([up.head(), up.asset(id)]);
  if (!a) throw new NotFound(`asset ${id} does not exist`);
  const pc = precompileAddress(id);
  const evmSupply = await up.erc20TotalSupply(pc);
  return {
    at: head,
    assetId: id,
    ...a,
    erc20: { precompile: pc, totalSupply: evmSupply, matchesSubstrate: evmSupply === a.supply },
  };
}
