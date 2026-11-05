// Replay a seller's public session log against the chain, from anywhere with fetch: the check the live page runs, as a
// library, and stricter. For every batch redeemed on-chain the log must reach the payer-signed head in the `Redeemed`
// event with the same cumulative amount, and the ink! anchor of that batch must hold its endpoint, the amount paid in
// it and its receipt hash. An edited, cut or reordered log, or an anchor that does not match the money, is a REJECT.
//
//   const r = await verifySellerSession({ seller: 'https://seller.example', session, deployment, testnet });
//   console.log(r.ok ? 'ACCEPT' : 'REJECT', r.checks);
import { id as eventTopic } from 'ethers';
import { sessionIface } from './session-chain.mjs';
import { batchHash, verifyLog } from './session.mjs';
import { RawInkRegistry } from './inkraw.mjs';
import { jsonRpc } from './rawtx.mjs';

export { batchHash, replayLog } from './session.mjs';

export const REDEEMED_TOPIC = eventTopic('Redeemed(bytes32,uint32,bytes32,uint96,uint96,uint32)');
const PAGE = 500;
const MAX_ROWS = 100_000;
const NO_BATCH = 'at least one batch of this session is redeemed on-chain';
const toHex = n => (typeof n === 'number' ? '0x' + n.toString(16) : n);

/** The `Redeemed` events of one session, oldest first, over plain JSON-RPC (eth_getLogs). */
export async function readRedemptions(rpc, sessionContract, session, { fromBlock = 0, toBlock = 'latest' } = {}) {
  const logs = await rpc('eth_getLogs', [{ address: sessionContract, topics: [REDEEMED_TOPIC, session.toLowerCase()], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }]);
  return logs
    .map(l => ({ l, p: sessionIface.parseLog({ topics: l.topics, data: l.data }) }))
    .map(({ l, p }) => ({
      block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, endpointId: Number(p.args.endpointId), head: p.args.head.toLowerCase(),
      cumulative: p.args.cumulative, paid: p.args.paid, count: Number(p.args.count),
    }))
    .sort((a, b) => a.count - b.count);
}

/** Every row of a seller's public log (GET {seller}/v1/session/{id}/log), page by page, capped. */
export async function fetchLog(seller, session, { fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 10_000 } = {}) {
  const rows = [];
  for (let from = 1; ;) {
    const res = await fetchImpl(new URL(`/v1/session/${session}/log?from=${from}`, seller), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`seller log: HTTP ${res.status}`);
    const page = await res.json();
    if (!page || !Array.isArray(page.rows)) throw new Error('seller log: unexpected answer');
    rows.push(...page.rows);
    if (rows.length > MAX_ROWS) throw new Error('seller log: too many rows');
    if (page.rows.length < PAGE) return rows;
    from = rows[rows.length - 1].n + 1;
  }
}

/**
 * The checks, on data already read.
 * @param o.session      session id
 * @param o.rows         the seller's public log rows {n, requestHash, responseHash, cumulative}
 * @param o.redemptions  from readRedemptions()
 * @param o.anchor       async head => the ink! anchor of that batch, or null (RawInkRegistry.anchor for the provider)
 * @param o.endpointId   optional: the endpoint every batch must belong to
 * @returns {ok, checks: [{name, ok, detail}]}
 */
