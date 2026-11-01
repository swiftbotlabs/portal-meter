#!/usr/bin/env node
// Builds pitch/deck.html (16:9 slides) from deployments/testnet.json. Render to PDF with any Chromium
// "print to PDF" (the page size comes from CSS). Every number on the proof slide comes from the deployment file.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/config.mjs';

const dep = existsSync(join(PATHS.root, 'deployments', 'testnet.json'))
  ? JSON.parse(readFileSync(join(PATHS.root, 'deployments', 'testnet.json'), 'utf8')) : null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (h, n = 8) => (h && h.length > 2 * n + 4 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const EXPLORER = 'https://scanner-testnet-v3.portaldot.dev';
const tx = label => dep?.transactions?.findLast(t => t.label.startsWith(label));
const counts = JSON.parse(readFileSync(join(PATHS.root, 'pitch', 'counts.json'), 'utf8'));

const proofRows = dep ? [
  ['MeterSettlement (Solidity, EVM)', dep.settlement, `deploy ${short(dep.settlementTx)} · block ${dep.settlementBlock}`],
  ['MeterRegistry (ink!, WASM)', dep.registry.address, `instantiate ${short(dep.registry.instantiateTx)} · block ${dep.registry.block}`],
  [`Native asset #${dep.token.assetId} ${dep.token.symbol}`, dep.token.precompile, 'ERC-20 precompile address'],
  ['Endpoints listed in ink! from the provider\'s Ethereum key', tx('provider: list')?.hash, `block ${tx('provider: list')?.block ?? ''}`],
  ['Paid request: buyer pays into escrow', tx('buyer: pay request (served')?.hash, `block ${tx('buyer: pay request (served')?.block ?? ''}`],
  ['Served: settle + ink! anchor, one Ethereum tx', tx('provider: settle the served request in Solidity + anchor')?.hash, `block ${tx('provider: settle the served request in Solidity + anchor')?.block ?? ''}`],
  ['Refunded: refund + ink! anchor, one Ethereum tx', tx('provider: refund the undeliverable request in Solidity + anchor')?.hash, `block ${tx('provider: refund the undeliverable request in Solidity + anchor')?.block ?? ''}`],
  ['Buyer confirms in ink! from its Ethereum key', tx('buyer: confirm')?.hash, `block ${tx('buyer: confirm')?.block ?? ''}`],
] : [];

const slides = [];
const slide = (cls, html) => slides.push(`<section class="slide ${cls}">${html}<footer><span>Portal Meter · Swift Bot Labs</span><span>${slides.length + 1}</span></footer></section>`);

slide('title', `
  <div class="kicker">Portaldot Hacker House 2026 · Modular Cloud &amp; Middleware</div>
  <h1>Portal Meter</h1>
  <p class="lead">Pay-per-request API settlement on Portaldot V3,<br>built on both of its contract VMs.</p>
  <p class="links">github.com/swiftbotlab/portal-meter · swiftbotlab.github.io/portal-meter/demo</p>`);

slide('', `
  <h2>The problem</h2>
  <div class="cols">
    <ul class="big">
      <li>APIs are now bought by <b>programs</b>: apps, bots, AI agents, indexers. They want to pay <b>per call</b>, cents or less.</li>
      <li>API keys + monthly plans don't fit a client that needs 40 calls today and none tomorrow.</li>
      <li>"Pay first" protocols (HTTP 402 / x402) move money but give the buyer <b>no recourse</b> when the call fails.</li>
      <li>And no way to know, before paying, whether a provider actually delivers.</li>
    </ul>
    <div class="callout"><b>What a machine buyer needs</b><br>price up front · pay only for what is served ·
      automatic refund when it isn't · a public track record of the seller</div>
  </div>`);

slide('', `
  <h2>Portal Meter</h2>
  <ol class="flow">
    <li><b>GET</b> → <code>402</code> with a quote (price, token, endpoint, nonce)</li>
    <li>Client pays <b>one request</b> into escrow: <code>MeterSettlement.pay()</code> on Portaldot's EVM; the request id is bound to the payer on-chain</li>
    <li>Client retries with a signed proof → served <b>once</b>, with a provider-signed receipt</li>
    <li>Provider <b>settles</b> (funds to payee) or <b>refunds</b>; the buyer can reclaim after a delay if the provider does nothing</li>
    <li>The outcome is <b>anchored in an ink! registry</b> in the same transaction; buyers confirm or dispute</li>
    <li>Anyone verifies a receipt: <b>ACCEPT / REJECT</b> with every check (CLI and browser)</li>
  </ol>`);

slide('', `
  <h2>Why Portaldot is essential</h2>
  <div class="grid2">
    <div class="card"><h3>Native assets are ERC-20s</h3><p>Every <code>pallet-assets</code> token is reachable from Solidity at a precompile address. Endpoints are priced in a native asset; no wrapped token to deploy or trust.</p></div>
    <div class="card"><h3>Two VMs, one identity</h3><p>Escrow in Solidity (pallet-revive), provider registry in ink! (pallet-contracts). Both sides key accounts by the same EVM address, using the runtime's own mapping rule.</p></div>
    <div class="card"><h3>One transaction across both VMs</h3><p>An Ethereum transaction to the runtime pallets address carries <code>utility.batchAll([revive.call(settle), contracts.call(record)])</code>: settlement and anchor succeed or fail together. A single-VM chain cannot do this.</p></div>
    <div class="card"><h3>Ink! checks EVM payers natively</h3><p>The registry recomputes the Solidity request id (keccak + ABI) from the caller's address, so only the real payer can rate a request, with no bridge or oracle.</p></div>
  </div>`);

slide('', `
  <h2>Architecture</h2>
  <img class="diagram" src="architecture.svg" alt="architecture">`);

slide('proof', `
  <h2>Tested, and checked on the live chain</h2>
  <div class="cols even">
    <div>
      <div class="stats">
        <div><b>${counts.foundry}</b><span>Solidity tests<br>unit · fuzz · invariant</span></div>
        <div><b>${counts.ink}</b><span>ink! unit tests</span></div>
        <div><b>${counts.node}</b><span>Node tests incl.<br>end to end on a chain</span></div>
      </div>
      <ul class="small">
        <li>CI on every push: Foundry, ink! release build (cargo-contract 5.0.3), Node end to end</li>
        <li>14 negative checks on the live contracts: replays, strangers and tampered receipts are refused</li>
        <li>Live page reads both VMs from the browser and verifies receipts</li>
        <li>Open source, MIT: github.com/swiftbotlab/portal-meter</li>
      </ul>
    </div>
    <img class="shot" src="demo-page.png" alt="live page">
  </div>`);

slide('proof', `
  <h2>Live on the PortaldotV3 testnet</h2>
  ${dep ? `<table>${proofRows.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td class="mono">${esc(short(b, 10))}</td><td>${esc(c)}</td></tr>`).join('')}</table>
  <p class="note">All transactions with blocks: deployments/testnet.json · live page: swiftbotlab.github.io/portal-meter/demo · explorer ${esc(EXPLORER)}</p>`
    : `<div class="placeholder"><b>PLACEHOLDER: filled after the testnet deployment</b><br>
       MeterSettlement address and deploy tx · MeterRegistry (ink!) address · native asset id ·
       endpoint registration tx (Solidity + ink! in one Ethereum tx) · one served request (pay, settle + anchor) ·
       one refunded request (pay, refund + anchor) · buyer feedback tx</div>
       <p class="note">The deployment runs with one command (scripts/deploy-testnet.mjs) once the deployer account holds testnet tPOT.</p>`}`);

slide('', `
  <h2>One transaction, both VMs</h2>
  <div class="cols even">
    <div>
      <p class="lead2">The provider's Ethereum key signs <b>one</b> transaction to the runtime pallets address:</p>
      <p><code>utility.batchAll([revive.call(settle), contracts.call(record)])</code></p>
      <ul class="small">
        <li>The buyer's escrow moves to the payee (<code>assets.Transferred</code>, <code>revive.ContractEmitted</code>)</li>
        <li>The ink! registry anchors the outcome (<code>contracts.ContractEmitted</code>, <code>contracts.Called</code>)</li>
        <li>All or nothing: <code>utility.BatchCompleted</code></li>
        <li>Block 276,658 on the testnet explorer, events tab</li>
      </ul>
    </div>
    <img class="shot" src="block-events.png" alt="events of block 276658">
  </div>`);

slide('', `
  <h2>Who pays, and how it grows</h2>
  <div class="cols">
    <ul class="big">
      <li><b>Users:</b> data/API providers on Portaldot (indexers, RPC and analytics services, AI tool endpoints) and the apps and agents that call them.</li>
      <li><b>First product:</b> the paid Portaldot data API in this repo (cross-VM account and asset views): a real endpoint other builders can call per request.</li>
      <li><b>Revenue (planned):</b> a small protocol fee on settlement (basis points, per deployment; not in the testnet contract yet) and a hosted seller for providers who do not want to run one.</li>
      <li><b>Growth:</b> drop-in middleware for Express/Fastify, listing in the Portaldot ecosystem directory, wallet support for 402 quotes.</li>
    </ul>
  </div>`);

slide('', `
  <h2>Roadmap, and why keep supporting it</h2>
  <div class="grid2">
    <div class="card"><h3>Next 4 weeks</h3><p>npm middleware package · batch settlement (many requests per transaction) · provider bond held in the ink! registry, slashable on disputes · mainnet migration review</p></div>
    <div class="card"><h3>Next quarter</h3><p>prepaid credit channels for high-frequency callers · explorer / wallet integration of receipts · more paid Portaldot data endpoints</p></div>
    <div class="card"><h3>What Portaldot gets</h3><p>open-source middleware every API builder can reuse · real fee-paying transactions on both VMs · a reference for cross-VM design (documented, tested, measured)</p></div>
    <div class="card"><h3>Team</h3><p>Swift Bot Labs, a small studio building payment and API infrastructure. Builds on our MIT-licensed HSK Meter (Oct 2026); this repository was written for Portaldot during the Hacker House.</p></div>
  </div>`);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Portal Meter · pitch</title>
<style>
@page { size: 13.333in 7.5in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font: 20px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #141a2b; }
.slide { width: 13.333in; height: 7.5in; padding: 0.6in 0.75in 0.5in; position: relative; page-break-after: always; overflow: hidden; background: #fff; }
.slide::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 0.14in; background: #e6007a; }
h1 { font-size: 72px; margin: 0.2in 0 0.1in; letter-spacing: -0.02em; }
h2 { font-size: 40px; margin: 0 0 0.25in; letter-spacing: -0.01em; }
h3 { margin: 0 0 6px; font-size: 22px; color: #e6007a; }
.kicker { color: #e6007a; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; font-size: 18px; }
.lead { font-size: 30px; color: #2b3350; }
.links { margin-top: 0.6in; color: #5b6478; font-size: 20px; }
.title { display: flex; flex-direction: column; justify-content: center; }
ul.big li, ol.flow li { margin: 0 0 12px; }
ol.flow { font-size: 22px; padding-left: 1.2em; }
.cols { display: grid; grid-template-columns: 1.6fr 1fr; gap: 0.4in; align-items: start; }
.cols.even { grid-template-columns: 1fr 1fr; }
.callout { background: #fdf0f7; border-left: 6px solid #e6007a; padding: 18px 20px; border-radius: 8px; font-size: 20px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.25in; }
.card { border: 1px solid #e2e6ef; border-radius: 12px; padding: 16px 18px; font-size: 18px; }
.card p { margin: 0; }
code, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85em; }
code { background: #eef1f7; padding: 1px 5px; border-radius: 4px; }
.shot { width: 100%; border: 1px solid #e2e6ef; border-radius: 10px; }
.lead2 { font-size: 22px; margin-top: 0; }
.small { font-size: 17px; margin-top: 0.2in; }
.small li { margin-bottom: 6px; }
.placeholder { border: 3px dashed #e6007a; border-radius: 14px; padding: 0.35in; font-size: 22px; color: #2b3350; background: #fdf0f7; }
.diagram { display: block; max-width: 100%; max-height: 5.6in; margin: 0 auto; }
table { width: 100%; border-collapse: collapse; font-size: 16px; }
td { padding: 7px 8px; border-bottom: 1px solid #e2e6ef; }
.note { color: #5b6478; font-size: 14px; }
.stats { display: flex; gap: 0.25in; margin-top: 0.2in; }
.stats div { border: 1px solid #e2e6ef; border-radius: 10px; padding: 10px 16px; }
.stats b { display: block; font-size: 30px; color: #e6007a; }
.stats span { font-size: 14px; color: #5b6478; }
footer { position: absolute; left: 0.75in; right: 0.75in; bottom: 0.25in; display: flex; justify-content: space-between; color: #8a8f9c; font-size: 13px; }
</style></head><body>${slides.join('\n')}</body></html>`;

mkdirSync(join(PATHS.root, 'pitch'), { recursive: true });
writeFileSync(join(PATHS.root, 'pitch', 'deck.html'), html);
console.log(`wrote pitch/deck.html (${slides.length} slides, deployment ${dep ? 'included' : 'pending'})`);
