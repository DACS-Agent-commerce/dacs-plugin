import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeJobCheckout } from '../lib/workflow-fixtures.mjs';

const GLOB_REQUIRED_NODE_MAJOR = 22;
const HANG_LIMIT_MS = 60_000;
const EXIT = { fail: 1, unverifiable: 2 };
const RESULT_PREFIX = 'test-all: ';
const ROOT = 'Root gate, lib and CI tests';
const HTTP = 'http-mcp, browser files included';
const STDIO = 'stdio typecheck and unit tests';
const PENDING_RESULTS = ['Checker regression suite', 'W-6 import check, both plugins', 'Buyer execution suite', 'Buyer runtime refusal on the floor']
  .map((suite) => `${suite}: unverifiable (pending-P54c2)`);
const STDIO_FLOOR_NOT_RUN = `${STDIO}: unverifiable (runtime-20.19.0-not-run)`;
/** An executable file that stands in for the browser the http-mcp row requires. */
const BROWSER = process.execPath;

/** A stand-in suite: records its name in ORDER_LOG and the CI value it saw in CI_LOG, fails when FAIL_AT names it, and prints its pid then waits when HANG_AT names it. */
const STUB_SUITE = `import { appendFileSync } from 'node:fs';
const name = process.argv[2] ?? 'root';
appendFileSync(process.env.ORDER_LOG, name + '\\n');
appendFileSync(process.env.CI_LOG, name + '=' + process.env.CI + '\\n');
if (process.env.FAIL_AT === name) process.exit(1);
if (process.env.HANG_AT === name) {
  console.log('hang-pid ' + process.pid);
  setTimeout(() => {}, ${HANG_LIMIT_MS});
}
`;

/** A nested `node --test` that inherits this variable reports to the outer runner instead of running its files. */
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.NODE_TEST_CONTEXT;

/**
 * A temporary project holding the repository's real scripts, root package.json (so its real `test` and `test:all` scripts) and manifests.
 * The suites are stand-ins: a root test file, and the scripts of the http-mcp and stdio manifests.
 */
function makeMatrixProject() {
  return makeJobCheckout(({ dir, editJson }) => {
    const plant = (file) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), STUB_SUITE);
    };
    plant('test/stub.test.mjs');
    plant('http-mcp/stub-suite.mjs');
    plant('stdio-mcp/stub-suite.mjs');
    editJson('http-mcp', 'package.json', (manifest) => { manifest.scripts = { 'test:ci': 'node stub-suite.mjs http-mcp' }; });
    editJson('stdio-mcp', 'package.json', (manifest) => {
      manifest.scripts = { typecheck: 'node stub-suite.mjs stdio-typecheck', test: 'node stub-suite.mjs stdio-test' };
    });
  });
}

const orderLog = (dir) => path.join(dir, 'order.log');
const suitesRun = (dir) => (existsSync(orderLog(dir)) ? readFileSync(orderLog(dir), 'utf8').split('\n').filter(Boolean) : []);
const ciLog = (dir) => path.join(dir, 'ci.log');
const ciSeenBySuites = (dir) => (existsSync(ciLog(dir)) ? readFileSync(ciLog(dir), 'utf8').split('\n').filter(Boolean) : []);
const testAllArgs = ['run', 'test:all', '--silent'];
const resultsOf = (stdout) => stdout.split('\n').filter((line) => line.startsWith(RESULT_PREFIX)).map((line) => line.slice(RESULT_PREFIX.length));
const runTestAll = (dir, env = {}) => spawnSync('npm', testAllArgs, {
  cwd: dir, env: { ...CLEAN_ENV, ORDER_LOG: orderLog(dir), CI_LOG: ciLog(dir), DACS_TEST_CHROME: BROWSER, ...env }, encoding: 'utf8',
});
const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

/**
 * Starts `npm run test:all` in its own process group, waits until the stand-in named by HANG_AT prints its pid, then sends SIGINT
 * to that group, as a terminal does for Ctrl-C. The suites run in groups of their own, so only test:all can stop the stand-in.
 * Resolves { pid, code }.
 */
function interruptWhileHanging(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', testAllArgs, { cwd: dir, detached: true, env: { ...CLEAN_ENV, ORDER_LOG: orderLog(dir), CI_LOG: ciLog(dir), DACS_TEST_CHROME: BROWSER, HANG_AT: 'stdio-typecheck' }, stdio: ['ignore', 'pipe', 'inherit'] });
    let hangingPid = null;
    let seen = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      seen += chunk;
      const match = hangingPid === null && /hang-pid (\d+)/.exec(seen);
      if (match) {
        hangingPid = Number(match[1]);
        process.kill(-child.pid, 'SIGINT');
      }
    });
    child.on('close', (code) => resolve({ pid: hangingPid, code }));
  });
}

