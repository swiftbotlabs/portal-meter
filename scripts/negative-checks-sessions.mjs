#!/usr/bin/env node
// Bad vouchers against the hosted seller and dry-runs against the live MeterSession: all must be refused, and nothing may
// change. No key needed: the only key used is the public demo key. Results: deployments/proof/session-negative-checks.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { NETWORK, PATHS } from '../src/config.mjs';
import { b64json, requestHash } from '../src/protocol.mjs';
import { HEADER_VOUCHER, nextHead, signVoucher } from '../src/session.mjs';
import { redeemCalldata, sessionIface } from '../src/session-chain.mjs';

const s = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'sessions.json'), 'utf8'));
const base = s.hostedSeller;
const demo = s.demoSession;
const key = new Wallet(keccak256(toUtf8Bytes(demo.seed)));
const chain = NETWORK.chainId;
const view = () => fetch(`${base}/v1/session/${demo.id}`).then(r => r.json());
const v0 = await view();
const url = new URL(`${base}/v1/asset/7777`);
const reqHash = requestHash('GET', url.pathname, url.searchParams);
const good = { session: demo.id, cumulative: BigInt(v0.cumulative) + BigInt(s.endpoint.price), count: v0.count + 1, head: nextHead(v0.head, reqHash, v0.lastResponseHash) };
const results = [];
const expect = (name, got, want) => {
  const ok = want.includes(got);
  results.push({ name, got, ok });
  console.log(`${ok ? 'REFUSED' : 'ACCEPTED'}  ${name}: ${got}`);
};

async function seller(name, v, signer = key, mutate = x => x, want = [400, 401, 402, 404, 409]) {
  const voucher = mutate(await signVoucher(signer, chain, s.sessionContract, v));
  const r = await fetch(url, { headers: { [HEADER_VOUCHER]: b64json(voucher) } });
  expect(`seller: ${name}`, r.status, want);
}

await seller('underpays by one base unit', { ...good, cumulative: good.cumulative - 1n });
await seller('skips a step', { ...good, count: good.count + 1 });
await seller('replays step 1', { ...good, count: 1 });
await seller('head that does not extend the chain', { ...good, head: keccak256('0x02') });
await seller('signed by a stranger', good, Wallet.createRandom());
await seller('v byte that ethers accepts and ecrecover does not', good, key, x => ({ ...x, signature: x.signature.slice(0, -2) + (parseInt(x.signature.slice(-2), 16) - 27).toString(16).padStart(2, '0') }));
await seller('session that does not exist', { ...good, session: '0x' + '77'.repeat(32) });
await seller('more than the budget', { ...good, cumulative: BigInt(demo.budget) + 1n });
expect('seller: header that is not base64', (await fetch(url, { headers: { [HEADER_VOUCHER]: '!!!' } })).status, [400]);
expect('seller: oversized header', (await fetch(url, { headers: { [HEADER_VOUCHER]: 'A'.repeat(5000) } })).status, [400, 431]);
expect('seller: asset id that is not a number, free', (await fetch(`${base}/v1/asset/abc`)).status, [400]);
expect('seller: address with a bad checksum, free', (await fetch(`${base}/v1/account/5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdD`)).status, [400]);
expect('seller: settlement trigger without the token', (await fetch(`${base}/admin/settle`, { method: 'POST' })).status, [404]);
expect('seller: internal route from outside', (await fetch(`${base}/internal/tick`)).status, [404]);

// the live contract, as eth_call dry-runs from the provider's address
async function contract(name, data, wantError, from = s.endpoint.provider) {
  const r = await fetch(NETWORK.evmRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to: s.sessionContract, data }, 'latest'] }) }).then(x => x.json());
  let got = 'no revert';
  if (r.error) {
    try {
      got = sessionIface.parseError(r.error.data)?.name ?? 'reverted';
    } catch {
      got = 'reverted';
    }
  }
  expect(`contract: ${name}`, got, [wantError]);
}

const v = await signVoucher(key, chain, s.sessionContract, good);
const redeem = x => redeemCalldata(x.session, x.cumulative, x.count, x.head, x.signature);
await contract('redeem from a stranger', redeem(v), 'NotAllowed', s.demoSession.payer);
await contract('tampered amount', redeem({ ...v, cumulative: good.cumulative + 1n }), 'BadSignature');
const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const sHex = (n - BigInt('0x' + v.signature.slice(66, 130))).toString(16).padStart(64, '0');
const flip = v.signature.slice(-2) === '1b' ? '1c' : '1b';
await contract('malleated signature', redeem({ ...v, signature: v.signature.slice(0, 66) + sHex + flip }), 'BadSignature');
const over = await signVoucher(key, chain, s.sessionContract, { ...good, cumulative: BigInt(demo.budget) + 1n, count: 999_999 });
await contract('over budget', redeem(over), 'OverBudget');
await contract('close before expiry', sessionIface.encodeFunctionData('close', [demo.id]), 'TooEarly', demo.payer);
await contract('close by the provider', sessionIface.encodeFunctionData('close', [demo.id]), 'NotAllowed');
await contract('session that does not exist', sessionIface.encodeFunctionData('close', ['0x' + '77'.repeat(32)]), 'NoSession', demo.payer);

const v1 = await view();
expect('session unchanged afterwards', v1.count === v0.count && v1.cumulative === v0.cumulative, [true]);
const refused = results.filter(r => r.ok).length;
console.log(`${refused}/${results.length} as expected`);
writeFileSync(join(PATHS.root, 'deployments', 'proof', 'session-negative-checks.json'), JSON.stringify({ at: new Date().toISOString(), block: await fetch(NETWORK.evmRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then(r => r.json()).then(j => parseInt(j.result, 16)), results }, null, 2) + '\n');
process.exit(refused === results.length ? 0 : 1);
