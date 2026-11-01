// MemoryRegistry must follow the same rules as the ink! contract (contracts/ink/meter_registry/lib.rs tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRegistry, OUTCOME, FEEDBACK, RegistryError } from '../src/registry.mjs';

const SETTLEMENT = '0x5e77ee0000000000000000000000000000000001';
const PROVIDER = '0x' + '43'.repeat(20);
const BUYER = '0x' + 'b0'.repeat(20);

test('request id equals the shared vector', () => {
  const r = new MemoryRegistry({ settlement: SETTLEMENT, chainId: 420420777 });
  assert.equal(r.requestIdFor('0x0118d896dC979963341e9449218e63E158CB6AbA', 1, '0x' + 'ab'.repeat(32)),
    '0x2aa9da812dcbc42abb80854df02c687e70b72bce5d18979ce95bc8d00372fcbd');
});

test('provider lists, records once, reputation', async () => {
  const r = new MemoryRegistry({ settlement: SETTLEMENT, chainId: 1 });
  r.registerEndpoint(PROVIDER, 1, 'https://meter.example/v1/x');
  assert.throws(() => r.registerEndpoint(PROVIDER, 1, 'https://dup'), /AlreadyRegistered/);
  const rid = r.requestIdFor(BUYER, 1, '0x' + '01'.repeat(32));
  r.record(PROVIDER, { endpointId: 1, requestId: rid, outcome: OUTCOME.SERVED, amount: 25000, receiptHash: '0x' + '09'.repeat(32) });
  assert.throws(() => r.record(PROVIDER, { endpointId: 1, requestId: rid, outcome: OUTCOME.SERVED, amount: 1, receiptHash: '0x' + '00'.repeat(32) }), /AlreadyAnchored/);
  const rid2 = r.requestIdFor(BUYER, 1, '0x' + '02'.repeat(32));
  r.record(PROVIDER, { endpointId: 1, requestId: rid2, outcome: OUTCOME.REFUNDED, amount: 25000, receiptHash: '0x' + '08'.repeat(32) });
  const rep = await r.reputation(PROVIDER, 1);
  assert.deepEqual([rep.served, rep.refunded, rep.scoreBps], [1, 1, 5000]);
  assert.equal((await r.endpoint(PROVIDER, 1)).volume, '25000');
});

test('guards and namespaces', () => {
  const r = new MemoryRegistry({ settlement: SETTLEMENT, chainId: 1 });
  assert.throws(() => r.record(PROVIDER, { endpointId: 1, requestId: '0x' + '01'.repeat(32), outcome: 1, amount: 1, receiptHash: '0x' + '00'.repeat(32) }), /NotRegistered/);
  r.registerEndpoint(PROVIDER, 1, 'https://a');
  assert.throws(() => r.record(PROVIDER, { endpointId: 1, requestId: '0x' + '00'.repeat(32), outcome: 1, amount: 1, receiptHash: '0x' + '00'.repeat(32) }), /ZeroRequestId/);
  assert.throws(() => r.record(PROVIDER, { endpointId: 1, requestId: '0x' + '01'.repeat(32), outcome: 3, amount: 1, receiptHash: '0x' + '00'.repeat(32) }), /BadOutcome/);
  assert.throws(() => r.registerEndpoint(PROVIDER, 2, ''), /UriEmpty/);
  assert.throws(() => r.registerEndpoint(PROVIDER, 2, 'a'.repeat(97)), /UriTooLong/);
  assert.throws(() => r.record('0x' + '66'.repeat(20), { endpointId: 1, requestId: '0x' + '01'.repeat(32), outcome: 1, amount: 1, receiptHash: '0x' + '00'.repeat(32) }), RegistryError);
});

test('only the payer can rate, once; refunds cannot be rated', async () => {
  const r = new MemoryRegistry({ settlement: SETTLEMENT, chainId: 1 });
  r.registerEndpoint(PROVIDER, 1, 'https://a');
  const nonce = '0x' + '07'.repeat(32);
  const rid = r.requestIdFor(BUYER, 1, nonce);
  r.record(PROVIDER, { endpointId: 1, requestId: rid, outcome: OUTCOME.SERVED, amount: 10, receiptHash: '0x' + '01'.repeat(32) });
  assert.throws(() => r.rate('0x' + '99'.repeat(20), { provider: PROVIDER, endpointId: 1, nonce, ok: false }), /NoSuchAnchor/);
  r.rate(BUYER, { provider: PROVIDER, endpointId: 1, nonce, ok: false });
  assert.throws(() => r.rate(BUYER, { provider: PROVIDER, endpointId: 1, nonce, ok: true }), /AlreadyRated/);
  assert.equal((await r.anchor(PROVIDER, rid)).feedback, FEEDBACK.DISPUTED);
  assert.equal((await r.reputation(PROVIDER, 1)).scoreBps, 0);
  const n2 = '0x' + '03'.repeat(32);
  r.record(PROVIDER, { endpointId: 1, requestId: r.requestIdFor(BUYER, 1, n2), outcome: OUTCOME.REFUNDED, amount: 10, receiptHash: '0x' + '01'.repeat(32) });
  assert.throws(() => r.rate(BUYER, { provider: PROVIDER, endpointId: 1, nonce: n2, ok: true }), /NotServed/);
});
