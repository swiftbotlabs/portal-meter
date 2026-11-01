#!/usr/bin/env node
// Sell any API on Portaldot in about thirty lines. Run: node examples/sell-an-api.mjs
// Register your endpoint first (`portal-meter register`, see the README) and set the values below.
import http from 'node:http';
import { Wallet } from 'ethers';
import { createMeter, metered, MemoryLedger } from '../src/meter.mjs';
import { makeProvider } from '../src/evm.mjs';
import { readSession, sessionContract } from '../src/session-chain.mjs';
import { NETWORK } from '../src/config.mjs';

const SESSION_CONTRACT = process.env.SESSION_CONTRACT; // deployments/sessions.json
const ENDPOINT_ID = Number(process.env.ENDPOINT_ID); // printed by `portal-meter register`
const PROVIDER_KEY = process.env.PROVIDER_KEY; // testnet key of the provider, never commit it
if (!SESSION_CONTRACT || !ENDPOINT_ID || !PROVIDER_KEY) {
  console.error('set SESSION_CONTRACT, ENDPOINT_ID and PROVIDER_KEY');
  process.exit(2);
}

const evm = makeProvider(NETWORK.evmRpc, NETWORK.chainId);
const contract = sessionContract(SESSION_CONTRACT, evm);
const meter = createMeter({
  chainId: NETWORK.chainId, sessionContract: SESSION_CONTRACT, endpointId: ENDPOINT_ID, wallet: new Wallet(PROVIDER_KEY),
  token: '0x00001e6100000000000000000000000000010000', tokenSymbol: 'pUSD', decimals: 6, // Portaldot's test dollar, asset 7777
  readSession: id => readSession(contract, id), ledger: new MemoryLedger(),
});

// the only line that changes in your API: a price and a handler that returns the body
const hello = metered(meter, { price: 10_000n }, async req => ({ hello: 'world', path: req.url }));

http.createServer((req, res) => hello(req, res, e => { res.statusCode = 500; res.end(String(e.message)); }))
  .listen(8402, '127.0.0.1', () => console.error('paid API on http://127.0.0.1:8402 (0.01 pUSD per request)'));