export async function verifySession({ session, rows, redemptions, anchor, endpointId }) {
  const v = verifyLog(session, rows, redemptions);
  // nothing on-chain to compare is not a proof of anything: fail closed
  if (redemptions.length === 0) v.checks.push({ name: NO_BATCH, ok: false, detail: 'none found' });
  let prev = 0n;
  for (const r of redemptions) {
    const paid = BigInt(r.cumulative) - prev;
    prev = BigInt(r.cumulative);
    if (r.paid !== undefined && BigInt(r.paid) !== paid) {
      v.checks.push({ name: `batch up to request ${r.count} paid exactly the increase in its cumulative amount`, ok: false, detail: `${r.paid} vs ${paid}` });
    }
    if (endpointId !== undefined && r.endpointId !== endpointId) {
      v.checks.push({ name: `batch up to request ${r.count} belongs to endpoint ${endpointId}`, ok: false, detail: `endpoint ${r.endpointId}` });
    }
    let a = null;
    try {
      a = anchor ? await anchor(r.head) : null;
    } catch {
      a = null;
    }
    const want = batchHash(session, r.cumulative, r.count, r.head).toLowerCase();
    const problems = !a ? ['not found'] : [
      a.endpointId !== r.endpointId && `endpoint ${a.endpointId}`,
      BigInt(a.amount) !== paid && `amount ${a.amount}, paid ${paid}`,
      String(a.receiptHash).toLowerCase() !== want && 'receipt hash differs',
    ].filter(Boolean);
    v.checks.push({
      name: `ink! anchor of the batch up to request ${r.count}: endpoint, amount and receipt hash`,
      ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `block ${a.block}, ${a.amount} paid`,
    });
  }
  return { ok: v.checks.length > 0 && v.checks.every(c => c.ok), checks: v.checks };
}

/**
 * Text lines and an exit code for a verifySellerSession result. ACCEPT is the only verdict with code 0. A session
 * whose log checks pass but that has no batch on-chain yet is NOT YET (code 1): nothing has been proved, so it fails
 * closed, but it is not called tampering either.
 * @returns {{verdict: 'ACCEPT'|'REJECT'|'NOT YET', code: 0|1, lines: string[]}}
 */
export function sessionReport(r) {
  const lines = [];
  for (const b of r.redemptions || []) lines.push(`batch     up to request ${b.count}: ${b.paid} paid, block ${b.block}, tx ${b.tx}`);
  for (const c of r.checks || []) lines.push(`${c.ok ? 'PASS' : 'FAIL'}      ${c.name}: ${c.detail}`);
  const failed = (r.checks || []).filter(c => !c.ok);
  const n = (r.redemptions || []).length;
  if (r.ok && n > 0) {
    lines.push(`ACCEPT    ${r.rows} request${r.rows === 1 ? '' : 's'} in the log, ${n} batch${n === 1 ? '' : 'es'} on-chain`);
    return { verdict: 'ACCEPT', code: 0, lines };
  }
  if (n === 0 && failed.length === 1 && failed[0].name === NO_BATCH && (r.rows ?? 0) > 0) {
    lines.push(`NOT YET   ${r.rows} request${r.rows === 1 ? '' : 's'} in the log, no batch on-chain yet: the seller settles on its own schedule, run this again later`);
    return { verdict: 'NOT YET', code: 1, lines };
  }
  lines.push('REJECT');
  return { verdict: 'REJECT', code: 1, lines };
}

/**
 * Everything from a seller URL and the chain.
 * @param o.seller      base URL of the seller
 * @param o.session     session id
 * @param o.deployment  deployments/sessions.json (sessionContract, registryAccountId)
 * @param o.testnet     deployments/testnet.json (registry selectors, a read origin)
 * @param o.provider    the provider's EVM address: the ink! namespace of its anchors
 * @param o.fromBlock   where to start looking for `Redeemed` events (the session's open block is enough)
 */
export async function verifySellerSession({ seller, session, deployment, testnet, provider, endpointId, fromBlock = 0, evmRpc, subRpc, fetchImpl }) {
  const rpc = jsonRpc(evmRpc || testnet.network.evmRpc, fetchImpl);
  const reg = new RawInkRegistry({
    rpc: subRpc || testnet.network.substrateHttp || 'https://test-node-v3.portaldot.dev', accountId: deployment.registryAccountId,
    origin: testnet.readOrigin, selectors: testnet.registry.selectors, fetchImpl,
  });
  const [rows, redemptions] = await Promise.all([
    fetchLog(seller, session, { fetchImpl }),
    readRedemptions(rpc, deployment.sessionContract, session, { fromBlock }),
  ]);
  const r = await verifySession({ session, rows, redemptions, endpointId, anchor: head => reg.anchor(provider, head) });
  return { ...r, rows: rows.length, redemptions };
}
