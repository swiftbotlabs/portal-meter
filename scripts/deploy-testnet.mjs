#!/usr/bin/env node
// End-to-end PortaldotV3 testnet deployment and live demo, resumable step by step.
//
//   node scripts/deploy-testnet.mjs --keys <0600 env file> [--plan] [--only step,step]
//
// Steps (each records its result in deployments/testnet.partial.json and is skipped once done):
//   fund       sr25519 account -> tPOT to the deployer, provider and buyer EVM keys (their twin accounts)
//   asset      create the native test asset "tUSDm" (pallet-assets), metadata, mint to the buyer
//   evm        deploy MeterSettlement from the deployer EVM key
//   ink        instantiate the ink! MeterRegistry (pallet-contracts) from the sr25519 account
//   endpoints  ONE Ethereum transaction from the provider key: register 2 endpoints in Solidity AND list
//              them in the ink! registry (utility.batchAll through the runtime pallets address)
//   demo       run the seller locally; the buyer pays one served request and one that gets refunded;
//              the seller settles/refunds + anchors in ink! in one cross-VM transaction each; both receipts
//              are verified; the buyer confirms the served one in the ink! registry from its EVM key
//   publish    write deployments/testnet.json (+ receipts) for the README and the live page
//
// Keys come from the env file (PORTALDOT_SUB_MNEMONIC, PORTALDOT_EVM_{DEPLOYER,PROVIDER,BUYER}_KEY) and are
// never printed. Only public data is written to deployments/.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Abi, CodePromise, ContractPromise } from '@polkadot/api-contract';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import { Wallet, ContractFactory, getAddress } from 'ethers';
import { NETWORK, PATHS, precompileAddress } from '../src/config.mjs';
import { makeProvider, sendTx, settlementIface, settlement as settlementContract, erc20 } from '../src/evm.mjs';
import { InkRegistry } from '../src/registry.mjs';
import { RawInkRegistry } from '../src/inkraw.mjs';
import { buildReviveCall, sendBatchFromEvmKey, sendCallFromEvmKey, twinSs58 } from '../src/xvm.mjs';
import { XvmSettler } from '../src/settle.mjs';
import { createSeller } from '../src/seller.mjs';
import { Store } from '../src/store.mjs';
import { makeRoutes } from '../src/routes.mjs';
import { portaldotUpstream } from '../src/data.mjs';
import { buy } from '../src/buyer.mjs';
import { verifyReceipt, formatReport } from '../src/verify.mjs';
import { twinAccountId } from './lib/addr.mjs';
import { readKeyFile, submit } from './lib/sub.mjs';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const KEYS = opt('--keys');
const PLAN = args.includes('--plan');
const ONLY = (opt('--only') || '').split(',').filter(Boolean);
if (!KEYS) {
  console.error('usage: deploy-testnet.mjs --keys <env file> [--plan] [--only step,...]');
  process.exit(2);
}

const TPOT = 10n ** 14n; // native planck per tPOT
const FUND = { DEPLOYER: 450n * TPOT, PROVIDER: 160n * TPOT, BUYER: 60n * TPOT };
const ASSET = { name: 'Portal Meter Test USD', symbol: 'tUSDm', decimals: 6, mintToBuyer: 1_000_000_000n };
const PRICES = { account: 25_000n, asset: 10_000n }; // 0.025 and 0.010 tUSDm
const REFUND_DELAY = 600;
const SELLER_PORT = 8402;
const DEPLOY_DIR = join(PATHS.root, 'deployments');
const PARTIAL = join(DEPLOY_DIR, 'testnet.partial.json');
const INK_BUNDLE = join(PATHS.root, 'contracts', 'ink', 'meter_registry', 'artifact', 'meter_registry.contract');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const state = existsSync(PARTIAL) ? JSON.parse(readFileSync(PARTIAL, 'utf8')) : { chainId: NETWORK.chainId, transactions: [] };
function save() {
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(PARTIAL, JSON.stringify(state, null, 2) + '\n');
}
function noteTx(label, layer, hash, block, extra = {}) {
  state.transactions.push({ label, layer, hash, block, ...extra });
  save();
  log(`  ${label}: ${hash} (block ${block})`);
}
const want = step => (ONLY.length === 0 || ONLY.includes(step)) && !(state.done || {})[step];
const done = step => {
  state.done = { ...(state.done || {}), [step]: new Date().toISOString() };
  save();
};

