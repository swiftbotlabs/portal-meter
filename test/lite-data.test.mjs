// The Worker's dependency-free reads: address mapping and SCALE decoding against values checked on the live chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountKey, accountView, assetId, assetKeys, assetView, decodeAccount, decodeAssetMetadata, parseAddress, precompileOf, ss58Decode, ss58Encode } from '../src/lite-data.mjs';

const SS58 = '5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC';
const ACCOUNT = '6a0d19ba716eef2ba5b0f24401860aa1e8e85a60182dfe04f031475af6039031';

test('SS58 round trip and h160 mapping match the runtime (ReviveApi_address)', () => {
  const raw = ss58Decode(SS58);
  assert.equal(Buffer.from(raw).toString('hex'), ACCOUNT);
  assert.equal(ss58Encode(raw), SS58);
  const p = parseAddress(SS58);
  assert.equal(p.h160.toLowerCase(), '0x299b95378937b7735dd0b11f3446c01fd00281bf');
  assert.equal(p.rule, 'keccak256(accountId)[12..]');
});

test('an Ethereum address maps to its twin and back', () => {
  const p = parseAddress('0x0118d896dC979963341e9449218e63E158CB6AbA');
  assert.equal(Buffer.from(p.accountId).toString('hex'), '0118d896dc979963341e9449218e63e158cb6aba' + 'ee'.repeat(12));
  const again = parseAddress(ss58Encode(p.accountId));
  assert.equal(again.h160, p.h160);
  assert.equal(again.rule, 'H160 ++ 0xEE*12');
});

test('bad input is refused before any upstream call', () => {
  for (const bad of ['', 'x', '0x12', SS58.slice(0, -1) + 'D', 'l'.repeat(47), '0'.repeat(70)]) assert.throws(() => parseAddress(bad), /address|Portaldot|SS58|checksum/, bad);
  for (const bad of ['', 'abc', '-1', '1.5', '4294967296', '99999999999']) assert.throws(() => assetId(bad), /asset id/, bad);
  assert.equal(assetId('4294967295'), 4294967295);
});

test('storage keys match the ones used on the live page', () => {
  assert.equal(assetKeys(7777).details, '0x682a59d51ab9e48a8c8cc418ff9708d2d34371a193a751eea5883e9553457b2e301de3a0ce9dd19ae8aa4083dc90d3f8611e0000');
  assert.equal(assetKeys(7777).metadata, '0x682a59d51ab9e48a8c8cc418ff9708d2b5f3822e35ca2f31ce3526eab1363fd2301de3a0ce9dd19ae8aa4083dc90d3f8611e0000');
  assert.equal(precompileOf(7777), '0x00001e6100000000000000000000000000010000');
  assert.ok(accountKey(ss58Decode(SS58)).startsWith('0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9'));
});

test('account and metadata decoding', () => {
  const free = 123456789012345n;
  const b = new Uint8Array(80);
  b[0] = 7;
  new DataView(b.buffer).setBigUint64(16, free, true);
  const hex = '0x' + Buffer.from(b).toString('hex');
  assert.deepEqual(decodeAccount(hex), { nonce: 7, free: free.toString(), reserved: '0', frozen: '0' });
  assert.deepEqual(decodeAccount(null), { nonce: 0, free: '0', reserved: '0', frozen: '0' });
  const name = Buffer.from('Portaldot USD (test)');
  const sym = Buffer.from('pUSD');
  const meta = Buffer.concat([Buffer.alloc(16), Buffer.from([name.length << 2]), name, Buffer.from([sym.length << 2]), sym, Buffer.from([6, 0])]);
  assert.deepEqual(decodeAssetMetadata('0x' + meta.toString('hex')), { name: 'Portaldot USD (test)', symbol: 'pUSD', decimals: 6 });
});

test('views: a missing asset is NotFound and carries a public message', async () => {
  const io = { sub: async () => null, evm: async () => '0x' };
  await assert.rejects(assetView(io, '404'), e => e.httpStatus === 404 && /does not exist/.test(e.publicMessage));
  await assert.rejects(accountView(io, 'nonsense'), e => e.httpStatus === 400);
});
