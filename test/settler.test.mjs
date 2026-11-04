// createSettler on a local anvil chain with the real MeterSession bytecode: when a batch is due, chain truth over the
// ledger, a bad voucher is set aside instead of sinking the batch, and concurrent ticks never send twice.
// The cross-VM path (one transaction to the runtime pallets address) is covered byte for byte in
// runtime-calls.test.mjs and was run on the Portaldot testnet (examples/paid-indexer/RUN.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, hexlify, randomBytes } from 'ethers';
import { startAnvil, deploy } from './helpers.mjs';
import { createMeter, MemoryLedger } from '../src/meter.mjs';
import { SessionClient } from '../src/session-client.mjs';
import { readSession, sessionContract, redeemCalldata, sessionIface } from '../src/session-chain.mjs';
import { sessionIdFor } from '../src/session.mjs';
import { createSettler } from '../src/settler.mjs';
import { sendTx, waitReceipt } from '../src/evm.mjs';

const PRICE = 10_000n;
const BUDGET = 1_000_000n;
const mined = async (tx, provider) => waitReceipt(provider, (await tx).hash, { timeoutMs: 20_000 });

async function setup(t, policy = { minRequests: 3, minGapSec: 0 }) {
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
  await mined(token.mint(payer.address, BUDGET), chain.provider);
  await mined(token.connect(payer).approve(address, BUDGET), chain.provider);
  await mined(settlement.connect(providerKey).registerEndpoint(payee, tokenAddress, PRICE, 600), chain.provider);
  const nonce = hexlify(randomBytes(32));
  const block = await chain.provider.getBlock('latest');
  await mined(sessionContract(address, payer).open(1, nonce, sessionKey.address, BUDGET, block.timestamp + 86_400), chain.provider);
  const session = sessionIdFor(chain.chainId, address, payer.address, 1, nonce).toLowerCase();
  const reader = sessionContract(address, chain.provider);
  const ledger = new MemoryLedger();
  const meter = createMeter({
    chainId: chain.chainId, sessionContract: address, endpointId: 1, wallet: providerKey, token: tokenAddress, tokenSymbol: 'tUSDm', decimals: 6,
    readSession: id => readSession(reader, id), ledger,
  });
  // the client talks to the meter directly: no HTTP server needed to make vouchers
  const client = new SessionClient({
    signer: sessionKey, session, maxPrice: PRICE,
    expect: { chainId: chain.chainId, sessionContract: address, provider: providerKey.address, token: tokenAddress },
    fetch: (url, init) => meter.charge(new Request(url, init), { price: PRICE }, async () => ({ ok: true })),
  });
  const settler = createSettler({
    ledger, wallet: new Wallet(providerKey.privateKey), rpc: chain.url, chainId: chain.chainId, sessionContract: address, endpointId: 1,
    policy, send: { polls: 200, pollMs: 25 },
  });
  const buy = async n => {
    for (let i = 0; i < n; i++) assert.equal((await client.get(`http://seller.test/v1/x/${i}`)).status, 200);
  };
  const redeemedEvents = async () => (await chain.provider.getLogs({ address, fromBlock: 0, toBlock: 'latest' }))
    .map(l => sessionIface.parseLog(l)).filter(e => e && e.name === 'Redeemed');
  return { chain, token, address, providerKey, payee, session, ledger, settler, buy, redeemedEvents, reader };
}

