import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, chmodSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carryOver, classify, discover, judge, matches, newState, readKnown, record, CARRY_OVER, TIMEOUT, PROCESS, INCOMPLETE } from '../scripts/run-test-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = join(root, 'scripts/run-test-files.mjs');
const fixture = (name) => `test/fixtures/ci-runner/${name}.mjs`;
// The whole message of the fixtures' `assert.equal(1, 2)`.
const unequal = 'Expected values to be strictly equal:\n\n1 !== 2\n';
const entry = (file, name, expect = unequal) => ({ file, test: name, reason: 'Intentional fixture failure.', class: 'main-defect', expect });
const failure = 'exact failure # name: café';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-ci-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function run(dir, files, { known, timeout = 10, cwd = root, env = {} } = {}) {
  const out = join(dir, 'results.jsonl'), knownPath = join(dir, 'known.json');
  if (known !== undefined) writeFileSync(knownPath, JSON.stringify(known));
  const args = [runner, cwd, out, String(timeout), ...(known === undefined ? [] : ['--known', knownPath]), ...files];
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
  return { ...result, rows: existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

test('an exact known failure passes the gate and preserves test counts', async (t) => {
  const file = fixture('fail');
  const result = await run(setup(t), [file], { known: [entry(file, failure)] });
  assert.equal(result.code, 0);
  assert.equal(result.rows[0].exit, 1);
  assert.equal(result.rows[0].fail, 1);
  assert.deepEqual(result.rows[0].knownFailures, [failure]);
  assert.deepEqual(result.rows[0].newFailures, []);
});

test('a new failure fails without a baseline or with the wrong exact test name', async (t) => {
  const dir = setup(t), file = fixture('fail');
  for (const known of [undefined, [entry(file, 'different name')], [entry(fixture('mixed'), failure)]]) {
    const result = await run(dir, [file], { known });
    assert.equal(result.code, 1);
    assert.deepEqual(result.rows[0].newFailures, [failure]);
  }
});

test('failed files retain TAP diagnostics next to the JSON lines; passing files do not', async (t) => {
  const dir = setup(t), file = fixture('fail');
  const result = await run(dir, [file, fixture('pass')], { known: [entry(file, failure)] });
  assert.equal(result.code, 0);
  const tapDir = join(dir, 'results.jsonl.failures');
  const tap = readFileSync(join(tapDir, `${file.replace(/[\\/]/g, '__')}.tap`), 'utf8');
  assert.match(tap, /TAP version 13/);
  assert.match(tap, /not ok 1 - exact failure/);
  assert.match(tap, /ERR_ASSERTION/);
  assert.match(tap, /stack:/);
  assert.equal(existsSync(join(tapDir, `${fixture('pass').replace(/[\\/]/g, '__')}.tap`)), false);
});

test('a known failure never hides another failing test in the same file', async (t) => {
  const file = fixture('mixed');
  const result = await run(setup(t), [file, fixture('pass')], { known: [entry(file, failure)] });
  assert.equal(result.code, 1);
  assert.equal(result.rows.length, 2, 'continues after a failure');
  assert.deepEqual(result.rows.find((row) => row.file === file).newFailures, ['a new failure in the same file']);
});

test('a timeout fails unless explicitly known and kills the process group', async (t) => {
  const dir = setup(t), file = fixture('timeout'), pidFile = join(dir, 'descendant.pid');
  for (const known of [[], [entry(file, '[timeout]', 'no exit within 1 s')]]) {
    const result = await run(dir, [file, fixture('pass')], { timeout: 1, known, env: { CI_RUNNER_PID_FILE: pidFile } });
    assert.equal(result.code, known.length ? 0 : 1);
    assert.equal(result.rows.length, 2);
    const row = result.rows.find((row) => row.file === file);
    assert.equal(row.timedOut, true);
    assert.deepEqual(row.failing, ['[timeout]']);
    assert.match(readFileSync(join(dir, 'results.jsonl.failures', `${file.replace(/[\\/]/g, '__')}.tap`), 'utf8'), /TAP version 13/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); } catch (err) { assert.equal(err.code, 'ESRCH'); break; }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});

test('a file whose tests pass but which never exits times out instead of being forced to succeed', async (t) => {
  const file = fixture('linger');
  const result = await run(setup(t), [file, fixture('pass')], { timeout: 1 });
  assert.equal(result.code, 1);
  const row = result.rows.find((row) => row.file === file);
  assert.equal(row.timedOut, true);
  assert.deepEqual(row.failing, ['[timeout]']);
  assert.deepEqual(row.newFailures, ['[timeout]']);
  assert.ok(row.ms >= 1000 && row.ms < 5000, `ended by the 1 s deadline, after ${row.ms} ms`);
  assert.equal(result.rows.find((row) => row.file === fixture('pass')).exit, 0, 'continues after the timeout');
});

test('a known failure that now passes fails until its entry is removed; a skipped test does neither', async (t) => {
  const dir = setup(t), file = fixture('pass');
  const result = await run(dir, [file], { known: [entry(file, 'previous failure now passes'), entry(file, 'skipped test')] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].newFailures, []);
  assert.deepEqual(result.rows[0].knownNowPassing, ['previous failure now passes']);
  assert.deepEqual(result.rows[0].staleKnown, []);
  assert.match(result.stderr, /Known failure now passes: Known failure now passes; remove its entry: test\/fixtures\/ci-runner\/pass\.mjs: previous failure now passes/);
  const skipped = await run(dir, [file], { known: [entry(file, 'skipped test')] });
  assert.equal(skipped.code, 0, 'a skipped known failure is neither passing nor stale');
});

test('a baseline entry that matches no test in its file fails the gate as stale', async (t) => {
  const file = fixture('pass');
  const result = await run(setup(t), [file], { known: [entry(file, 'previous failure now passes'), entry(file, 'removed test')] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].newFailures, []);
  assert.deepEqual(result.rows[0].knownNowPassing, ['previous failure now passes']);
  assert.deepEqual(result.rows[0].staleKnown, ['removed test']);
  assert.match(result.stderr, /Stale known failure: Known failure matches no test: test\/fixtures\/ci-runner\/pass\.mjs: removed test/);
  assert.match(result.stdout, /1 stale known failures/);
});

test('a discovery run reports entries for files that no longer exist as stale', async (t) => {
  const dir = setup(t);
  mkdirSync(join(dir, 'test'), { recursive: true });
  copyFileSync(join(root, fixture('pass')), join(dir, 'test/unit.test.mjs'));
  const result = await run(dir, [], { cwd: dir, known: [entry('test/removed.test.mjs', 'old failure')] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Known failure matches no test: test\/removed\.test\.mjs: old failure/);
  const selected = await run(dir, ['test/unit.test.mjs'], { cwd: dir, known: [entry('test/removed.test.mjs', 'old failure')] });
  assert.equal(selected.code, 0, 'an explicit file selection only judges the selected files');
});

test('same-named tests in different describe blocks are told apart by their suite path', async (t) => {
  const dir = setup(t), file = fixture('suites');
  const all = await run(dir, [file]);
  assert.equal(all.code, 1);
  assert.deepEqual(all.rows[0].failing, ['block a > same name', 'block a', 'block b > same name', 'block b']);
  const result = await run(dir, [file], { known: [entry(file, 'block a > same name', 'known failure'), entry(file, 'block a', '1 subtest failed')] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].knownFailures, ['block a > same name', 'block a']);
  assert.deepEqual(result.rows[0].newFailures, ['block b > same name', 'block b']);
  assert.deepEqual(result.rows[0].staleKnown, []);
});

test('suite paths follow nested and sibling describe blocks', async (t) => {
  const file = fixture('nested');
  const result = await run(setup(t), [file], { known: [entry(file, 'outer > inner a > leaf', 'a')] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].knownFailures, ['outer > inner a > leaf']);
  assert.deepEqual(result.rows[0].newFailures, ['outer > inner a', 'outer > inner b > leaf', 'outer > inner b', 'outer > after', 'outer', 'top']);
});

test('a stale entry fails the gate even in a file whose other failures are known', async (t) => {
  const file = fixture('fail');
  const result = await run(setup(t), [file], { known: [entry(file, failure), entry(file, 'renamed test')] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].knownFailures, [failure]);
  assert.deepEqual(result.rows[0].newFailures, []);
  assert.deepEqual(result.rows[0].staleKnown, ['renamed test']);
});

test('a [timeout] entry on a file that now completes fails as now passing, not as stale', async (t) => {
  const file = fixture('pass');
  const result = await run(setup(t), [file], { known: [entry(file, '[timeout]', 'no exit within')] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].newFailures, []);
  assert.deepEqual(result.rows[0].knownNowPassing, ['[timeout]']);
  assert.deepEqual(result.rows[0].staleKnown, []);
});

test('each baseline entry carries a class from the fixed set', async (t) => {
  const dir = setup(t), file = fixture('fail');
  for (const cls of ['main-defect', 'environment', 'browser']) {
    const result = await run(dir, [file], { known: [{ ...entry(file, failure), class: cls }] });
    assert.equal(result.code, 0, cls);
  }
  const { class: _, ...unclassed } = entry(file, failure);
  for (const known of [[unclassed], [{ ...unclassed, class: 'flaky' }], [{ ...unclassed, class: '' }]]) {
    const result = await run(setup(t), [file], { known });
    assert.equal(result.code, 1);
    assert.equal(result.rows.length, 0);
    assert.match(result.stderr, /Invalid known failure entry/);
  }
});

test('appends a GitHub summary and emits notices with file and exact test name', async (t) => {
  const dir = setup(t), summary = join(dir, 'summary.md');
  writeFileSync(summary, 'Earlier step\n');
  const result = await run(dir, [fixture('fail'), fixture('pass')], {
    known: [entry(fixture('pass'), 'previous failure now passes')],
    env: { GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /::error::Known failure now passes; remove its entry: /);
  assert.match(result.stderr, /::error::.*exact failure # name: café/);
  const content = readFileSync(summary, 'utf8');
  assert.match(content, /^Earlier step\n/);
  assert.match(content, /2 files; 3 tests; 1 passed; 1 failed/);
  assert.match(content, /### New failures[\s\S]*fail\.mjs: exact failure # name: café/);
  assert.match(content, /### Known failures now passing \(remove their entries\)[\s\S]*pass\.mjs: previous failure now passes/);
});

// A directory shaped like a checkout: nested tests, browser files and files discovery never takes.
function discoveryTree(t) {
  const dir = setup(t);
  for (const folder of ['test/browser', 'test/fixtures', 'test/helpers', 'test/sub/deeper', 'test/sub/fixtures', 'deploy/test']) mkdirSync(join(dir, folder), { recursive: true });
  for (const file of ['test/unit.test.mjs', 'test/sub/nested.test.mjs', 'test/sub/deeper/leaf.test.mjs', 'test/top.browser.test.mjs', 'test/browser/other.test.mjs']) copyFileSync(join(root, fixture('pass')), join(dir, file));
  for (const file of ['deploy/test/unit.test.mjs', 'test/dacs-loopback-fixture.test.mjs', 'test/fixtures/fail.test.mjs', 'test/helpers/fail.test.mjs',
    'test/sub/fixtures/fail.test.mjs', 'test/helper.mjs', 'test/old.test.js', 'test/unit.test.mjs.bak', 'test/sub/notes.test.mjs.txt']) copyFileSync(join(root, fixture('fail')), join(dir, file));
  return dir;
}

test('discovery includes browser files only with the browser flag, and test:ci passes it', async (t) => {
  const dir = discoveryTree(t), plain = ['test/sub/deeper/leaf.test.mjs', 'test/sub/nested.test.mjs', 'test/unit.test.mjs'];
  assert.deepEqual(discover(dir, 'test').sort(), plain);
  assert.deepEqual(discover(dir, 'test', true).sort(), [...plain, 'test/browser/other.test.mjs', 'test/top.browser.test.mjs'].sort());
  const without = await run(dir, [], { cwd: dir });
  assert.equal(without.code, 0, without.stderr);
  assert.deepEqual(without.rows.map((row) => row.file), plain);
  const withFlag = await run(dir, ['--browser'], { cwd: dir });
  assert.equal(withFlag.code, 0, withFlag.stderr);
  assert.deepEqual(withFlag.rows.map((row) => row.file), ['test/browser/other.test.mjs', 'test/sub/deeper/leaf.test.mjs', 'test/sub/nested.test.mjs', 'test/top.browser.test.mjs', 'test/unit.test.mjs']);
  assert.match(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts['test:ci'], / --browser( |$)/);
});

test('discovery has one root, test/; a missing root fails', async (t) => {
  const dir = discoveryTree(t);
  const result = await run(dir, [], { cwd: dir });
  assert.ok(!result.rows.some((row) => row.file.startsWith('deploy/')), 'deploy/test is no discovery root');
  rmSync(join(dir, 'test'), { recursive: true });
  rmSync(join(dir, 'results.jsonl'));
  const missing = await run(dir, [], { cwd: dir });
  assert.equal(missing.code, 1);
  assert.equal(missing.rows.length, 0);
  assert.match(missing.stderr, /Test root not found: test/);
  assert.equal(existsSync(join(dir, 'deploy/test/unit.test.mjs')), true);
});

test('the documented discovery counts equal the runner\'s discovery with and without browser files', () => {
  const docs = readFileSync(join(root, 'docs/CI.md'), 'utf8');
  const counts = docs.match(/discovery finds (\d+) files under `test\/`, browser files included\s+\((\d+) without `--browser`\)/);
  assert.ok(counts, 'document the current numbers of discovered files, with and without browser files');
  const withBrowser = discover(root, 'test', true), without = discover(root, 'test');
  assert.ok(without.length > 0 && withBrowser.length > without.length);
  assert.equal(Number(counts[1]), withBrowser.length);
  assert.equal(Number(counts[2]), without.length);
});

test('a discovery that finds no test file fails', async (t) => {
  const dir = setup(t);
  mkdirSync(join(dir, 'test/fixtures'), { recursive: true });
  copyFileSync(join(root, fixture('pass')), join(dir, 'test/fixtures/only.test.mjs'));
  const result = await run(dir, [], { cwd: dir });
  assert.equal(result.code, 1);
  assert.equal(result.rows.length, 0);
  assert.match(result.stderr, /Expected unique relative test files/);
});

test('the runner works when started by an absolute path through a symlinked checkout', async (t) => {
  const dir = setup(t), link = join(dir, 'checkout'), out = join(dir, 'results.jsonl');
  symlinkSync(root, link);
  for (const options of [[], ['--preserve-symlinks-main']]) {
    rmSync(out, { force: true });
    const code = await new Promise((done) => spawn(process.execPath, [...options, join(link, 'scripts/run-test-files.mjs'), root, out, '10', fixture('fail')],
      { env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: 'false' }, stdio: 'ignore' }).on('close', done));
    assert.equal(code, 1, options.join(' '));
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).newFailures, [failure], options.join(' '));
  }
});

test('a file process that cannot start keeps its error and stderr; a finished file does not wait for its deadline', async (t) => {
  const dir = setup(t), file = fixture('pass');
  const unstarted = await run(dir, [file], { cwd: join(dir, 'missing') });
  assert.equal(unstarted.code, 1);
  assert.match(unstarted.rows[0].error, /ENOENT/);
  assert.deepEqual(unstarted.rows[0].failures[0], { test: PROCESS, error: unstarted.rows[0].error });
  const missing = 'test/missing-ci-fixture.mjs', absent = await run(dir, [missing]);
  assert.match(absent.rows[0].stderr, /Could not find/);
  assert.match(readFileSync(join(dir, 'results.jsonl.failures', `${missing.replace(/[\\/]/g, '__')}.tap`), 'utf8'), /^# stderr: Could not find/m);
  const started = Date.now(), prompt = await run(dir, [file], { timeout: 120 });
  assert.equal(prompt.code, 0);
  assert.ok(Date.now() - started < 30000, `exited ${Date.now() - started} ms after start with a 120 s deadline`);
});

test('malformed and duplicate known failures fail closed', async (t) => {
  const dir = setup(t), file = fixture('fail'), valid = entry(file, failure);
  const { expect: _, ...unexpected } = valid;
  for (const known of [{}, [null], ['entry'], [{ ...valid, extra: true }], [{ ...valid, reason: '' }], [unexpected], [{ ...valid, expect: ' ' }], [valid, valid]]) {
    const result = await run(dir, [file], { known });
    assert.equal(result.code, 1);
    assert.equal(result.rows.length, 0);
  }
});

test('a run without TMPDIR gives all its files one fresh private TMPDIR under the system temp directory', async (t) => {
  const dir = setup(t), system = join(dir, 'system-tmp'), record = join(dir, 'tmpdirs.txt');
  mkdirSync(system);
  chmodSync(system, 0o1777);
  mkdirSync(join(dir, 'test'), { recursive: true });
  for (const file of ['test/a.test.mjs', 'test/b.test.mjs']) copyFileSync(join(root, fixture('tmpdir')), join(dir, file));
  const given = [];
  // Discovery with TMPDIR unset, then empty; then explicit files as on GitHub.
  for (const [TMPDIR, files, GITHUB_ACTIONS] of [[undefined, [], 'false'], ['', [], 'false'], [undefined, ['test/a.test.mjs', 'test/b.test.mjs'], 'true']]) {
    const result = await run(dir, files, { cwd: dir, env: { TMPDIR, TMP: system, CI_RUNNER_TMPDIR_FILE: record, GITHUB_ACTIONS } });
    assert.equal(result.code, 0, result.stderr);
    const lines = readFileSync(record, 'utf8').trim().split('\n');
    rmSync(record);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], lines[0], 'every file gets the same TMPDIR');
    const [path, mode, uid] = lines[0].split('\t');
    assert.equal(dirname(path), system);
    assert.match(basename(path), /^dacs-test-/);
    assert.equal(mode, '700');
    assert.equal(Number(uid), process.getuid());
    assert.deepEqual(readdirSync(system), [], 'the run removes its own TMPDIR when it ends');
    given.push(path);
  }
  assert.equal(new Set(given).size, 3, 'each run gets a fresh directory');
});

test('a run with TMPDIR set gives its files that TMPDIR unchanged', async (t) => {
  const dir = setup(t), mine = join(dir, 'mine'), record = join(dir, 'tmpdirs.txt');
  mkdirSync(mine);
  const result = await run(dir, [fixture('tmpdir')], { env: { TMPDIR: mine, CI_RUNNER_TMPDIR_FILE: record } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(record, 'utf8').split('\t')[0], mine);
  assert.deepEqual(readdirSync(mine), [], 'a TMPDIR that was given is left as it is');
});

test('a missing test file fails even if a different failure in that file is known', async (t) => {
  const file = 'test/missing-ci-fixture.mjs';
  const result = await run(setup(t), [file], { known: [entry(file, failure)] });
  assert.equal(result.code, 1);
  assert.ok(result.rows[0].newFailures.includes('[process failure]'));
  assert.deepEqual(result.rows[0].staleKnown, [], 'an incomplete file cannot show which tests exist');
});

test('a crash, kill or early exit after a known failure fails as incomplete instead of hiding the rest of the file', async (t) => {
  const dir = setup(t), file = fixture('crash');
  // Exit status 1 is what a file with a failing test ends with anyway; a kill or exit 0 is also a process failure.
  for (const [mode, status] of [['kill', 'killed by SIGKILL'], ['exit1'], ['exit0', 'exit code 0']]) {
    const result = await run(dir, [file], { known: [entry(file, failure)], env: { CI_RUNNER_CRASH: mode } });
    assert.equal(result.code, 1, mode);
    assert.deepEqual(result.rows[0].knownFailures, [failure], mode);
    assert.deepEqual(result.rows[0].newFailures, [...status ? ['[process failure]'] : [], '[incomplete results]'], mode);
    assert.deepEqual(result.rows[0].failures.filter(({ test }) => test === PROCESS).map(({ error }) => error), status ? [status] : [], mode);
    assert.deepEqual(result.rows[0].failures.at(-1), { test: '[incomplete results]', error: 'no per-file test summary' }, mode);
    assert.deepEqual(result.rows[0].staleKnown, [], `${mode}: an incomplete file cannot show which tests exist`);
  }
  const finished = await run(dir, [file], { known: [entry(file, failure)], env: { CI_RUNNER_CRASH: 'exitcode' } });
  assert.deepEqual(finished.rows[0].newFailures, ['never reported after a crash'], 'a file that runs on reports the rest');
});

test('an abnormal exit after passing tests is a [process failure] with its exit status, not a test named by its path', async (t) => {
  const dir = setup(t), file = fixture('exit-code');
  const result = await run(dir, [file]);
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].failing, ['[process failure]']);
  assert.deepEqual(result.rows[0].failures, [{ test: '[process failure]', error: 'exit code 3' }]);
  assert.equal((await run(dir, [file], { known: [entry(file, PROCESS, 'exit code 3')] })).code, 0);
  const generic = await run(dir, [file], { known: [entry(file, PROCESS, 'test failed')] });
  assert.equal(generic.code, 1, 'Node\'s generic "test failed" excuses no exit status');
  assert.deepEqual(generic.rows[0].newFailures, ['[process failure]']);
});

test('a root hook failure, which Node names by the absolute file path, is a [process failure]', async (t) => {
  const result = await run(setup(t), [fixture('root-hook')]);
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].failures, [{ test: '[process failure]', error: 'root after hook failed', cause: 'root after hook failed' }]);
});

test('an error no test catches after the tests end fails the file even beside a known failure', async (t) => {
  const dir = setup(t), file = fixture('late'), known = [entry(file, failure)];
  const quiet = await run(dir, [file], { known });
  assert.equal(quiet.code, 0, quiet.stderr);
  for (const [mode, message] of [['exit', /^uncaught error after the file's summary/], ['timer', /asynchronous activity after the test ended.*new late exception.*uncaughtException/],
    ['reject', /asynchronous activity after the test ended.*new late rejection.*unhandledRejection/]]) {
    const result = await run(dir, [file], { known, env: { CI_RUNNER_LATE: mode } });
    assert.equal(result.code, 1, mode);
    assert.deepEqual(result.rows[0].knownFailures, [failure], mode);
    assert.deepEqual(result.rows[0].newFailures, ['[process failure]'], mode);
    assert.match(result.rows[0].failures.at(-1).error, message, mode);
  }
  const tap = readFileSync(join(dir, 'results.jsonl.failures', `${file.replace(/[\\/]/g, '__')}.tap`), 'utf8');
  assert.match(tap, /new late rejection/, 'the TAP keeps the late error');
  const passing = await run(dir, [file], { env: { CI_RUNNER_LATE: 'timer', CI_RUNNER_PASS: '1' } });
  assert.equal(passing.code, 1);
  assert.deepEqual(passing.rows[0].failing, ['[process failure]']);
  const unexplained = await run(dir, [file], { known, env: { CI_RUNNER_LATE: 'exit', NODE_OPTIONS: '--no-extra-info-on-fatal-exception' } });
  assert.equal(unexplained.code, 1, 'the runner keeps the fatal-error line on whatever NODE_OPTIONS says');
  assert.deepEqual(unexplained.rows[0].newFailures, ['[process failure]']);
});

test('a signal, abort or exit status that ends the file after its summary fails it even beside a known failure', async (t) => {
  const dir = setup(t), file = fixture('late'), known = [entry(file, failure)];
  for (const [mode, status] of [['kill', 'killed by SIGKILL'], ['abort', 'killed by SIGABRT'], ['exit-code', 'exit code 9'], ['exit-call', 'exit code 42']]) {
    const result = await run(dir, [file], { known, env: { CI_RUNNER_LATE: mode } });
    assert.equal(result.code, 1, mode);
    assert.deepEqual(result.rows[0].knownFailures, [failure], mode);
    assert.deepEqual(result.rows[0].newFailures, ['[process failure]'], mode);
    assert.deepEqual(result.rows[0].failures.filter(({ test }) => test === PROCESS), [{ test: PROCESS, error: status }], mode);
  }
  // Without a failing test Node reports the status itself; it is still reported once.
  const passing = await run(dir, [file], { env: { CI_RUNNER_LATE: 'kill', CI_RUNNER_PASS: '1' } });
  assert.deepEqual(passing.rows[0].failures, [{ test: PROCESS, error: 'killed by SIGKILL' }]);
  // Node's fatal-error line from a child before the summary, or inside another line, is no late error.
  for (const mode of ['child', 'version']) {
    const result = await run(dir, [file], { known, env: { CI_RUNNER_LATE: mode } });
    assert.equal(result.code, 0, `${mode}: ${result.stderr}`);
    assert.deepEqual(result.rows[0].failing, [failure], mode);
  }
  // A failed suite after hook leaves the file's summary successful, so Node exits 0:
  // that is its normal status, and a baselined suite failure passes the gate.
  const suite = 'a suite whose after hook fails', suiteKnown = entry(file, suite, 'suite after hook failed');
  for (const [env, entries, failing] of [[{ CI_RUNNER_PASS: '1' }, [suiteKnown], [suite]], [{}, [...known, suiteKnown], [failure, suite]]]) {
    const result = await run(dir, [file], { known: entries, env: { CI_RUNNER_LATE: 'suite-after', ...env } });
    assert.equal(result.code, 0, `${JSON.stringify(env)}: ${result.stderr}`);
    assert.deepEqual(result.rows[0].knownFailures, failing);
    assert.deepEqual(result.rows[0].newFailures, []);
  }
  const unbaselined = await run(dir, [file], { known: [], env: { CI_RUNNER_LATE: 'suite-after', CI_RUNNER_PASS: '1' } });
  assert.equal(unbaselined.code, 1);
  assert.deepEqual(unbaselined.rows[0].newFailures, [suite], 'only the suite, with no [process failure]');
});

test('a multi-line failure is excused only by its whole message, as in the payment-path baseline entry', async (t) => {
  const dir = setup(t), file = fixture('disposition');
  const baseline = JSON.parse(readFileSync(join(root, 'test/known-failures.json'), 'utf8'));
  const creates = baseline.find((known) => known.file === 'test/devnet-operator-seller-disposition-prefixed.test.mjs' && known.test.startsWith('one same-process API workflow'));
  const interrupt = 'Expected values to be strictly equal:\n+ actual - expected\n\n+ {\n+   code: null,\n+   name: \'Error\',\n+   phase: \'interrupt\'\n+ }\n- null\n';
  const known = [entry(file, 'effects after the first purchase', creates.expect), entry(file, 'no error in any phase', interrupt)];
  const judged = async (env) => (await run(dir, [file], { known, env })).rows[0];
  const baselined = await judged({ CI_RUNNER_EFFECTS: '7,1', CI_RUNNER_ATTEMPT: 'Error' });
  assert.deepEqual(baselined.newFailures, []);
  assert.deepEqual(baselined.knownFailures, ['effects after the first purchase', 'no error in any phase']);
  for (const [env, regression] of [[{ CI_RUNNER_EFFECTS: '7,2', CI_RUNNER_ATTEMPT: 'Error' }, 'effects after the first purchase'],
    [{ CI_RUNNER_EFFECTS: '8,1', CI_RUNNER_ATTEMPT: 'Error' }, 'effects after the first purchase'],
    [{ CI_RUNNER_EFFECTS: '7,1', CI_RUNNER_ATTEMPT: 'AssertionError' }, 'no error in any phase']]) {
    assert.deepEqual((await judged(env)).newFailures, [regression], JSON.stringify(env));
  }
});

test('the committed baseline cannot excuse missing or changed seller reference artifacts', () => {
  const known = readKnown(join(root, 'test/known-failures.json'));
  for (const file of ['test/agreement-context-integration.test.mjs', 'test/agreement-context-interactions.test.mjs', 'test/dacs-current-broker-interactions.test.mjs']) {
    assert.equal([...known.values()].some((entry) => entry.file === file), false, file);
    for (const error of ["ENOENT: no such file or directory, scandir '/missing/seller'", 'unchanged seller reference digest', 'seller reference file count']) {
      const name = 'seller reference interop';
      const result = judge(file, { failures: [{ test: name, error }], passing: [], seen: [name], exit: 1 }, known);
      assert.deepEqual(result.newFailures, [name], `${file}: ${error}`);
      assert.deepEqual(result.knownFailures, []);
    }
  }
});

test('matches takes a one-line message by a part of it and a multi-line message only whole', () => {
  assert.equal(matches('ENOENT: no such file, scandir \'/x\'', 'scandir \'/x\''), true);
  assert.equal(matches('one line', 'other'), false);
  assert.equal(matches(unequal, unequal), true);
  assert.equal(matches(unequal, '1 !== 2'), false);
  assert.equal(matches(`${unequal}one more line\n`, unequal), false);
  assert.equal(matches(`x\n${unequal}`, unequal), false, 'a line added before the expect');
  assert.equal(matches('a\nb', 'a'), false, 'one newline makes a message multi-line');
  assert.equal(matches('a\n', 'a'), false, 'a trailing newline is part of the message');
  assert.equal(matches(undefined, 'x'), false);
});

test('a known name that fails for a cause other than its expect is a new failure', async (t) => {
  const file = fixture('fail');
  for (const expect of ['NEW regression: authorization bypassed', '2 !== 1', '1 !== 2']) {
    const result = await run(setup(t), [file], { known: [entry(file, failure, expect)] });
    assert.equal(result.code, 1, expect);
    assert.deepEqual(result.rows[0].newFailures, [failure], expect);
    assert.deepEqual(result.rows[0].knownFailures, [], expect);
  }
});

test('a name shared by several results in a file cannot be excused, whether duplicate, suite or delimiter', async (t) => {
  const file = fixture('collide');
  const known = ['payment > settles', 'payment', 'same name', 'a > b'].map((name) => entry(file, name, 'known failure'));
  const result = await run(setup(t), [file], { known });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].knownFailures, ['payment > settles']);
  assert.deepEqual(result.rows[0].newFailures, ['payment', 'same name', 'a > b']);
  assert.deepEqual(result.rows[0].staleKnown, []);
});

