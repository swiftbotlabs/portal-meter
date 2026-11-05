// The example, offline: a real meter and a real session client against the app, with the chain read and the explorer
// replaced by stubs. What a paid call does, what is free, and what is never charged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { createMeter, MemoryLedger } from 'portal-meter';
import { SessionClient, checkReceipt } from 'portal-meter/session-client';
import { batchHash, verifySession } from 'portal-meter/verify';
import { createApp, accountOf } from '../app.mjs';
import { amountOf, explorerUpstream, formatNative, normaliseTransfers } from '../upstream.mjs';
import { FileLedger } from '../file-ledger.mjs';

const dep = createRequire(import.meta.url)('portal-meter/deployments/sessions.json');
const PRICE = 10_000n;
const BUYER = '5C69HXuCHWTgFcDRUAmwEqgWoXdVwAfmJspoda2yZWXcwE8P';
const BUYER_H160 = '0x0118d896dC979963341e9449218e63E158CB6AbA';
const FUNDER = '5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC';

// the shape the explorer answers with (GET /accounts/{address}/transfers), one row deliberately broken
const EXPLORER_ANSWER = {
  items: [
    { indexer: { blockHeight: 282489, blockHash: '0xce', blockTime: 1793566944001, eventIndex: 2, extrinsicIndex: 1 }, from: FUNDER, to: BUYER, balance: '2500000000000000', isSigned: true, isNativeAsset: true },
    // some rows carry the amount as a big-endian u128 in hex (seen on the live explorer, 4 Nov 2026): 310 tPOT
    { indexer: { blockHeight: 282413, blockHash: '0xc8', blockTime: 1793566482000, eventIndex: 3, extrinsicIndex: 1 }, from: FUNDER, to: BUYER, balance: '0x0000000000000000006e2255f4098000', isSigned: true, isNativeAsset: true },
    { indexer: { blockHeight: 282414 }, from: '<script>', to: BUYER, balance: 'lots', isNativeAsset: true },
  ],
  page: 0, pageSize: 10, total: 3,
};

function fakeExplorer({ status = 200, body = EXPLORER_ANSWER, raw = null, fail = false } = {}) {
  const ex = { seen: [], fail };
  ex.fetchImpl = async (url, init) => {
    ex.seen.push({ url, init });
    if (ex.fail) throw new Error('connect ECONNREFUSED');
    return new Response(raw ?? JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return ex;
}

function setup(t, explorer = fakeExplorer(), { ledger = new MemoryLedger() } = {}) {
  const provider = Wallet.createRandom();
  const sessionKey = Wallet.createRandom();
  const session = hexlify(randomBytes(32));
  const onChain = {
    payer: BUYER_H160, endpointId: 9, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400, signer: sessionKey.address,
    deposit: 50_000n, redeemed: 0n, count: 0, closed: false,
  };
  const meter = createMeter({
    chainId: dep.chainId, sessionContract: dep.sessionContract, endpointId: 9, wallet: provider, token: dep.token.precompile,
    tokenSymbol: 'pUSD', decimals: 6, readSession: async id => (id === session ? onChain : null), ledger,
  });
  const upstream = explorerUpstream({ fetchImpl: explorer.fetchImpl, minGapMs: 0 });
  const app = createApp({ meter, upstream, price: PRICE });
  const call = (url, init) => app.fetch(new Request(url, init));
  const client = () => new SessionClient({
    signer: sessionKey, session, maxPrice: PRICE, fetch: call,
    expect: { chainId: dep.chainId, sessionContract: dep.sessionContract, provider: provider.address, token: dep.token.precompile },
  });
  return { app, call, client, meter, ledger, explorer, upstream, session, provider };
}

const base = 'http://seller.test';

test('no voucher: 402 and a quote bound to this exact request', async t => {
  const c = setup(t);
  const r = await c.call(`${base}/v1/transfers/${BUYER}`);
  assert.equal(r.status, 402);
  const q = (await r.json()).accepts[0];
  assert.equal(q.price, '10000');
  assert.equal(q.resource, `GET /v1/transfers/${BUYER}`);
  assert.equal(q.endpointId, 9);
  assert.equal(c.explorer.seen.length, 0, 'the explorer is not called before payment');
});

test('one paid call: 402, voucher, 200 with normalised data and a receipt the client checks', async t => {
  const c = setup(t);
  const r = await c.client().get(`${base}/v1/transfers/${BUYER}`);
  assert.equal(r.status, 200);
  assert.equal(checkReceipt(r.receipt, r.body, r).length, 0);
  const body = JSON.parse(new TextDecoder().decode(r.body));
  assert.equal(body.account, BUYER);
  assert.equal(body.transfers.length, 2);
  assert.deepEqual(body.transfers[0], {
    block: 282489, time: new Date(1793566944001).toISOString(), direction: 'in', from: FUNDER, to: BUYER, amount: '25', unit: 'tPOT', raw: '2500000000000000', native: true,
  });
  assert.equal(body.transfers[1].amount, '310', 'a hex amount is read, not dropped');
  assert.equal(body.transfers[1].raw, '31000000000000000');
  assert.equal(body.skipped, 1, 'the broken row is dropped, not passed on');
  assert.equal(c.explorer.seen[0].url, `https://scanner-testnet-v3-api.portaldot.dev/accounts/${BUYER}/transfers`);
  assert.equal(c.explorer.seen[0].init.redirect, 'manual', 'redirects are never followed (Workers refuse redirect: error)');
  const st = await c.ledger.get(c.session);
  assert.equal(st.count, 1);
  assert.equal(st.cumulative, '10000');
  // the free routes: where the session stands, and its public log
  const view = await (await c.call(`${base}/v1/session/${c.session}`)).json();
  assert.equal(view.count, 1);
  const log = await (await c.call(`${base}/v1/session/${c.session}/log`)).json();
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].responseHash, r.receipt.responseHash);
});

