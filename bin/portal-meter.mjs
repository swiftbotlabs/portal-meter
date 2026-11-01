#!/usr/bin/env node
// Portal Meter command line.
//
//   portal-meter status                                   deployment, endpoints and provider record (no key)
//   portal-meter verify <receipt.json | base64> [--body <file>]   ACCEPT / REJECT with every check (no key)
//   portal-meter buy <url> --keys <env file> [--key-var NAME] [--max 0.05] [--out <file>]
//   portal-meter serve --keys <env file> [--key-var NAME] [--port 8402] [--host 127.0.0.1] [--mode xvm|evm]
//
// Keys are read from a 0600 env file (default variables PORTALDOT_EVM_BUYER_KEY / PORTALDOT_EVM_PROVIDER_KEY)
// and never printed. Network and contract addresses come from deployments/testnet.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Abi, ContractPromise } from '@polkadot/api-contract';
import { Wallet, parseUnits } from 'ethers';
import { NETWORK, loadDeployment, PATHS } from '../src/config.mjs';
import { makeProvider, settlement as settlementContract, readEndpoint } from '../src/evm.mjs';
import { InkRegistry } from '../src/registry.mjs';
import { RawInkRegistry } from '../src/inkraw.mjs';
import { verifyReceipt, formatReport } from '../src/verify.mjs';
import { parseB64json, formatUnits } from '../src/protocol.mjs';
import { buy } from '../src/buyer.mjs';
import { createSeller } from '../src/seller.mjs';
import { Store } from '../src/store.mjs';
import { XvmSettler, EvmSettler } from '../src/settle.mjs';
import { makeRoutes } from '../src/routes.mjs';
import { portaldotUpstream } from '../src/data.mjs';
import { twinSs58 } from '../src/xvm.mjs';
import { readKeyFile } from '../scripts/lib/sub.mjs';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : def;
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
const die = msg => {
  console.error(msg);
  process.exit(2);
};

const dep = loadDeployment();
if (!dep && cmd !== 'verify') die('deployments/testnet.json not found: deploy first (scripts/deploy-testnet.mjs)');
const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const rawRegistry = dep?.registry ? new RawInkRegistry({ rpc: NETWORK.substrateHttp, accountId: dep.registry.accountId, origin: dep.readOrigin, selectors: dep.registry.selectors }) : null;

function keyWallet(defVar) {
  const file = flag('--keys');
  if (!file) die('--keys <env file> is required');
  const k = readKeyFile(file);
  const v = flag('--key-var', defVar);
  if (!k[v]) die(`${v} not found in the key file`);
  return new Wallet(k[v], evm);
}

async function inkClient(readOrigin) {
  const api = await ApiPromise.create({ provider: new WsProvider(NETWORK.substrateWs, 2500, {}, 30_000), noInitWarn: true });
  const bundle = JSON.parse(readFileSync(join(PATHS.root, 'contracts', 'ink', 'meter_registry', 'artifact', 'meter_registry.contract'), 'utf8'));
  if (!dep.registry) return { api, ink: null };
  const contract = new ContractPromise(api, new Abi(bundle, api.registry.getChainProperties()), dep.registry.address);
  return { api, ink: new InkRegistry({ api, contract, readOrigin }) };
}

