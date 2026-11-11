// Usage: node scripts/run-test-files.mjs <dir> <out.jsonl> [timeoutSec=600] [--known <file>] [--expected <file>] [--browser] [file...]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const key = (file, test) => JSON.stringify([file, test]);
const reporter = fileURLToPath(new URL('./test-file-reporter.mjs', import.meta.url));
export const TIMEOUT = '[timeout]';
export const PROCESS = '[process failure]';
export const INCOMPLETE = '[incomplete results]';
// A file that cannot load because a module it imports is not carried (see carryOver).
export const CARRY_OVER = '[carry-over]';
const SENTINELS = [TIMEOUT, PROCESS, INCOMPLETE, CARRY_OVER];
const CLASSES = ['main-defect', 'environment', 'browser', 'carry-over'];
const FIELDS = ['class', 'expect', 'file', 'reason', 'test'];
const EXPECTED_FIELDS = ['card', 'expect', 'file', 'issue', 'reason', 'test'];
const CAUSE_TOKEN = /(?:^|[\s'"(])(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+(?=$|[\s'":,)])|@[\w.-]+\/[\w.-]+@[0-9][\w.+-]*/;
const TEST_ROOT = 'test';
// Shared fixture modules named *.test.mjs that register no tests.
const MODULES = ['test/dacs-loopback-fixture.test.mjs'];
let ownTmp, current;

// The test files under dir/prefix; browser files (browser/ and *.browser.test.mjs) only when browser is set.
export function discover(dir, prefix, browser = false) {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const file = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return ['fixtures', 'helpers', ...browser ? [] : ['browser']].includes(entry.name) ? [] : discover(dir, file, browser);
    return entry.isFile() && entry.name.endsWith('.test.mjs') && (browser || !entry.name.endsWith('.browser.test.mjs')) && !MODULES.includes(file) ? [file] : [];
  });
}

function discoverTests(dir, browser) {
  if (!existsSync(join(dir, TEST_ROOT))) throw new Error(`Test root not found: ${TEST_ROOT}`);
  return discover(dir, TEST_ROOT, browser);
}

// A plain relative path in the form posix.normalize gives, on one line, that stays inside the run directory.
const isRunPath = (path) => typeof path === 'string' && path.trim() !== '' && !/[\r\n]/.test(path) && path === posix.normalize(path) &&
  !path.startsWith('/') && path !== '..' && !path.startsWith('../');

export function readKnown(path) {
  const entries = path ? JSON.parse(readFileSync(path, 'utf8')) : [];
  if (!Array.isArray(entries)) throw new Error('Known failures must be an array');
  const known = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== FIELDS.join(',') ||
      !FIELDS.every((field) => typeof entry[field] === 'string' && entry[field].trim()) ||
      !CLASSES.includes(entry.class) || /[\r\n]/.test(entry.reason) || !isRunPath(entry.file) ||
      // A carry-over entry is the one on the [carry-over] test, and its expect is the missing module's path.
      (entry.class === 'carry-over') !== (entry.test === CARRY_OVER) || entry.class === 'carry-over' && !isRunPath(entry.expect)) throw new Error('Invalid known failure entry');
    const id = key(entry.file, entry.test);
    if (known.has(id)) throw new Error(`Duplicate known failure: ${id}`);
    known.set(id, entry);
  }
  return known;
}

/** Returns card-owned failures; throws for malformed entries or known-failure overlap. */
export function readExpected(path, known = new Map()) {
  const entries = path ? JSON.parse(readFileSync(path, 'utf8')) : [];
  if (!Array.isArray(entries)) throw new Error('Invalid expected-until-card entry');
  const expected = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== EXPECTED_FIELDS.join(',') ||
      !EXPECTED_FIELDS.every((field) => typeof entry[field] === 'string' && entry[field].trim()) ||
      !isRunPath(entry.file) || SENTINELS.includes(entry.test) || /[\r\n]/.test(entry.reason) ||
      !/^P\d+[a-z0-9]*$/.test(entry.card) || !/^#\d+$/.test(entry.issue) ||
      /[\r\n]/.test(entry.expect) || entry.expect.startsWith('/') || entry.expect.length < 30 || !CAUSE_TOKEN.test(entry.expect))
      throw new Error('Invalid expected-until-card entry');
    const id = key(entry.file, entry.test);
    if (expected.has(id) || known.has(id)) throw new Error('Invalid expected-until-card entry');
    expected.set(id, entry);
  }
  return expected;
}

