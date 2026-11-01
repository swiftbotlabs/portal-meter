import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  requestIdFor, canonical, b64json, parseB64json, requestHash, validateQuote, makeQuote, validateProof, proofSigner,
  proofMessage, receiptCoreHash, formatUnits, ProtocolError, VERSION,
} from '../src/protocol.mjs';
import { precompileAddress, assetIdOfPrecompile } from '../src/config.mjs';
import { twinAccountId, h160OfAccount } from '../scripts/lib/addr.mjs';
import { encodeAddress } from '@polkadot/util-crypto';

test('request id: the same vector as Solidity and ink!', () => {
  const rid = requestIdFor(420420777, '0x5e77ee0000000000000000000000000000000001',
    '0x0118d896dC979963341e9449218e63E158CB6AbA', 1, '0x' + 'ab'.repeat(32));
  assert.equal(rid, '0x2aa9da812dcbc42abb80854df02c687e70b72bce5d18979ce95bc8d00372fcbd');
});

test('address mapping matches the runtime answers recorded in docs', () => {
  assert.equal(encodeAddress(twinAccountId('0x77df5A7c0375bE0A492C109CcaFB96551fa8Ca5C'), 42),
    '5EmsuTbjRoX4EBA1QGcNvDc3FHs7kvKj6rDPZk9L2zFTuzxA');
  assert.equal(h160OfAccount('5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC'), '0x299b95378937b7735dd0b11f3446c01fd00281bf');
  assert.equal(h160OfAccount(twinAccountId('0x77df5A7c0375bE0A492C109CcaFB96551fa8Ca5C')), '0x77df5a7c0375be0a492c109ccafb96551fa8ca5c');
});

test('assets precompile address round trip', () => {
  assert.equal(precompileAddress(7777), '0x00001e6100000000000000000000000000010000');
  assert.equal(assetIdOfPrecompile('0x00001e6100000000000000000000000000010000'), 7777);
  assert.equal(assetIdOfPrecompile('0x00001e6100000000000000000000000000020000'), null);
  assert.throws(() => precompileAddress(-1));
  assert.throws(() => precompileAddress(2 ** 32));
});

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
});

test('base64 header parsing is strict and capped', () => {
  assert.deepEqual(parseB64json(b64json({ a: 1 })), { a: 1 });
  for (const bad of ['', 'not base64!', Buffer.from('[1]').toString('base64'), Buffer.from('nul').toString('base64'), 'A'.repeat(5000)]) {
    assert.throws(() => parseB64json(bad), ProtocolError);
  }
});

test('request hash ignores query order but not values', () => {
  const a = requestHash('GET', '/v1/x', 'b=2&a=1');
  assert.equal(a, requestHash('get', '/v1/x', 'a=1&b=2'));
  assert.notEqual(a, requestHash('GET', '/v1/x', 'a=1&b=3'));
  assert.notEqual(a, requestHash('GET', '/v1/y', 'a=1&b=2'));
});

function quote(over = {}) {
  return makeQuote({
    chainId: 420420777, settlement: '0x' + '11'.repeat(20), registry: null, endpointId: 1, token: '0x' + '22'.repeat(20),
    tokenSymbol: 'tUSDm', decimals: 6, price: 25000n, nonce: '0x' + '33'.repeat(32), resource: 'GET /v1/x',
    reqHash: '0x' + '44'.repeat(32), expiresAt: 2_000_000_000, provider: '0x' + '55'.repeat(20), ...over,
  });
}

test('quote validation rejects every malformed field', () => {
  validateQuote(quote());
  const bad = [
    { v: 'x' }, { network: 'eip155:abc' }, { settlement: '0x12' }, { endpointId: 0 }, { endpointId: 2 ** 32 },
    { price: '0' }, { price: '-1' }, { price: '1e3' }, { nonce: '0x12' }, { decimals: 99 }, { expiresAt: 1.5 },
  ];
  for (const b of bad) assert.throws(() => validateQuote({ ...quote(), ...b }), ProtocolError, JSON.stringify(b));
});

test('payment proof: signer recovery, wrong resource fails', async () => {
  const w = Wallet.createRandom();
  const rid = '0x' + '66'.repeat(32);
  const rh = '0x' + '77'.repeat(32);
  const p = { v: VERSION, requestId: rid, nonce: '0x' + '88'.repeat(32), payer: w.address, signature: await w.signMessage(proofMessage(rid, rh)) };
  validateProof(p);
  assert.equal(proofSigner(p, rh), w.address);
  assert.notEqual(proofSigner(p, '0x' + '99'.repeat(32)), w.address);
  assert.throws(() => validateProof({ ...p, signature: '0x1234' }), ProtocolError);
  assert.throws(() => validateProof({ ...p, payer: 'alice' }), ProtocolError);
});

test('receipt core hash covers outcome, amount and response hash', () => {
  const r = { network: 'eip155:1', settlement: '0x' + '11'.repeat(20), endpointId: 1, requestId: '0x' + 'aa'.repeat(32),
    payer: '0x' + '22'.repeat(20), amount: '10', requestHash: '0x' + 'bb'.repeat(32), responseHash: '0x' + 'cc'.repeat(32), outcome: 'served' };
  const h = receiptCoreHash(r);
  assert.notEqual(h, receiptCoreHash({ ...r, outcome: 'refunded' }));
  assert.notEqual(h, receiptCoreHash({ ...r, amount: '11' }));
  assert.notEqual(h, receiptCoreHash({ ...r, responseHash: '0x' + 'cd'.repeat(32) }));
  assert.equal(h, receiptCoreHash({ ...r, tx: '0x' + 'ee'.repeat(32), signature: '0x00' })); // tx and signature are outside the core
});

test('formatUnits', () => {
  assert.equal(formatUnits(25000n, 6), '0.025');
  assert.equal(formatUnits(1000000n, 6), '1');
  assert.equal(formatUnits(0n, 6), '0');
});
