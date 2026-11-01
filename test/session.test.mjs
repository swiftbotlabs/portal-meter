// Session protocol: Solidity vectors, chain replay, and a real run on a local anvil chain with the deployed bytecode:
// open, many requests through the meter, redeem one batch, close.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Wallet, hexlify, keccak256, randomBytes } from 'ethers';
import { startAnvil, deploy } from './helpers.mjs';
import { createMeter, metered, MemoryLedger, sendNode, nodeRequest } from '../src/meter.mjs';
import { SessionClient, SessionError, checkReceipt } from '../src/session-client.mjs';
import { readSession, sessionContract, redeemCalldata, sessionIface } from '../src/session-chain.mjs';
import {
  HEADER_VOUCHER, ZERO32, batchHash, genesisHead, nextHead, replayLog, sessionIdFor, signVoucher, validateVoucher, verifyLog, voucherDigest, voucherSigner,
} from '../src/session.mjs';
import { b64json, parseB64json, requestHash, HEADER_REQUIRED, HEADER_RESPONSE } from '../src/protocol.mjs';
import { sendTx, waitReceipt } from '../src/evm.mjs';

const PRICE = 10_000n;
const BUDGET = 1_000_000n;
const mined = async (tx, provider) => waitReceipt(provider, (await tx).hash, { timeoutMs: 20_000 });