/** Returns a failure message with every absolute run-directory prefix removed. */
export function normalizeExpectedMessage(message, dir) {
  return typeof message === 'string' ? message.replaceAll(`${resolve(dir)}/`, '') : '';
}

export const newState = () => ({ counts: undefined, success: undefined, fileSummary: false, fileSuccess: undefined, exited: undefined, error: undefined, passing: [], seen: [], failures: [], loadFailures: [] });

// Adds one reporter line to a file's state; a line that is not a reporter event
// makes the file a process failure.
export function record(state, line, name = (test) => test) {
  let event;
  try { event = JSON.parse(line); } catch { state.error = 'Invalid reporter output'; return; }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') { state.error = 'Invalid reporter output'; return; }
  if (event.type === 'test:summary') {
    if (event.file !== null) {
      state.fileSummary = true;
      state.fileSuccess = event.success;
    }
    state.counts = event.counts;
    state.success = event.success;
  } else if (event.type === 'test:late') {
    state.failures.push({ test: PROCESS, error: event.error });
  } else if (event.type === 'test:exit') {
    if (name(event.test) === PROCESS) state.exited = { exitCode: event.exitCode, signal: event.signal };
  } else if (event.type === 'test:load-failure') {
    // The path of a module the file could not load; it is neither a pass nor a failure of a test.
    if (isRunPath(event.path)) state.loadFailures.push(event.path);
    else state.error = 'Invalid reporter output';
  } else {
    if (event.type === 'test:pass' || event.type === 'test:fail') state.seen.push(event.test);
    if (event.type === 'test:fail' && !event.todo && !event.skipped) {
      const test = name(event.test);
      // Node's file-level failure says only "test failed"; its exit status says what happened.
      const status = event.signal ? `killed by ${event.signal}` : Number.isInteger(event.exitCode) ? `exit code ${event.exitCode}` : undefined;
      state.failures.push(test === PROCESS && event.error === 'test failed' && status ? { test, error: status } : { test, error: event.error, cause: event.cause });
    } else if (event.type === 'test:pass' && !event.todo && !event.skipped) state.passing.push(event.test);
  }
}

// A one-line message is matched by an expect it contains. A message of several
// lines (an assertion diff, a list of problems) only by an expect equal to all of
// it, so an extra or changed line is a different failure.
export const matches = (message, expect) => typeof message === 'string' &&
  (message.includes('\n') ? message === expect : message.includes(expect));

// The sentinel failures for one finished file. Under process isolation the
// file's own process reports a summary naming the file, and the runner's closing
// summary follows; a file that died or exited early lacks the first even when an
// earlier test in it failed, so a known failure cannot excuse the missing rest.
// The file's own process exits 1 when its own summary is unsuccessful and 0 when
// it is successful. A failed suite whose tests all passed (for example its
// after hook failed) leaves that summary successful; without that summary, 1 when a
// test failed. Node reports any other status, or a signal, as a failure only when
// no test failed, so the status it recorded for the file (`exited`) is checked
// here as well.
export function classify({ code, signal, timedOut, timeoutMs, error, counts, fileSummary, success, fileSuccess, pending, failing, failures = [], exited }) {
  if (timedOut) return [{ test: TIMEOUT, error: `no exit within ${timeoutMs / 1000} s; process group killed` }];
  const sentinels = [];
  if (signal || error || code !== 0 && !failing.length) sentinels.push({ test: PROCESS, error: error ?? (signal ? `killed by ${signal}` : `exit code ${code}`) });
  const expected = typeof fileSuccess === 'boolean' ? (fileSuccess ? 0 : 1) : failing.some((test) => !SENTINELS.includes(test)) ? 1 : 0;
  const status = exited?.signal ? `killed by ${exited.signal}` : Number.isInteger(exited?.exitCode) && exited.exitCode !== expected ? `exit code ${exited.exitCode}` : null;
  if (status && !failures.some((failure) => failure.test === PROCESS && failure.error === status)) sentinels.push({ test: PROCESS, error: status });
  const incomplete = !counts ? 'no test summary' : !fileSummary ? 'no per-file test summary' : pending ? 'partial reporter output' :
    success === false && !failing.length ? 'unsuccessful summary without a failing test' : null;
  if (incomplete) sentinels.push({ test: INCOMPLETE, error: incomplete });
  return sentinels;
}

