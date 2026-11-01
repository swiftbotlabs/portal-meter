#!/usr/bin/env node
// Sessions on the PortaldotV3 testnet, resumable step by step.
//
//   node scripts/deploy-sessions.mjs --keys <0600 env> --hosted <0600 env> [--plan] [--only step,step]
//
// Steps (each is recorded in deployments/sessions.partial.json and skipped once done):
//   fund      sr25519 account -> tPOT to the deployer, the hosted provider and the buyer EVM keys
//   swap      sr25519 account -> native exchange tPOT -> pUSD (asset 7777, Portaldot's own test dollar), sent to the buyer
//   deploy    MeterSession from the deployer key, pointing at the existing MeterSettlement
//   endpoint  ONE Ethereum transaction from the hosted provider: register the public data API in Solidity
//             and list its URL in the ink! registry
//   approve   buyer approves MeterSession on the pUSD ERC-20 precompile
//   demo      buyer opens the public demo session; its signer is a key derived from a public string
//   publish   write deployments/sessions.json
//
// Keys are read from the env files and never printed. Only public data goes to deployments/.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { Wallet, ContractFactory, hexlify, randomBytes, keccak256, toUtf8Bytes, formatEther } from 'ethers';
import { NETWORK, PATHS, loadDeployment, precompileAddress } from '../src/config.mjs';
import { makeProvider, sendTx, settlementIface, settlement as settlementContract, erc20 } from '../src/evm.mjs';
import { sessionIface } from '../src/session-chain.mjs';
import { sessionIdFor } from '../src/session.mjs';
import { RUNTIME_PALLETS_ADDRESS } from '../src/session-settle.mjs';
import { CALLS_SPEC_3002 as CALLS, batchAll, contractsCall, reviveCall } from '../src/runtime-calls.mjs';
import { twinSs58 } from '../src/xvm.mjs';
import { readKeyFile, submit } from './lib/sub.mjs';

const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const KEYS = opt('--keys');
const HOSTED = opt('--hosted');
const PLAN = args.includes('--plan');
const ONLY = (opt('--only') || '').split(',').filter(Boolean);
if (!KEYS || !HOSTED) {
  console.error('usage: deploy-sessions.mjs --keys <env file> --hosted <env file> [--plan] [--only step,...]');
  process.exit(2);
}

const TPOT = 10n ** 14n;
const PUSD = 7777;
const PUSD_DECIMALS = 6;
export const DEMO_KEY_SEED = 'portal-meter/public-demo-session-key/1';
const PRICE = 10_000n; // 0.01 pUSD
const DEMO_BUDGET = 2_500_000n; // 2.5 pUSD = 250 requests
const BENCH_BUDGET = 1_500_000n; // 1.5 pUSD = 150 requests
const SWAP_IN = 5n * TPOT;
const FUND = { deployer: 320n * TPOT, hosted: 120n * TPOT, buyer: 30n * TPOT };
const PUBLIC_URL = 'https://portal-meter.swiftbotlab.workers.dev';

const PART = join(PATHS.root, 'deployments', 'sessions.partial.json');
const FINAL = join(PATHS.root, 'deployments', 'sessions.json');
const state = existsSync(PART) ? JSON.parse(readFileSync(PART, 'utf8')) : { transactions: [] };
const save = () => writeFileSync(PART, JSON.stringify(state, null, 2) + '\n');
const note = (label, layer, hash, block, extra = {}) => {
  state.transactions.push({ label, layer, hash, block, ...extra });
  save();
  console.log(`  ${label}: block ${block} ${hash}`);
};
const want = s => (ONLY.length ? ONLY.includes(s) : !(state.done || []).includes(s));
const done = s => {
  state.done = [...new Set([...(state.done || []), s])];
  save();
};

const d = loadDeployment();
const k = readKeyFile(KEYS);
const h = readKeyFile(HOSTED);
const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const deployer = new Wallet(k.PORTALDOT_EVM_DEPLOYER_KEY, evm);
const buyer = new Wallet(k.PORTALDOT_EVM_BUYER_KEY, evm);
const hosted = new Wallet(h.PORTALDOT_EVM_HOSTED_KEY, evm);
const pusd = precompileAddress(PUSD);
const payee = deployer.address;

if (PLAN) {
  console.log('deployer', deployer.address, 'hosted', hosted.address, 'buyer', buyer.address);
  console.log('steps left:', ['fund', 'swap', 'deploy', 'endpoint', 'approve', 'demo', 'publish'].filter(want).join(' '));
  console.log('fund', Object.entries(FUND).map(([n, v]) => `${n} ${v / TPOT} tPOT`).join(', '), `swap ${SWAP_IN / TPOT} tPOT`);
  process.exit(0);
}

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(NETWORK.substrateWs), noInitWarn: true });
const sub = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(k.PORTALDOT_SUB_MNEMONIC);
const logBal = async () => {
  const a = await api.query.system.account(sub.address);
  console.log(`sr25519 free ${(Number(a.data.free.toBigInt()) / 1e14).toFixed(4)} tPOT`);
};

