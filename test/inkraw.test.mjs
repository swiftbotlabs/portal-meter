// The browser-side SCALE codec must agree with polkadot.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TypeRegistry } from '@polkadot/types';
import { u8aToHex } from '@polkadot/util';
import { Reader, decoders, decodeContractsResult, encodeContractsCall, _internal } from '../src/inkraw.mjs';

const reg = new TypeRegistry();
reg.register({
  Anchor: { endpoint_id: 'u32', outcome: 'u8', amount: 'u128', receipt_hash: '[u8;32]', block: 'u32', feedback: 'u8' },
  EndpointRecord: { uri: 'Bytes', served: 'u64', refunded: 'u64', confirmed: 'u64', disputed: 'u64', volume: 'u128', registered_at: 'u32', last_activity: 'u32' },
  Reputation: { served: 'u64', refunded: 'u64', confirmed: 'u64', disputed: 'u64', score_bps: 'u16' },
  WeightV2: { ref_time: 'Compact<u64>', proof_size: 'Compact<u64>' },
  StorageDeposit: { _enum: { Refund: 'u128', Charge: 'u128' } },
  ExecReturnValue: { flags: 'u32', data: 'Bytes' },
  CResult: { gas_consumed: 'WeightV2', gas_required: 'WeightV2', storage_deposit: 'StorageDeposit', debug_message: 'Bytes', result: 'Result<ExecReturnValue, u8>', events: 'Option<Bytes>' },
});

test('compact encoding matches polkadot.js', () => {
  for (const n of [0, 1, 63, 64, 16383, 16384, 1073741823, 1073741824, 2n ** 64n - 1n, 10n ** 30n]) {
    assert.equal(u8aToHex(_internal.compact(n)), u8aToHex(reg.createType('Compact<u128>', n).toU8a()), String(n));
    assert.equal(new Reader(_internal.compact(n)).compact(), BigInt(n));
  }
});

test('anchor / endpoint / reputation decoders', () => {
  const a = reg.createType('Option<Anchor>', { endpoint_id: 2, outcome: 1, amount: 25000, receipt_hash: new Uint8Array(32).fill(9), block: 271999, feedback: 2 });
  assert.deepEqual(decoders.anchor(new Reader(a.toU8a())), { endpointId: 2, outcome: 1, amount: '25000', receiptHash: '0x' + '09'.repeat(32), block: 271999, feedback: 2 });
  assert.equal(decoders.anchor(new Reader(reg.createType('Option<Anchor>', null).toU8a())), null);
  const e = reg.createType('Option<EndpointRecord>', { uri: 'https://x/v1', served: 3, refunded: 1, confirmed: 2, disputed: 0, volume: 75000, registered_at: 10, last_activity: 20 });
  assert.deepEqual(decoders.endpoint(new Reader(e.toU8a())), { uri: 'https://x/v1', served: 3, refunded: 1, confirmed: 2, disputed: 0, volume: '75000', registeredAt: 10, lastActivity: 20 });
  const r = reg.createType('Reputation', { served: 3, refunded: 1, confirmed: 2, disputed: 0, score_bps: 7500 });
  assert.deepEqual(decoders.reputation(new Reader(r.toU8a())), { served: 3, refunded: 1, confirmed: 2, disputed: 0, scoreBps: 7500 });
});

test('ContractResult decoding and revert detection', () => {
  const ok = reg.createType('CResult', {
    gas_consumed: { ref_time: 1000, proof_size: 50 }, gas_required: { ref_time: 2000, proof_size: 60 },
    storage_deposit: { Charge: 15 }, debug_message: '0x', result: { Ok: { flags: 0, data: '0x0001' } }, events: null,
  });
  const d = decodeContractsResult(ok.toU8a());
  assert.equal(u8aToHex(d.data), '0x0001');
  assert.equal(d.gasRequired.refTime, 2000n);
  assert.equal(d.storageDeposit.amount, 15n);
  const reverted = reg.createType('CResult', { ...ok.toJSON(), result: { Ok: { flags: 1, data: '0x' } } });
  assert.throws(() => decodeContractsResult(reverted.toU8a()), /reverted/);
  const failed = reg.createType('CResult', { ...ok.toJSON(), result: { Err: 3 } });
  assert.throws(() => decodeContractsResult(failed.toU8a()), /DispatchError/);
});

test('ContractsApi_call argument encoding', () => {
  const input = Uint8Array.of(1, 2, 3, 4);
  const enc = encodeContractsCall({ originHex: '0x' + '11'.repeat(32), destHex: '0x' + '22'.repeat(32), input });
  const want = u8aToHex(new Uint8Array([
    ...reg.createType('[u8;32]', '0x' + '11'.repeat(32)).toU8a(), ...reg.createType('[u8;32]', '0x' + '22'.repeat(32)).toU8a(),
    ...reg.createType('u128', 0).toU8a(), ...reg.createType('Option<WeightV2>', null).toU8a(), ...reg.createType('Option<u128>', null).toU8a(),
    ...reg.createType('Bytes', u8aToHex(input)).toU8a(),
  ]));
  assert.equal(u8aToHex(enc), want);
});
