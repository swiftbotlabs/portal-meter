// Settle many sessions in one Ethereum transaction: for each session a Solidity MeterSession.redeem and an ink!
// MeterRegistry.record, all inside one utility.batchAll to the runtime pallets address. They land together or not at all.
import { keccak256 } from 'ethers';
import { batchAll, contractsCall, inkRecordData, reviveCall } from './runtime-calls.mjs';
import { redeemCalldata } from './session-chain.mjs';
import { batchHash } from './session.mjs';
import { sendRaw } from './rawtx.mjs';

export const RUNTIME_PALLETS_ADDRESS = '0x6d6f646c70792f70616464720000000000000000';
const REVIVE_WEIGHT = { refTime: 6_000_000_000n, proofSize: 200_000n };
const INK_WEIGHT = { refTime: 6_000_000_000n, proofSize: 200_000n };
const REVIVE_DEPOSIT_LIMIT = 5n * 10n ** 14n; // 5 tPOT: the first redeem of a session writes one slot (3.84 tPOT), later ones none

/** Sessions with signed vouchers not redeemed yet, oldest activity first. */
export function pendingSessions(states) {
  return states
    .filter(s => s.lastVoucher && s.count > (s.redeemedCount ?? 0))
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
}

/**
 * When to spend deposit on a batch: enough requests are waiting, or the oldest has waited long enough.
 * Every batch locks one ink! anchor deposit, so this is the knob between cost and freshness.
 */
export function shouldSettle(states, { now, minRequests = 25, maxWaitSec = 6 * 3600, minGapSec = 1800, expiryMarginSec = 3600, lastSettledAt = 0 }) {
  const p = pendingSessions(states);
  if (p.length === 0) return false;
  // after expiry plus the grace period the payer can close the session, and an unredeemed voucher is worth nothing
  if (p.some(s => s.expiresAt - now < expiryMarginSec)) return true;
  if (now - lastSettledAt < minGapSec) return false;
  const waiting = p.reduce((n, s) => n + s.count - (s.redeemedCount ?? 0), 0);
  return waiting >= minRequests || now - (p[0].updatedAt ?? 0) >= maxWaitSec;
}

/** Hex input of the one transaction that settles `sessions` (ledger states). */
export function settleInput(sessions, { calls, sessionContract, registryAccountId, endpointId }) {
  const encoded = [];
  for (const s of sessions) {
    const v = s.lastVoucher;
    encoded.push(reviveCall(calls, {
      dest: sessionContract, weight: REVIVE_WEIGHT, depositLimit: REVIVE_DEPOSIT_LIMIT,
      data: redeemCalldata(v.session, v.cumulative, v.count, v.head, v.signature),
    }));
    const paid = BigInt(v.cumulative) - BigInt(s.redeemedCum ?? '0');
    if (registryAccountId) {
      encoded.push(contractsCall(calls, {
        dest: registryAccountId, weight: INK_WEIGHT,
        data: inkRecordData({ endpointId, requestId: v.head, amount: paid, receiptHash: batchHash(v.session, v.cumulative, v.count, v.head) }),
      }));
    }
  }
  return batchAll(calls, encoded);
}

/** Send one batch. Returns {tx, block, batch: [{session, count, cumulative, head, paid}]}. */
export async function settleSessions(sessions, o) {
  const data = settleInput(sessions, o);
  const { hash, block } = await sendRaw(o.rpc, o.wallet, o.chainId, { to: RUNTIME_PALLETS_ADDRESS, data }, o.send);
  return {
    tx: hash, block, inputHash: keccak256(data),
    batch: sessions.map(s => ({
      session: s.session, count: s.lastVoucher.count, cumulative: s.lastVoucher.cumulative, head: s.lastVoucher.head,
      requests: s.lastVoucher.count - (s.redeemedCount ?? 0), paid: (BigInt(s.lastVoucher.cumulative) - BigInt(s.redeemedCum ?? '0')).toString(),
    })),
  };
}