test('skip and todo with an empty reason count as skip and todo, as in node:test', async (t) => {
  const dir = setup(t), file = fixture('empty-reason');
  const result = await run(dir, [file]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.rows[0].failing, []);
  // Baselined, they are neither passing nor stale.
  const names = ['todo with an empty reason', 'skipped with an empty reason', 'failing test skipped with an empty reason'];
  const known = await run(dir, [file], { known: names.map((name) => entry(file, name)) });
  assert.equal(known.code, 0, known.stderr);
  assert.deepEqual(known.rows[0].knownNowPassing, []);
  assert.deepEqual(known.rows[0].staleKnown, []);
});

test('classify names each sentinel from what the file process reported', () => {
  const done = { code: 0, signal: null, timedOut: false, timeoutMs: 600000, counts: { tests: 1 }, fileSummary: true, success: true, pending: '', failing: [] };
  const cases = [
    [{}, []],
    [{ code: 1, success: false, failing: ['a test'] }, []],
    [{ timedOut: true, signal: 'SIGKILL', counts: undefined }, [[TIMEOUT, 'no exit within 600 s; process group killed']]],
    [{ signal: 'SIGKILL' }, [[PROCESS, 'killed by SIGKILL']]],
    [{ error: 'Invalid reporter output' }, [[PROCESS, 'Invalid reporter output']]],
    [{ code: 1, success: false, failing: ['a test'], error: 'Invalid reporter output' }, [[PROCESS, 'Invalid reporter output']]],
    [{ code: 3 }, [[PROCESS, 'exit code 3']]],
    [{ counts: undefined }, [[INCOMPLETE, 'no test summary']]],
    [{ fileSummary: false }, [[INCOMPLETE, 'no per-file test summary']]],
    [{ fileSummary: false, failing: ['a known failure'], code: 1, success: false }, [[INCOMPLETE, 'no per-file test summary']]],
    [{ pending: '{"type":"test:pa' }, [[INCOMPLETE, 'partial reporter output']]],
    [{ success: false }, [[INCOMPLETE, 'unsuccessful summary without a failing test']]],
    [{ code: 1, success: false }, [[PROCESS, 'exit code 1'], [INCOMPLETE, 'unsuccessful summary without a failing test']]],
    // The file process's own status: 1 with a failing test, 0 without.
    [{ exited: { exitCode: 0, signal: null } }, []],
    [{ code: 1, success: false, failing: ['a test'], exited: { exitCode: 1, signal: null } }, []],
    [{ code: 1, success: false, failing: ['a test'], exited: { exitCode: null, signal: 'SIGABRT' } }, [[PROCESS, 'killed by SIGABRT']]],
    [{ code: 1, success: false, failing: ['a test'], exited: { exitCode: 9, signal: null } }, [[PROCESS, 'exit code 9']]],
    [{ code: 1, success: false, failing: ['a test'], exited: { exitCode: 0, signal: null } }, [[PROCESS, 'exit code 0']]],
    [{ code: 1, success: false, failing: [PROCESS], exited: { exitCode: 1, signal: null } }, [[PROCESS, 'exit code 1']]],
    [{ code: 1, success: false, failing: [PROCESS], failures: [{ test: PROCESS, error: 'exit code 3' }], exited: { exitCode: 3, signal: null } }, []],
    [{ exited: {} }, []],
    // With the file's own summary, its success decides: a failed suite (an after
    // hook) leaves it successful and the process exits 0.
    [{ fileSuccess: true, failing: ['a suite'], exited: { exitCode: 0, signal: null } }, []],
    [{ code: 1, success: false, fileSuccess: true, failing: ['a suite'], exited: { exitCode: 1, signal: null } }, [[PROCESS, 'exit code 1']]],
    [{ code: 1, success: false, fileSuccess: false, failing: ['a test'], exited: { exitCode: 1, signal: null } }, []],
    [{ code: 1, success: false, fileSuccess: false, failing: ['a test'], exited: { exitCode: 0, signal: null } }, [[PROCESS, 'exit code 0']]],
  ];
  for (const [change, expected] of cases) {
    assert.deepEqual(classify({ ...done, ...change }).map(({ test, error }) => [test, error]), expected, JSON.stringify(change));
  }
});