// What a file that cannot load ends with: its process exits 1 and it never reports its own summary.
const LOAD_FAILURE = [{ test: PROCESS, error: 'exit code 1' }, { test: INCOMPLETE, error: 'no per-file test summary' }];

// Turns the failures of a file that only failed to load into one [carry-over]
// failure naming the missing module, when the file has an entry for it. Only
// those two failures count: with a timeout, a signal, a test that started,
// any other failure, or not exactly one load-failure record that equals the
// entry's expect, the failures are returned as they are (DC-P7).
export function carryOver(file, { failures, loadFailures, started }, known) {
  const [path] = loadFailures;
  const onlyLoadFailure = failures.length === LOAD_FAILURE.length &&
    failures.every(({ test, error, cause }, index) => test === LOAD_FAILURE[index].test && error === LOAD_FAILURE[index].error && cause === undefined);
  return !started && loadFailures.length === 1 && onlyLoadFailure && known.get(key(file, CARRY_OVER))?.expect === path ? [{ test: CARRY_OVER, error: path }] : failures;
}

// Splits one file's failures into new and known, and finds its entries that now
// pass or match no test. An entry excuses its test only when the name is a single
// result in the file and every failure under it carries the entry's expected cause.
export function judge(file, { failures, passing, seen, exit }, known, expected = new Map(), dir = '.') {
  const entries = [...known.values()].filter((entry) => entry.file === file);
  const expectedEntries = [...expected.values()].filter((entry) => entry.file === file);
  const failing = [...new Set(failures.map(({ test }) => test))];
  const excused = (test) => {
    const entry = known.get(key(file, test));
    return !!entry && (SENTINELS.includes(test) || seen.filter((name) => name === test).length === 1) &&
      failures.filter((failure) => failure.test === test).every(({ error, cause }) => [error, cause].some((message) => matches(message, entry.expect)));
  };
  const expectedCause = (test) => {
    const entry = expected.get(key(file, test));
    return !!entry && seen.filter((name) => name === test).length === 1 &&
      failures.filter((failure) => failure.test === test).every(({ error, cause }) =>
        [error, cause].some((message) => normalizeExpectedMessage(message, dir).includes(entry.expect)));
  };
  // Only a file that ran to completion shows which tests exist in it.
  const complete = !failing.some((test) => SENTINELS.includes(test));
  return {
    newFailures: failing.filter((test) => !excused(test) && !expectedCause(test)),
    knownFailures: failing.filter(excused),
    expectedUntilCard: failing.filter(expectedCause),
    expectedNowPassing: expectedEntries.filter((entry) => !failing.includes(entry.test) && passing.includes(entry.test)).map((entry) => entry.test),
    // A carry-over entry is spent as soon as the file loads, whatever else it reports.
    knownNowPassing: entries.filter((entry) => !failing.includes(entry.test) && (entry.test === CARRY_OVER ? complete :
      passing.includes(entry.test) || SENTINELS.includes(entry.test) && exit === 0 && !failing.length)).map((entry) => entry.test),
    staleKnown: complete ? entries.filter((entry) => !SENTINELS.includes(entry.test) && !seen.includes(entry.test)).map((entry) => entry.test) : [],
    staleExpected: complete ? expectedEntries.filter((entry) => !seen.includes(entry.test)).map((entry) => entry.test) : [],
  };
}