try {
  await logBal();
  if (want('fund')) {
    const tx = api.tx.utility.batchAll([
      api.tx.balances.transferKeepAlive(twinSs58(deployer.address), FUND.deployer),
      api.tx.balances.transferKeepAlive(twinSs58(hosted.address), FUND.hosted),
      api.tx.balances.transferKeepAlive(twinSs58(buyer.address), FUND.buyer),
    ]);
    const r = await submit(api, sub, tx);
    note('fund the deployer, hosted provider and buyer keys', 'substrate', r.hash, r.block);
    done('fund');
  }
  if (want('swap')) {
    const path = [{ Native: null }, { WithId: PUSD }];
    const quote = await api.call.assetConversionApi.quotePriceExactTokensForTokens({ Native: null }, { WithId: PUSD }, SWAP_IN, true);
    const out = BigInt(quote.toString());
    console.log(`  quote: ${SWAP_IN / TPOT} tPOT -> ${Number(out) / 10 ** PUSD_DECIMALS} pUSD`);
    const r = await submit(api, sub, api.tx.assetConversion.swapExactTokensForTokens(path, SWAP_IN, (out * 97n) / 100n, twinSs58(buyer.address), true));
    note(`swap ${SWAP_IN / TPOT} tPOT to pUSD on the native exchange, sent to the buyer`, 'substrate', r.hash, r.block);
    done('swap');
  }
  if (want('deploy')) {
    const a = JSON.parse(readFileSync(join(PATHS.root, 'contracts', 'evm', 'out', 'MeterSession.sol', 'MeterSession.json'), 'utf8'));
    const f = new ContractFactory(a.abi, a.bytecode.object, deployer);
    const dtx = await f.getDeployTransaction(d.settlement);
    const before = await evm.getBalance(deployer.address);
    const r = await sendTx(deployer, { data: dtx.data });
    state.sessionContract = r.contractAddress;
    state.deployCostTpot = formatEther(before - (await evm.getBalance(deployer.address)));
    note('deploy MeterSession', 'evm', r.hash, r.blockNumber, { address: r.contractAddress, costTpot: state.deployCostTpot });
    done('deploy');
  }
  if (want('endpoint')) {
    const s = settlementContract(d.settlement, evm);
    const id = Number(await s.endpointCount()) + 1;
    const uri = `${PUBLIC_URL}/v1/`;
    const w = { refTime: 6_000_000_000n, proofSize: 200_000n };
    const reg = reviveCall(CALLS, {
      dest: d.settlement, weight: w, depositLimit: 40n * TPOT,
      data: settlementIface.encodeFunctionData('registerEndpoint', [payee, pusd, PRICE, 600]),
    });
    const list = contractsCall(CALLS, {
      dest: d.registry.accountId, weight: { refTime: 8_000_000_000n, proofSize: 300_000n },
      data: registerEndpointData(id, uri),
    });
    const r = await sendTx(hosted, { to: RUNTIME_PALLETS_ADDRESS, data: batchAll(CALLS, [reg, list]), value: 0n });
    const ep = await s.endpoint(id);
    if (ep[0].toLowerCase() !== hosted.address.toLowerCase()) throw new Error('endpoint not registered by the hosted key');
    state.endpoint = { id, uri, price: PRICE.toString(), provider: hosted.address, payee, token: pusd };
    note('hosted provider: register the public data API in Solidity + list its URL in ink!, one Ethereum tx', 'evm -> substrate', r.hash, r.blockNumber);
    done('endpoint');
  }
  if (want('approve')) {
    const t = erc20(pusd, buyer);
    const bal = await t.balanceOf(buyer.address);
    console.log(`  buyer pUSD ${Number(bal) / 1e6}`);
    const r = await sendTx(buyer, { to: pusd, data: t.interface.encodeFunctionData('approve', [state.sessionContract, DEMO_BUDGET + 4n * BENCH_BUDGET]) });
    note('buyer: approve MeterSession on the pUSD precompile', 'evm', r.hash, r.blockNumber);
    done('approve');
  }
  if (want('demo')) {
    const before = await evm.getBalance(buyer.address);
    const demoKey = new Wallet(keccak256(toUtf8Bytes(DEMO_KEY_SEED)));
    const nonce = hexlify(randomBytes(32));
    const latest = await evm.getBlock('latest');
    const expiresAt = latest.timestamp + 20 * 86_400;
    const r = await sendTx(buyer, { to: state.sessionContract, data: sessionIface.encodeFunctionData('open', [state.endpoint.id, nonce, demoKey.address, DEMO_BUDGET, expiresAt]) });
    state.demoSession = {
      id: sessionIdFor(NETWORK.chainId, state.sessionContract, buyer.address, state.endpoint.id, nonce).toLowerCase(),
      payer: buyer.address, signer: demoKey.address, nonce, budget: DEMO_BUDGET.toString(), expiresAt, seed: DEMO_KEY_SEED,
      openCostTpot: formatEther(before - (await evm.getBalance(buyer.address))),
    };
    note('buyer: open the public demo session', 'evm', r.hash, r.blockNumber, { costTpot: state.demoSession.openCostTpot });
    done('demo');
  }
  if (want('publish')) {
    const out = {
      chainId: NETWORK.chainId, sessionContract: state.sessionContract, settlement: d.settlement, registry: d.registry.address,
      registryAccountId: d.registry.accountId, endpoint: state.endpoint, token: { assetId: PUSD, symbol: 'pUSD', decimals: PUSD_DECIMALS, precompile: pusd },
      hostedSeller: PUBLIC_URL, demoSession: state.demoSession, calls: CALLS, transactions: state.transactions, publishedAt: new Date().toISOString(),
    };
    writeFileSync(FINAL, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${FINAL}`);
    done('publish');
  }
  await logBal();
} finally {
  await api.disconnect();
}

/** Input of the ink! message MeterRegistry.register_endpoint(endpoint_id, uri). */
function registerEndpointData(id, uri) {
  const u = new TextEncoder().encode(uri);
  if (u.length > 96 || u.length > 63) throw new Error('uri too long for this one-byte compact');
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, id, true);
  return hexlify(new Uint8Array([0x82, 0x07, 0x9a, 0xd5, ...le, u.length << 2, ...u]));
}