test('record keeps results, tells the file summary from the closing one, and refuses non-events', () => {
  const state = newState();
  for (const event of [
    { type: 'test:fail', test: 'a', skipped: false, todo: false, error: 'boom', cause: 'boom' },
    { type: 'test:fail', test: 'b', skipped: false, todo: true, error: 'todo' },
    { type: 'test:pass', test: 'c', skipped: true, todo: false },
    { type: 'test:pass', test: 'd', skipped: false, todo: false },
    { type: 'test:summary', file: null, counts: { tests: 4 }, success: false },
  ]) record(state, JSON.stringify(event));
  assert.deepEqual(state.failures, [{ test: 'a', error: 'boom', cause: 'boom' }]);
  assert.deepEqual(state.passing, ['d']);
  assert.deepEqual(state.seen, ['a', 'b', 'c', 'd']);
  assert.equal(state.fileSummary, false, 'the closing summary alone does not show the file finished');
  assert.equal(state.fileSuccess, undefined, 'nor does it give the file its success');
  assert.equal(state.error, undefined);
  record(state, JSON.stringify({ type: 'test:summary', file: '/abs/a.test.mjs', counts: { tests: 4 }, success: true }));
  assert.equal(state.fileSummary, true);
  assert.equal(state.fileSuccess, true);
  record(state, JSON.stringify({ type: 'test:summary', file: null, counts: { tests: 4 }, success: false }));
  assert.equal(state.fileSuccess, true, 'a later closing summary keeps the file\'s own success');
  assert.equal(state.success, false);
  record(state, 'not a reporter event');
  assert.equal(state.error, 'Invalid reporter output');
  for (const line of ['null', '7', '"text"', '{}', '[1]', '{"type":7}']) {
    const other = newState();
    record(other, line);
    assert.equal(other.error, 'Invalid reporter output', line);
  }
  const named = newState(), file = (test) => test === 'test/a.test.mjs' ? PROCESS : test;
  for (const event of [{ exitCode: 3 }, { exitCode: 1, signal: 'SIGKILL' }, {}, { error: 'root hook failed', cause: 'root hook failed', exitCode: 1 }]) {
    record(named, JSON.stringify({ type: 'test:fail', test: 'test/a.test.mjs', error: 'test failed', ...event }), file);
  }
  record(named, JSON.stringify({ type: 'test:late', error: 'uncaught error after the file\'s summary' }));
  assert.deepEqual(named.failures, [{ test: PROCESS, error: 'exit code 3' }, { test: PROCESS, error: 'killed by SIGKILL' },
    { test: PROCESS, error: 'test failed', cause: undefined }, { test: PROCESS, error: 'root hook failed', cause: 'root hook failed' },
    { test: PROCESS, error: 'uncaught error after the file\'s summary' }]);
  assert.equal(named.error, undefined);
  assert.equal(named.exited, undefined);
  record(named, JSON.stringify({ type: 'test:exit', test: 'a test', exitCode: 7, signal: null }), file);
  assert.equal(named.exited, undefined, 'only the file-level test carries the file\'s status');
  record(named, JSON.stringify({ type: 'test:exit', test: 'test/a.test.mjs', exitCode: null, signal: 'SIGKILL' }), file);
  assert.deepEqual(named.exited, { exitCode: null, signal: 'SIGKILL' });
  assert.equal(named.failures.length, 5, 'a status is judged when the file ends, not recorded as a failure');
});

