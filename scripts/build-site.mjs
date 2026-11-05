#!/usr/bin/env node
// Builds worker/public: the live page, deck, docs, contracts, proofs and a source archive with the full commit history,
// served by the hosted seller itself. Run from the repository root before `wrangler deploy`.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/config.mjs';

const ROOT = PATHS.root;
const OUT = join(ROOT, 'worker', 'public');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1 << 28 });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const d of ['demo', 'src']) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });
// the published deployment record only: resumable deploy state and local seller state stay on the machine
for (const f of ['testnet.json', 'sessions.json', 'proof', 'receipts']) cpSync(join(ROOT, 'deployments', f), join(OUT, 'deployments', f), { recursive: true });
mkdirSync(join(OUT, 'pitch'));
for (const f of ['portal-meter-deck.pdf', 'architecture.svg', 'block-events.png', 'demo-page.png', 'cost-per-request.png', 'cost-per-request.svg']) cpSync(join(ROOT, 'pitch', f), join(OUT, 'pitch', f));

// plain text, so that a browser shows them instead of downloading them
mkdirSync(join(OUT, 'read'));
const read = (from, name) => cpSync(join(ROOT, from), join(OUT, 'read', `${name}.txt`));
read('README.md', 'README');
read('SECURITY.md', 'SECURITY');
for (const f of readdirSync(join(ROOT, 'docs'))) read(join('docs', f), f.replace(/\.md$/, ''));
read('contracts/evm/src/MeterSession.sol', 'MeterSession.sol');
read('contracts/evm/src/MeterSettlement.sol', 'MeterSettlement.sol');
read('contracts/ink/meter_registry/lib.rs', 'meter_registry.lib.rs');
read('worker/src/index.mjs', 'worker-index.mjs');
read('src/meter.mjs', 'meter.mjs');
read('src/session.mjs', 'session.mjs');
read('src/settler.mjs', 'settler.mjs');
read('examples/paid-indexer/README.md', 'paid-indexer-README');
read('examples/paid-indexer/RUN.md', 'paid-indexer-RUN');
read('examples/paid-indexer/server.mjs', 'paid-indexer-server.mjs');

mkdirSync(join(OUT, 'source'));
const excludes = [':(exclude)demo/portal-meter-demo.mp4', ':(exclude)contracts/evm/lib'];
writeFileSync(join(OUT, 'source', 'portal-meter-src.tar.gz'), git('archive', '--format=tar.gz', 'HEAD', '--', '.', ...excludes));
writeFileSync(join(OUT, 'source', 'commit-history.txt'), git('log', '--date=iso-strict', '--stat', '--format=%H%n%ad %an%n%s%n'));
const bundle = join(OUT, 'source', 'portal-meter.bundle');
git('bundle', 'create', bundle, '--all');
const data = readFileSync(bundle);
const PART = 24 * 1024 * 1024; // the host's limit is 25 MiB per file
const parts = [];
for (let i = 0, n = 0; i < data.length; i += PART, n += 1) {
  const name = `portal-meter.bundle.part${n}`;
  writeFileSync(join(OUT, 'source', name), data.subarray(i, i + PART));
  parts.push(name);
}
rmSync(bundle);
// the package itself, for `npm i <url>` when GitHub is out of reach: exactly what `npm pack` ships (package.json "files")
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tgz = `${pkg.name}-${pkg.version}.tgz`;
execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', join(OUT, 'source')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
if (!statSync(join(OUT, 'source', tgz)).isFile()) throw new Error(`npm pack did not write ${tgz}`);

const head = git('rev-parse', '--short', 'HEAD').toString().trim();
const count = git('rev-list', '--count', 'HEAD').toString().trim();
// the landing page: site/index.html is the template, site/assets its styles, script, fonts and icon
cpSync(join(ROOT, 'site', 'assets'), join(OUT, 'assets'), { recursive: true });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// the seller's health at publish time, so the page carries a real number without JavaScript; the page script reads it live
let health = 'Seller health: requests settled so far, read live from <a class="link" href="health">health</a>.';
try {
  const h = await fetch('https://portal-meter.swiftbotlab.workers.dev/health', { signal: AbortSignal.timeout(10_000) }).then(r => (r.ok ? r.json() : null));
  if (h && Number.isInteger(h.requestsSettled) && Number.isInteger(h.batches) && Number.isInteger(h.requestsWaitingForSettlement)) {
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    health = `At publish, ${at} UTC: <b>${h.requestsSettled}</b> requests settled in <b>${h.batches}</b> transactions, <b>${h.requestsWaitingForSettlement}</b> waiting for the next batch. <a class="link" href="health">health</a>`;
  }
} catch { /* offline build: keep the plain line */ }
const vars = {
  HEAD: esc(head), COUNT: esc(count), TGZ: esc(tgz), HEALTH: health,
  PARTS: parts.map(p => `<a href="source/${esc(p)}">${esc(p.split('.').pop())}</a>`).join(' '),
};
let page = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
page = page.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => {
  if (!(k in vars)) throw new Error(`site/index.html: unknown placeholder ${m}`);
  return vars[k];
});
writeFileSync(join(OUT, 'index.html'), page);
const size = dir => readdirSync(dir).reduce((n, f) => { const p = join(dir, f); const s = statSync(p); return n + (s.isDirectory() ? size(p) : s.size); }, 0);
console.log(`worker/public: ${(size(OUT) / 1e6).toFixed(1)} MB, head ${head}, ${count} commits, ${parts.length} bundle parts`);
