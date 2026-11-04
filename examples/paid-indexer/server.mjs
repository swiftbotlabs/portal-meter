#!/usr/bin/env node
// A paid indexer API: account transfer history from Portaldot's public explorer, sold per call with Portal Meter
// sessions and settled across both VMs (Solidity redeem + ink! record in one Ethereum transaction).
// An example built by the Portal Meter authors, written the way a third party would: it depends on the published
// package only (see package.json) and runs from a folder of its own.
//
//   node server.mjs --keys provider.env --endpoint <id> [--key-var PORTALDOT_EVM_PROVIDER_KEY] [--port 8788]
//                   [--state ledger.json] [--check-sec 60] [--settle-min 25] [--settle-gap 1800] [--max-failures 5]
//
// The key file is a 0600 env file holding the provider's testnet key; the key is never printed. Register the endpoint
// first: `npx portal-meter register --keys provider.env --asset 7777 --price 0.01 --url http://127.0.0.1:8788/v1/transfers/`.
import http from 'node:http';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import { Contract, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { createMeter, nodeRequest, sendNode } from 'portal-meter';
import { readSession, sessionContract } from 'portal-meter/chain';
import { CALLS_SPEC_3002, createSettler } from 'portal-meter/settle';
import { createApp } from './app.mjs';
import { explorerUpstream } from './upstream.mjs';
import { FileLedger } from './file-ledger.mjs';

const dep = createRequire(import.meta.url)('portal-meter/deployments/sessions.json');
const EVM_RPC = process.env.PM_EVM_RPC || 'https://test-evm-rpc-v3.portaldot.dev';
const SUB_RPC = process.env.PM_SUBSTRATE_HTTP || 'https://test-node-v3.portaldot.dev';
const ENDPOINT_ABI = ['function endpoint(uint32 endpointId) view returns (address provider, address payee, address token, uint96 price, uint32 refundDelay, bool active)'];

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const die = msg => {
  console.error(msg);
  process.exit(2);
};
const log = obj => console.log(JSON.stringify({ at: new Date().toISOString(), ...obj }));

function readKey(file, name) {
  const st = lstatSync(file);
  if (!st.isFile()) die(`${file} must be a regular file, not a link`);
  if ((st.mode & 0o077) !== 0) die(`${file} must not be readable by group or others (chmod 600)`);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] === name) return m[2].replace(/^"|"$/g, '');
  }
  return die(`${name} not found in ${file}`);
}

const keys = flag('--keys');
const endpointId = Number(flag('--endpoint'));
if (!keys || !Number.isInteger(endpointId) || endpointId <= 0) die('usage: node server.mjs --keys provider.env --endpoint <id> [--port 8788]');
const wallet = new Wallet(readKey(keys, flag('--key-var', 'PORTALDOT_EVM_PROVIDER_KEY')));
const evm = new JsonRpcProvider(EVM_RPC, dep.chainId, { staticNetwork: true, batchMaxCount: 1 });

// refuse to start on an endpoint this key does not own, or on a runtime whose call indices changed
const ep = await new Contract(dep.settlement, ENDPOINT_ABI, evm).endpoint(endpointId);
if (getAddress(ep.provider) !== wallet.address) die(`endpoint ${endpointId} belongs to ${ep.provider}, not to this key`);
if (!ep.active) die(`endpoint ${endpointId} is not active`);
const spec = await fetch(SUB_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_getRuntimeVersion', params: [] }) })
  .then(r => r.json()).then(j => j.result.specVersion);
if (spec !== CALLS_SPEC_3002.specVersion) die(`runtime spec ${spec}: the cross-VM call indices were checked on ${CALLS_SPEC_3002.specVersion} only`);

const decimals = Number(await new Contract(ep.token, ['function decimals() view returns (uint8)'], evm).decimals());
const symbol = getAddress(ep.token) === getAddress(dep.token.precompile) ? dep.token.symbol : 'token';
const ledger = new FileLedger(flag('--state', 'ledger.json'));
const reader = sessionContract(dep.sessionContract, evm);
const meter = createMeter({
  chainId: dep.chainId, sessionContract: dep.sessionContract, settlement: dep.settlement, registry: { kind: 'ink', address: dep.registry },
  endpointId, wallet, token: ep.token, tokenSymbol: symbol, decimals, readSession: id => readSession(reader, id), ledger,
  log: (...a) => log({ event: 'meter', detail: a.join(' ').slice(0, 300) }),
});
const app = createApp({
  meter, upstream: explorerUpstream(), price: ep.price,
  catalog: { network: `eip155:${dep.chainId}`, endpointId, token: ep.token, tokenSymbol: symbol, sessionContract: dep.sessionContract, registry: dep.registry },
});

const settler = createSettler({
  ledger, wallet, rpc: EVM_RPC, chainId: dep.chainId, sessionContract: dep.sessionContract, endpointId, registryAccountId: dep.registryAccountId,
  policy: { minRequests: Number(flag('--settle-min', '25')), minGapSec: Number(flag('--settle-gap', '1800')) },
  minBalance: 8n * 10n ** 18n, // one batch locks an ink! anchor deposit of about 3.7 tPOT
});

// one log line per check; after too many failed checks in a row, exit non-zero so a supervisor restarts us
const maxFailures = Number(flag('--max-failures', '5'));
let failures = 0;
async function check() {
  const r = await settler.tick();
  failures = r.error ? failures + 1 : 0;
  log({ check: 'settle', settled: r.settled, ...(r.tx ? { tx: r.tx, block: r.block, requests: r.requests } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.error ? { error: r.error, failures } : {}) });
  if (failures >= maxFailures) {
    log({ check: 'watchdog', exit: 1, failures });
    process.exit(1);
  }
}
setInterval(check, Number(flag('--check-sec', '60')) * 1000).unref?.();

const port = Number(flag('--port', '8788'));
const server = http.createServer(async (req, res) => {
  let request;
  try {
    request = nodeRequest(req, `http://127.0.0.1:${port}`);
  } catch {
    res.statusCode = 400;
    return res.end('bad request');
  }
  const response = await app.fetch(request).catch(() => new Response('{"error":"internal error"}\n', { status: 500 }));
  log({ event: 'request', path: new URL(request.url).pathname.slice(0, 80), status: response.status });
  return sendNode(res, response);
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.listen(port, flag('--host', '127.0.0.1'), () => log({ event: 'listening', url: `http://127.0.0.1:${port}/`, endpointId, provider: wallet.address, price: ep.price.toString() }));
