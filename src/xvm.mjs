// Cross-VM: one Ethereum-signed transaction that runs a Solidity call (pallet-revive) and an ink! call
// (pallet-contracts) atomically. The transaction goes to Portaldot's runtime pallets address; the runtime
// decodes its input as a SCALE-encoded RuntimeCall (here utility.batchAll) and dispatches it with the
// sender's twin account (H160 ++ 0xEE*12) as a signed origin, so the Solidity call sees msg.sender = that H160.
import { encodeAddress } from '@polkadot/util-crypto';
import { twinAccountId } from '../scripts/lib/addr.mjs';
import { sendTx } from './evm.mjs';

export const RUNTIME_PALLETS_ADDRESS = '0x6d6f646c70792f70616464720000000000000000';
const DEFAULT_REVIVE_WEIGHT = { refTime: 20_000_000_000n, proofSize: 1_000_000n };

export function twinSs58(h160, ss58Format = 42) {
  return encodeAddress(twinAccountId(h160), ss58Format);
}

/** Dry-run a Solidity call from `fromH160` through ReviveApi_call and build the matching revive.call. */
export async function buildReviveCall(api, fromH160, dest, data, value = 0n) {
  const origin = twinSs58(fromH160);
  let weight = DEFAULT_REVIVE_WEIGHT;
  let deposit = 0n;
  try {
    const dry = await api.call.reviveApi.call(origin, dest, value, null, null, data);
    const j = dry.toJSON();
    const res = j.result || {};
    if (res.err) throw new Error(`revive dry-run reverted: ${JSON.stringify(res.err)}`);
    const flags = res.ok ? BigInt(res.ok.flags?.bits ?? res.ok.flags ?? 0) : 0n; // ReturnFlags { bits }
    if ((flags & 1n) === 1n) throw new Error(`Solidity call reverts (data ${res.ok.data})`);
    const w = j.weightRequired || j.gasRequired;
    if (w) weight = { refTime: (BigInt(w.refTime) * 3n) / 2n, proofSize: (BigInt(w.proofSize) * 3n) / 2n };
    const sd = j.storageDeposit || {};
    deposit = BigInt(sd.charge ?? 0);
  } catch (e) {
    if (/reverts|reverted/.test(e.message)) throw e;
    // older/newer result layouts: fall back to generous limits, the outer eth gas limit still caps the cost
  }
  const limit = deposit === 0n ? 10n ** 14n : (deposit * 12n) / 10n + 1n; // at least 1 tPOT of headroom
  return api.tx.revive.call(dest, value, weight, limit, data);
}

/** utility.batchAll(calls) sent as one Ethereum transaction from `wallet` (ethers Wallet on the EVM RPC). */
export async function sendBatchFromEvmKey(api, wallet, calls) {
  const batch = api.tx.utility.batchAll(calls);
  const data = batch.method.toHex();
  const receipt = await sendTx(wallet, { to: RUNTIME_PALLETS_ADDRESS, data, value: 0n });
  return { receipt, callHex: data };
}

/** Single runtime call (e.g. contracts.call or instantiate) from an EVM key. */
export async function sendCallFromEvmKey(wallet, call) {
  // a SubmittableExtrinsic also has toHex() (the whole signed-extrinsic encoding): always send the Call
  // (on a Call, .method is the method's name, a string)
  const data = (typeof call.method === 'object' ? call.method : call).toHex();
  return sendTx(wallet, { to: RUNTIME_PALLETS_ADDRESS, data, value: 0n });
}
