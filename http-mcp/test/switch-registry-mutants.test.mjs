// Keep freshness checks outside the behavior tests executed against mutants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutations, staleAnchors } from './helpers/switch-registry-mutants.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = 'test/helpers/switch-registry-mutants.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'switch-mutation-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source');
  const copy = (path) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    cpSync(join(root, path), join(source, path), { recursive: true });
  };
  for (const path of new Set([runner, ...mutations.map(([, path]) => path)])) copy(path);
  return { base, source, copy };
}

function runnerEnv(extra = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', ...extra };
  // The CLI must start independent test runners, outside this test harness.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('switch mutation anchors match exactly once outside mutant behavior tests', () => {
  assert.deepEqual(staleAnchors(), []);
  assert.ok(mutations.every(([, , , , tests]) => !tests.includes('test/switch-registry-mutants.test.mjs')));
});

for (const [label, count] of [['missing', 0], ['repeated', 2]]) {
  test(`${label} mutation anchor refuses the CLI before mirror setup or test execution`, t => {
    const { base, source } = fixture(t);
    const [name, path, before] = mutations[0];
    const file = join(source, path), original = readFileSync(file, 'utf8');
    writeFileSync(file, count === 0 ? original.replace(before, '') : `${original}\n${before}`);
    assert.deepEqual(staleAnchors(source), [[name, path, count]]);
    const marker = join(base, 'started'), preload = join(base, 'forbid-run.mjs'), output = join(base, 'results.jsonl');
    // Trap both stages, so even creating a mirror and cleaning it up would fail.
    writeFileSync(preload, `import fs from 'node:fs';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
function started(stage) { fs.writeFileSync(${JSON.stringify(marker)}, stage); throw new Error(stage); }
fs.mkdtempSync = () => started('mirror setup');
child.spawnSync = () => started('test execution');
syncBuiltinESMExports();
`);
    const run = spawnSync(process.execPath, ['--import', preload, join(source, runner), output], {
      encoding: 'utf8', timeout: 10_000, env: runnerEnv(),
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Mutation anchors missing or repeated, nothing run:/);
    assert.ok(run.stderr.includes(`${path}: ${count} matches`), run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(existsSync(marker), false, 'neither setup nor tests start');
    assert.equal(existsSync(output), false, 'no mutation results are written');
  });
}

test('a behavior-preserving mutation survives without an anchor freshness false kill', t => {
  const { base, source, copy } = fixture(t);
  for (const path of ['src/switches', 'deploy/env-contract.json', 'test/switch-registry.test.mjs', 'test/helpers/env-contract-view.mjs']) copy(path);
  mkdirSync(join(source, 'node_modules'));
  const registry = 'test/switch-registry.test.mjs';
  const neutral = ['neutral parentheses', 'src/config.mjs', 'const value = env[s.env] ?? s.default;', 'const value = (env[s.env] ?? s.default);', [registry]];
  const script = join(source, runner), original = readFileSync(script, 'utf8');
  writeFileSync(script, original.replace(/export const mutations = \[[\s\S]+?\n\];/, `export const mutations = ${JSON.stringify([neutral])};`));
  const scratch = join(base, 'tmp'), output = join(base, 'results.jsonl');
  mkdirSync(scratch);
  const run = spawnSync(process.execPath, [script, output], {
    encoding: 'utf8', timeout: 20_000, env: runnerEnv({ TMPDIR: scratch }),
  });
  assert.equal(run.status, 1, run.stderr || run.stdout); // A surviving mutant makes the sweep fail.
  const [baseline] = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(baseline, { baseline: { [registry]: [] } });
  const [result] = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(result.name, neutral[0]);
  assert.equal(result.killed, false);
  assert.deepEqual(result.runs, [{ test: registry, exit: 0, failing: [], killed: false }]);
});
