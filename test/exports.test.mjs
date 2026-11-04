// The package boundary a third party gets: `npm i github:swiftbotlabs/portal-meter` installs these entry points and
// nothing else. Resolved through the package's own name, exactly as an installed copy resolves them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { PATHS } from '../src/config.mjs';

test('every documented entry point resolves and exports what a seller and a buyer need', async () => {
  const core = await import('portal-meter');
  for (const k of ['createMeter', 'metered', 'MemoryLedger', 'nodeRequest', 'sendNode', 'PaymentError']) assert.equal(typeof core[k], 'function', k);
  const client = await import('portal-meter/session-client');
  for (const k of ['SessionClient', 'checkReceipt']) assert.equal(typeof client[k], 'function', k);
  const chain = await import('portal-meter/chain');
  for (const k of ['sessionContract', 'readSession', 'sessionReader', 'redeemCalldata']) assert.equal(typeof chain[k], 'function', k);
  assert.ok(Array.isArray(chain.SESSION_ABI));
  const settle = await import('portal-meter/settle');
  for (const k of ['createSettler', 'shouldSettle', 'pendingSessions', 'settleSessions', 'MemoryState']) assert.equal(typeof settle[k], 'function', k);
  assert.equal(settle.CALLS_SPEC_3002.specVersion, 3002);
  const address = await import('portal-meter/address');
  for (const k of ['parseAddress', 'ss58Decode', 'ss58Encode', 'BadInput']) assert.equal(typeof address[k], 'function', k);
});

test('the testnet deployment ships as data', () => {
  const d = createRequire(import.meta.url)('portal-meter/deployments/sessions.json');
  assert.equal(d.chainId, 420420777);
  assert.match(d.sessionContract, /^0x[0-9a-fA-F]{40}$/);
  assert.match(d.registryAccountId, /^0x[0-9a-f]{64}$/);
});

test('internals stay internal: deep imports are refused', async () => {
  await assert.rejects(import('portal-meter/src/meter.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  await assert.rejects(import('portal-meter/src/rawtx.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('address helpers: checksum, both address forms, and a refusal that an API can turn into a free 400', async () => {
  const { parseAddress, ss58Encode, BadInput } = await import('portal-meter/address');
  const a = parseAddress('5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P');
  assert.equal(a.h160, '0x0118d896dC979963341e9449218e63E158CB6AbA'); // the buyer's twin: H160 ++ 0xEE*12
  assert.equal(ss58Encode(a.accountId), '5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P');
  assert.equal(ss58Encode(parseAddress('0x0118d896dC979963341e9449218e63E158CB6AbA').accountId), '5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P');
  for (const bad of ['5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8Q', 'not an address', '0x1234', '../../etc/passwd']) {
    assert.throws(() => parseAddress(bad), e => e instanceof BadInput && e.httpStatus === 400, bad);
  }
});

test('the package ships the published deployment, never local state', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PATHS.root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map(f => f.path);
  for (const must of ['bin/portal-meter.mjs', 'src/settler.mjs', 'deployments/sessions.json', 'deployments/testnet.json', 'scripts/lib/sub.mjs']) assert.ok(files.includes(must), must);
  const local = files.filter(f => /partial\.json$|seller-state|\.env$|secrets/.test(f));
  assert.deepEqual(local, []);
  assert.ok(files.length >= 30, `only ${files.length} files`);
});