test('judge excuses a sentinel only with its expected cause and leaves stale checks to complete files', () => {
  const file = 'test/a.test.mjs';
  const known = new Map([[JSON.stringify([file, PROCESS]), entry(file, PROCESS, 'exit code 1')]]);
  const base = { passing: [], seen: [], exit: 1 };
  assert.deepEqual(judge(file, { ...base, failures: [{ test: PROCESS, error: 'exit code 1' }] }, known).knownFailures, [PROCESS]);
  assert.deepEqual(judge(file, { ...base, failures: [{ test: PROCESS, error: 'exit code 1' }, { test: PROCESS, error: 'killed by SIGKILL' }] }, known).newFailures, [PROCESS]);
  assert.deepEqual(judge(file, { ...base, failures: [{ test: PROCESS, error: 'test failed', cause: 'exit code 1' }] }, known).knownFailures, [PROCESS], 'the cause counts too');
  assert.deepEqual(judge(file, { ...base, exit: 0, failures: [] }, known).knownNowPassing, [PROCESS]);
  const missing = new Map([[JSON.stringify([file, 'gone']), entry(file, 'gone')]]);
  assert.deepEqual(judge(file, { ...base, failures: [{ test: INCOMPLETE, error: 'no test summary' }] }, missing).staleKnown, []);
  assert.deepEqual(judge(file, { ...base, exit: 0, failures: [] }, missing).staleKnown, ['gone']);
});