if (cmd === 'status') {
  const s = settlementContract(dep.settlement, evm);
  const n = Number(await s.endpointCount());
  const info = rawRegistry ? await rawRegistry.info() : null;
  console.log(`network      ${NETWORK.name} (EVM chain id ${NETWORK.chainId})`);
  console.log(`settlement   ${dep.settlement} (Solidity, pallet-revive)`);
  console.log(info ? `registry     ${dep.registry.address} (ink!, pallet-contracts): ${info.endpoints} endpoints, ${info.anchors} anchors` : 'registry     not deployed');
  console.log(`token        native asset #${dep.token.assetId} ${dep.token.symbol} at ${dep.token.precompile}`);
  for (let i = 1; i <= n; i++) {
    const ep = await readEndpoint(s, i);
    const price = `${formatUnits(ep.price, dep.token.decimals)} ${dep.token.symbol}`;
    if (!rawRegistry) {
      console.log(`endpoint ${i}   ${price} · provider ${ep.provider} · payee ${ep.payee}`);
      continue;
    }
    const [rec, rep] = await Promise.all([rawRegistry.endpoint(ep.provider, i), rawRegistry.reputation(ep.provider, i)]);
    console.log(`endpoint ${i}   ${price} · ${rec ? rec.uri : '(not listed)'} · served ${rep.served}, refunded ${rep.refunded}, confirmed ${rep.confirmed}, disputed ${rep.disputed}, score ${(rep.scoreBps / 100).toFixed(1)} %`);
  }
} else if (cmd === 'verify') {
  const src = positional[0];
  if (!src) die('usage: portal-meter verify <receipt.json | base64> [--body <file>]');
  let receipt;
  if (existsSync(src)) {
    const j = JSON.parse(readFileSync(src, 'utf8'));
    receipt = j.receipt || j;
  } else {
    try {
      receipt = parseB64json(src.trim(), 32_768);
    } catch (e) {
      console.log(`REJECT\n  FAIL receipt format: ${e.message}`);
      process.exit(1);
    }
  }
  const bodyFile = flag('--body');
  const v = await verifyReceipt(receipt, {
    evm, expect: { chainId: NETWORK.chainId, settlement: dep?.settlement }, registry: rawRegistry || undefined,
    body: bodyFile ? readFileSync(bodyFile) : undefined, fromBlock: dep?.fromBlock ?? 0,
  });
  console.log(formatReport(v));
  process.exit(v.verdict === 'ACCEPT' ? 0 : 1);
} else if (cmd === 'buy') {
  const url = positional[0];
  if (!url) die('usage: portal-meter buy <url> --keys <file> [--max 0.05]');
  const wallet = keyWallet('PORTALDOT_EVM_BUYER_KEY');
  const r = await buy(url, {
    wallet, expect: { chainId: NETWORK.chainId, settlement: dep.settlement, token: dep.token.precompile },
    maxPrice: parseUnits(flag('--max', '0.05'), dep.token.decimals), registry: rawRegistry || undefined, log: m => console.error(`· ${m}`),
  });
  console.error(`· HTTP ${r.status}`);
  process.stdout.write(r.body);
  if (r.receipt) {
    const v = await verifyReceipt(r.receipt, { evm, expect: { chainId: NETWORK.chainId, settlement: dep.settlement }, registry: rawRegistry || undefined, body: r.receipt.outcome === 'served' ? r.body : undefined, fromBlock: dep.fromBlock });
    console.error(formatReport(v));
    const out = flag('--out');
    if (out) writeFileSync(out, JSON.stringify({ receipt: r.receipt, body: r.body.toString('utf8') }, null, 2) + '\n');
  }
} else if (cmd === 'serve') {
  const wallet = keyWallet('PORTALDOT_EVM_PROVIDER_KEY');
  const { api, ink } = await inkClient(twinSs58(wallet.address));
  const mode = dep.registry ? flag('--mode', 'xvm') : 'evm';
  const settler = mode === 'evm'
    ? new EvmSettler({ wallet, settlementAddress: dep.settlement })
    : new XvmSettler({ api, wallet, settlementAddress: dep.settlement, inkRegistry: ink });
  const prices = Object.fromEntries(dep.endpoints.map(e => [e.id, BigInt(e.price)]));
  const server = createSeller({
    chain: { chainId: NETWORK.chainId, settlementAddress: dep.settlement, settlement: settlementContract(dep.settlement, evm) },
    provider: wallet.address, signer: wallet, settler,
    store: new Store(flag('--state', join(PATHS.root, 'deployments', '.seller-state.json'))),
    registry: dep.registry ? { kind: 'ink', address: dep.registry.address } : { kind: 'none', address: null },
    routes: makeRoutes({
      upstream: portaldotUpstream(api, evm, { assets: [dep.token.assetId] }), token: dep.token.precompile,
      tokenSymbol: dep.token.symbol, decimals: dep.token.decimals,
      endpoints: { account: { id: 1, price: prices[1] }, asset: { id: 2, price: prices[2] } },
    }),
    log: (...a) => console.error(new Date().toISOString(), ...a),
  });
  const port = Number(flag('--port', '8402'));
  const host = flag('--host', '127.0.0.1');
  server.listen(port, host, () => console.error(`seller on http://${host}:${port} (settle mode ${mode}); catalog at /.well-known/portal-meter`));
} else {
  die('usage: portal-meter status | verify <receipt> [--body f] | buy <url> --keys f | serve --keys f');
}
if (cmd !== 'serve') process.exit(0);
