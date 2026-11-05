#!/usr/bin/env node
// Check a session against the chain, as anyone can: the seller's public log, the payer-signed heads in MeterSession's
// Redeemed events, and the ink! anchors of every batch (endpoint, amount paid, receipt hash). No key needed.
//
//   node verify.mjs http://127.0.0.1:8788 --session session.json      (or --id 0x<session id> --provider 0x<address>)
//
// Exit 0 on ACCEPT, 1 on REJECT, 2 on bad usage.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getAddress } from 'ethers';
import { verifySellerSession } from 'portal-meter/verify';

const require = createRequire(import.meta.url);
const deployment = require('portal-meter/deployments/sessions.json');
const testnet = require('portal-meter/deployments/testnet.json');
const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const seller = args[0];
const file = flag('--session');
const s = file ? JSON.parse(readFileSync(file, 'utf8')) : { session: flag('--id'), provider: flag('--provider'), endpointId: Number(flag('--endpoint')) || undefined };
if (!seller || seller.startsWith('--') || !/^0x[0-9a-fA-F]{64}$/.test(String(s.session)) || !/^0x[0-9a-fA-F]{40}$/.test(String(s.provider))) {
  console.error('usage: node verify.mjs <seller url> --session session.json | --id 0x<session> --provider 0x<provider> [--endpoint n]');
  process.exit(2);
}

const r = await verifySellerSession({
  seller, session: s.session.toLowerCase(), deployment, testnet, provider: getAddress(s.provider), endpointId: s.endpointId,
  fromBlock: Number(flag('--from') || 0),
});
for (const b of r.redemptions) console.log(`batch     up to request ${b.count}: ${b.paid} paid, block ${b.block}, tx ${b.tx}`);
for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}      ${c.name}: ${c.detail}`);
console.log(r.ok ? `ACCEPT    ${r.rows} requests in the log, ${r.redemptions.length} batch${r.redemptions.length === 1 ? '' : 'es'} on-chain` : 'REJECT');
process.exit(r.ok ? 0 : 1);