test('npm run test:all, executed as package.json defines it in a temporary project, runs the matrix\'s delivered rows in order through the real root test script, fails if any suite fails, reports an absent suite or unavailable input as unverifiable, and stops its child when interrupted', async (t) => {
  if (Number(process.versions.node.split('.')[0]) < GLOB_REQUIRED_NODE_MAJOR) {
    t.skip('node --test expands the root test script\'s glob only from Node 22');
    return;
  }

  await t.test('the delivered rows run in order through the real root test script; a row whose runtime this run is not on and the pending rows are unverifiable, never a pass', () => {
    const dir = makeMatrixProject();
    const result = runTestAll(dir);
    assert.equal(result.status, EXIT.unverifiable, result.stdout + result.stderr);
    assert.deepEqual(suitesRun(dir), ['root', 'http-mcp', 'stdio-typecheck', 'stdio-test']);
    assert.deepEqual(resultsOf(result.stdout), [`${ROOT}: pass`, `${HTTP}: pass`, STDIO_FLOOR_NOT_RUN, ...PENDING_RESULTS]);
  });

  await t.test('every suite runs with CI set, so the suites\' own refusals to skip in CI apply, whatever the caller\'s environment held', () => {
    for (const callerCi of [undefined, '', 'false']) {
      const dir = makeMatrixProject();
      const result = runTestAll(dir, callerCi === undefined ? {} : { CI: callerCi });
      assert.equal(result.status, EXIT.unverifiable, result.stdout + result.stderr);
      assert.deepEqual(ciSeenBySuites(dir), ['root=true', 'http-mcp=true', 'stdio-typecheck=true', 'stdio-test=true'], `caller CI ${JSON.stringify(callerCi)}`);
    }
  });

  await t.test('a row whose suite needs a runtime this run is not on is unverifiable, never a pass, even though the commands it ran passed', () => {
    const dir = makeMatrixProject();
    const result = runTestAll(dir);
    assert.deepEqual(suitesRun(dir), ['root', 'http-mcp', 'stdio-typecheck', 'stdio-test'], 'the commands ran on this run\'s runtime');
    assert.ok(resultsOf(result.stdout).includes(STDIO_FLOOR_NOT_RUN), result.stdout);
  });

  for (const [description, env, cause] of [
    ['unset', { DACS_TEST_CHROME: '' }, 'browser-unset'],
    ['not an existing file', { DACS_TEST_CHROME: path.join(os.tmpdir(), 'no-such-browser') }, 'browser-absent'],
  ]) {
    await t.test(`the http-mcp row is unverifiable (${cause}) when DACS_TEST_CHROME is ${description}, so its browser files cannot skip into a pass`, () => {
      const dir = makeMatrixProject();
      const result = runTestAll(dir, env);
      assert.equal(result.status, EXIT.unverifiable, result.stdout + result.stderr);
      assert.ok(resultsOf(result.stdout).includes(`${HTTP}: unverifiable (${cause})`), result.stdout);
      assert.ok(!suitesRun(dir).includes('http-mcp'));
    });
  }

  for (const [failing, expected] of [
    ['root', [`${ROOT}: fail (exit-1)`, `${HTTP}: pass`, STDIO_FLOOR_NOT_RUN]],
    ['stdio-test', [`${ROOT}: pass`, `${HTTP}: pass`, `${STDIO}: fail (exit-1)`]],
  ]) {
    await t.test(`a failing ${failing} suite fails the run, and the other rows still run and report`, () => {
      const dir = makeMatrixProject();
      const result = runTestAll(dir, { FAIL_AT: failing });
      assert.equal(result.status, EXIT.fail, result.stdout + result.stderr);
      assert.deepEqual(resultsOf(result.stdout), [...expected, ...PENDING_RESULTS]);
      assert.deepEqual(suitesRun(dir), ['root', 'http-mcp', 'stdio-typecheck', 'stdio-test']);
    });
  }

  await t.test('an absent suite is unverifiable with its own cause, not a pass and not a failure; an absent root takes the other rows\' SDK input with it, so no suite runs', () => {
    const dir = makeMatrixProject();
    rmSync(path.join(dir, 'stdio-mcp'), { recursive: true });
    const result = runTestAll(dir);
    assert.equal(result.status, EXIT.unverifiable, result.stdout + result.stderr);
    assert.deepEqual(resultsOf(result.stdout), [
      `${ROOT}: unverifiable (sdk-input-unavailable)`, `${HTTP}: unverifiable (sdk-input-unavailable)`, `${STDIO}: unverifiable (suite-absent)`, ...PENDING_RESULTS,
    ]);
    assert.deepEqual(suitesRun(dir), []);
  });

  await t.test('an interrupt stops the running suite, runs nothing after it and exits non-zero', async () => {
    const dir = makeMatrixProject();
    const { pid, code } = await interruptWhileHanging(dir);
    assert.ok(Number.isInteger(pid), 'the hanging suite started');
    assert.notEqual(code, 0);
    assert.equal(isRunning(pid), false, 'the suite process is gone');
    assert.deepEqual(suitesRun(dir), ['root', 'http-mcp', 'stdio-typecheck']);
  });
});
