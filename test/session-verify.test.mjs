// verifySession / readRedemptions on a local anvil chain with the real MeterSession bytecode: two batches redeemed,
// the public log replayed against the Redeemed events, and the ink! anchors (here an in-memory stand-in holding exactly
// what MeterRegistry.record stores) checked for endpoint, amount and receipt hash. Every tampering is a REJECT; the
// untouched data is the positive control and must ACCEPT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { startAnvil, deploy } from './helpers.mjs';
import { createMeter, MemoryLedger } from '../src/meter.mjs';
import { SessionClient } from '../src/session-client.mjs';
import { readSession, sessionContract } from '../src/session-chain.mjs';
import { batchHash, sessionIdFor } from '../src/session.mjs';
import { createSettler } from '../src/settler.mjs';
import { jsonRpc } from '../src/rawtx.mjs';
import { readRedemptions, verifySession, fetchLog } from '../src/session-verify.mjs';
import { waitReceipt } from '../src/evm.mjs';

const PRICE = 10_000n;
const mined = async (tx, provider) => waitReceipt(provider, (await tx).hash, { timeoutMs: 20_000 });

async function twoBatches(t) {
  const chain = await startAnvil();
  t.after(() => chain.stop());
  const deployer = await chain.wallet();
  const providerKey = await chain.wallet();
  const payer = await chain.wallet();
  const sessionKey = Wallet.createRandom();
  const token = await deploy(deployer, 'Mocks.sol', 'MockERC20', ['Meter Test USD', 'tUSDm', 6]);
  const settlement = await deploy(deployer, 'MeterSettlement.sol', 'MeterSettlement');
  const m = await deploy(deployer, 'MeterSession.sol', 'MeterSession', [await settlement.getAddress()]);
  const address = await m.getAddress();
  const tokenAddress = await token.getAddress();
  await mined(token.mint(payer.address, 1_000_000n), chain.provider);
  await mined(token.connect(payer).approve(address, 1_000_000n), chain.provider);
  await mined(settlement.connect(providerKey).registerEndpoint(Wallet.createRandom().address, tokenAddress, PRICE, 600), chain.provider);
  const nonce = hexlify(randomBytes(32));
  const block = await chain.provider.getBlock('latest');
  await mined(sessionContract(address, payer).open(1, nonce, sessionKey.address, 1_000_000n, block.timestamp + 86_400), chain.provider);
  const session = sessionIdFor(chain.chainId, address, payer.address, 1, nonce).toLowerCase();
  const reader = sessionContract(address, chain.provider);
  const ledger = new MemoryLedger();
  const meter = createMeter({
    chainId: chain.chainId, sessionContract: address, endpointId: 1, wallet: providerKey, token: tokenAddress, tokenSymbol: 'tUSDm', decimals: 6,
    readSession: id => readSession(reader, id), ledger,
  });
  const client = new SessionClient({
    signer: sessionKey, session, maxPrice: PRICE, fetch: (url, init) => meter.charge(new Request(url, init), { price: PRICE }, async () => ({ url })),
    expect: { chainId: chain.chainId, sessionContract: address, provider: providerKey.address, token: tokenAddress },
  });
  const settler = createSettler({
    ledger, wallet: new Wallet(providerKey.privateKey), rpc: chain.url, chainId: chain.chainId, sessionContract: address, endpointId: 1,
    policy: { minRequests: 1, minGapSec: 0 }, send: { polls: 200, pollMs: 25 },
  });
  for (let i = 0; i < 3; i++) await client.get(`http://seller.test/a/${i}`);
  assert.equal((await settler.tick()).settled, true);
  for (let i = 0; i < 2; i++) await client.get(`http://seller.test/b/${i}`);
  assert.equal((await settler.tick()).settled, true);
  const rpc = jsonRpc(chain.url);
  const redemptions = await readRedemptions(rpc, address, session);
  const rows = await ledger.log(session);
  // what MeterRegistry.record would hold for each batch: the cross-VM settler writes exactly this
  const anchors = new Map();
  let prev = 0n;
  for (const r of redemptions) {
    anchors.set(r.head, { endpointId: 1, outcome: 1, amount: (r.cumulative - prev).toString(), receiptHash: batchHash(session, r.cumulative, r.count, r.head), block: r.block, feedback: 0 });
    prev = r.cumulative;
  }
  return { session, rows, redemptions, anchors, rpc, address };
}

