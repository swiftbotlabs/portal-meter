// End to end on a local anvil chain: real MeterSettlement + a test ERC-20, the HTTP seller, the buyer client
// and the verifier. The WASM registry is the in-memory twin (same rules as the ink! contract).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { startAnvil, deploy } from './helpers.mjs';
import { createSeller, RateLimiter } from '../src/seller.mjs';
import { buy, BuyError } from '../src/buyer.mjs';
import { verifyReceipt } from '../src/verify.mjs';
import { Store } from '../src/store.mjs';
import { EvmSettler } from '../src/settle.mjs';
import { MemoryRegistry } from '../src/registry.mjs';
import { makeRoutes } from '../src/routes.mjs';
import { NotFound, UpstreamError } from '../src/data.mjs';
import { b64json, parseB64json, VERSION, proofMessage, HEADER_PAYMENT, HEADER_RESPONSE } from '../src/protocol.mjs';
import { settlement as settlementContract, sendTx, readPayment, waitReceipt, STATUS } from '../src/evm.mjs';

const PRICE_ACCOUNT = 25_000n;
const PRICE_ASSET = 10_000n;

// a scripted upstream: deterministic data, an asset that does not exist, an asset whose lookup fails
function fakeUpstream() {
  return {
    trackedAssets: [7777],
    async head() { return { number: 271000, hash: '0x' + 'ab'.repeat(32) }; },
    async account() { return { nonce: 3, free: '1000000000000000', reserved: '0', frozen: '0' }; },
    async evmAccount() { return { balanceWei: '0', nonce: 0, codeBytes: 0 }; },
    async mappedOriginal() { return null; },
    async assetBalance() { return '42'; },
    async asset(id) {
      if (id === 404) return null;
      if (id === 502) throw new UpstreamError('node timed out');
      return { owner: '5D', supply: '100', accounts: 1, minBalance: '1', status: 'Live', name: 'Test', symbol: 'TST', decimals: 6 };
    },
    async erc20TotalSupply() { return '100'; },
  };
}

const mined = async (tx, provider) => waitReceipt(provider, (await tx).hash, { timeoutMs: 20_000 });

