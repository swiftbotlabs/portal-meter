#!/usr/bin/env node
// One paid request, from the buyer's side, with a session opened by `npx portal-meter session-open`:
//
//   node buy.mjs http://127.0.0.1:8788/v1/transfers/<address> --session session.json [--max 0.02]
//
// The session file holds a capped session key (it can spend this session's budget and nothing else) and the client's
// own count and head, which are saved after every answer. Nothing secret is printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Wallet, parseUnits } from 'ethers';
import { SessionClient } from 'portal-meter/session-client';

const dep = createRequire(import.meta.url)('portal-meter/deployments/sessions.json');
const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const url = args[0];
const file = flag('--session');
if (!url || url.startsWith('--') || !file) {
  console.error('usage: node buy.mjs <url> --session session.json [--max 0.02]');
  process.exit(2);
}

const s = JSON.parse(readFileSync(file, 'utf8'));
const client = new SessionClient({
  signer: new Wallet(s.sessionKey), session: s.session, state: s.state || undefined,
  maxPrice: parseUnits(flag('--max', '0.02'), dep.token.decimals),
  expect: { chainId: dep.chainId, sessionContract: dep.sessionContract, provider: s.provider, token: s.token },
});
// a run that died between sending a voucher and saving the answer leaves the seller one step ahead
const view = await fetch(new URL(`/v1/session/${s.session}`, url)).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (view && client.resume(view)) console.error('picked up one step ahead: that response was lost');

const r = await client.get(url, {
  onStep: (name, x) => {
    if (name === 'quote') console.log(`HTTP 402  quote: ${x.price} base units of ${x.tokenSymbol} for endpoint ${x.endpointId}, provider ${x.provider}, request ${x.requestHash}`);
    if (name === 'voucher') console.log(`voucher   ${x.count} signed: cumulative ${x.cumulative}, head ${x.head}`);
  },
});
writeFileSync(file, JSON.stringify({ ...s, state: client.state }, null, 2) + '\n', { mode: 0o600 });
const text = new TextDecoder().decode(r.body);
if (r.status !== 200) {
  console.log(`HTTP ${r.status}  not charged: ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`HTTP 200  receipt checked: response ${r.receipt.responseHash}, signed by the provider`);
const body = JSON.parse(text);
console.log(`data      ${body.transfers.length} of ${body.total} transfers of ${body.account}, from ${body.source}`);
for (const t of body.transfers.slice(0, 3)) console.log(`          block ${t.block}  ${t.direction.padEnd(5)} ${t.amount ?? t.raw} ${t.unit}`);