await cryptoWaitReady();
const k = readKeyFile(KEYS);
const sub = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(k.PORTALDOT_SUB_MNEMONIC);
const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const W = {
  DEPLOYER: new Wallet(k.PORTALDOT_EVM_DEPLOYER_KEY, evm),
  PROVIDER: new Wallet(k.PORTALDOT_EVM_PROVIDER_KEY, evm),
  BUYER: new Wallet(k.PORTALDOT_EVM_BUYER_KEY, evm),
};
const api = await ApiPromise.create({ provider: new WsProvider(NETWORK.substrateWs, 2500, {}, 30_000), noInitWarn: true });
const fmt = planck => `${(Number(planck) / 1e14).toFixed(4)} tPOT`;

async function freeOf(address) {
  return (await api.query.system.account(address)).data.free.toBigInt();
}

try {
  state.sub = sub.address;
  state.deployer = W.DEPLOYER.address;
  state.provider = W.PROVIDER.address;
  state.buyer = W.BUYER.address;
  state.payee = W.DEPLOYER.address;
  const subFree = await freeOf(sub.address);
  log(`sr25519 ${sub.address}: ${fmt(subFree)}`);
  for (const [r, w] of Object.entries(W)) log(`${r.toLowerCase()} ${w.address} (twin ${twinSs58(w.address)}): ${fmt(await freeOf(twinSs58(w.address)))}`);

  // ---------------------------------------------------------------- plan: cost estimates, nothing is sent
  if (PLAN) {
    const art = JSON.parse(readFileSync(PATHS.evmArtifact, 'utf8'));
    const gp = BigInt(await evm.send('eth_gasPrice', []));
    const g = BigInt(await evm.send('eth_estimateGas', [{ from: W.DEPLOYER.address, data: art.bytecode.object }]));
    log(`MeterSettlement deploy: ~${(Number(g * gp) / 1e18).toFixed(1)} tPOT`);
    if (existsSync(INK_BUNDLE)) {
      const bundle = JSON.parse(readFileSync(INK_BUNDLE, 'utf8'));
      const abi = new Abi(bundle, api.registry.getChainProperties());
      const data = abi.findConstructor('new').toU8a(['0x' + '11'.repeat(20), NETWORK.chainId]);
      const dry = await api.call.contractsApi.instantiate(sub.address, 0, null, null, { Upload: bundle.source.wasm }, data, '0x01');
      log(`MeterRegistry instantiate dry-run: ${JSON.stringify(dry.toHuman()).slice(0, 400)}`);
      log(`wasm size ${(bundle.source.wasm.length - 2) / 2} bytes`);
    } else log('ink! bundle missing: download it from CI first (contracts/ink/meter_registry/artifact/)');
    log(`planned funding: ${Object.entries(FUND).map(([r, v]) => `${r.toLowerCase()} ${fmt(v)}`).join(', ')}`);
    process.exit(0);
  }

  // ---------------------------------------------------------------- fund
  if (want('fund')) {
    const calls = [];
    for (const [r, w] of Object.entries(W)) {
      const twin = twinSs58(w.address);
      const have = await freeOf(twin);
      if (have < FUND[r]) calls.push(api.tx.balances.transferKeepAlive(twin, FUND[r] - have));
    }
    if (calls.length) {
      const res = await submit(api, sub, api.tx.utility.batchAll(calls));
      noteTx('fund EVM keys (twin accounts) from the sr25519 account', 'substrate', res.hash, res.block, { extrinsic: `${res.block}-${res.index}` });
    }
    done('fund');
  }

  // ---------------------------------------------------------------- asset
  if (want('asset')) {
    let id = state.token?.assetId;
    if (!id) {
      do id = 40_000 + randomInt(1, 9_999); while ((await api.query.assets.asset(id)).isSome);
    }
    const buyerTwin = twinSs58(W.BUYER.address);
    const res = await submit(api, sub, api.tx.utility.batchAll([
      api.tx.assets.create(id, sub.address, 1),
      api.tx.assets.setMetadata(id, ASSET.name, ASSET.symbol, ASSET.decimals),
      api.tx.assets.mint(id, buyerTwin, ASSET.mintToBuyer),
    ]));
    state.token = {
      kind: 'pallet-assets native asset via the ERC-20 precompile', assetId: id, symbol: ASSET.symbol, name: ASSET.name,
      decimals: ASSET.decimals, precompile: getAddress(precompileAddress(id)),
      assetKey: api.query.assets.asset.key(id), metadataKey: api.query.assets.metadata.key(id),
    };
    noteTx(`create native asset #${id} ${ASSET.symbol}, metadata, mint ${ASSET.mintToBuyer / 10n ** 6n} to the buyer`, 'substrate', res.hash, res.block, { extrinsic: `${res.block}-${res.index}` });
    const viaEvm = await erc20(state.token.precompile, evm).balanceOf(W.BUYER.address);
    log(`  buyer balance through the ERC-20 precompile: ${viaEvm}`);
    done('asset');
  }

  // ---------------------------------------------------------------- evm
  if (want('evm')) {
    const art = JSON.parse(readFileSync(PATHS.evmArtifact, 'utf8'));
    const f = new ContractFactory(art.abi, art.bytecode.object, W.DEPLOYER);
    const tx = await f.getDeployTransaction();
    const r = await sendTx(W.DEPLOYER, { data: tx.data });
    state.settlement = getAddress(r.contractAddress);
    state.settlementTx = r.hash;
    state.settlementBlock = r.blockNumber;
    state.fromBlock = r.blockNumber;
    noteTx('deploy MeterSettlement (Solidity, pallet-revive)', 'evm', r.hash, r.blockNumber, { address: state.settlement });
    done('evm');
  }

  // ---------------------------------------------------------------- ink
  const bundle = JSON.parse(readFileSync(INK_BUNDLE, 'utf8'));
  const abi = new Abi(bundle, api.registry.getChainProperties());
  if (want('ink')) {
    const ctor = abi.findConstructor('new');
    const data = ctor.toU8a([state.settlement, NETWORK.chainId]);
    const salt = u8aToHex(new TextEncoder().encode(`portal-meter-${Date.now()}`));
    const dry = await api.call.contractsApi.instantiate(sub.address, 0, null, null, { Upload: bundle.source.wasm }, data, salt);
    if (dry.result.isErr) throw new Error(`instantiate dry-run failed: ${dry.result.asErr.toString()}`);
    const w = dry.gasRequired;
    const dep = dry.storageDeposit.isCharge ? dry.storageDeposit.asCharge.toBigInt() : 0n;
    log(`  ink! instantiate needs ~${fmt(dep)} storage deposit`);
    const code = new CodePromise(api, abi, bundle.source.wasm);
    const tx = code.tx.new({
      gasLimit: api.registry.createType('WeightV2', { refTime: (w.refTime.toBigInt() * 3n) / 2n, proofSize: (w.proofSize.toBigInt() * 3n) / 2n }),
      storageDepositLimit: (dep * 12n) / 10n + TPOT,
      salt,
    }, state.settlement, NETWORK.chainId);
    const res = await submit(api, sub, tx);
    const inst = res.events.find(({ event }) => api.events.contracts.Instantiated.is(event));
    const address = inst.event.data[1].toString();
    state.registry = {
      address,
      accountId: u8aToHex(api.createType('AccountId32', address).toU8a()),
      codeHash: bundle.source.hash,
      selectors: Object.fromEntries(['anchor', 'endpoint', 'reputation', 'info'].map(m => [m, abi.findMessage(m).selector.toHex()])),
      instantiateTx: res.hash,
      block: res.block,
    };
    state.readOrigin = u8aToHex(twinAccountId(W.BUYER.address));
    noteTx('instantiate MeterRegistry (ink!, pallet-contracts)', 'substrate', res.hash, res.block, { extrinsic: `${res.block}-${res.index}`, address });
    done('ink');
  }

  const contract = new ContractPromise(api, abi, state.registry.address);
  const ink = new InkRegistry({ api, contract, readOrigin: twinSs58(W.BUYER.address) });

  // ---------------------------------------------------------------- endpoints: one cross-VM transaction
  if (want('endpoints')) {
    const providerTwin = twinSs58(W.PROVIDER.address);
    const reg = (price) => settlementIface.encodeFunctionData('registerEndpoint', [state.payee, state.token.precompile, price, REFUND_DELAY]);
    const uri1 = `http://127.0.0.1:${SELLER_PORT}/v1/account/{address}`;
    const uri2 = `http://127.0.0.1:${SELLER_PORT}/v1/asset/{id}`;
    const calls = [
      await buildReviveCall(api, W.PROVIDER.address, state.settlement, reg(PRICES.account)),
      await buildReviveCall(api, W.PROVIDER.address, state.settlement, reg(PRICES.asset)),
      (await ink.buildCall(providerTwin, 'registerEndpoint', 1, u8aToHex(new TextEncoder().encode(uri1)))).call,
      (await ink.buildCall(providerTwin, 'registerEndpoint', 2, u8aToHex(new TextEncoder().encode(uri2)))).call,
    ];
    const { receipt } = await sendBatchFromEvmKey(api, W.PROVIDER, calls);
    state.endpoints = [
      { id: 1, path: '/v1/account/{address}', price: String(PRICES.account), uri: uri1 },
      { id: 2, path: '/v1/asset/{id}', price: String(PRICES.asset), uri: uri2 },
    ];
    noteTx('provider: register 2 endpoints in Solidity + list them in ink!, one Ethereum tx (utility.batchAll via the runtime pallets address)', 'evm -> substrate', receipt.hash, receipt.blockNumber);
    const s = settlementContract(state.settlement, evm);
    log(`  EVM endpointCount ${await s.endpointCount()}, ink! endpoint 1: ${JSON.stringify(await ink.endpoint(W.PROVIDER.address, 1))}`);
    done('endpoints');
  }

  // ---------------------------------------------------------------- demo: one served request, one refund
  if (want('demo')) {
    const upstream = portaldotUpstream(api, evm, { assets: [state.token.assetId] });
    const routes = makeRoutes({
      upstream, token: state.token.precompile, tokenSymbol: state.token.symbol, decimals: state.token.decimals,
      endpoints: { account: { id: 1, price: PRICES.account }, asset: { id: 2, price: PRICES.asset } },
    });
    const server = createSeller({
      chain: { chainId: NETWORK.chainId, settlementAddress: state.settlement, settlement: settlementContract(state.settlement, evm) },
      provider: W.PROVIDER.address,
      signer: W.PROVIDER,
      settler: new XvmSettler({ api, wallet: W.PROVIDER, settlementAddress: state.settlement, inkRegistry: ink }),
      store: new Store(join(PATHS.root, 'deployments', '.seller-state.json')),
      registry: { kind: 'ink', address: state.registry.address },
      routes,
      log: (...a) => log('  seller:', ...a),
    });
    await new Promise(r => server.listen(SELLER_PORT, '127.0.0.1', r));
    const opts = {
      wallet: W.BUYER, expect: { chainId: NETWORK.chainId, settlement: state.settlement, token: state.token.precompile },
      maxPrice: 50_000n, registry: ink, approveAmount: 1_000_000n, log: m => log('  buyer:', m),
    };
    const raw = new RawInkRegistry({ rpc: NETWORK.substrateHttp, accountId: state.registry.accountId, origin: state.readOrigin, selectors: state.registry.selectors });
    const results = [];
    try {
      const cases = [
        { name: 'served', url: `http://127.0.0.1:${SELLER_PORT}/v1/account/${twinSs58(W.BUYER.address)}` },
        { name: 'refunded', url: `http://127.0.0.1:${SELLER_PORT}/v1/asset/${state.token.assetId + 1_000_000}` },
      ];
      for (const c of cases) {
        log(`request (${c.name} case): GET ${new URL(c.url).pathname}`);
        const r = await buy(c.url, opts);
        log(`  -> HTTP ${r.status}, outcome ${r.receipt?.outcome}, tx ${r.receipt?.tx}`);
        if (!r.receipt) throw new Error(`no receipt: ${r.body.toString().slice(0, 300)}`);
        const v = await verifyReceipt(r.receipt, { evm, expect: { chainId: NETWORK.chainId, settlement: state.settlement }, body: r.receipt.outcome === 'served' ? r.body : undefined, registry: ink, fromBlock: state.fromBlock });
        const v2 = await verifyReceipt(r.receipt, { evm, expect: { chainId: NETWORK.chainId, settlement: state.settlement }, body: r.receipt.outcome === 'served' ? r.body : undefined, registry: raw, fromBlock: state.fromBlock });
        console.log(formatReport(v));
        if (v.verdict !== 'ACCEPT' || v2.verdict !== 'ACCEPT') throw new Error(`verifier did not accept the ${c.name} receipt`);
        results.push({ name: c.name, request: new URL(c.url).pathname, status: r.status, payTx: r.payTx, approveTx: r.approveTx, receipt: r.receipt, body: r.body.toString('utf8'), verification: v });
        if (r.approveTx) noteTx('buyer: approve the settlement contract on the tUSDm precompile', 'evm', r.approveTx, null);
        noteTx(`buyer: pay request (${c.name} case)`, 'evm', r.payTx, null);
        noteTx(`provider: ${c.name === 'served' ? 'settle' : 'refund'} in Solidity + anchor in ink!, one Ethereum tx`, 'evm -> substrate', r.receipt.tx, r.receipt.block);
      }
      // buyer confirms the served request in the ink! registry, from its EVM key
      const served = results.find(x => x.name === 'served');
      const { call } = await ink.buildCall(twinSs58(W.BUYER.address), 'rate', W.PROVIDER.address, 1, served.receipt.nonce, true);
      const rr = await sendCallFromEvmKey(W.BUYER, call);
      noteTx('buyer: confirm the served request in ink! (contracts.call from its EVM key)', 'evm -> substrate', rr.hash, rr.blockNumber);
      log(`  reputation now: ${JSON.stringify(await ink.reputation(W.PROVIDER.address, 1))}`);
    } finally {
      server.close();
    }
    mkdirSync(join(DEPLOY_DIR, 'receipts'), { recursive: true });
    for (const r of results) writeFileSync(join(DEPLOY_DIR, 'receipts', `${r.name}.json`), JSON.stringify(r, null, 2) + '\n');
    state.sampleReceipt = 'deployments/receipts/served.json';
    done('demo');
  }

  // ---------------------------------------------------------------- publish
  if (want('publish') || ONLY.includes('publish')) {
    const pub = { ...state, network: { name: NETWORK.name, evmRpc: NETWORK.evmRpc, substrateWs: NETWORK.substrateWs, explorer: NETWORK.explorer }, publishedAt: new Date().toISOString() };
    delete pub.done;
    writeFileSync(join(DEPLOY_DIR, 'testnet.json'), JSON.stringify(pub, null, 2) + '\n');
    log('wrote deployments/testnet.json');
    done('publish');
  }
  log('balances after:');
  log(`  sr25519 ${fmt(await freeOf(sub.address))}`);
  for (const [r, w] of Object.entries(W)) log(`  ${r.toLowerCase()} ${fmt(await freeOf(twinSs58(w.address)))}`);
} finally {
  await api.disconnect();
}
