// Portal Meter live page: reads the PortaldotV3 testnet directly (EVM JSON-RPC + Substrate state_call).
import { JsonRpcProvider, getAddress } from 'ethers';
import { settlement as settlementContract, readEndpoint, settlementIface } from '../src/evm.mjs';
import { RawInkRegistry } from '../src/inkraw.mjs';
import { verifyReceipt } from '../src/verify.mjs';
import { parseB64json, formatUnits } from '../src/protocol.mjs';
import { setupTry } from './try.js';

const NET = {
  evmRpc: 'https://test-evm-rpc-v3.portaldot.dev',
  subRpc: 'https://test-node-v3.portaldot.dev',
  chainId: 420420777,
  explorer: 'https://scanner-testnet-v3.portaldot.dev',
};
// Reference asset shown before our own test asset exists: 7777 "Portaldot USD (test)".
// Storage keys = twox128("Assets") ++ twox128("Asset"|"Metadata") ++ blake2_128concat(u32 LE id), precomputed.
const REFERENCE_ASSET = {
  assetId: 7777,
  precompile: '0x00001e6100000000000000000000000000010000',
  assetKey: '0x682a59d51ab9e48a8c8cc418ff9708d2d34371a193a751eea5883e9553457b2e301de3a0ce9dd19ae8aa4083dc90d3f8611e0000',
  metadataKey: '0x682a59d51ab9e48a8c8cc418ff9708d2b5f3822e35ca2f31ce3526eab1363fd2301de3a0ce9dd19ae8aa4083dc90d3f8611e0000',
};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h, n = 6) => (h && h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const evm = new JsonRpcProvider(NET.evmRpc, NET.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });

