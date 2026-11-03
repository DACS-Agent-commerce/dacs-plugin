import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, makeTempDir } from '../lib/gate-fixtures.mjs';

const GLOB_REQUIRED_NODE_MAJOR = 22;
const PASSING_TEST = "import { test } from 'node:test';\ntest('passes', () => {});\n";
const FAILING_TEST = "import { test } from 'node:test';\ntest('fails', () => { throw new Error('planned failure'); });\n";
const NESTED_TEST_FILES = ['test/public-gate/engine.test.mjs', 'test/lib/choice.test.mjs', 'test/ci/root-script.test.mjs'];
const PLUGIN_TEST_FILE = 'stdio-mcp/test/plugin.test.mjs';

function makeProject(failing) {
  const rootPackage = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const dir = makeTempDir('project');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: rootPackage.scripts.test } }));
  const plant = (file, source) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source);
  };
  for (const file of NESTED_TEST_FILES) plant(file, file === failing ? FAILING_TEST : PASSING_TEST);
  plant(PLUGIN_TEST_FILE, FAILING_TEST);
  return dir;
}

// A nested `node --test` that inherits this variable reports to the outer runner instead of printing its own results.
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.NODE_TEST_CONTEXT;
const runTestScript = (dir) => spawnSync('npm', ['test', '--silent'], { cwd: dir, env: CLEAN_ENV, encoding: 'utf8' });

test('the package\'s own test script, run exactly as package.json defines it on Node 22.23.3 in a temporary project with nested public-gate, lib and ci test files, runs all three and fails when any one fails; a plugin test file beside them is not collected', async (t) => {
  if (Number(process.versions.node.split('.')[0]) < GLOB_REQUIRED_NODE_MAJOR) {
    t.skip('node --test expands its glob only from Node 22');
    return;
  }
  const passing = runTestScript(makeProject(null));
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  assert.match(passing.stdout, /# tests 3\b/);
  assert.match(passing.stdout, /# pass 3\b/);
  for (const failing of NESTED_TEST_FILES) {
    const result = runTestScript(makeProject(failing));
    assert.notEqual(result.status, 0, failing);
    assert.match(result.stdout, /# fail 1\b/);
    assert.match(result.stdout, /# tests 3\b/);
  }
});
