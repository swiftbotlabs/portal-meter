// The hand-written SCALE encoder against a vector produced by polkadot.js from the live PortaldotV3 metadata (spec 3002).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALLS_SPEC_3002 as C, INK_REGISTER_SELECTOR, INK_SET_URI_SELECTOR, INK_RECORD_SELECTOR, batchAll, compact, contractsCall, inkRecordData, inkUriData, reviveCall } from '../src/runtime-calls.mjs';
import { PATHS } from '../src/config.mjs';
import { pendingSessions, settleInput, shouldSettle } from '../src/session-settle.mjs';

const VECTOR = '0x01020850019e7ad2aa754a0eba70cfbd1db01d25ef97e5781e000700bca0650102350c000b00407a10f35af101deadbeef1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111506003621669d774ff38e377992f276b1e320fd9836aad3581f688e4c7b8a1abf35d7000700bca0650102350c00006501ad11afc403000000abababababababababababababababababababababababababababababababab01d20a1feb8ca954ab0000000000000000cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

const hex = u8 => Buffer.from(u8).toString('hex');

test('compact matches the SCALE spec', () => {
  assert.equal(hex(compact(0)), '00');
  assert.equal(hex(compact(1)), '04');
  assert.equal(hex(compact(63)), 'fc');
  assert.equal(hex(compact(64)), '0101');
  assert.equal(hex(compact(16383)), 'fdff');
  assert.equal(hex(compact(16384)), '02000100');
  assert.equal(hex(compact(1073741823)), 'feffffff');
  assert.equal(hex(compact(1073741824)), '0300000040');
  assert.equal(hex(compact(10n ** 14n)), '0b00407a10f35a');
  assert.throws(() => compact(-1));
});

test('batchAll(revive.call, contracts.call) is byte-identical to polkadot.js', () => {
  const w = { refTime: 6000000000n, proofSize: 200000n };
  const dest = '0x9E7Ad2Aa754A0EBA70CFbd1db01d25ef97e5781e';
  const data = '0xdeadbeef' + '11'.repeat(120);
  const acct = '0x3621669d774ff38e377992f276b1e320fd9836aad3581f688e4c7b8a1abf35d7';
  const ink = inkRecordData({ endpointId: 3, requestId: '0x' + 'ab'.repeat(32), amount: 12345678901234567890n, receiptHash: '0x' + 'cd'.repeat(32) });
  const mine = batchAll(C, [reviveCall(C, { dest, weight: w, depositLimit: 10n ** 14n, data }), contractsCall(C, { dest: acct, weight: w, data: ink })]);
  assert.equal(mine, VECTOR);
});

const state = (o = {}) => ({
  session: '0x' + '11'.repeat(32), count: 5, cumulative: '50000', redeemedCount: 0, redeemedCum: '0', updatedAt: 1000, expiresAt: 10_000_000,
  lastVoucher: { session: '0x' + '11'.repeat(32), cumulative: '50000', count: 5, head: '0x' + '22'.repeat(32), signature: '0x' + '33'.repeat(65) }, ...o,
});

test('pendingSessions skips sessions with nothing new', () => {
  assert.equal(pendingSessions([state(), state({ redeemedCount: 5 }), state({ lastVoucher: null })]).length, 1);
});

test('shouldSettle: enough requests, or waited long enough, never twice in the gap', () => {
  const now = 100_000;
  assert.equal(shouldSettle([], { now }), false);
  assert.equal(shouldSettle([state({ updatedAt: now })], { now }), false); // 5 waiting, fresh
  assert.equal(shouldSettle([state({ updatedAt: now - 7 * 3600 })], { now }), true); // old
  assert.equal(shouldSettle([state({ count: 30, updatedAt: now })], { now }), true); // many
  assert.equal(shouldSettle([state({ count: 30, updatedAt: now })], { now, lastSettledAt: now - 60 }), false); // just settled
  assert.equal(shouldSettle([state({ updatedAt: now, expiresAt: now + 600 })], { now, lastSettledAt: now - 60 }), true); // about to expire
  assert.equal(shouldSettle([state({ updatedAt: now, expiresAt: now + 600 })], { now, lastSettledAt: now - 60, minValue: 100_000n }), false); // too small to force
  assert.equal(shouldSettle([state({ stuck: 'x', updatedAt: 1 })], { now }), false);
  assert.deepEqual(pendingSessions([state({ session: 'later', expiresAt: 50 }), state({ session: 'sooner', expiresAt: 20 })]).map(s => s.session), ['sooner', 'later']);
});

test('settleInput pairs one redeem and one anchor per session', () => {
  const data = settleInput([state(), state()], { calls: C, sessionContract: '0x9E7Ad2Aa754A0EBA70CFbd1db01d25ef97e5781e', registryAccountId: '0x' + '36'.repeat(32), endpointId: 3 });
  assert.ok(data.startsWith('0x010210')); // utility.batchAll, compact(4) calls
  const without = settleInput([state()], { calls: C, sessionContract: '0x9E7Ad2Aa754A0EBA70CFbd1db01d25ef97e5781e', registryAccountId: null, endpointId: 3 });
  assert.ok(without.startsWith('0x010204'));
});

test('ink! URL messages: selectors from the contract metadata, SCALE compact length, the 96-byte limit of the contract', () => {
  const meta = JSON.parse(readFileSync(join(PATHS.root, 'contracts', 'ink', 'meter_registry', 'artifact', 'meter_registry.contract'), 'utf8'));
  const sel = label => meta.spec.messages.find(m => m.label === label).selector;
  assert.equal(INK_REGISTER_SELECTOR, sel('register_endpoint'));
  assert.equal(INK_SET_URI_SELECTOR, sel('set_uri'));
  assert.equal(INK_RECORD_SELECTOR, sel('record'));
  // the short form the CLI sent on the testnet (endpoint 4, block 323203): one-byte length
  const url = 'http://127.0.0.1:8788/v1/transfers/{address}';
  assert.equal(inkUriData(INK_REGISTER_SELECTOR, 4, url), '0x82079ad504000000' + (url.length << 2).toString(16) + Buffer.from(url).toString('hex'));
  // longer than 63 bytes: a two-byte compact length, which the old one-byte form could not express
  const long = 'https://paid-indexer.swiftbotlab.workers.dev/v1/transfers/{address}';
  assert.ok(long.length > 63);
  assert.equal(inkUriData(INK_SET_URI_SELECTOR, 4, long), '0x5f8e7ffc04000000' + hex(compact(long.length)) + Buffer.from(long).toString('hex'));
  assert.throws(() => inkUriData(INK_SET_URI_SELECTOR, 4, ''), /1 to 96 bytes/);
  assert.throws(() => inkUriData(INK_SET_URI_SELECTOR, 4, 'x'.repeat(97)), /1 to 96 bytes/);
});
