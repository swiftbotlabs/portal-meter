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
for (const d of ['demo', 'src', 'deployments']) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });
mkdirSync(join(OUT, 'pitch'));
for (const f of ['portal-meter-deck.pdf', 'architecture.svg', 'block-events.png', 'demo-page.png']) cpSync(join(ROOT, 'pitch', f), join(OUT, 'pitch', f));

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

const head = git('rev-parse', '--short', 'HEAD').toString().trim();
const count = git('rev-list', '--count', 'HEAD').toString().trim();
const li = (href, text) => `<li><a href="${href}">${text}</a></li>`;
writeFileSync(join(OUT, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portal Meter</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#141a2b;background:#fff}h1{margin:0}a{color:#e6007a}code{background:#eef1f7;padding:1px 5px;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#0e111a;color:#e8ebf3}a{color:#ff4fa8}code{background:#1f2638}}</style></head><body>
<h1>Portal Meter</h1><p>Sell any API per call on Portaldot V3, settled across both of its contract VMs. By Swift Bot Labs.</p>
<ul>${li('demo/', 'Live page: buy a real API call, no wallet')}${li('demo/portal-meter-demo.mp4', 'Demo video, 2:30')}${li('pitch/portal-meter-deck.pdf', 'Pitch deck, PDF')}${li('read/README.txt', 'README')}${li('read/SESSIONS.txt', 'Sessions: protocol, guarantees and limits')}${li('read/ARCHITECTURE.txt', 'Architecture')}${li('read/SECURITY.txt', 'Security')}${li('read/PORTALDOT_V3_NOTES.txt', 'Measured Portaldot V3 notes')}</ul>
<h2>Source</h2><ul>${li('source/portal-meter-src.tar.gz', `Source at ${head}, ${count} commits`)}${li('source/commit-history.txt', 'Commit history with dates and files')}${li('read/MeterSession.sol.txt', 'MeterSession.sol')}${li('read/MeterSettlement.sol.txt', 'MeterSettlement.sol')}${li('read/meter_registry.lib.rs.txt', 'MeterRegistry (ink!)')}${li('read/worker-index.mjs.txt', 'The hosted seller')}${li('read/meter.mjs.txt', 'The metering core')}</ul>
<p>Full git history as a bundle, in parts: ${parts.map(p => `<a href="source/${p}">${p.split('.').pop()}</a>`).join(' ')}. Join them with <code>cat portal-meter.bundle.part* &gt; portal-meter.bundle</code>, then <code>git clone portal-meter.bundle</code>.</p>
<h2>Proof</h2><ul>${li('deployments/sessions.json', 'Sessions: contracts and transactions')}${li('deployments/testnet.json', 'Escrow: contracts and transactions')}${li('deployments/proof/session-measure.json', 'Measured costs')}${li('deployments/proof/session-negative-checks.json', 'Negative checks')}${li('.well-known/portal-meter', 'Seller catalog')}${li('health', 'Seller health')}</ul>
</body></html>\n`);
const size = dir => readdirSync(dir).reduce((n, f) => { const p = join(dir, f); const s = statSync(p); return n + (s.isDirectory() ? size(p) : s.size); }, 0);
console.log(`worker/public: ${(size(OUT) / 1e6).toFixed(1)} MB, head ${head}, ${count} commits, ${parts.length} bundle parts`);