test('an EVM address is sold as its Portaldot twin account', async t => {
  const c = setup(t);
  assert.equal(accountOf(BUYER_H160), BUYER);
  assert.equal((await c.client().get(`${base}/v1/transfers/${BUYER_H160}`)).status, 200);
  assert.match(c.explorer.seen[0].url, new RegExp(`/accounts/${BUYER}/transfers$`));
});

test('bad input is refused for free, before any quote, and never reaches the explorer', async t => {
  const c = setup(t);
  for (const bad of [`${BUYER.slice(0, -1)}Q`, 'not-an-address', '%E0%A4%A', '..%2F..%2Fadmin', '0x1234']) {
    const r = await c.call(`${base}/v1/transfers/${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal((await r.json()).charged, false);
  }
  assert.equal((await c.call(`${base}/v1/nothing`)).status, 404);
  assert.equal((await c.call(`${base}/v1/transfers/${BUYER}`, { method: 'POST' })).status, 405);
  assert.equal(c.explorer.seen.length, 0);
});

test('explorer down: not charged, and the next request reuses the same step', async t => {
  const explorer = fakeExplorer({ fail: true });
  const c = setup(t, explorer);
  const cl = c.client();
  const r = await cl.get(`${base}/v1/transfers/${BUYER}`);
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(new TextDecoder().decode(r.body)).charged, false);
  assert.equal((await c.ledger.get(c.session)).count, 0);
  assert.equal(cl.state.count, 0, 'the client did not move either');
  explorer.fail = false;
  const ok = await cl.get(`${base}/v1/transfers/${BUYER}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.receipt.count, 1, 'the same step, signed again');
  assert.equal((await c.ledger.get(c.session)).cumulative, '10000', 'charged once');
});

test('oversized, non-JSON, redirected and error answers from the explorer are not charged', async t => {
  for (const explorer of [fakeExplorer({ raw: 'x'.repeat(300 * 1024) }), fakeExplorer({ raw: '<html>' }), fakeExplorer({ status: 500 }), fakeExplorer({ status: 302, raw: '' }), fakeExplorer({ body: { nope: true } })]) {
    const c = setup(t, explorer);
    const r = await c.client().get(`${base}/v1/transfers/${BUYER}`);
    assert.equal(r.status, 502);
    assert.equal((await c.ledger.get(c.session)).count, 0);
  }
});

test('the budget is a hard stop', async t => {
  const c = setup(t);
  const cl = c.client();
  for (let i = 0; i < 5; i++) assert.equal((await cl.get(`${base}/v1/transfers/${BUYER}?page=${i}`)).status, 200);
  const r = await cl.get(`${base}/v1/transfers/${BUYER}?page=6`);
  assert.equal(r.status, 402, 'deposit 0.05 pUSD = 5 calls');
  assert.equal(c.explorer.seen.length, 5);
});

test('formatting and normalisation', () => {
  assert.equal(amountOf('0x0000000000000000006e2255f4098000'), 31_000_000_000_000_000n);
  assert.equal(amountOf('3500000000000000'), 3_500_000_000_000_000n);
  for (const bad of ['lots', '-1', '0x', '0x' + 'f'.repeat(33), '1e18', '', null]) assert.equal(amountOf(bad), null, String(bad));
  assert.equal(formatNative('2500000000000000'), '25');
  assert.equal(formatNative('1'), '0.00000000000001');
  assert.equal(formatNative('123450000000000000'), '1234.5');
  assert.throws(() => normaliseTransfers(BUYER, { items: 'no' }), /unexpected answer/);
});

test('the file ledger survives a restart and is private', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-example-'));
  try {
    const path = join(dir, 'ledger.json');
    const a = new FileLedger(path);
    await a.put('0x' + '11'.repeat(32), { count: 2, lastVoucher: { count: 2 } });
    await a.append('0x' + '11'.repeat(32), { n: 1 });
    await a.append('0x' + '11'.repeat(32), { n: 2 });
    const b = new FileLedger(path);
    assert.equal((await b.get('0x' + '11'.repeat(32))).count, 2);
    assert.deepEqual((await b.log('0x' + '11'.repeat(32), { from: 2 })).map(r => r.n), [2]);
    assert.equal((await b.all()).length, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the public log replays against a batch, and an edited log does not', async t => {
  const c = setup(t);
  const cl = c.client();
  for (const a of [BUYER, BUYER_H160, BUYER]) assert.equal((await cl.get(`${base}/v1/transfers/${a}`)).status, 200);
  const rows = (await (await c.call(`${base}/v1/session/${c.session}/log`)).json()).rows;
  const v = (await c.ledger.get(c.session)).lastVoucher;
  // what the chain would hold after the settler redeemed this voucher: the Redeemed event and the ink! anchor
  const redemptions = [{ count: v.count, head: v.head, cumulative: BigInt(v.cumulative), paid: BigInt(v.cumulative), endpointId: 9, block: 1 }];
  const anchor = async head => (head === v.head ? { endpointId: 9, amount: v.cumulative, receiptHash: batchHash(c.session, v.cumulative, v.count, v.head), block: 1 } : null);
  const ok = await verifySession({ session: c.session, rows, redemptions, anchor, endpointId: 9 });
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));
  const edited = rows.map((r, i) => (i === 0 ? { ...r, requestHash: '0x' + '44'.repeat(32) } : r));
  assert.equal((await verifySession({ session: c.session, rows: edited, redemptions, anchor })).ok, false);
});
