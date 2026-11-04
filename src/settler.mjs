// Settlement for any seller: what the hosted Worker's cron does, as a library. Give it the meter's ledger and the
// provider key; on each tick it decides whether a batch is worth an anchor deposit, re-reads every session from the
// chain (the chain is the truth: an earlier batch may have landed although its receipt never arrived), dry-runs each
// redeem so one bad voucher cannot sink the whole batch, and then sends one transaction.
//
//   const settler = createSettler({ ledger: meter.ledger, wallet, rpc: 'https://test-evm-rpc-v3.portaldot.dev', chainId,
//                                   sessionContract, endpointId, registryAccountId });
//   setInterval(async () => console.log(await settler.tick()), 60_000);
//
// With `registryAccountId` the batch is one Ethereum transaction to the runtime pallets address: for each session a
// Solidity MeterSession.redeem and an ink! MeterRegistry.record inside one utility.batchAll, so money and public record
// land together. Without it (any plain EVM chain, or a local test chain) each session is one direct redeem transaction.
// Runs wherever fetch does: Node.js 20+, Cloudflare Workers, Bun, Deno. Never throws from tick(): errors come back as data.
import { pendingSessions, settleSessions, shouldSettle } from './session-settle.mjs';
import { redeemCalldata, sessionReader } from './session-chain.mjs';
import { RpcError, jsonRpc, sendRaw } from './rawtx.mjs';
import { CALLS_SPEC_3002 } from './runtime-calls.mjs';

export { pendingSessions, settleSessions, shouldSettle } from './session-settle.mjs';
export { CALLS_SPEC_3002 } from './runtime-calls.mjs';

/** In-memory place for the settler's own bookkeeping; pass something durable to survive restarts. */
export class MemoryState {
  #v = null;
  async get() {
    return this.#v;
  }
  async put(v) {
    this.#v = v;
  }
}

/**
 * @param o.ledger            the meter's ledger: get(id), put(id, state), and pending() or all()
 * @param o.wallet            ethers Wallet of the endpoint's provider (no provider object needed)
 * @param o.rpc               EVM JSON-RPC URL, or a jsonRpc()-style function (method, params) => result
 * @param o.chainId, o.sessionContract, o.endpointId
 * @param o.registryAccountId ink! MeterRegistry account id (0x + 64 hex) to settle across both VMs; omit for EVM only
 * @param o.calls             runtime call indices (default: portaldot-v3 spec 3002)
 * @param o.policy            shouldSettle options: minRequests, maxWaitSec, minGapSec, expiryMarginSec, minValue
 * @param o.maxSessions       sessions per batch (default 4)
 * @param o.minBalance        wei: refuse to send below this provider balance (default 0)
 * @param o.state             {get, put} for {lastSettledAt, batches, requests} (default MemoryState)
 * @param o.send              sendRaw options, such as {polls, pollMs}
 */
export function createSettler(o) {
  for (const k of ['ledger', 'wallet', 'rpc', 'chainId', 'sessionContract', 'endpointId']) {
    if (o[k] === undefined || o[k] === null) throw new Error(`createSettler: ${k} is required`);
  }
  const rpc = typeof o.rpc === 'function' ? o.rpc : jsonRpc(o.rpc);
  const now = o.now || (() => Math.floor(Date.now() / 1000));
  const state = o.state || new MemoryState();
  const maxSessions = o.maxSessions ?? 4;
  const minBalance = BigInt(o.minBalance ?? 0);
  const calls = o.calls || CALLS_SPEC_3002;
  const read = sessionReader(async ({ to, data }) => rpc('eth_call', [{ to, data }, 'latest']), o.sessionContract);
  let running = null;

  const pending = async () => (o.ledger.pending ? o.ledger.pending() : o.ledger.all());
  const meta = async () => (await state.get()) ?? { lastSettledAt: 0, batches: 0, requests: 0 };

  async function sendBatch(usable) {
    if (o.registryAccountId) {
      return settleSessions(usable, {
        rpc, wallet: o.wallet, chainId: o.chainId, calls, sessionContract: o.sessionContract,
        registryAccountId: o.registryAccountId, endpointId: o.endpointId, send: o.send,
      });
    }
    const txs = [];
    const batch = [];
    let block = null;
    for (const s of usable) {
      const v = s.lastVoucher;
      const r = await sendRaw(rpc, o.wallet, o.chainId, { to: o.sessionContract, data: redeemCalldata(v.session, v.cumulative, v.count, v.head, v.signature) }, o.send);
      txs.push(r.hash);
      batch.push({ session: s.session, count: v.count, cumulative: v.cumulative, head: v.head, requests: v.count - (s.redeemedCount ?? 0), paid: (BigInt(v.cumulative) - BigInt(s.redeemedCum ?? '0')).toString() });
      block = r.block;
    }
    return { tx: txs[txs.length - 1], txs, block, batch };
  }

  async function run(force) {
    const m = await meta();
    const t = now();
    const states = await pending();
    if (!force && !shouldSettle(states, { now: t, lastSettledAt: m.lastSettledAt, ...(o.policy || {}) })) {
      return { settled: false, reason: 'not due', waiting: pendingSessions(states).length };
    }
    try {
      if (minBalance > 0n) {
        const bal = BigInt(await rpc('eth_getBalance', [o.wallet.address, 'latest']));
        if (bal < minBalance) throw new Error('provider balance too low to settle');
      }
      const usable = [];
      const stuck = [];
      for (const s of pendingSessions(states).slice(0, maxSessions)) {
        const on = await read(s.session);
        if (on) await o.ledger.put(s.session, { ...(await o.ledger.get(s.session)), redeemedCount: on.count, redeemedCum: on.redeemed.toString() });
        if (!on || s.lastVoucher.count <= on.count) continue;
        const v = s.lastVoucher;
        try {
          await rpc('eth_call', [{ from: o.wallet.address, to: o.sessionContract, data: redeemCalldata(v.session, v.cumulative, v.count, v.head, v.signature) }, 'latest']);
          usable.push({ ...s, redeemedCount: on.count, redeemedCum: on.redeemed.toString() });
        } catch (e) {
          if (!(e instanceof RpcError) || !e.reverted) throw e; // a network problem says nothing about the session
          await o.ledger.put(s.session, { ...(await o.ledger.get(s.session)), stuck: String(e.data || e.message).slice(0, 120) });
          stuck.push(s.session);
        }
      }
      if (usable.length === 0) return { settled: false, reason: 'no session can be redeemed', stuck };
      const r = await sendBatch(usable);
      for (const b of r.batch) {
        const st = await o.ledger.get(b.session); // the freshest row: requests may have been served meanwhile
        await o.ledger.put(b.session, { ...st, redeemedCount: b.count, redeemedCum: b.cumulative });
      }
      const requests = r.batch.reduce((n, b) => n + b.requests, 0);
      await state.put({ ...m, lastSettledAt: t, batches: (m.batches ?? 0) + 1, requests: (m.requests ?? 0) + requests });
      return { settled: true, tx: r.tx, txs: r.txs ?? [r.tx], block: r.block, requests, sessions: r.batch, stuck };
    } catch (e) {
      return { settled: false, error: String(e.message).slice(0, 200) };
    }
  }

  /** One check. Concurrent calls share the run in flight, so a slow chain never gets two batches for one voucher. */
  function tick({ force = false } = {}) {
    if (!running) running = run(force).finally(() => { running = null; });
    return running;
  }

  return { tick, state };
}