const anchorFrom = map => async head => map.get(head) ?? null;

test('two batches: the untouched log and anchors ACCEPT (positive control)', async t => {
  const c = await twoBatches(t);
  assert.deepEqual(c.redemptions.map(r => r.count), [3, 5]);
  assert.deepEqual(c.redemptions.map(r => r.paid), [3n * PRICE, 2n * PRICE]);
  const v = await verifySession({ session: c.session, rows: c.rows, redemptions: c.redemptions, anchor: anchorFrom(c.anchors), endpointId: 1 });
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  assert.equal(v.checks.length, 1 + 2 + 2);
});

test('an edited, cut or reordered log is a REJECT', async t => {
  const c = await twoBatches(t);
  const run = rows => verifySession({ session: c.session, rows, redemptions: c.redemptions, anchor: anchorFrom(c.anchors) });
  const edited = c.rows.map((r, i) => (i === 1 ? { ...r, responseHash: '0x' + '22'.repeat(32) } : r));
  assert.equal((await run(edited)).ok, false, 'a changed response hash');
  assert.equal((await run(c.rows.slice(0, 4))).ok, false, 'the last request cut');
  const swapped = [c.rows[1], c.rows[0], ...c.rows.slice(2)].map((r, i) => ({ ...r, n: i + 1 }));
  assert.equal((await run(swapped)).ok, false, 'two requests swapped');
  const wrongSum = c.rows.map((r, i) => (i === 2 ? { ...r, cumulative: '1' } : r));
  assert.equal((await run(wrongSum)).ok, false, 'a cumulative amount that is not the one redeemed');
});

test('an anchor that does not match the money is a REJECT, and so is a missing one', async t => {
  const c = await twoBatches(t);
  const head = c.redemptions[1].head;
  const tamper = patch => new Map([...c.anchors].map(([k, a]) => [k, k === head ? { ...a, ...patch } : a]));
  const run = async anchors => (await verifySession({ session: c.session, rows: c.rows, redemptions: c.redemptions, anchor: anchorFrom(anchors) })).ok;
  assert.equal(await run(tamper({ amount: '1' })), false, 'wrong amount');
  assert.equal(await run(tamper({ receiptHash: '0x' + '33'.repeat(32) })), false, 'wrong receipt hash');
  assert.equal(await run(tamper({ endpointId: 2 })), false, 'wrong endpoint');
  assert.equal(await run(new Map([...c.anchors].filter(([k]) => k !== head))), false, 'missing anchor');
  const failing = async () => { throw new Error('node down'); };
  assert.equal((await verifySession({ session: c.session, rows: c.rows, redemptions: c.redemptions, anchor: failing })).ok, false, 'an anchor read that fails is not a pass');
  assert.equal((await verifySession({ session: c.session, rows: c.rows, redemptions: c.redemptions, anchor: anchorFrom(c.anchors), endpointId: 7 })).ok, false, 'batches of another endpoint');
});

test('nothing redeemed and nothing to read is never an ACCEPT by default', async () => {
  const v = await verifySession({ session: '0x' + '11'.repeat(32), rows: [], redemptions: [], anchor: async () => null });
  assert.equal(v.ok, false);
  assert.ok(v.checks.some(c => !c.ok && /at least one batch/.test(c.name)));
});

test('fetchLog follows pages and refuses junk', async () => {
  const session = '0x' + 'ab'.repeat(32);
  const all = Array.from({ length: 1203 }, (_, i) => ({ n: i + 1 }));
  const seen = [];
  const fetchImpl = async url => {
    const from = Number(new URL(url).searchParams.get('from'));
    seen.push(from);
    return new Response(JSON.stringify({ session, rows: all.slice(from - 1, from - 1 + 500) }));
  };
  assert.equal((await fetchLog('http://seller.test', session, { fetchImpl })).length, 1203);
  assert.deepEqual(seen, [1, 501, 1001]);
  await assert.rejects(fetchLog('http://seller.test', session, { fetchImpl: async () => new Response('{"rows":"no"}') }), /unexpected answer/);
  await assert.rejects(fetchLog('http://seller.test', session, { fetchImpl: async () => new Response('', { status: 404 }) }), /HTTP 404/);
});
