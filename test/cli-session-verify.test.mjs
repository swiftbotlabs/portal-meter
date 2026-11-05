// `portal-meter session-verify`: the verdict a buyer sees after one paid call. The report is built from the real
// verifySession checks on a real log: ACCEPT only with a matching batch on-chain, NOT YET (still a failure, exit 1)
// for an honest log that is not settled yet, REJECT for anything else. The CLI refuses bad input before any network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hexlify, randomBytes } from 'ethers';
import { batchHash, replayLog } from '../src/session.mjs';
import { sessionReport, verifySession } from '../src/session-verify.mjs';

const CLI = new URL('../bin/portal-meter.mjs', import.meta.url).pathname;
const rand = () => hexlify(randomBytes(32));

test('session-verify report: ACCEPT only with a batch on-chain, NOT YET before it, REJECT on a bad log, usage errors exit 2', async () => {
  const session = rand();
  const rows = [1, 2].map(n => ({ n, requestHash: rand(), responseHash: rand(), cumulative: String(10_000 * n) }));
  const head2 = replayLog(session, rows)[2];
  const redemption = { count: 2, head: head2, cumulative: 20_000n, paid: 20_000n, endpointId: 3, block: 1, tx: '0x01' };
  const goodAnchor = async () => ({ endpointId: 3, amount: 20_000n, receiptHash: batchHash(session, 20_000n, 2, head2), block: 1 });

  // positive control: honest log, matching batch and anchor
  const ok = await verifySession({ session, rows, redemptions: [redemption], anchor: goodAnchor, endpointId: 3 });
  const accept = sessionReport({ ...ok, rows: rows.length, redemptions: [redemption] });
  assert.equal(accept.verdict, 'ACCEPT');
  assert.equal(accept.code, 0);
  assert.match(accept.lines.at(-1), /^ACCEPT {4}2 requests in the log, 1 batch on-chain$/);

  // honest log, nothing redeemed yet: not a proof, so not 0, but not called tampering
  const pending = await verifySession({ session, rows, redemptions: [], anchor: goodAnchor, endpointId: 3 });
  const notYet = sessionReport({ ...pending, rows: rows.length, redemptions: [] });
  assert.equal(notYet.verdict, 'NOT YET');
  assert.equal(notYet.code, 1);

  // an empty log with no batch proves nothing at all
  const empty = await verifySession({ session, rows: [], redemptions: [], anchor: goodAnchor });
  assert.equal(sessionReport({ ...empty, rows: 0, redemptions: [] }).verdict, 'REJECT');

  // a cut log with no batch yet is a REJECT, not a NOT YET
  const cut = await verifySession({ session, rows: [rows[1]], redemptions: [], anchor: goodAnchor });
  assert.equal(sessionReport({ ...cut, rows: 1, redemptions: [] }).verdict, 'REJECT');

  // a batch whose ink! anchor does not hold the money is a REJECT
  const badAnchor = async () => ({ endpointId: 3, amount: 1n, receiptHash: batchHash(session, 20_000n, 2, head2), block: 1 });
  const bad = await verifySession({ session, rows, redemptions: [redemption], anchor: badAnchor, endpointId: 3 });
  const reject = sessionReport({ ...bad, rows: rows.length, redemptions: [redemption] });
  assert.equal(reject.verdict, 'REJECT');
  assert.equal(reject.code, 1);
  assert.ok(reject.lines.some(l => l.startsWith('FAIL') && /amount 1, paid 20000/.test(l)));

  // the CLI refuses bad input before it touches the network
  for (const args of [[], ['not-a-url', '--id', rand(), '--provider', '0x' + '11'.repeat(20)], ['https://x.example', '--id', '0x12', '--provider', '0x' + '11'.repeat(20)],
    ['https://x.example', '--id', rand(), '--provider', '0x1234'], ['https://x.example', '--session', '/nonexistent/session.json']]) {
    const r = spawnSync(process.execPath, [CLI, 'session-verify', ...args], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
});