test('readKnown rejects every malformed entry and accepts the exact shape', (t) => {
  const dir = setup(t), path = join(dir, 'known.json'), valid = entry('test/a.test.mjs', 'name');
  const read = (value) => { writeFileSync(path, JSON.stringify(value)); return readKnown(path); };
  assert.throws(() => read({ entries: [valid] }), /must be an array/);
  for (const change of [{ reason: 'two\nlines' }, { reason: 'carriage\rreturn' }, { file: 'test/./a.test.mjs' },
    { file: '/abs/a.test.mjs' }, { file: '../a.test.mjs' }, { file: 'test//a.test.mjs' }, { class: 'flaky' }, { test: 7 }]) {
    assert.throws(() => read([{ ...valid, ...change }]), /Invalid known failure entry/, JSON.stringify(change));
  }
  assert.throws(() => read([valid, { ...valid, reason: 'other' }]), /Duplicate known failure/);
  assert.equal(read([valid, entry('test/a.test.mjs', 'other', 'a whole\nmulti-line message\n')]).size, 2);
  assert.equal(readKnown(join(root, 'test/known-failures.json')).size > 0, true, 'the committed baseline is valid');
  assert.equal(readKnown(undefined).size, 0);
});

test('invalid arguments fail before any test file starts', async (t) => {
  const dir = setup(t), file = fixture('pass');
  for (const files of [['--known'], ['--unknown', file], [file, file], [join(root, file)], ['../outside.mjs']]) {
    const result = await run(dir, files);
    assert.equal(result.code, 1, files.join(' '));
    assert.equal(result.rows.length, 0, files.join(' '));
  }
  for (const timeout of [0, -1, 'never', 2147484]) {
    const result = await run(dir, [file], { timeout });
    assert.equal(result.code, 1, String(timeout));
    assert.match(result.stderr, /Usage:/);
  }
});