async function setup(t, { settlerOverride } = {}) {
  const chain = await startAnvil();
  t.after(() => chain.stop());
  const deployer = await chain.wallet();
  const providerKey = await chain.wallet();
  const buyerKey = await chain.wallet();
  const payee = Wallet.createRandom().address;
  const token = await deploy(deployer, 'Mocks.sol', 'MockERC20', ['Meter Test USD', 'tUSDm', 6]);
  const s = await deploy(deployer, 'MeterSettlement.sol', 'MeterSettlement');
  const settlementAddress = await s.getAddress();
  const tokenAddress = await token.getAddress();
  await mined(token.mint(buyerKey.address, 1_000_000n), chain.provider);
  const asProvider = s.connect(providerKey);
  await mined(asProvider.registerEndpoint(payee, tokenAddress, PRICE_ACCOUNT, 600), chain.provider);
  await mined(asProvider.registerEndpoint(payee, tokenAddress, PRICE_ASSET, 600), chain.provider);

  const registry = new MemoryRegistry({ settlement: settlementAddress, chainId: chain.chainId });
  registry.registerEndpoint(providerKey.address, 1, 'http://127.0.0.1/v1/account/{address}');
  registry.registerEndpoint(providerKey.address, 2, 'http://127.0.0.1/v1/asset/{id}');
  const store = new Store(null);
  const settler = settlerOverride ? settlerOverride({ providerKey, settlementAddress, registry }) : new EvmSettler({ wallet: providerKey, settlementAddress, registry });
  const server = createSeller({
    chain: { chainId: chain.chainId, settlementAddress, settlement: settlementContract(settlementAddress, chain.provider) },
    provider: providerKey.address,
    signer: providerKey,
    settler,
    store,
    registry: { kind: 'memory', address: null },
    routes: makeRoutes({
      upstream: fakeUpstream(), token: tokenAddress, tokenSymbol: 'tUSDm', decimals: 6,
      endpoints: { account: { id: 1, price: PRICE_ACCOUNT }, asset: { id: 2, price: PRICE_ASSET } },
    }),
    quoteLimiter: new RateLimiter({ limit: 25, windowSec: 60 }),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = { wallet: buyerKey, expect: { chainId: chain.chainId, settlement: settlementAddress, token: tokenAddress }, maxPrice: 50_000n, registry };
  return { chain, s, token, tokenAddress, settlementAddress, providerKey, buyerKey, payee, registry, store, base, opts };
}

test('paid request: served once, settled to the payee, receipt ACCEPTed, anchored', async t => {
  const e = await setup(t);
  const url = `${e.base}/v1/account/5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC`;
  const r = await buy(url, e.opts);
  assert.equal(r.status, 200, r.body.toString());
  const data = JSON.parse(r.body.toString());
  assert.equal(data.evm.address.toLowerCase(), '0x299b95378937b7735dd0b11f3446c01fd00281bf');
  assert.equal(r.receipt.outcome, 'served');
  assert.equal(await e.token.balanceOf(e.payee), PRICE_ACCOUNT);
  assert.equal(await e.token.balanceOf(e.settlementAddress), 0n);

  const v = await verifyReceipt(r.receipt, { evm: e.chain.provider, expect: { chainId: e.chain.chainId, settlement: e.settlementAddress }, body: r.body, registry: e.registry });
  assert.equal(v.verdict, 'ACCEPT', JSON.stringify(v.checks, null, 1));
  assert.ok(v.checks.filter(c => c.ok === true).length >= 14);

  // replay the same proof: the request id is spent
  const proof = { v: VERSION, requestId: r.requestId, nonce: r.quote.nonce, payer: e.buyerKey.address, signature: await e.buyerKey.signMessage(proofMessage(r.requestId, r.quote.requestHash)) };
  const again = await fetch(url, { headers: { [HEADER_PAYMENT]: b64json(proof) } });
  assert.equal(again.status, 409);

  // the ink! twin knows the outcome; the buyer can confirm it once
  const rep = await e.registry.reputation(e.providerKey.address, 1);
  assert.equal(rep.served, 1);
  e.registry.rate(e.buyerKey.address, { provider: e.providerKey.address, endpointId: 1, nonce: r.quote.nonce, ok: true });
  assert.equal((await e.registry.reputation(e.providerKey.address, 1)).confirmed, 1);
});

test('undeliverable request is refunded on-chain and the refund receipt verifies', async t => {
  const e = await setup(t);
  const before = await e.token.balanceOf(e.buyerKey.address);
  const r = await buy(`${e.base}/v1/asset/404`, e.opts);
  assert.equal(r.status, 404);
  assert.equal(r.receipt.outcome, 'refunded');
  assert.equal(r.receipt.refundReason, 3);
  assert.equal(await e.token.balanceOf(e.buyerKey.address), before);
  const pay = await readPayment(e.s, r.requestId);
  assert.equal(pay.status, STATUS.REFUNDED);
  const v = await verifyReceipt(r.receipt, { evm: e.chain.provider, expect: { chainId: e.chain.chainId, settlement: e.settlementAddress }, registry: e.registry });
  assert.equal(v.verdict, 'ACCEPT', JSON.stringify(v.checks, null, 1));
  assert.equal((await e.registry.reputation(e.providerKey.address, 2)).refunded, 1);

  const up = await buy(`${e.base}/v1/asset/502`, e.opts); // upstream failure: refund reason 1
  assert.equal(up.status, 502);
  assert.equal(up.receipt.refundReason, 1);
});

test('tampered receipts and bodies are REJECTed', async t => {
  const e = await setup(t);
  const r = await buy(`${e.base}/v1/asset/7`, e.opts);
  assert.equal(r.status, 200);
  const vopts = { evm: e.chain.provider, expect: { chainId: e.chain.chainId, settlement: e.settlementAddress }, registry: e.registry };
  const failed = async (receipt, body) => (await verifyReceipt(receipt, { ...vopts, body })).checks.filter(c => c.ok === false).map(c => c.name);
  assert.deepEqual(await failed(r.receipt, Buffer.from('{"forged":true}')), ['response body hash']);
  assert.ok((await failed({ ...r.receipt, amount: '1' }, r.body)).includes('provider signature'));
  const other = Wallet.createRandom();
  const { signature, ...rest } = r.receipt; // eslint-disable-line no-unused-vars
  const { receiptMessage } = await import('../src/protocol.mjs');
  const forged = { ...rest, signature: await other.signMessage(receiptMessage(rest)) };
  assert.ok((await failed(forged, r.body)).includes('provider signature'));
  assert.equal((await verifyReceipt({ ...r.receipt, network: 'eip155:1' }, vopts)).verdict, 'REJECT');
  assert.equal((await verifyReceipt({ nonsense: 1 }, vopts)).verdict, 'REJECT');
});

test('a proof signed by someone else, or replayed on another resource, is refused', async t => {
  const e = await setup(t);
  // buyer pays for asset 1, then a thief (who saw the tx) tries to use the payment
  const url = `${e.base}/v1/asset/1`;
  const q = parseB64json((await fetch(url)).headers.get('payment-required'));
  const tokenAsBuyer = e.token.connect(e.buyerKey);
  await mined(tokenAsBuyer.approve(e.settlementAddress, 10n ** 9n), e.chain.provider);
  await sendTx(e.buyerKey, { to: e.settlementAddress, data: e.s.interface.encodeFunctionData('pay', [q.endpointId, q.nonce, PRICE_ASSET]) });
  const rid = await e.s.requestIdFor(e.buyerKey.address, q.endpointId, q.nonce);
  const thief = Wallet.createRandom();
  const stolen = { v: VERSION, requestId: rid.toLowerCase(), nonce: q.nonce, payer: e.buyerKey.address, signature: await thief.signMessage(proofMessage(rid, q.requestHash)) };
  assert.equal((await fetch(url, { headers: { [HEADER_PAYMENT]: b64json(stolen) } })).status, 401);
  // the real payer's proof on a different resource of the same endpoint
  const proof = { ...stolen, signature: await e.buyerKey.signMessage(proofMessage(rid, q.requestHash)) };
  assert.equal((await fetch(`${e.base}/v1/asset/2`, { headers: { [HEADER_PAYMENT]: b64json(proof) } })).status, 409);
  // unknown nonce
  assert.equal((await fetch(url, { headers: { [HEADER_PAYMENT]: b64json({ ...proof, nonce: '0x' + '12'.repeat(32) }) } })).status, 409);
  // garbage header
  assert.equal((await fetch(url, { headers: { [HEADER_PAYMENT]: 'x'.repeat(10) } })).status, 400);
  // and the genuine one still works
  const ok = await fetch(url, { headers: { [HEADER_PAYMENT]: b64json(proof) } });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get(HEADER_RESPONSE));
});

test('proof before payment gets 402 not-yet; buyer limits stop payment early; bad input is free', async t => {
  const e = await setup(t);
  const url = `${e.base}/v1/asset/9`;
  const q = parseB64json((await fetch(url)).headers.get('payment-required'));
  const rid = await e.s.requestIdFor(e.buyerKey.address, q.endpointId, q.nonce);
  const early = { v: VERSION, requestId: rid.toLowerCase(), nonce: q.nonce, payer: e.buyerKey.address, signature: await e.buyerKey.signMessage(proofMessage(rid, q.requestHash)) };
  assert.equal((await fetch(url, { headers: { [HEADER_PAYMENT]: b64json(early) } })).status, 402);

  const nonceBefore = await e.chain.provider.getTransactionCount(e.buyerKey.address);
  await assert.rejects(buy(url, { ...e.opts, maxPrice: 1n }), BuyError);
  await assert.rejects(buy(url, { ...e.opts, expect: { ...e.opts.expect, settlement: Wallet.createRandom().address } }), BuyError);
  assert.equal(await e.chain.provider.getTransactionCount(e.buyerKey.address), nonceBefore, 'no transaction was sent');

  for (const bad of ['/v1/account/not-an-address', '/v1/account/5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdD', '/v1/account/%E0%A4%A', '/v1/asset/99999999999']) {
    const res = await fetch(e.base + bad);
    assert.ok([400, 404].includes(res.status), `${bad} -> ${res.status}`);
    assert.equal(res.headers.get('payment-required'), null);
  }
  assert.equal((await fetch(e.base + '/v1/asset/1', { method: 'POST', body: 'x' })).status, 405);
  assert.equal((await fetch(e.base + '/health')).status, 200);
});

test('quote flood is rate limited', async t => {
  const e = await setup(t);
  let limited = 0;
  for (let i = 0; i < 30; i++) if ((await fetch(`${e.base}/v1/asset/1`)).status === 429) limited++;
  assert.ok(limited >= 5);
});

test('if settlement fails nothing is delivered and the payer can reclaim after the delay', async t => {
  const failing = () => ({ mode: 'evm', async settle() { throw new Error('rpc down'); }, async refund() { throw new Error('rpc down'); } });
  const e = await setup(t, { settlerOverride: failing });
  const r = await buy(`${e.base}/v1/asset/1`, e.opts);
  assert.equal(r.status, 503);
  assert.equal(r.receipt, null);
  assert.equal(JSON.parse(r.body).requestId, r.requestId);
  assert.equal(e.store.request(r.requestId).state, 'settle_failed');
  await e.chain.warp(601);
  const before = await e.token.balanceOf(e.buyerKey.address);
  await sendTx(e.buyerKey, { to: e.settlementAddress, data: e.s.interface.encodeFunctionData('refund', [r.requestId, 2]) });
  assert.equal(await e.token.balanceOf(e.buyerKey.address), before + PRICE_ASSET);
});