test('settles only when due, pays the payee exactly, and updates the ledger', async t => {
  const c = await setup(t);
  await c.buy(2);
  const early = await c.settler.tick();
  assert.equal(early.settled, false);
  assert.equal(early.reason, 'not due');
  assert.equal(await c.token.balanceOf(c.payee), 0n);

  await c.buy(1);
  const r = await c.settler.tick();
  assert.equal(r.settled, true, JSON.stringify(r));
  assert.equal(r.requests, 3);
  assert.match(r.tx, /^0x[0-9a-f]{64}$/);
  assert.equal(await c.token.balanceOf(c.payee), 3n * PRICE);
  const st = await c.ledger.get(c.session);
  assert.equal(st.redeemedCount, 3);
  assert.equal(st.redeemedCum, (3n * PRICE).toString());
  const ev = await c.redeemedEvents();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].args.head.toLowerCase(), st.head);

  // nothing left to settle: no transaction, even when forced
  assert.equal((await c.settler.tick()).settled, false);
  assert.equal((await c.settler.tick({ force: true })).reason, 'no session can be redeemed');
  assert.equal((await c.redeemedEvents()).length, 1);
  assert.equal((await c.settler.state.get()).batches, 1);
});

test('a voucher the contract would refuse is set aside, and only that one (positive control first)', async t => {
  const c = await setup(t);
  await c.buy(3);
  const good = structuredClone(await c.ledger.get(c.session));
  // the same row with a signature from a stranger: well-formed, but MeterSession.redeem reverts with BadSignature
  const forged = await Wallet.createRandom().signTypedData(
    { name: 'Portal Meter Session', version: '1', chainId: c.chain.chainId, verifyingContract: c.address },
    { Voucher: [{ name: 'session', type: 'bytes32' }, { name: 'cumulative', type: 'uint96' }, { name: 'count', type: 'uint32' }, { name: 'head', type: 'bytes32' }] },
    { session: good.lastVoucher.session, cumulative: BigInt(good.lastVoucher.cumulative), count: good.lastVoucher.count, head: good.lastVoucher.head },
  );
  await c.ledger.put(c.session, { ...good, lastVoucher: { ...good.lastVoucher, signature: forged } });
  const bad = await c.settler.tick({ force: true });
  assert.equal(bad.settled, false);
  assert.deepEqual(bad.stuck, [c.session]);
  assert.ok((await c.ledger.get(c.session)).stuck, 'the row is marked stuck');
  assert.equal((await c.redeemedEvents()).length, 0, 'nothing was sent');

  // the genuine voucher goes through the same path
  await c.ledger.put(c.session, good);
  const ok = await c.settler.tick({ force: true });
  assert.equal(ok.settled, true, JSON.stringify(ok));
  assert.equal(await c.token.balanceOf(c.payee), 3n * PRICE);
});

test('the chain is the truth: a batch that landed elsewhere is not sent again', async t => {
  const c = await setup(t);
  await c.buy(3);
  const v = (await c.ledger.get(c.session)).lastVoucher;
  // the provider redeemed this voucher, but the ledger never heard of it (a lost receipt, a crash, a second process)
  await sendTx(c.providerKey, { to: c.address, data: redeemCalldata(v.session, v.cumulative, v.count, v.head, v.signature) });
  const r = await c.settler.tick({ force: true });
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'no session can be redeemed');
  assert.equal((await c.ledger.get(c.session)).redeemedCount, 3, 'ledger caught up from the chain');
  assert.equal((await c.redeemedEvents()).length, 1);
});

test('concurrent ticks share one run and send one transaction', async t => {
  const c = await setup(t);
  await c.buy(3);
  const [a, b] = await Promise.all([c.settler.tick(), c.settler.tick()]);
  assert.equal(a.settled, true, JSON.stringify(a));
  assert.deepEqual(a, b);
  assert.equal((await c.redeemedEvents()).length, 1);
});

test('errors come back as data, and required options are checked', async t => {
  const c = await setup(t);
  await c.buy(3);
  const down = createSettler({
    ledger: c.ledger, wallet: Wallet.createRandom(), rpc: async () => { throw new Error('node unreachable'); }, chainId: 1, sessionContract: c.address, endpointId: 1,
  });
  const r = await down.tick({ force: true });
  assert.equal(r.settled, false);
  assert.match(r.error, /node unreachable/);
  assert.throws(() => createSettler({ ledger: c.ledger }), /wallet is required/);
});
