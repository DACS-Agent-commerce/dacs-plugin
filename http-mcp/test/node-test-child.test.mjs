// The rules test/helpers/node-test-child.mjs documents, checked against fixture files in
// test/fixtures/node-test-child/, and the kill and pass predicates the mutant helpers share.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTests, killed, passed, runNodeTest } from './helpers/node-test-child.mjs';
import { loadFailure } from './helpers/showcase-ledger-mutants.mjs';

const fixtures = fileURLToPath(new URL('fixtures/node-test-child/', import.meta.url));
// Every run's private reporter directory goes under TMPDIR: a fresh one shows what is left behind.
const ownTmp = mkdtempSync(join(tmpdir(), 'ntc-test-'));
process.env.TMPDIR = ownTmp;
after(() => rmSync(ownTmp, { recursive: true, force: true }));
const base = { cwd: fixtures, timeoutMs: 20000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const groupAlive = (group) => alive(-group);
const leftovers = (dir) => readdirSync(dir).filter((name) => name.startsWith('node-test-child-'));
const sorted = (names) => [...names].sort();
const verdict = (run) => ({ passed: passed(run), killed: killed(run) });

function driver(mode) {
  const tmp = mkdtempSync(join(ownTmp, 'driver-'));
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [join(fixtures, 'guard-driver.mjs'), mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  const line = async (pattern) => {
    for (let i = 0; i < 400; i++) { const match = pattern.exec(out); if (match) return { match, at: Date.now() }; await sleep(25); }
    throw new Error(`driver printed no ${pattern}: ${out}`);
  };
  return { child, tmp, exited, line, out: () => out };
}

test('timeoutMs and a non-empty expected list (or null) are required', () => {
  assert.throws(() => runNodeTest('pass.mjs', { cwd: fixtures, expected: null }), /timeoutMs is required/);
  assert.throws(() => runNodeTest('pass.mjs', { cwd: fixtures, expected: null, timeoutMs: 0 }), /timeoutMs is required/);
  for (const expected of [undefined, 'alpha', []]) assert.throws(() => runNodeTest('pass.mjs', { ...base, expected }), /expected is required/);
});

test('a passing file is complete and names results by suite, duplicates kept', async () => {
  let calls = 0;
  const run = await runNodeTest('pass.mjs', { ...base, expected: null, onSpawn: (pid) => { calls++; assert.equal(typeof pid, 'number'); } });
  assert.equal(calls, 1);
  assert.deepEqual([run.incomplete, run.exit, run.signal], [null, 0, null]);
  assert.equal(run.nodeVersion, process.version);
  assert.deepEqual([run.tests, run.pass, run.fail, run.cancelled, run.skipped, run.todo], [4, 4, 0, 0, 0, 0]);
  assert.deepEqual(sorted(run.names), ['alpha', 'dup', 'dup', 'suite', 'suite > inner']);
  assert.deepEqual(run.notOk, []);
  assert.deepEqual(verdict(run), { passed: true, killed: false });
});

test('expected names are a multiset, and a missing one makes the run incomplete', async () => {
  assert.equal((await runNodeTest('pass.mjs', { ...base, expected: ['alpha', 'suite > inner', 'suite', 'dup', 'dup'] })).incomplete, null);
  assert.match((await runNodeTest('pass.mjs', { ...base, expected: ['alpha', 'dup', 'dup', 'dup'] })).incomplete ?? '', /^1 expected test\(s\) have no result, first: dup$/);
  assert.match((await runNodeTest('pass.mjs', { ...base, expected: ['alpha', 'beta'] })).incomplete ?? '', /first: beta$/);
});

test('a failing file is a complete kill; lines in YAML blocks, even after one ending in ..., are not results', async () => {
  const run = await runNodeTest('fail.mjs', { ...base, expected: ['passes', 'fails'] });
  assert.deepEqual([run.incomplete, run.exit, run.tests, run.pass, run.fail], [null, 1, 2, 1, 1]);
  assert.deepEqual(run.names, ['passes', 'fails']);
  assert.deepEqual(run.notOk, ['fails']);
  // A failure keeps its block's own fields; the message's lines sit under `error:`.
  assert.deepEqual(run.failures.map(({ name }) => name), ['fails']);
  const { fields } = run.failures[0];
  assert.ok(fields.includes("code: 'ERR_ASSERTION'") && fields.includes('error: |-'), fields.join('\n'));
  assert.deepEqual(fields.filter((field) => !/^\w+:/.test(field)), []);
  assert.deepEqual(verdict(run), { passed: false, killed: true });
});

test('a result line inside a YAML block does not supply a missing subtest', async () => {
  const ok = await runNodeTest('nested.mjs', { ...base, expected: ['outer > inner', 'outer'] });
  assert.equal(ok.incomplete, null);
  assert.deepEqual(ok.names, ['outer > inner', 'outer']);
  const run = await runNodeTest('nested.mjs', { ...base, env: { ...process.env, SKIP_INNER: '1' }, expected: ['outer > inner', 'outer'] });
  assert.match(run.incomplete ?? '', /first: outer > inner$/);
  assert.deepEqual(verdict(run), { passed: false, killed: false });
});

test('results come from the private reporter, not from stdout', async () => {
  const spoof = await runNodeTest('no-tests-spoof.mjs', { ...base, expected: null });
  assert.equal(spoof.exit, 0);
  assert.equal(spoof.tap, '');
  assert.match(spoof.incomplete ?? '', /^no closing test summary/);
  const run = await runNodeTest('stdout-spoof.mjs', { ...base, expected: ['real'] });
  assert.equal(run.incomplete, null);
  assert.deepEqual([run.tests, run.pass, run.fail, run.names], [1, 1, 0, ['real']]);
});

test('process.exit(0) part-way leaves no summary: incomplete, neither a pass nor a kill', async () => {
  const run = await runNodeTest('exit-midway.mjs', { ...base, expected: null });
  assert.equal(run.exit, 0);
  assert.match(run.incomplete ?? '', /^no closing test summary/);
  assert.deepEqual(verdict(run), { passed: false, killed: false });
});

test('an exit code that disagrees with the summary makes the run incomplete', async () => {
  const late = await runNodeTest('late-error.mjs', { ...base, expected: null });
  assert.deepEqual([late.exit, late.fail], [1, 0]);
  assert.match(late.incomplete ?? '', /^exit code 1 disagrees with the summary$/);
  assert.match((await runNodeTest('exitcode.mjs', { ...base, expected: null })).incomplete ?? '', /^exit code 3 disagrees with the summary$/);
  // A failed test needs exit 1, not just a non-zero one.
  const run = await runNodeTest('fail-exit-3.mjs', { ...base, expected: null });
  assert.deepEqual([run.exit, run.fail], [3, 1]);
  assert.match(run.incomplete ?? '', /^exit code 3 disagrees with the summary$/);
  assert.deepEqual(verdict(run), { passed: false, killed: false });
});

test('a failed suite or root hook is complete but neither a pass nor a kill', async () => {
  const suite = await runNodeTest('suite-hook-fail.mjs', { ...base, expected: null });
  assert.deepEqual([suite.incomplete, suite.exit, suite.fail, suite.notOk], [null, 0, 0, ['suite']]);
  assert.deepEqual(verdict(suite), { passed: false, killed: false });
  // Later Node exits 1 for a failed suite: that agrees with the summary too.
  const later = await runNodeTest('suite-hook-fail.mjs', { ...base, env: { ...process.env, EXIT_CODE: '1' }, expected: null });
  assert.deepEqual([later.incomplete, later.exit, later.fail, later.notOk], [null, 1, 0, ['suite']]);
  assert.deepEqual(verdict(later), { passed: false, killed: false });
  const root = await runNodeTest('root-after-fail.mjs', { ...base, expected: null });
  assert.deepEqual([root.incomplete, root.exit, root.fail, root.notOk.length], [null, 0, 0, 1]);
  assert.deepEqual(verdict(root), { passed: false, killed: false });
  await assert.rejects(expectedTests('suite-hook-fail.mjs', base), /must pass with complete results: not ok: suite$/m);
  await assert.rejects(expectedTests('root-after-fail.mjs', base), /must pass with complete results: not ok: /);
});

test('a signal after the summary makes the run incomplete', async () => {
  const run = await runNodeTest('sigkill-after.mjs', { ...base, expected: null });
  assert.equal(run.signal, 'SIGKILL');
  assert.match(run.incomplete ?? '', /^the file was killed by SIGKILL$/);
});

test('the deadline kills the run group with SIGKILL', { timeout: 15000 }, async () => {
  const started = Date.now();
  const run = await runNodeTest('hang.mjs', { ...base, timeoutMs: 1500, expected: null });
  assert.equal(run.signal, 'SIGKILL');
  assert.match(run.incomplete ?? '', /^no exit within 1\.5 s; process group killed$/);
  assert.ok(Date.now() - started >= 1400, 'stopped before the deadline');
});

test('a test cancelled when the loop drains is a complete result; one never registered is missing', async () => {
  const pending = await runNodeTest('pending.mjs', { ...base, expected: ['ok', 'pending'] });
  assert.deepEqual([pending.incomplete, pending.exit, pending.tests, pending.pass, pending.cancelled], [null, 1, 2, 1, 1]);
  // A cancelled test needs exit 1, as a failed one does.
  const zero = await runNodeTest('pending.mjs', { ...base, env: { ...process.env, EXIT_CODE: '0' }, expected: ['ok', 'pending'] });
  assert.match(zero.incomplete ?? '', /^exit code 0 disagrees with the summary$/);
  assert.notEqual((await runNodeTest('tla.mjs', { ...base, expected: ['before', 'after'] })).incomplete, null);
});

test('a name pattern that matches no test ran no test', async () => {
  assert.match((await runNodeTest('pass.mjs', { ...base, args: ['--test-name-pattern=^nomatch$'], expected: null })).incomplete ?? '', /^the file ran no test$/);
  const run = await runNodeTest('pass.mjs', { ...base, args: ['--test-name-pattern=^alpha$'], expected: ['alpha'] });
  assert.equal(run.incomplete, null);
  assert.deepEqual(run.names, ['alpha']);
});

test('stdout or stderr over maxBuffer stops the run', { timeout: 20000 }, async () => {
  for (const file of ['big-output.mjs', 'big-stderr.mjs']) {
    const run = await runNodeTest(file, { ...base, maxBuffer: 100000, expected: null });
    assert.match(run.incomplete ?? '', /^output over 100000 bytes; process group killed$/, file);
  }
});

test('pipes held open by a process outside the group end the wait after 5 s', { timeout: 20000 }, async () => {
  const pidFile = join(ownTmp, 'holder.pid'), started = Date.now();
  try {
    const run = await runNodeTest('detached-holder.mjs', { ...base, env: { ...process.env, PID_FILE: pidFile }, expected: null });
    assert.match(run.incomplete ?? '', /^output held open 5 s after the file exited/);
    assert.ok(Date.now() - started >= 4500, 'gave up before the grace period');
  } finally { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
});

test('nothing in the run group outlives the file', { timeout: 15000 }, async () => {
  const pidFile = join(ownTmp, 'grandchild.pid');
  let pid;
  try {
    const run = await runNodeTest('same-group.mjs', { ...base, env: { ...process.env, PID_FILE: pidFile }, expected: null });
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(run.incomplete, null);
    assert.equal(alive(pid), false, 'grandchild still alive after the run resolved');
  } finally { if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('SKIP and TODO directives are not part of names; a failing TODO is not a failure, a failing SKIP is', async () => {
  const run = await runNodeTest('skip-todo.mjs', { ...base, expected: ['s', 't', 'fine'] });
  assert.deepEqual([run.incomplete, run.exit, run.tests, run.skipped, run.todo, run.pass], [null, 0, 3, 1, 1, 1]);
  assert.deepEqual(run.notOk, []);
  assert.equal(passed(run), true);
  // A failed SKIP is a failure all the same, though counted as skipped.
  const skipFail = await runNodeTest('skip-fail.mjs', { ...base, expected: ['skipped then fails', 'fine'] });
  assert.deepEqual([skipFail.incomplete, skipFail.exit, skipFail.fail, skipFail.skipped, skipFail.notOk], [null, 0, 0, 1, ['skipped then fails']]);
  assert.deepEqual(verdict(skipFail), { passed: false, killed: false });
});

test('NODE_TEST_CONTEXT is removed from the run env', async () => {
  assert.equal((await runNodeTest('pass.mjs', { ...base, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' }, expected: null })).incomplete, null);
});

test('a run that cannot start resolves as incomplete', { timeout: 10000 }, async () => {
  const run = await runNodeTest('pass.mjs', { ...base, cwd: join(ownTmp, 'no-such-dir'), expected: null });
  assert.match(run.incomplete ?? '', /could not run/);
});

test('expectedTests refuses a failing or incomplete unmutated run and caches per cwd, file and args', async () => {
  await assert.rejects(expectedTests('fail.mjs', base), /must pass with complete results: not ok: fails$/m);
  await assert.rejects(expectedTests('exit-midway.mjs', base), /must pass with complete results: no closing test summary/);
  const all = expectedTests('pass.mjs', base), again = expectedTests('pass.mjs', { ...base, timeoutMs: 1 });
  const alpha = expectedTests('pass.mjs', { ...base, args: ['--test-name-pattern=^alpha$'] });
  // The same file name in another directory is another file.
  const elsewhere = mkdtempSync(join(ownTmp, 'cwd-'));
  writeFileSync(join(elsewhere, 'pass.mjs'), "import { test } from 'node:test';\ntest('elsewhere', () => {});\n");
  const other = expectedTests('pass.mjs', { ...base, cwd: elsewhere });
  assert.equal(all, again);
  assert.notEqual(all, alpha);
  assert.notEqual(all, other);
  assert.deepEqual(sorted(await all), ['alpha', 'dup', 'dup', 'suite', 'suite > inner']);
  assert.deepEqual(await alpha, ['alpha']);
  assert.deepEqual(await other, ['elsewhere']);
});

for (const [mode, expectedExit] of [['sigterm', [143, null]], ['exit', [0, null]]]) {
  test(`${mode === 'sigterm' ? 'SIGTERM to' : 'process.exit in'} the helper kills the run group and removes its directory`, { timeout: 20000 }, async () => {
    const helper = driver(mode);
    const group = Number((await helper.line(/^group (\d+)$/m)).match[1]);
    try {
      if (mode === 'sigterm') { await sleep(300); helper.child.kill('SIGTERM'); }
      const { code, signal } = await helper.exited;
      assert.deepEqual([code, signal], expectedExit, helper.out());
      for (let i = 0; i < 100 && groupAlive(group); i++) await sleep(20);
      assert.equal(groupAlive(group), false, 'run group survived the helper');
      assert.deepEqual(leftovers(helper.tmp), []);
    } finally { try { process.kill(-group, 'SIGKILL'); } catch {} }
  });
}

test('a finished run leaves no timer behind', { timeout: 20000 }, async () => {
  const helper = driver('prompt');
  const { match, at } = await helper.line(/^resolved (.*)$/m);
  assert.equal(match[1], 'null');
  const { at: exitAt } = await helper.exited;
  assert.ok(exitAt - at < 3000, `helper lingered ${exitAt - at} ms after the run resolved`);
  assert.deepEqual(leftovers(helper.tmp), []);
});

test('the hanging fixture exits at its own deadline when parent cleanup cannot run', { timeout: 10000 }, async () => {
  // Speed up only the orphan deadline; the helper's longer timeout must not fire.
  const preload = join(ownTmp, 'fast-orphan-deadline.mjs');
  writeFileSync(preload, `
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => original(fn, delay === 120_000 ? 100 : delay, ...args);
  `);
  const run = await runNodeTest('hang.mjs', { ...base, args: ['--import', preload], expected: null });
  assert.equal(run.exit, 1, JSON.stringify(run));
  assert.equal(run.signal, null, 'the fixture exited itself rather than being killed by its parent');
  assert.match(run.incomplete, /no closing test summary/);
});

test('manual helper runs warn on a Node version different from the CI pin', { timeout: 10000 }, async () => {
  const helper = driver('version');
  const { code, signal } = await helper.exited;
  assert.deepEqual([code, signal], [0, null], helper.out());
  assert.match(helper.out(), /nodeVersion v99\.0\.0/);
  assert.match(helper.out(), /running v99\.0\.0; test-result parsing is validated on Node v22\.23\.3 \(the CI pin\)/);
});

test('showcase-ledger-mutants: only loader SyntaxErrors are refused; runtime errors, assertions and failing TODOs can catch regressions', async () => {
  for (const [load, expected, refused] of [['syntax', ['syntax'], true], ['missing', ['missing'], true], ['nested', ['suite > syntax', 'suite'], true],
    ['json', ['json'], false], ['mention', ['mention'], false], ['deep', ['deep'], false],
    ['deep-stack', ['deep-stack'], false], ['todo', ['real', 'todo'], false]]) {
    const run = await runNodeTest('load-failure.mjs', { ...base, env: { ...process.env, LOAD: load }, expected });
    assert.equal(killed(run), true, load);
    assert.equal(loadFailure(run), refused, load);
    if (load === 'syntax' || load === 'nested') assert.ok(run.failures.some(({ stack }) => stack.some((frame) => frame.includes('node:internal/modules/'))));
    if (load === 'json') assert.ok(run.failures[0].stack.some((frame) => frame.startsWith('JSON.parse')));
  }
  assert.equal(loadFailure({ failures: [], stderr: "SyntaxError: Unexpected token ';'" }), true);
});

test('no run leaves its reporter directory behind', () => {
  assert.deepEqual(leftovers(ownTmp), []);
});