function runOne(dir, file, timeoutMs, tapOut, known) {
  return new Promise((done) => {
    const t0 = Date.now();
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.NODE_TEST_CONTEXT;
    writeFileSync(tapOut, '');
    // Node passes its options on to the file's process; the fatal-error trailer that
    // the reporter looks for is printed only with --extra-info-on-fatal-exception,
    // which NODE_OPTIONS could otherwise turn off.
    const child = current = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--extra-info-on-fatal-exception', '--test', '--test-concurrency=1', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapOut}`, file],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let pending = '', stderr = '', timedOut = false;
    const state = newState();
    // Node names a file-level failure after the file (relative or absolute), not a test.
    const name = (test) => [file, resolve(dir, file)].includes(test) ? PROCESS : test;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        record(state, pending.slice(0, end), name);
        pending = pending.slice(end + 1);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', (err) => { state.error = err.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') state.error = err.message; }
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      current = undefined;
      const { counts, passing, seen, failures, error, loadFailures } = state;
      failures.push(...classify({ ...state, code, signal, timedOut, timeoutMs, pending, failing: failures.map(({ test }) => test) }));
      failures.splice(0, failures.length, ...carryOver(file, { failures, loadFailures, started: seen.some((test) => name(test) !== PROCESS) }, known));
      if (failures.length) {
        if (stderr) appendFileSync(tapOut, `\n${stderr.split('\n').map((line) => `# stderr: ${line}`).join('\n')}\n`);
      } else rmSync(tapOut);
      done({ file, exit: code, signal, timedOut, ms: Date.now() - t0, tests: counts?.tests ?? null,
        pass: counts?.passed ?? null, fail: counts?.failed ?? null, cancelled: counts?.cancelled ?? null,
        skipped: counts?.skipped ?? null, todo: counts?.todo ?? null, failing: [...new Set(failures.map(({ test }) => test))], passing, seen, failures,
        ...(error ? { error } : {}), ...(code !== 0 || timedOut ? { stderr } : {}) });
    });
  });
}

