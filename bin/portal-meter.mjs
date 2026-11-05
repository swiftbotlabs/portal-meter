#!/usr/bin/env node
// Portal Meter command line.
//
//   portal-meter status                                   deployment, endpoints and provider record (no key)
//   portal-meter verify <receipt.json | base64> [--body <file>]   ACCEPT / REJECT with every check (no key)
//   portal-meter buy <url> --keys <env file> [--key-var NAME] [--max 0.05] [--out <file>]
//   portal-meter serve --keys <env file> [--key-var NAME] [--port 8402] [--host 127.0.0.1] [--mode xvm|evm]
//
// Sell an API, buy from one (deployments/sessions.json):
//   portal-meter register --keys <env file> --key-var NAME --asset 7777 --price 0.01 --payee 0x.. --url https://..
//   portal-meter set-url <endpoint id> --keys <env file> --key-var NAME --url https://..     (move an endpoint to a new host)
//   portal-meter session-open <endpoint id> --keys <env file> --budget 0.5 [--days 7] --out session.json
//   portal-meter session-buy <url> --session session.json [--max 0.05]
//   portal-meter session-close --session session.json
//   portal-meter session-verify <seller url> --session session.json   ACCEPT / NOT YET / REJECT against the chain (no key)
//
// Keys are read from a 0600 env file (default variables PORTALDOT_EVM_BUYER_KEY / PORTALDOT_EVM_PROVIDER_KEY)
// and never printed. Network and contract addresses come from deployments/testnet.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Abi, ContractPromise } from '@polkadot/api-contract';
import { Wallet, getAddress, hexlify, parseUnits, randomBytes } from 'ethers';
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
import { precompileAddress } from '../src/config.mjs';
import { erc20, sendTx, settlementIface } from '../src/evm.mjs';
import { sessionContract, sessionIface } from '../src/session-chain.mjs';
import { sessionIdFor } from '../src/session.mjs';
import { SessionClient } from '../src/session-client.mjs';
import { CALLS_SPEC_3002 as CALLS, INK_REGISTER_SELECTOR, INK_SET_URI_SELECTOR, batchAll, contractsCall, inkUriData, reviveCall } from '../src/runtime-calls.mjs';
import { RUNTIME_PALLETS_ADDRESS } from '../src/session-settle.mjs';
import { verifySellerSession, sessionReport } from '../src/session-verify.mjs';

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
    const unit = ep.token.toLowerCase() === dep.token.precompile.toLowerCase() ? dep.token : { decimals: Number(await erc20(ep.token, evm).decimals()), symbol: await erc20(ep.token, evm).symbol() };
    const price = `${formatUnits(ep.price, unit.decimals)} ${unit.symbol}`;
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
} else if (cmd === 'register') {
  // one Ethereum transaction: the endpoint in Solidity and its URL in ink!, together or not at all
  const wallet = keyWallet('PORTALDOT_EVM_PROVIDER_KEY');
  const uri = flag('--url');
  const assetId = Number(flag('--asset'));
  const payee = flag('--payee', wallet.address);
  if (!uri || !Number.isInteger(assetId)) die('usage: portal-meter register --keys f --asset <id> --price 0.01 --payee 0x.. --url https://..');
  if (new TextEncoder().encode(uri).length > 96) die('--url must be at most 96 bytes');
  const token = precompileAddress(assetId);
  const decimals = Number(await erc20(token, evm).decimals());
  const price = parseUnits(flag('--price', '0.01'), decimals);
  const s = settlementContract(dep.settlement, evm);
  const id = Number(await s.endpointCount()) + 1;
  const weight = { refTime: 8_000_000_000n, proofSize: 300_000n };
  const r = await sendTx(wallet, {
    to: RUNTIME_PALLETS_ADDRESS, value: 0n,
    data: batchAll(CALLS, [
      reviveCall(CALLS, { dest: dep.settlement, weight, depositLimit: 40n * 10n ** 14n, data: settlementIface.encodeFunctionData('registerEndpoint', [payee, token, price, 600]) }),
      contractsCall(CALLS, { dest: dep.registry.accountId, weight, data: inkUriData(INK_REGISTER_SELECTOR, id, uri) }),
    ]),
  });
  console.log(`endpoint ${id}: ${flag('--price', '0.01')} per request, tx ${r.hash}, block ${r.blockNumber}`);
} else if (cmd === 'set-url') {
  // the URL buyers find in the ink! registry, for an endpoint the key already owns: one Ethereum transaction
  const wallet = keyWallet('PORTALDOT_EVM_PROVIDER_KEY');
  const id = Number(positional[0]);
  const uri = flag('--url');
  if (!Number.isInteger(id) || id <= 0 || !uri) die('usage: portal-meter set-url <endpoint id> --keys f --url https://..');
  if (new TextEncoder().encode(uri).length > 96) die('--url must be at most 96 bytes');
  const ep = await readEndpoint(settlementContract(dep.settlement, evm), id);
  if (ep.provider.toLowerCase() !== wallet.address.toLowerCase()) die(`endpoint ${id} belongs to ${ep.provider}, not to this key`);
  const weight = { refTime: 8_000_000_000n, proofSize: 300_000n };
  const r = await sendTx(wallet, {
    to: RUNTIME_PALLETS_ADDRESS, value: 0n,
    data: batchAll(CALLS, [contractsCall(CALLS, { dest: dep.registry.accountId, weight, data: inkUriData(INK_SET_URI_SELECTOR, id, uri) })]),
  });
  const rec = rawRegistry ? await rawRegistry.endpoint(wallet.address, id) : null;
  console.log(`endpoint ${id}: URL in ink! is now ${rec ? rec.uri : '(unread)'}, tx ${r.hash}, block ${r.blockNumber}`);
} else if (cmd === 'session-open') {
  const ses = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'sessions.json'), 'utf8'));
  const endpointId = Number(positional[0]);
  const out = flag('--out');
  if (!Number.isInteger(endpointId) || !out) die('usage: portal-meter session-open <endpoint id> --keys f --budget 0.5 [--days 7] --out session.json');
  const wallet = keyWallet('PORTALDOT_EVM_BUYER_KEY');
  const ep = await readEndpoint(settlementContract(dep.settlement, evm), endpointId);
  const token = erc20(ep.token, wallet);
  const decimals = Number(await token.decimals());
  const budget = parseUnits(flag('--budget', '0.5'), decimals);
  const key = Wallet.createRandom(); // the session key can only spend this budget
  const nonce = hexlify(randomBytes(32));
  const allowance = BigInt(await token.allowance(wallet.address, ses.sessionContract));
  if (allowance < budget) await sendTx(wallet, { to: ep.token, data: token.interface.encodeFunctionData('approve', [ses.sessionContract, budget]) });
  const latest = await evm.getBlock('latest');
  const expiresAt = latest.timestamp + Number(flag('--days', '7')) * 86_400;
  const r = await sendTx(wallet, { to: ses.sessionContract, data: sessionIface.encodeFunctionData('open', [endpointId, nonce, key.address, budget, expiresAt]) });
  const session = sessionIdFor(NETWORK.chainId, ses.sessionContract, wallet.address, endpointId, nonce).toLowerCase();
  writeFileSync(out, JSON.stringify({ session, endpointId, provider: ep.provider, token: ep.token, openedAt: r.blockNumber, sessionKey: key.privateKey, state: null }, null, 2) + '\n', { mode: 0o600 });
  console.log(`session ${session}: budget ${flag('--budget', '0.5')}, tx ${r.hash}, block ${r.blockNumber}, state in ${out}`);
} else if (cmd === 'session-buy') {
  const ses = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'sessions.json'), 'utf8'));
  const file = flag('--session');
  if (!positional[0] || !file) die('usage: portal-meter session-buy <url> --session session.json [--max 0.05]');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const decimals = Number(await erc20(j.token, evm).decimals());
  const client = new SessionClient({
    signer: new Wallet(j.sessionKey), session: j.session, state: j.state || undefined, maxPrice: parseUnits(flag('--max', '0.05'), decimals),
    expect: { chainId: NETWORK.chainId, sessionContract: ses.sessionContract, provider: j.provider, token: j.token },
  });
  // if an earlier run died between sending a voucher and saving the answer, the seller is one step ahead
  const view = await fetch(new URL(`/v1/session/${j.session}`, positional[0])).then(x => (x.ok ? x.json() : null)).catch(() => null);
  if (view && client.resume(view)) console.error('· picked up one step ahead: that response was lost');
  const r = await client.get(positional[0]);
  writeFileSync(file, JSON.stringify({ ...j, state: client.state }, null, 2) + '\n', { mode: 0o600 });
  console.error(`· HTTP ${r.status}${r.receipt ? `, request ${r.receipt.count}, spent ${r.receipt.cumulative}, head ${r.receipt.head}` : ', not charged'}`);
  process.stdout.write(r.body);
  if (r.status !== 200) process.exit(1);
} else if (cmd === 'session-close') {
  const ses = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'sessions.json'), 'utf8'));
  const file = flag('--session');
  if (!file) die('usage: portal-meter session-close --session session.json --keys f');
  const wallet = keyWallet('PORTALDOT_EVM_BUYER_KEY');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const r = await sendTx(wallet, { to: ses.sessionContract, data: sessionContract(ses.sessionContract, wallet).interface.encodeFunctionData('close', [j.session]) });
  console.log(`closed: tx ${r.hash}, block ${r.blockNumber}`);
} else if (cmd === 'session-verify') {
  // anyone can run this: the seller's public log, the payer-signed heads in the Redeemed events and the ink! anchors
  const ses = JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'sessions.json'), 'utf8'));
  const file = flag('--session');
  const usage = 'usage: portal-meter session-verify <seller url> --session session.json   (or --id 0x<session> --provider 0x<address> [--endpoint n])';
  if (!positional[0] || !/^https?:\/\//.test(positional[0])) die(usage);
  let j = { session: flag('--id'), provider: flag('--provider'), endpointId: flag('--endpoint') ? Number(flag('--endpoint')) : undefined };
  if (file) {
    try {
      j = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      die(`cannot read ${file}`);
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(j.session)) || !/^0x[0-9a-fA-F]{40}$/.test(String(j.provider))) die(usage);
  if (j.endpointId !== undefined && !(Number.isInteger(j.endpointId) && j.endpointId > 0)) die(usage);
  const from = Number(flag('--from', j.openedAt ?? 0));
  const r = await verifySellerSession({
    seller: positional[0], session: j.session.toLowerCase(), deployment: ses, testnet: dep, provider: getAddress(j.provider),
    endpointId: j.endpointId, fromBlock: Number.isInteger(from) && from >= 0 ? from : 0,
  });
  const rep = sessionReport(r);
  console.log(rep.lines.join('\n'));
  process.exit(rep.code);
} else {
  die('usage: portal-meter status | verify <receipt> [--body f] | buy <url> --keys f | serve --keys f | register | set-url | session-open | session-buy | session-close | session-verify');
}
if (cmd !== 'serve') process.exit(0);