async function setup(t) {
  const chain = await startAnvil();
  t.after(() => chain.stop());
  const deployer = await chain.wallet();
  const providerKey = await chain.wallet();
  const payer = await chain.wallet();
  const sessionKey = Wallet.createRandom();
  const payee = Wallet.createRandom().address;
  const token = await deploy(deployer, 'Mocks.sol', 'MockERC20', ['Meter Test USD', 'tUSDm', 6]);
  const settlement = await deploy(deployer, 'MeterSettlement.sol', 'MeterSettlement');
  const m = await deploy(deployer, 'MeterSession.sol', 'MeterSession', [await settlement.getAddress()]);
  const address = await m.getAddress();
  const tokenAddress = await token.getAddress();
  await mined(token.mint(payer.address, 10n * BUDGET), chain.provider);
  await mined(token.connect(payer).approve(address, 10n * BUDGET), chain.provider);
  await mined(settlement.connect(providerKey).registerEndpoint(payee, tokenAddress, PRICE, 600), chain.provider);
  const nonce = hexlify(randomBytes(32));
  const asPayer = sessionContract(address, payer);
  const block = await chain.provider.getBlock('latest');
  await mined(asPayer.open(1, nonce, sessionKey.address, BUDGET, block.timestamp + 86_400), chain.provider);
  const session = sessionIdFor(chain.chainId, address, payer.address, 1, nonce).toLowerCase();
  const reader = sessionContract(address, chain.provider);
  const ledger = new MemoryLedger();
  let calls = 0;
  const handlers = { fail: null };
  const clock = { offset: 0 };
  const meter = createMeter({
    chainId: chain.chainId, sessionContract: address, endpointId: 1, wallet: providerKey, token: tokenAddress, tokenSymbol: 'tUSDm', decimals: 6,
    readSession: id => readSession(reader, id), ledger, now: () => Math.floor(Date.now() / 1000) + clock.offset,
  });
  const server = http.createServer((req, res) => {
    const r = nodeRequest(req, `http://${req.headers.host}`);
    meter.charge(r, { price: PRICE }, async () => {
      calls += 1;
      if (handlers.fail) throw handlers.fail;
      return { path: new URL(r.url).pathname, calls };
    }).then(x => sendNode(res, x));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const expect = { chainId: chain.chainId, sessionContract: address, provider: providerKey.address, token: tokenAddress };
  const client = () => new SessionClient({ signer: sessionKey, session, expect, maxPrice: PRICE });
  return { chain, m, token, address, tokenAddress, providerKey, payer, payee, sessionKey, session, reader, ledger, meter, base, expect, client, handlers, clock, calls: () => calls };
}

test('voucher digest and session id match the contract', async t => {
  const c = await setup(t);
  const head = keccak256('0x01');
  const onChain = await c.reader.voucherDigest(c.session, 30_000n, 3, head);
  assert.equal(voucherDigest(c.chain.chainId, c.address, { session: c.session, cumulative: 30_000n, count: 3, head }), onChain);
  const v = await signVoucher(c.sessionKey, c.chain.chainId, c.address, { session: c.session, cumulative: 30_000n, count: 3, head });
  assert.equal(voucherSigner(c.chain.chainId, c.address, v), c.sessionKey.address);
});

test('hash chain: order, request and response all change the head', () => {
  const s = '0x' + '11'.repeat(32);
  const [a, b, c] = ['aa', 'bb', 'cc'].map(x => '0x' + x.repeat(32));
  const g = genesisHead(s);
  assert.notEqual(g, genesisHead('0x' + '12'.repeat(32)));
  assert.notEqual(nextHead(g, a, ZERO32), nextHead(g, b, ZERO32));
  assert.notEqual(nextHead(g, a, b), nextHead(g, a, c));
  const rows = [{ n: 1, requestHash: a, responseHash: b }, { n: 2, requestHash: b, responseHash: c }];
  const heads = replayLog(s, rows);
  assert.equal(heads[2], nextHead(nextHead(g, a, ZERO32), b, b));
  assert.throws(() => replayLog(s, [rows[1]]), /has n = 2/);
});

test('verifyLog accepts the real log and rejects an edited one', () => {
  const s = '0x' + '11'.repeat(32);
  const [a, b, c] = ['aa', 'bb', 'cc'].map(x => '0x' + x.repeat(32));
  const rows = [{ n: 1, requestHash: a, responseHash: b }, { n: 2, requestHash: b, responseHash: c }, { n: 3, requestHash: c, responseHash: a }];
  const heads = replayLog(s, rows);
  assert.equal(verifyLog(s, rows, [{ count: 3, head: heads[3] }]).ok, true);
  const edited = rows.map((r, i) => (i === 1 ? { ...r, responseHash: a } : r)); // a provider rewrites response 2
  assert.equal(verifyLog(s, edited, [{ count: 3, head: heads[3] }]).ok, false);
  assert.equal(verifyLog(s, rows.slice(0, 2), [{ count: 3, head: heads[3] }]).ok, false); // log cut short
});

test('validateVoucher refuses malformed input', () => {
  const good = { session: '0x' + 'ab'.repeat(32), cumulative: '10', count: 1, head: '0x' + 'cd'.repeat(32), signature: '0x' + '11'.repeat(65) };
  assert.ok(validateVoucher(good));
  for (const bad of [
    null, 7, {}, { ...good, session: '0x12' }, { ...good, cumulative: '0' }, { ...good, cumulative: '-1' }, { ...good, cumulative: 10 },
    { ...good, cumulative: (1n << 96n).toString() }, { ...good, count: 0 }, { ...good, count: 1.5 }, { ...good, count: 2 ** 32 },
    { ...good, head: 'x' }, { ...good, signature: '0x00' },
  ]) assert.throws(() => validateVoucher(bad), /./);
});

test('e2e: 50 requests, one redeem pays the payee exactly, close returns the rest', async t => {
  const c = await setup(t);
  const cl = c.client();
  for (let i = 0; i < 50; i++) {
    const r = await cl.get(`${c.base}/v1/thing/${i}`);
    assert.equal(r.status, 200);
    assert.equal(checkReceipt(r.receipt, r.body, r).length, 0);
  }
  assert.equal(c.calls(), 50);
  const st = await c.ledger.get(c.session);
  assert.equal(st.count, 50);
  assert.equal(st.cumulative, (50n * PRICE).toString());

  // nothing moved on chain yet: fifty requests, zero transactions
  assert.equal(await c.token.balanceOf(c.payee), 0n);
  const v = st.lastVoucher;
  const rcpt = await sendTx(c.providerKey, { to: c.address, data: redeemCalldata(v.session, v.cumulative, v.count, v.head, v.signature) });
  assert.equal(await c.token.balanceOf(c.payee), 50n * PRICE);
  const ev = rcpt.logs.map(l => sessionIface.parseLog(l)).find(l => l && l.name === 'Redeemed');
  assert.equal(ev.args.count, 50n);
  assert.equal(ev.args.head.toLowerCase(), st.head);

  // anyone can check the batch from the public log
  const log = await c.ledger.log(c.session);
  assert.equal(verifyLog(c.session, log, [{ count: 50, head: ev.args.head }]).ok, true);
  assert.ok(batchHash(c.session, v.cumulative, v.count, v.head).startsWith('0x'));

  await mined(sessionContract(c.address, c.providerKey).close(c.session), c.chain.provider);
  assert.equal(await c.token.balanceOf(c.payer.address), 9n * BUDGET + BUDGET - 50n * PRICE);
});

test('a failed handler charges nothing and the next request reuses the step', async t => {
  const c = await setup(t);
  const cl = c.client();
  assert.equal((await cl.get(`${c.base}/a`)).status, 200);
  c.handlers.fail = Object.assign(new Error('upstream down'), { httpStatus: 502, publicMessage: 'upstream down' });
  const r = await cl.get(`${c.base}/b`);
  assert.equal(r.status, 502);
  assert.equal(r.charged, false);
  assert.match(new TextDecoder().decode(r.body), /"charged": false/);
  c.handlers.fail = null;
  const again = await cl.get(`${c.base}/c`);
  assert.equal(again.status, 200);
  assert.equal(again.receipt.count, 2);
  assert.equal(again.receipt.cumulative, (2n * PRICE).toString());
});

test('the meter refuses every bad voucher before the handler runs', async t => {
  const c = await setup(t);
  const cl = c.client();
  await cl.get(`${c.base}/a`);
  const url = new URL(`${c.base}/b`);
  const reqHash = requestHash('GET', url.pathname, url.searchParams);
  const s = cl.state;
  const good = { session: c.session, cumulative: BigInt(s.cumulative) + PRICE, count: s.count + 1, head: nextHead(s.head, reqHash, s.lastResponseHash) };
  const send = async (v, key = c.sessionKey) => {
    const h = b64json(await signVoucher(key, c.chain.chainId, c.address, v));
    const r = await fetch(url, { headers: { [HEADER_VOUCHER]: h } });
    return { status: r.status, body: await r.json() };
  };
  const before = c.calls();
  assert.equal((await send({ ...good, cumulative: good.cumulative - 1n })).status, 409); // underpays
  assert.equal((await send({ ...good, count: good.count + 1 })).status, 409); // skips ahead
  assert.equal((await send({ ...good, count: 1, cumulative: PRICE })).status, 409); // replay of step 1
  assert.equal((await send({ ...good, head: keccak256('0x02') })).status, 409); // a chain the seller cannot extend
  assert.equal((await send(good, Wallet.createRandom())).status, 401); // a stranger's key
  const other = await fetch(url, { headers: { [HEADER_VOUCHER]: b64json(await signVoucher(c.sessionKey, c.chain.chainId, c.address, { ...good, session: '0x' + '77'.repeat(32) })) } });
  assert.equal(other.status, 404); // a session that does not exist
  assert.equal((await fetch(url, { headers: { [HEADER_VOUCHER]: 'not base64!' } })).status, 400);
  assert.equal((await fetch(url, { headers: { [HEADER_VOUCHER]: Buffer.from('[1,2]').toString('base64') } })).status, 400);
  assert.equal((await fetch(url, { headers: { [HEADER_VOUCHER]: 'A'.repeat(5000) } })).status, 400);
  assert.equal(c.calls(), before);
  assert.equal((await send(good)).status, 200); // the honest voucher still works afterwards
});

test('a voucher for one request cannot buy another', async t => {
  const c = await setup(t);
  const cl = c.client();
  const a = new URL(`${c.base}/a`);
  const v = await signVoucher(c.sessionKey, c.chain.chainId, c.address, {
    session: c.session, cumulative: PRICE, count: 1, head: nextHead(cl.state.head, requestHash('GET', a.pathname, a.searchParams), ZERO32),
  });
  const r = await fetch(`${c.base}/b`, { headers: { [HEADER_VOUCHER]: b64json(v) } });
  assert.equal(r.status, 409);
});

test('the budget is a hard stop, and a top-up reopens it', async t => {
  const c = await setup(t);
  const cl = c.client();
  cl.state = { ...cl.state }; // spend to the last whole request
  const n = Number(BUDGET / PRICE);
  await c.ledger.put(c.session, { ...(await c.meter.loadState(c.session)), count: n, cumulative: BUDGET.toString() });
  const st = await c.ledger.get(c.session);
  cl.state = { count: n, cumulative: BUDGET.toString(), head: st.head, lastResponseHash: st.lastResponseHash };
  const r = await cl.get(`${c.base}/x`);
  assert.equal(r.status, 402);
  assert.match(new TextDecoder().decode(r.body), /budget is used up/);
  await mined(sessionContract(c.address, c.payer).topUp(c.session, PRICE), c.chain.provider);
  assert.equal((await cl.get(`${c.base}/x`)).status, 200);
});

test('closed, expired and foreign sessions are refused', async t => {
  const c = await setup(t);
  const cl = c.client();
  await c.chain.warp(86_401);
  c.clock.offset = 86_401;
  assert.equal((await cl.get(`${c.base}/a`)).status, 410);
  await mined(sessionContract(c.address, c.providerKey).close(c.session), c.chain.provider);
  await assert.rejects(c.meter.loadState(c.session, { force: true }), /closed/);
});

test('the client stops on a provider that lies', async t => {
  const c = await setup(t);
  const cl = c.client();
  const stranger = Wallet.createRandom();
  const wrapped = new SessionClient({
    signer: c.sessionKey, session: c.session, expect: c.expect, maxPrice: PRICE,
    fetch: async (u, init) => {
      const r = await fetch(u, init);
      if (r.status !== 200) return r;
      const rc = parseB64json(r.headers.get(HEADER_RESPONSE), 16_384);
      const body = new TextEncoder().encode('{"tampered":true}');
      return new Response(body, { status: 200, headers: { [HEADER_RESPONSE]: b64json({ ...rc, signature: await stranger.signMessage('x') }) } });
    },
  });
  await assert.rejects(wrapped.get(`${c.base}/a`), err => err instanceof SessionError && /stop signing/.test(err.message));
  assert.equal(wrapped.state.count, 0);
  const pricey = new SessionClient({ signer: c.sessionKey, session: c.session, expect: c.expect, maxPrice: PRICE - 1n });
  await assert.rejects(pricey.get(`${c.base}/a`), /above max/);
  const other = new SessionClient({ signer: c.sessionKey, session: c.session, expect: { ...c.expect, provider: Wallet.createRandom().address }, maxPrice: PRICE });
  await assert.rejects(other.get(`${c.base}/a`), /unexpected provider/);
});

test('metered() puts a price on an Express-style route', async t => {
  const c = await setup(t);
  const handler = metered(c.meter, { price: PRICE }, async req => ({ echo: req.url }));
  const server = http.createServer((req, res) => handler(req, res, e => { res.statusCode = 500; res.end(String(e)); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const bare = await fetch(`${base}/priced?a=1`);
  assert.equal(bare.status, 402);
  assert.ok(bare.headers.get(HEADER_REQUIRED));
  const cl = c.client();
  const r = await cl.get(`${base}/priced?a=1`);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body)), { echo: '/priced?a=1' });
});