async function subRpc(method, params = []) {
  const r = await fetch(NET.subRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function kv(el, rows) {
  el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
}

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

function leU128(hex, offsetBytes) {
  const h = hex.slice(2 + offsetBytes * 2, 2 + offsetBytes * 2 + 32);
  let x = 0n;
  for (let i = 30; i >= 0; i -= 2) x = (x << 8n) | BigInt(parseInt(h.slice(i, i + 2), 16));
  return x;
}

function decodeMetadata(hex) {
  // AssetMetadata { deposit: u128, name: Vec<u8>, symbol: Vec<u8>, decimals: u8, is_frozen: bool }
  const b = Uint8Array.from(hex.slice(2).match(/../g).map(x => parseInt(x, 16)));
  let o = 16;
  const vec = () => {
    const len = b[o] >> 2; // names are < 64 bytes (StringLimit 50): single-byte compact
    o += 1;
    const s = new TextDecoder().decode(b.slice(o, o + len));
    o += len;
    return s;
  };
  const name = vec();
  const symbol = vec();
  return { name, symbol, decimals: b[o] };
}

// ------------------------------------------------------------------ network
async function refreshNetwork() {
  const el = $('net');
  try {
    const [chainId, block, gasPrice, header, rv] = await Promise.all([
      evm.send('eth_chainId', []), evm.getBlockNumber(), evm.send('eth_gasPrice', []),
      subRpc('chain_getHeader'), subRpc('state_getRuntimeVersion'),
    ]);
    el.className = 'net live';
    $('net-text').textContent = `PortaldotV3 testnet · block ${parseInt(header.number, 16).toLocaleString()}`;
    kv($('network-kv'), [
      ['EVM chain id', `${parseInt(chainId, 16)} <span class="muted">(${esc(chainId)})</span>`],
      ['EVM block', block.toLocaleString()],
      ['Substrate block', `${link(`${NET.explorer}/#/blocks/${parseInt(header.number, 16)}`, parseInt(header.number, 16).toLocaleString())}`],
      ['runtime', `${esc(rv.specName)} ${esc(rv.specVersion)}`],
      ['gas price', `${BigInt(gasPrice).toLocaleString()} wei`],
      ['contract VMs', 'pallet-revive (EVM) + pallet-contracts (ink!/WASM)'],
    ]);
  } catch (e) {
    el.className = 'net down';
    $('net-text').textContent = `testnet unreachable: ${e.message}`;
  }
}

// ------------------------------------------------------------------ asset
async function refreshAsset(token) {
  const a = token && token.assetKey ? token : REFERENCE_ASSET;
  const [evmSupplyHex, details, meta] = await Promise.all([
    evm.call({ to: a.precompile, data: '0x18160ddd' }), subRpc('state_getStorage', [a.assetKey]), subRpc('state_getStorage', [a.metadataKey]),
  ]);
  const evmSupply = BigInt(evmSupplyHex);
  const subSupply = details ? leU128(details, 128) : null; // owner, issuer, admin, freezer (4 x 32 bytes), then supply
  const md = meta ? decodeMetadata(meta) : { name: '?', symbol: '?', decimals: 0 };
  kv($('asset-kv'), [
    ['asset', `${link(`${NET.explorer}/#/assets/${a.assetId}`, `#${a.assetId}`)} ${esc(md.name)} (${esc(md.symbol)}), ${md.decimals} decimals${token && token.assetKey ? '' : ' <span class="muted">· reference asset until ours is deployed</span>'}`],
    ['ERC-20 address', `<span class="mono">${esc(a.precompile)}</span>`],
    ['supply via EVM', `${formatUnits(evmSupply, md.decimals)} <span class="muted">totalSupply() on the precompile</span>`],
    ['supply via Substrate', subSupply === null ? 'n/a' : `${formatUnits(subSupply, md.decimals)} <span class="muted">Assets.Asset storage</span>`],
    ['same value', subSupply === evmSupply ? '<b style="color:var(--ok)">yes</b>' : '<b style="color:var(--bad)">no</b>'],
  ]);
  return md;
}

// ------------------------------------------------------------------ contracts, endpoints, activity
async function refreshContracts(d, md, sessions) {
  const s = settlementContract(d.settlement, evm);
  const reg = d.registry
    ? new RawInkRegistry({ rpc: NET.subRpc, accountId: d.registry.accountId, origin: d.readOrigin, selectors: d.registry.selectors })
    : null;
  const [count, info] = await Promise.all([s.endpointCount(), reg ? reg.info().catch(e => ({ error: e.message })) : null]);
  kv($('contracts-kv'), [
    ['MeterSettlement (EVM)', `<span class="mono">${esc(d.settlement)}</span>`],
    ['deployed in', `${link(`${NET.explorer}/#/blocks/${d.settlementBlock}`, `block ${d.settlementBlock}`)}`],
    ...(reg ? [
      ['MeterRegistry (ink!)', link(`${NET.explorer}/#/accounts/${d.registry.address}`, short(d.registry.address, 8))],
      ['registry knows', info.error ? esc(info.error) : `settlement ${short(info.settlement)} · ${info.endpoints} endpoints · ${info.anchors} outcomes anchored`],
    ] : [['MeterRegistry (ink!)', 'built and tested, not on the testnet yet']]),
    ['endpoints listed', String(count)],
  ]);
  const rows = [];
  // anyone can list an endpoint in MeterSettlement: show the first 20 only
  for (let i = 1; i <= Math.min(Number(count), 20); i++) {
    const ep = await readEndpoint(s, i);
    const [rec, rep] = reg
      ? await Promise.all([reg.endpoint(ep.provider, i).catch(() => null), reg.reputation(ep.provider, i).catch(() => null)])
      : [null, null];
    const known = (d.endpoints || []).find(x => x.id === i);
    const unit = sessions && ep.token.toLowerCase() === sessions.token.precompile.toLowerCase() ? sessions.token : md;
    const uri = rec ? rec.uri : known ? known.path : '(third-party endpoint)';
    // endpoints 1 and 2 were registered by the escrow run against a seller on the developer's machine: their on-chain URL
    // is kept as recorded, and labelled, so nobody takes it for a public service
    const local = /^https?:\/\/(127\.|localhost|\[::1\])/i.test(uri);
    rows.push(`<tr><td>${i}</td><td class="mono">${esc(uri)}${local ? ' <span class="pill local">local dev seller, escrow run</span>' : ''}</td><td>${formatUnits(ep.price, unit.decimals)} ${esc(unit.symbol)}</td>
      <td class="mono">${esc(short(ep.provider))}</td><td>${rep ? rep.served : '-'}</td><td>${rep ? rep.refunded : '-'}</td>
      <td>${rep ? rep.confirmed : '-'}</td><td>${rep ? rep.disputed : '-'}</td><td>${rep ? (rep.scoreBps / 100).toFixed(1) + ' %' : '-'}</td></tr>`);
  }
  $('endpoints').tBodies[0].innerHTML = rows.length ? rows.join('') : '<tr><td colspan="9" class="muted">no endpoints yet</td></tr>';

  const logs = await evm.getLogs({ address: d.settlement, fromBlock: d.fromBlock, toBlock: 'latest' });
  const ev = [];
  let paid = 0, served = 0, refunded = 0, volume = 0n, paidIn = 0n, refundedOut = 0n;
  for (const l of logs) {
    let p;
    try { p = settlementIface.parseLog(l); } catch { continue; }
    if (!p) continue;
    if (p.name === 'Paid') { paid++; paidIn += p.args.amount; }
    if (p.name === 'Served') { served++; volume += p.args.amount; }
    if (p.name === 'Refunded') { refunded++; refundedOut += p.args.amount; }
    if (!['Paid', 'Served', 'Refunded'].includes(p.name)) continue;
    const detail = p.name === 'Paid' ? `payer ${short(p.args.payer)}` : p.name === 'Served' ? `payee ${short(p.args.payee)}, response ${short(p.args.responseHash)}`
      : `to ${short(p.args.payer)}, reason ${p.args.reason}, by ${p.args.byProvider ? 'provider' : 'payer'}`;
    const cls = p.name === 'Paid' ? 'paid' : p.name === 'Served' ? 'served' : 'refunded';
    ev.push(`<tr><td>${l.blockNumber}</td><td><span class="pill ${cls}">${p.name}</span></td><td class="mono">${esc(short(p.args.requestId))}</td>
      <td>${formatUnits(p.args.amount, md.decimals)}</td><td>${esc(detail)}</td><td class="mono">${esc(short(l.transactionHash))}</td></tr>`);
  }
  $('activity').tBodies[0].innerHTML = ev.length ? ev.reverse().slice(0, 60).join('') : '<tr><td colspan="6" class="muted">no activity yet</td></tr>';
  // three amounts, one scope: what was paid into escrow splits into what providers settled and what went back to payers
  const sym = md.symbol;
  $('totals').innerHTML = [['paid requests', paid], ['served', served], ['refunded', refunded],
    [`paid into escrow (${sym})`, formatUnits(paidIn, md.decimals)], [`settled to providers (${sym})`, formatUnits(volume, md.decimals)],
    [`refunded to payers (${sym})`, formatUnits(refundedOut, md.decimals)]]
    .map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  return reg;
}

function renderTxs(d) {
  const tx = d.transactions || [];
  if (!tx.length) return;
  $('txs').tBodies[0].innerHTML = tx.map(t => `<tr><td>${esc(t.label)}</td><td>${esc(t.layer)}</td>
    <td>${t.block ? link(`${NET.explorer}/#/blocks/${t.block}?tab=events`, t.block) : '-'}</td><td class="mono">${esc(t.hash)}</td></tr>`).join('');
}

// ------------------------------------------------------------------ verifier
function renderVerdict(v) {
  const mark = c => (c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'SKIP');
  $('verdict').innerHTML = `<div class="verdict ${v.verdict}">${v.verdict}</div><ul class="checks">${v.checks.map(c =>
    `<li><span class="m ${mark(c)}">${mark(c)}</span><span><b>${esc(c.name)}</b>${c.detail ? ` <span class="d">${esc(c.detail)}</span>` : ''}</span></li>`).join('')}</ul>`;
}

function setupVerifier(d, reg) {
  const btn = $('verify-btn');
  btn.addEventListener('click', async () => {
    const raw = $('receipt-in').value.trim();
    if (!raw) return;
    btn.disabled = true;
    $('verdict').textContent = 'checking on-chain…';
    try {
      const receipt = raw.startsWith('{') ? JSON.parse(raw) : parseB64json(raw.replace(/\s+/g, ''), 32_768);
      const bodyText = $('body-in').value;
      const v = await verifyReceipt(receipt, {
        evm,
        expect: { chainId: NET.chainId, settlement: d ? d.settlement : undefined },
        body: bodyText ? new TextEncoder().encode(bodyText) : undefined,
        registry: reg || undefined,
        fromBlock: d ? d.fromBlock : 0,
      });
      renderVerdict(v);
    } catch (e) {
      $('verdict').innerHTML = `<div class="verdict REJECT">REJECT</div><p class="muted">${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  });
  if (d && d.sampleReceipt) {
    const s = $('sample-btn');
    s.hidden = false;
    s.addEventListener('click', async () => {
      const r = await fetch(`../${d.sampleReceipt}`, { cache: 'no-store' });
      const j = await r.json();
      $('receipt-in').value = JSON.stringify(j.receipt, null, 2);
      $('body-in').value = j.body || '';
    });
  }
}

// ------------------------------------------------------------------ boot
async function main() {
  // the static snapshot's note: from here on every panel is live. Reworded in place, its space held, so nothing below moves
  const note = document.getElementById('prerendered');
  if (note) {
    note.style.minHeight = `${note.offsetHeight}px`;
    const at = (note.textContent.match(/\d{4}-\d\d-\d\dT[\d:]+Z/) || ['an earlier time'])[0];
    note.textContent = `This page opened with a snapshot of the live PortaldotV3 testnet taken at ${at}, including the replay of the public session below. Your browser is now reading every panel again, live from the chain.`;
  }
  refreshNetwork();
  setInterval(refreshNetwork, 12_000);
  let d = null;
  try {
    const r = await fetch('../deployments/testnet.json', { cache: 'no-store' });
    if (r.ok) d = await r.json();
  } catch { /* not deployed yet */ }
  const md = await refreshAsset(d && d.token).catch(e => {
    kv($('asset-kv'), [['error', esc(e.message)]]);
    return { decimals: 6, symbol: '' };
  });
  if (!d) {
    // only when the deployment file cannot be read; the static page carries no deployment claims of its own
    $('pending').innerHTML = `<h2>Deployment file unavailable</h2><p>The deployment record could not be loaded. The panels below
      still read the live chain: the network itself and Portaldot's native-asset ERC-20 precompile.</p>`;
    $('pending').hidden = false;
    $('try').hidden = true;
    kv($('contracts-kv'), [['status', 'not deployed yet']]);
    setupVerifier(null, null);
    return;
  }
  d.settlement = getAddress(d.settlement);
  if (!d.registry) {
    $('pending').hidden = false;
    $('pending').innerHTML = `<h2>The EVM half is live on the testnet</h2><p>Settlement, the native-asset payment, a served request
      and a refund below are real testnet transactions. The ink! registry is built and tested but not deployed yet: its storage
      deposit is larger than the current testnet funds. Until then the provider columns and the anchor check stay empty.</p>`;
  }
  renderTxs(d);
  let sessions = null;
  try {
    const r = await fetch('../deployments/sessions.json', { cache: 'no-store' });
    if (r.ok) sessions = await r.json();
  } catch { /* sessions not deployed */ }
  if (sessions) {
    sessions.readOrigin = d.readOrigin;
    sessions.selectors = d.registry.selectors;
    setupTry(sessions, NET);
  } else {
    $('try').hidden = true;
  }
  let reg = null;
  try {
    reg = await refreshContracts(d, md, sessions);
  } catch (e) {
    kv($('contracts-kv'), [['error', esc(e.message)]]);
  }
  setupVerifier(d, reg);
}

main();
