// "Try it" panel: buys one real request from the hosted seller with a public demo key, right in this browser.
// The key is derived from a public string and can only sign vouchers for one capped session of test tokens. Visitors
// share it, so this page takes the session's place from the seller; a real client keeps its own count and head.
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes, id as eventTopic } from 'ethers';
import { SessionClient } from '../src/session-client.mjs';
import { verifyLog } from '../src/session.mjs';
import { sessionIface } from '../src/session-chain.mjs';
import { RawInkRegistry } from '../src/inkraw.mjs';
import { formatUnits } from '../src/protocol.mjs';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h, n = 6) => (h && h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const EXPLORER = 'https://scanner-testnet-v3.portaldot.dev';
const blockLink = n => `<a href="${EXPLORER}/#/blocks/${n}?tab=events" target="_blank" rel="noopener">${n}</a>`;

function step(state, title, detail = '') {
  const li = document.createElement('li');
  li.innerHTML = `<span class="m ${state}">${state === 'PASS' ? 'DONE' : state}</span><span><b>${esc(title)}</b>${detail ? ` <span class="d">${detail}</span>` : ''}</span>`;
  $('try-steps').append(li);
}

export async function setupTry(s, net) {
  const box = $('try');
  if (!s || !s.demoSession) return;
  box.hidden = false;
  const base = s.hostedSeller;
  const demo = s.demoSession;
  const signer = new Wallet(keccak256(toUtf8Bytes(demo.seed)));
  const { symbol, decimals } = s.token;
  const money = v => `${formatUnits(v, decimals)} ${symbol}`;
  const evm = new JsonRpcProvider(net.evmRpc, net.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  const expect = { chainId: net.chainId, sessionContract: s.sessionContract, provider: s.endpoint.provider, token: s.token.precompile };

  async function refresh() {
    try {
      const [v, b, h] = await Promise.all([
        fetch(`${base}/v1/session/${demo.id}`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`${base}/v1/batches`, { cache: 'no-store' }).then(r => r.json()),
        fetch(`${base}/health`, { cache: 'no-store' }).then(r => r.json()),
      ]);
      const left = BigInt(v.deposit) - BigInt(v.cumulative);
      $('try-stats').innerHTML = [
        ['requests in this session', v.count], ['spent', money(v.cumulative)], ['budget left', money(left)],
        ['requests settled, all sessions', h.requestsSettled], ['on-chain transactions for them', h.batches], ['waiting for the next batch', h.requestsWaitingForSettlement],
      ].map(([k, x]) => `<div class="stat"><b>${esc(x)}</b><span>${esc(k)}</span></div>`).join('');
      const rows = (b.batches || []).map(x => `<tr><td>${blockLink(x.block)}</td><td>${x.requests}</td><td>${x.sessions.length}</td><td class="mono">${esc(short(x.tx, 8))}</td></tr>`);
      $('try-batches').tBodies[0].innerHTML = rows.length ? rows.join('') : '<tr><td colspan="4" class="muted">no batch yet</td></tr>';
      return v;
    } catch (e) {
      $('try-stats').textContent = `hosted seller unreachable: ${e.message}`;
      return null;
    }
  }

  async function buyOnce(url) {
    $('try-steps').innerHTML = '';
    $('try-body').hidden = true;
    for (let attempt = 0; attempt < 4; attempt++) {
      const v = await fetch(`${base}/v1/session/${demo.id}`, { cache: 'no-store' }).then(r => r.json());
      const client = new SessionClient({
        signer, session: demo.id, expect, maxPrice: BigInt(s.endpoint.price),
        state: { count: v.count, cumulative: v.cumulative, head: v.head, lastResponseHash: v.lastResponseHash },
      });
      const r = await client.get(url, {
        onStep: (name, x) => {
          if (name === 'quote') step('PASS', `HTTP 402: ${money(x.price)} for endpoint ${x.endpointId}`, `request hash ${short(x.requestHash)}`);
          if (name === 'voucher') step('PASS', `Voucher ${x.count} signed in your browser, no gas and no wallet`, `cumulative ${money(x.cumulative)}, chain head ${short(x.head)}`);
        },
      });
      if (r.status === 409 || r.status === 429) {
        step('SKIP', 'Another visitor got there first, signing the next step');
        await new Promise(res => setTimeout(res, 1200));
        continue;
      }
      const text = new TextDecoder().decode(r.body);
      if (r.status !== 200) {
        step('FAIL', `HTTP ${r.status}: not charged`, esc(text.slice(0, 200)));
        return;
      }
      step('PASS', 'HTTP 200: body received, its hash matches the provider-signed receipt', `response ${short(r.receipt.responseHash)}`);
      step('PASS', 'The next voucher of this session commits to this response hash', 'the key here is shared by visitors, so this shows the mechanism; a real client checks each response before it signs the next voucher');
      $('try-body').textContent = text;
      $('try-body').hidden = false;
      return;
    }
    step('FAIL', 'Busy right now: try again in a minute');
  }

  const btn = $('try-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const kind = $('try-kind').value;
      const arg = encodeURIComponent($('try-arg').value.trim());
      await buyOnce(`${base}/v1/${kind}/${arg}`);
    } catch (e) {
      step('FAIL', esc(e.message));
    } finally {
      btn.disabled = false;
      refresh();
    }
  });
  $('try-kind').addEventListener('change', () => {
    $('try-arg').value = $('try-kind').value === 'asset' ? '7777' : s.demoSession.payer;
  });

  // Anyone can replay the public log against the payer-signed heads on-chain and the ink! anchors.
  $('try-verify').addEventListener('click', async () => {
    const out = $('try-verdict');
    out.textContent = 'replaying the log and reading the chain…';
    try {
      const rows = [];
      for (let from = 1; ;) {
        const page = await fetch(`${base}/v1/session/${demo.id}/log?from=${from}`, { cache: 'no-store' }).then(r => r.json());
        rows.push(...page.rows);
        if (page.rows.length < 500) break;
        from = rows[rows.length - 1].n + 1;
      }
      const topic = eventTopic('Redeemed(bytes32,uint32,bytes32,uint96,uint96,uint32)');
      const logs = await evm.getLogs({ address: s.sessionContract, topics: [topic, demo.id], fromBlock: demo.openBlock, toBlock: 'latest' });
      const redemptions = logs.map(l => sessionIface.parseLog(l)).map(p => ({ head: p.args.head, count: Number(p.args.count), cumulative: p.args.cumulative }));
      const v = verifyLog(demo.id, rows, redemptions);
      const reg = new RawInkRegistry({ rpc: net.subRpc, accountId: s.registryAccountId, origin: s.readOrigin, selectors: s.selectors });
      for (const r of redemptions) {
        const a = await reg.anchor(s.endpoint.provider, r.head).catch(() => null);
        v.checks.push({ name: `ink! registry holds the anchor for the batch up to request ${r.count}`, ok: !!a, detail: a ? `block ${a.block}` : 'not found' });
      }
      const ok = v.checks.every(c => c.ok);
      const last = rows.slice(-5).reverse().map(r => `<tr><td>${r.n}</td><td class="mono">${esc(short(r.requestHash, 8))}</td><td class="mono">${esc(short(r.responseHash, 8))}</td></tr>`).join('');
      const batches = redemptions.map(r => `${r.count}`).join(', ');
      out.innerHTML = `<div class="verdict ${ok ? 'ACCEPT' : 'REJECT'}">${ok ? 'ACCEPT' : 'REJECT'}</div><ul class="checks">${v.checks.map(c =>
        `<li><span class="m ${c.ok ? 'PASS' : 'FAIL'}">${c.ok ? 'PASS' : 'FAIL'}</span><span><b>${esc(c.name)}</b> <span class="d">${esc(short(String(c.detail), 10))}</span></span></li>`).join('')}</ul>
        <p class="muted">Session ${esc(short(demo.id, 8))}: ${rows.length} requests in the public log, redeemed on-chain in batches up to request ${esc(batches || 'none yet')}. The latest requests:</p>
        <div class="table-scroll"><table><thead><tr><th>request</th><th>request hash</th><th>response hash</th></tr></thead><tbody>${last}</tbody></table></div>`;
    } catch (e) {
      out.innerHTML = `<div class="verdict REJECT">REJECT</div><p class="muted">${esc(e.message)}</p>`;
    }
  });
  await refresh();
  setInterval(refresh, 30_000);
}