const markdown = (value) => String(value).replace(/[\\`*_{}[\]<>|]/g, '\\$&').replace(/[\r\n]/g, ' ');
export const annotation = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

async function main() {
  const args = process.argv.slice(2);
  const optionFile = (option) => {
    const index = args.indexOf(option);
    if (index === -1) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${option} requires a file`);
    return args.splice(index, 2)[1];
  };
  const knownArg = optionFile('--known'), expectedArg = optionFile('--expected');
  const browserIndex = args.indexOf('--browser'), browser = browserIndex !== -1;
  if (browser) args.splice(browserIndex, 1);
  const [dir, out, timeoutArg = '600', ...only] = args;
  const timeoutMs = Number(timeoutArg) * 1000;
  if (!dir || !out || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 || only.some((file) => file.startsWith('--'))) {
    throw new Error('Usage: run-test-files.mjs <dir> <out.jsonl> [timeoutSec=600] [--known <file>] [--expected <file>] [--browser] [file...]');
  }
  const known = readKnown(knownArg && resolve(dir, knownArg));
  const expected = readExpected(expectedArg && resolve(dir, expectedArg), known);
  const files = (only.length ? only.map((file) => posix.normalize(file)) : discoverTests(dir, browser)).sort();
  if (!files.length || new Set(files).size !== files.length || files.some((file) => file.startsWith('/') || file.startsWith('../'))) throw new Error('Expected unique relative test files');
  // docs/TESTING.md: the suites run with TMPDIR set to a fresh directory you own.
  // GitHub sets none, which leaves the shared /tmp, so such a run makes a private
  // one under the system temp directory and every file gets it; it is removed at the end.
  if (!process.env.TMPDIR) process.env.TMPDIR = ownTmp = mkdtempSync(join(tmpdir(), 'dacs-test-'));
  // An interrupted run takes the running file's process group and its own TMPDIR with it.
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      if (current) try { process.kill(-current.pid, 'SIGKILL'); } catch {}
      if (ownTmp) rmSync(ownTmp, { recursive: true, force: true });
      process.exit(status);
    });
  }
  writeFileSync(out, '');
  const tapDir = resolve(`${out}.failures`);
  mkdirSync(tapDir, { recursive: true });
  const results = [], newFailures = [], recovered = [], stale = [], expectedRecovered = [], expectedStale = [];
  const error = (prefix, message) => console.error(`${process.env.GITHUB_ACTIONS === 'true' ? '::error::' : prefix}${annotation(message)}`);
  const reportStale = (file, test) => {
    stale.push({ file, test });
    error('Stale known failure: ', `Known failure matches no test: ${file}: ${test}`);
  };
  const reportExpectedStale = (file, test) => {
    expectedStale.push({ file, test });
    error('Stale expected: ', `Expected-until-card entry matches no test: ${file}: ${test}`);
  };
  for (const file of files) {
    const result = await runOne(dir, file, timeoutMs, join(tapDir, `${file.replace(/[\\/]/g, '__')}.tap`), known);
    Object.assign(result, judge(file, result, known, expected, dir));
    delete result.passing;
    delete result.seen;
    results.push(result);
    appendFileSync(out, `${JSON.stringify(result)}\n`);
    console.log(`${file}: pass ${result.pass ?? '?'}, fail ${result.fail ?? '?'}, new ${result.newFailures.length}${result.timedOut ? ', TIMEOUT' : ''}`);
    for (const test of result.newFailures) {
      newFailures.push({ file, test });
      error('New failure: ', `${file}: ${test}`);
    }
    for (const test of result.knownNowPassing) {
      recovered.push({ file, test });
      error('Known failure now passes: ', `Known failure now passes; remove its entry: ${file}: ${test}`);
    }
    for (const test of result.staleKnown) reportStale(file, test);
    for (const test of result.expectedNowPassing) {
      expectedRecovered.push({ file, test });
      error('Expected now passes: ', `Expected-until-card test now passes; remove its entry: ${file}: ${test}`);
    }
    for (const test of result.staleExpected) reportExpectedStale(file, test);
  }
  // A discovery run covers every test file, so an entry for any other file is stale too.
  if (!only.length) for (const entry of known.values()) if (!files.includes(entry.file)) reportStale(entry.file, entry.test);
  if (!only.length) for (const entry of expected.values()) if (!files.includes(entry.file)) reportExpectedStale(entry.file, entry.test);
  const total = (field) => results.reduce((sum, result) => sum + (result[field] ?? 0), 0);
  const knownCount = results.reduce((sum, result) => sum + result.knownFailures.length, 0);
  const expectedCount = results.reduce((sum, result) => sum + result.expectedUntilCard.length, 0);
  const summary = `${results.length} files; ${total('tests')} tests; ${total('pass')} passed; ${total('fail')} failed; ${total('cancelled')} cancelled; ${total('skipped')} skipped; ${total('todo')} todo; ${results.filter((result) => result.timedOut).length} timeouts; ${knownCount} known failures; ${expectedCount} expected until card; ${newFailures.length} new failures; ${recovered.length} known failures now pass; ${stale.length} stale known failures; ${expectedRecovered.length} expected now passes; ${expectedStale.length} stale expected`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const section = (title, entries) => `\n### ${title}\n\n${entries.length ? entries.map(({ file, test }) => `- ${markdown(file)}: ${markdown(test)}`).join('\n') : 'None.'}\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## http-mcp tests\n\n${summary}. Counts from completed files only.\n${section('New failures', newFailures)}${section('Stale known failures (match no test)', stale)}${section('Known failures now passing (remove their entries)', recovered)}${section('Expected now passes (remove their entries)', expectedRecovered)}${section('Stale expected (match no test)', expectedStale)}\n`);
  }
  process.exitCode = newFailures.length || stale.length || recovered.length || expectedRecovered.length || expectedStale.length ? 1 : 0;
}

// Node gives argv[1] as typed and import.meta.url as the main module's real path,
// or as typed under --preserve-symlinks-main, so the two differ when the checkout
// is reached through a symlink. Both are compared as real paths.
const invoked = (path) => { try { return realpathSync(path); } catch { return undefined; } };
if (process.argv[1] && invoked(process.argv[1]) === invoked(fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => { if (ownTmp) rmSync(ownTmp, { recursive: true, force: true }); });
}
