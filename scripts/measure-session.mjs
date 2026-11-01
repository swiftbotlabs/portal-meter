#!/usr/bin/env node
// Measures what a session costs on the PortaldotV3 testnet, against the hosted seller, and writes the numbers to
// deployments/proof/session-measure.json. The buyer key here is ours: this is a measurement, not user traffic.
//
//   node scripts/measure-session.mjs --keys <0600 env> --hosted <0600 env> [--a 100] [--b 20]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, formatEther, hexlify, id as topicOf, randomBytes } from 'ethers';
import { NETWORK, PATHS } from '../src/config.mjs';
import { erc20, makeProvider, sendTx } from '../src/evm.mjs';
import { sessionContract, sessionIface } from '../src/session-chain.mjs';
import { sessionIdFor, verifyLog } from '../src/session.mjs';
import { SessionClient } from '../src/session-client.mjs';
import { readKeyFile } from './lib/sub.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const k = readKeyFile(opt('--keys'));
const h = readKeyFile(opt('--hosted'));
const N_A = Number(opt('--a', '100'));
const N_B = Number(opt('--b', '20'));
const PAUSE_MS = 2200; // the seller allows 30 paid requests a minute per address
const LIFE_SEC = 3300; // short on purpose: the payer closes these sessions afterwards, once expiry and the grace period have passed

const s = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'sessions.json'), 'utf8'));
const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const buyer = new Wallet(k.PORTALDOT_EVM_BUYER_KEY, evm);
const provider = new Wallet(h.PORTALDOT_EVM_HOSTED_KEY, evm);
const pusd = erc20(s.token.precompile, evm);
const price = BigInt(s.endpoint.price);
const base = s.hostedSeller;
const tpot = async a => evm.getBalance(a);
const delta = (x, y) => Number(formatEther(y - x));
const FILE = join(PATHS.root, 'deployments', 'proof', 'session-measure.json');
const out = { startedAt: new Date().toISOString(), price: price.toString(), steps: [] };
const log = (step, o) => {
  out.steps.push({ step, ...o });
  console.log(step, JSON.stringify(o));
};

async function open(n) {
  const key = Wallet.createRandom();
  const nonce = hexlify(randomBytes(32));
  const latest = await evm.getBlock('latest');
  const before = await tpot(buyer.address);
  const budget = [(BigInt(n) + 1n) * price, 250_000n].reduce((a, b) => (a > b ? a : b)); // the seller's minimum budget
  const expiresAt = latest.timestamp + LIFE_SEC;
  const r = await sendTx(buyer, { to: s.sessionContract, data: sessionIface.encodeFunctionData('open', [s.endpoint.id, nonce, key.address, budget, expiresAt]) });
  const id = sessionIdFor(NETWORK.chainId, s.sessionContract, buyer.address, s.endpoint.id, nonce).toLowerCase();
  log('open', { session: id, requests: n, budget: budget.toString(), expiresAt, tx: r.hash, block: r.blockNumber, buyerTpot: delta(before, await tpot(buyer.address)) });
  return { id, key, n };
}

async function run(sess) {
  const client = new SessionClient({ signer: sess.key, session: sess.id, maxPrice: price, expect: { chainId: NETWORK.chainId, sessionContract: s.sessionContract, provider: s.endpoint.provider, token: s.token.precompile } });
  const paths = ['/v1/asset/7777', '/v1/asset/43907', `/v1/account/${s.demoSession.payer}`];
  const t0 = Date.now();
  let done = 0;
  while (done < sess.n) {
    let status = 0;
    try {
      const r = await client.get(base + paths[done % paths.length]);
      status = r.status;
      if (r.status === 200) done += 1;
      else console.log('retry', r.status);
    } catch (e) {
      console.log('network', e.message); // the home line drops now and then: pick the session up where the seller has it
      await new Promise(res => setTimeout(res, 15_000));
      const view = await fetch(`${base}/v1/session/${sess.id}`).then(r => r.json()).catch(() => null);
      if (view && client.resume(view)) done += 1;
      continue;
    }
    await new Promise(res => setTimeout(res, status === 429 ? 30_000 : PAUSE_MS));
  }
  log('requests', { session: sess.id, requests: done, seconds: Math.round((Date.now() - t0) / 1000), onChainTransactions: 0 });
}

if (args.includes('--close')) {
  // run once the sessions have expired and the grace period has passed: the payer takes back the rest and its deposits
  const m = JSON.parse(readFileSync(FILE, 'utf8'));
  const asBuyer = sessionContract(s.sessionContract, buyer);
  const before = await tpot(buyer.address);
  const usdBefore = await pusd.balanceOf(buyer.address);
  for (const id of m.toClose) {
    const r = await sendTx(buyer, { to: s.sessionContract, data: asBuyer.interface.encodeFunctionData('close', [id]) });
    m.steps.push({ step: 'close', session: id, tx: r.hash, block: r.blockNumber });
  }
  m.steps.push({ step: 'closed', buyerTpot: delta(before, await tpot(buyer.address)), pusdReturned: (await pusd.balanceOf(buyer.address) - usdBefore).toString() });
  writeFileSync(FILE, JSON.stringify(m, null, 2) + '\n');
  console.log(JSON.stringify(m.steps.at(-1)));
  process.exit(0);
}

const payeeBefore = await pusd.balanceOf(s.endpoint.payee);
const sessions = [await open(N_A), await open(N_B)];
for (const x of sessions) await run(x);

const before = await tpot(provider.address);
const res = await fetch(`${base}/admin/settle`, { method: 'POST', headers: { authorization: `Bearer ${h.PORTALDOT_HOSTED_ADMIN_TOKEN}` } }).then(r => r.json());
if (!res.settled) throw new Error(`settle failed: ${res.error}`);
const costSettle = delta(before, await tpot(provider.address));
log('settle', { tx: res.tx, block: res.block, requests: res.requests, providerTpot: costSettle });

const topic = topicOf('Redeemed(bytes32,uint32,bytes32,uint96,uint96,uint32)');
for (const x of sessions) {
  const logs = await evm.getLogs({ address: s.sessionContract, topics: [topic, x.id], fromBlock: res.block, toBlock: res.block });
  const rows = (await fetch(`${base}/v1/session/${x.id}/log`).then(r => r.json())).rows;
  const redemptions = logs.map(l => sessionIface.parseLog(l)).map(p => ({ head: p.args.head, count: Number(p.args.count) }));
  const v = verifyLog(x.id, rows, redemptions);
  log('verify', { session: x.id, rows: rows.length, redemptions: redemptions.length, ok: v.ok });
  if (!v.ok) throw new Error('log does not match the chain');
}
log('payee', { pusdReceived: (await pusd.balanceOf(s.endpoint.payee) - payeeBefore).toString() });

out.toClose = sessions.map(x => x.id);
out.closableAt = (await evm.getBlock('latest')).timestamp + LIFE_SEC + 900;
out.finishedAt = new Date().toISOString();
writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
console.log('written');
