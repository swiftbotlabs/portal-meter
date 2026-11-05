// examples/paid-indexer is a consumer of the package, not part of it: it imports 'portal-meter' by name. Here it is
// copied to an empty folder with this repository linked in as its installed 'portal-meter', so it can only reach the
// published entry points, and its own tests run there. (examples/paid-indexer/RUN.md records the real thing: a clean
// install from the packed tarball and a paid call settled on the Portaldot testnet.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PATHS } from '../src/config.mjs';

const EXAMPLE = join(PATHS.root, 'examples', 'paid-indexer');

test('the example only imports public entry points of the package', () => {
  const files = [...readdirSync(EXAMPLE).filter(f => f.endsWith('.mjs')), 'worker/index.mjs'];
  assert.ok(files.length >= 7, 'the example files are there');
  for (const f of files) {
    const src = readFileSync(join(EXAMPLE, f), 'utf8');
    assert.doesNotMatch(src, /from '\.\.\/\.\.\//, `${f} reaches into the repository`);
    for (const m of src.matchAll(/from '(portal-meter[^']*)'/g)) {
      assert.match(m[1], /^portal-meter(\/(session-client|chain|settle|address|verify|deployments\/(sessions|testnet)\.json))?$/, `${f}: ${m[1]}`);
    }
  }
});

test('the example passes its own tests from a folder of its own', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-consumer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(EXAMPLE, dir, { recursive: true, filter: src => !/node_modules|ledger\.json|session\.json/.test(src) });
  mkdirSync(join(dir, 'node_modules'));
  symlinkSync(PATHS.root, join(dir, 'node_modules', 'portal-meter'), 'dir');
  symlinkSync(join(PATHS.root, 'node_modules', 'ethers'), join(dir, 'node_modules', 'ethers'), 'dir');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // otherwise the inner runner reports to ours instead of printing
  const r = spawnSync(process.execPath, ['--test', 'test/app.test.mjs'], { cwd: dir, env, encoding: 'utf8', timeout: 90_000 });
  const pass = Number(/# pass (\d+)/.exec(r.stdout)?.[1] ?? 0);
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
  assert.match(r.stdout, /# fail 0/);
  assert.ok(pass >= 8, `only ${pass} tests ran`);
});