test('an interrupted run kills the running file\'s process group and removes its own TMPDIR', async (t) => {
  for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    const dir = setup(t), system = join(dir, 'system-tmp'), pidFile = join(dir, 'descendant.pid');
    mkdirSync(system);
    const env = { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: 'false', TMPDIR: '', TMP: system, CI_RUNNER_PID_FILE: pidFile };
    const child = spawn(process.execPath, [runner, root, join(dir, 'results.jsonl'), '30', fixture('timeout')], { env, stdio: 'ignore' });
    const closed = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
    for (let attempt = 0; attempt < 250 && !existsSync(pidFile); attempt++) await new Promise((done) => setTimeout(done, 20));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    child.kill(signal);
    assert.deepEqual(await closed, { code: status, signal: null }, signal);
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); } catch (err) { assert.equal(err.code, 'ESRCH'); break; }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, signal);
    assert.deepEqual(readdirSync(system), [], signal);
  }
});

// A module that no checkout carries, imported by the load-failure fixtures.
const NOT_CARRIED = 'test/fixtures/ci-runner/not-carried.mjs';
const BEHIND_HELPER = 'test/fixtures/ci-runner/not-carried-behind-helper.mjs';
const carry = (file, path = NOT_CARRIED) => ({ file, test: CARRY_OVER, reason: 'Intentional fixture load failure.', class: 'carry-over', expect: path });
const key = (file) => JSON.stringify([file, CARRY_OVER]);
const LOAD_SENTINELS =[{ test: PROCESS, error: 'exit code 1' }, { test: INCOMPLETE, error: 'no per-file test summary' }];

// The stderr lines Node prints when a static import does not resolve.
const diagnostic = (missing, { importer = join(root, 'test/a.test.mjs'), subject = 'module' } = {}) => [
  'node:internal/modules/esm/resolve:275\n', '    throw new ERR_MODULE_NOT_FOUND(\n', '          ^\n', '\n',
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find ${subject} '${missing}' imported from ${importer}\n`,
  '    at finalizeResolution (node:internal/modules/esm/resolve:275:11) {\n',
  "  code: 'ERR_MODULE_NOT_FOUND',\n", `  url: 'file://${missing}'\n`, '}\n', '\n', 'Node.js v22.23.3\n',
];

// The events the reporter gets for one file process that ended with these stderr lines.
function fileEvents(lines, { file = 'test/a.test.mjs', started = false, printed = false, passed = false, exitCode = 1 } = {}) {
  const details = passed ? { passed: true } : { passed: false, error: { message: 'test failed', exitCode } };
  return [
    ...(started ? [{ type: 'test:start', data: { nesting: 1, name: 'an inner test' } }] : []),
    ...(printed ? [{ type: 'test:stdout', data: { file, message: 'database initialization started\n' } }] : []),
    ...lines.map((message) => ({ type: 'test:stderr', data: { file, message } })),
    { type: 'test:complete', data: { name: file, nesting: 0, file: join(root, file), details } },
  ];
}

function reporterLines(events) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, fixture('feed-reporter'))], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => code === 0 ? done(stdout.split('\n').filter(Boolean).map(JSON.parse)) : fail(new Error(stderr)));
    child.stdin.end(JSON.stringify(events));
  });
}

const loadFailuresOf = async (events) => (await reporterLines(events)).filter(({ type }) => type === 'test:load-failure');

test('reporter: a pre-test module-load failure yields one structured load-failure record naming the missing module\'s path, read from test:stderr events', async () => {
  const missing = join(root, NOT_CARRIED);
  assert.deepEqual(await loadFailuresOf(fileEvents(diagnostic(missing))), [{ type: 'test:load-failure', path: NOT_CARRIED }]);
  const enoent = ['node:internal/fs/utils:356\n', "Error: ENOENT: no such file or directory, open 'x'\n", '    at Object.openSync (node:fs:573:18) {\n', "  code: 'ENOENT',\n", '}\n', '\n', 'Node.js v22.23.3\n'];
  const trailer = diagnostic(missing).slice(0, -1);
  const whole = diagnostic(missing), stray = 'database initialization failed\n';
  const refused = {
    'a line of its own before the diagnostic': [stray, ...whole],
    'a line of its own between the preamble and the error': [...whole.slice(0, 4), stray, ...whole.slice(4)],
    'a line of its own between the frames and the code': [...whole.slice(0, 6), stray, ...whole.slice(6)],
    'a line of its own between the code and the closing brace': [...whole.slice(0, 8), stray, ...whole.slice(8)],
    'a warning before the diagnostic': ['(node:1) Warning: something\n', ...whole],
    'a throw site that is not Node\'s': ['./app.mjs:1\n', ...whole.slice(1)],
    'a module outside the run directory': diagnostic(join(root, '../outside.mjs')),
    'a package, not a file': diagnostic('left-pad', { subject: 'package' }),
    'a missing file read, not a module': enoent,
    'a second error after the diagnostic': [...diagnostic(missing), 'Error: another\n', 'Node.js v22.23.3\n'],
    'a diagnostic without the closing version line': trailer,
    'more than the diagnostic limit': [...trailer, '    at frame (file:1:1)\n'.repeat(5000), 'Node.js v22.23.3\n'],
  };
  for (const [name, lines] of Object.entries(refused)) assert.deepEqual(await loadFailuresOf(fileEvents(lines)), [], name);
  assert.deepEqual(await loadFailuresOf(fileEvents(diagnostic(missing), { started: true })), [], 'a test had started');
  assert.deepEqual(await loadFailuresOf(fileEvents(diagnostic(missing), { passed: true })), [], 'the file passed');
});

test('reporter: a line the file printed to stdout before the missing import yields no load-failure record', async () => {
  const events = fileEvents(diagnostic(join(root, NOT_CARRIED)), { printed: true });
  assert.deepEqual(await loadFailuresOf(events), []);
});

test('reporter: a valid load-failure diagnostic yields a record only when the file process exited with status 1', async () => {
  const events = (exitCode) => fileEvents(diagnostic(join(root, NOT_CARRIED)), { exitCode });
  assert.deepEqual(await loadFailuresOf(events(1)), [{ type: 'test:load-failure', path: NOT_CARRIED }], 'exit status 1');
  for (const exitCode of [0, 2, 7, 127, null]) assert.deepEqual(await loadFailuresOf(events(exitCode)), [], `exit status ${exitCode}`);
});

test('record keeps a load-failure path apart from results and refuses an unsafe one', () => {
  const state = newState();
  record(state, JSON.stringify({ type: 'test:load-failure', path: NOT_CARRIED }));
  assert.deepEqual(state.loadFailures, [NOT_CARRIED]);
  assert.deepEqual([state.failures, state.passing, state.seen, state.error], [[], [], [], undefined]);
  for (const path of [undefined, 7, '', ' ', '/abs/m.mjs', '../m.mjs', '..', 'a/../m.mjs', 'a//m.mjs', 'a\nb.mjs']) {
    const refused = newState();
    record(refused, JSON.stringify({ type: 'test:load-failure', path }));
    assert.equal(refused.error, 'Invalid reporter output', String(path));
    assert.deepEqual(refused.loadFailures, [], String(path));
  }
});

test('runner: an absent static import, and an absent import reached through a helper, become one carry-over outcome that the entry naming that path excuses', async (t) => {
  const dir = setup(t);
  for (const [file, path] of [[fixture('absent-static'), NOT_CARRIED], [fixture('absent-helper'), BEHIND_HELPER]]) {
    const excused = await run(dir, [file], { known: [carry(file, path)] });
    assert.equal(excused.code, 0, excused.stderr);
    assert.deepEqual(excused.rows[0].failures, [{ test: CARRY_OVER, error: path }], file);
    assert.deepEqual([excused.rows[0].knownFailures, excused.rows[0].newFailures], [[CARRY_OVER], []], file);
    const unexcused = await run(dir, [file]);
    assert.equal(unexcused.code, 1, file);
    assert.deepEqual(unexcused.rows[0].newFailures, [PROCESS, INCOMPLETE], 'without an entry the cause stays visible');
  }
});

test('runner: a different missing module, a matching diagnostic followed by another fatal error, an ordinary assertion failure and a malformed reporter event are not excused', async (t) => {
  const dir = setup(t), file = fixture('absent-static');
  const different = await run(dir, [file], { known: [carry(file, 'test/fixtures/ci-runner/other.mjs')] });
  assert.equal(different.code, 1);
  assert.deepEqual(different.rows[0].newFailures, [PROCESS, INCOMPLETE]);
  const fatal = fixture('absent-then-fatal'), second = await run(dir, [fatal], { known: [carry(fatal)] });
  assert.equal(second.code, 1);
  assert.ok(!second.rows[0].failing.includes(CARRY_OVER));
  const output = fixture('absent-after-output'), printed = await run(dir, [output], { known: [carry(output)] });
  assert.equal(printed.code, 1, printed.stderr);
  assert.deepEqual(printed.rows[0].newFailures, [PROCESS, INCOMPLETE], 'a line the file printed before the absent import stays visible');
  const stdout = fixture('absent-after-stdout'), echoed = await run(dir, [stdout], { known: [carry(stdout)] });
  assert.equal(echoed.code, 1, echoed.stderr);
  assert.deepEqual(echoed.rows[0].newFailures, [PROCESS, INCOMPLETE], 'a line the file printed to stdout before the absent import stays visible');
  const assertion = fixture('fail'), plain = await run(dir, [assertion], { known: [carry(assertion)] });
  assert.equal(plain.code, 1);
  assert.deepEqual(plain.rows[0].newFailures, [failure]);
  const known = new Map([[key(file), carry(file)]]), input = { failures: LOAD_SENTINELS, loadFailures: [NOT_CARRIED], started: false };
  assert.deepEqual(carryOver(file, input, known), [{ test: CARRY_OVER, error: NOT_CARRIED }]);
  const unchanged = {
    'no load-failure record': { loadFailures: [] },
    'two records': { loadFailures: [NOT_CARRIED, NOT_CARRIED] },
    'a test started': { started: true },
    'another failure': { failures: [...LOAD_SENTINELS, { test: 'a test', error: 'boom' }] },
    'another cause for the process failure': { failures: [{ test: PROCESS, error: 'exit code 3' }, LOAD_SENTINELS[1]] },
    'a malformed reporter event': { failures: [{ test: PROCESS, error: 'Invalid reporter output' }, ...LOAD_SENTINELS] },
  };
  for (const [name, change] of Object.entries(unchanged)) assert.deepEqual(carryOver(file, { ...input, ...change }, known), (change.failures ?? LOAD_SENTINELS), name);
  assert.deepEqual(carryOver(file, input, new Map()), LOAD_SENTINELS, 'no entry');
});

test('runner: a timeout and an interrupted run are not excused by a carry-over entry', async (t) => {
  const dir = setup(t), hang = fixture('timeout'), crash = fixture('crash');
  const timedOut = await run(dir, [hang], { known: [carry(hang)], timeout: 1 });
  assert.equal(timedOut.code, 1);
  assert.deepEqual(timedOut.rows[0].newFailures, [TIMEOUT]);
  const killed = await run(dir, [crash], { known: [carry(crash)], env: { CI_RUNNER_CRASH: 'kill' } });
  assert.equal(killed.code, 1);
  assert.ok(killed.rows[0].newFailures.includes(PROCESS) && !killed.rows[0].failing.includes(CARRY_OVER));
  const known = new Map([[key(hang), carry(hang)]]);
  const withTimeout = [{ test: TIMEOUT, error: 'no exit within 1 s; process group killed' }];
  assert.deepEqual(carryOver(hang, { failures: withTimeout, loadFailures: [NOT_CARRIED], started: false }, known), withTimeout);
});

test('a carry-over entry for a file that now loads fails as now-passing', async (t) => {
  const file = fixture('pass'), result = await run(setup(t), [file], { known: [carry(file)] });
  assert.equal(result.code, 1);
  assert.deepEqual(result.rows[0].knownNowPassing, [CARRY_OVER]);
  assert.match(result.stderr, /Known failure now passes; remove its entry: .*pass\.mjs: \[carry-over\]/);
});

test('a carry-over entry on a test other than [carry-over], or without a path in expect, fails closed', async (t) => {
  const dir = setup(t), path = join(dir, 'known.json'), valid = carry('test/a.test.mjs');
  const read = (value) => { writeFileSync(path, JSON.stringify([value])); return readKnown(path); };
  assert.equal(read(valid).size, 1);
  const malformed = [{ test: 'some test' }, { class: 'main-defect' }, { expect: '' }, { expect: ' ' }, { expect: '/abs/m.mjs' }, { expect: '..' }, { expect: '../m.mjs' },
    { expect: 'a/./m.mjs' }, { expect: 'a//m.mjs' }, { expect: 'a\nb.mjs' }, { expect: unequal }];
  for (const change of malformed) assert.throws(() => read({ ...valid, ...change }), /Invalid known failure entry/, JSON.stringify(change));
  const file = fixture('absent-static'), result = await run(dir, [file], { known: [{ ...carry(file), test: 'some test' }] });
  assert.equal(result.code, 1);
  assert.equal(result.rows.length, 0, 'the run stops before any file starts');
});

test('runner: a test that fails reading an absent file at module evaluation (ENOENT), as the carried commit-on-signature doc test does, is not excused as carry-over', async (t) => {
  const dir = setup(t), file = fixture('absent-read');
  for (const path of ['test/fixtures/ci-runner/not-carried.txt', NOT_CARRIED]) {
    const result = await run(dir, [file], { known: [carry(file, path)] });
    assert.equal(result.code, 1, path);
    assert.deepEqual(result.rows[0].newFailures, [PROCESS, INCOMPLETE], path);
    assert.match(readFileSync(join(dir, 'results.jsonl.failures', `${file.replace(/[\\/]/g, '__')}.tap`), 'utf8'), /^# Error: ENOENT/m, 'the cause is kept in the TAP output');
  }
});
