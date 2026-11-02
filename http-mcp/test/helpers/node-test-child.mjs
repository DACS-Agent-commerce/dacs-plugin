// Runs one test file for the mutant helpers, as `node --test-reporter=tap <file>`.
// No --test-force-exit: it can end a file before its tests register and still
// exit 0. Not under `node --test` either: that runner closes with a summary of
// whatever results arrived, so a file that calls process.exit(0) part-way looks
// complete with fewer tests. Run directly, the file prints its own summary only
// when its event loop drains after the last test.
// Results are read from a second TAP reporter that writes to a private file, not
// from stdout, where the file and the code it tests can print anything. A file
// that never loads node:test writes nothing there.
// The run leads its own process group, and the whole group is killed at the
// deadline, when its output passes maxBuffer, when the file exits (nothing it
// started outlives it), and when this process exits or is interrupted. SIGKILL
// cannot be caught: a caller that SIGKILLs a helper also kills the run's group,
// whose id onSpawn receives.
//
// `incomplete` names why a run has no complete results; such a run is neither a
// pass nor a caught mutant. A run is complete only when the file exited by
// itself, its reporter's TAP ends with the summary, the counts add up and match
// the exit code, at least one test ran, and every name in `expected` has a
// result. `expected` comes from expectedTests: the results of a complete, passing
// run of the same file and arguments against unmutated code. `notOk` names every
// failed result, suites and hooks included, which the counts leave out: a run
// passes only with none, and a mutant is caught only when a test failed. `failures`
// holds the same results with the fields of each one's YAML block. A file that
// registers no test or exits before its tests finish (even with code 0) writes
// no summary. One that crashes or fails to load after a test ran writes a
// summary that disagrees with its exit code. One whose tests all miss
// --test-name-pattern reports 0 tests. One that ends cleanly before registering
// a later test, for example after a promise that never settles, misses an
// expected name.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COUNTS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const running = new Map();
const killGroup = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
const groupGone = (child) => { try { process.kill(-child.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
let guarded = false;

function guard() {
  if (guarded) return;
  guarded = true;
  // TAP and hook-exit semantics are verified against the CI pin. Keep manual runs usable,
  // but identify the runtime when a different Node release may produce different results.
  if (process.version !== 'v22.23.3') console.warn(`node-test-child: running ${process.version}; test-result parsing is validated on Node v22.23.3 (the CI pin)`);
  process.prependListener('exit', () => { for (const [child, dir] of running) { killGroup(child); rmSync(dir, { recursive: true, force: true }); } });
  // A detached group misses a terminal's Ctrl-C; a helper without a handler of
  // its own exits through the 'exit' listener above.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) if (!process.listenerCount(signal)) process.on(signal, () => process.exit(code));
}

// Each result line outside the YAML blocks, named by its enclosing suites and its own name,
// and those of them that are `not ok` other than a failing TODO. For each of those, `failures`
// keeps the fields of the YAML block that follows its line (its error's name and code among
// them), not the lines of a value nested under a field. Its own stack is retained separately.
function reported(tap) {
  const names = [], notOk = [], failures = [], path = [];
  let yaml = null, fields = null, stack = null, inStack = false, failure = null;
  for (const line of tap.split('\n')) {
    if (yaml !== null) {
      if (line === `${yaml}...`) yaml = null;
      else if (fields && line.startsWith(yaml) && line[yaml.length] !== ' ') {
        const field = line.slice(yaml.length);
        fields.push(field);
        inStack = field === 'stack: |-' || field === 'stack: |';
      } else if (inStack && line.startsWith(`${yaml}  `)) stack.push(line.slice(yaml.length + 2));
      continue;
    }
    const [, indent, start, subtest, failed, name, directive] = /^( *)(?:(---)$|# Subtest: (.*)$|(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$)/.exec(line) ?? [];
    const level = indent?.length / 4;
    if (start) { yaml = indent; fields = failure?.fields ?? null; stack = failure?.stack ?? null; inStack = false; failure = null; }
    else if (subtest !== undefined) { path.length = level; path[level] = subtest; }
    else if (name !== undefined) {
      names.push([...path.slice(0, level), name].join(' > '));
      failure = failed && directive !== 'TODO' ? { name: names.at(-1), fields: [], stack: [] } : null;
      if (failure) { notOk.push(failure.name); failures.push(failure); }
    }
  }
  return { names, notOk, failures };
}

function account({ tap, exit, signal, stopped, expected }) {
  // The summary follows the top-level plan; diagnostics such as a late uncaught error may sit between them.
  const block = /\n1\.\.\d+\n((?:# .*\n)+)$/.exec(`\n${tap}`)?.[1] ?? '';
  const summary = Object.fromEntries([...block.matchAll(/^# (\w+) ([\d.]+)$/gm)].map(([, key, value]) => [key, Number(value)]));
  const counts = Object.fromEntries(COUNTS.map((key) => [key, Number.isSafeInteger(summary[key]) ? summary[key] : null]));
  const { tests, pass, fail, cancelled, skipped, todo } = counts;
  const { names, notOk, failures } = reported(tap), left = new Map();
  for (const name of names) left.set(name, (left.get(name) ?? 0) + 1);
  const missing = (expected ?? []).filter((name) => !(left.get(name) > 0 && left.set(name, left.get(name) - 1)));
  // Node 22 exits 0 when only a suite or a hook failed; later Node exits 1 for a failed suite.
  const exits = fail + cancelled > 0 ? [1] : notOk.length ? [0, 1] : [0];
  const incomplete = stopped ? stopped
    : signal !== null ? `the file was killed by ${signal}`
    : COUNTS.some((key) => counts[key] === null) ? 'no closing test summary (the file registered no test, exited early or was not a node:test file)'
    : tests !== pass + fail + cancelled + skipped + todo ? 'summary counts do not add up'
    : !exits.includes(exit) ? `exit code ${exit} disagrees with the summary`
    : tests === 0 ? 'the file ran no test'
    : missing.length ? `${missing.length} expected test(s) have no result, first: ${missing[0]}`
    : null;
  return { ...counts, names, notOk, failures, incomplete };
}

// A complete run with no failed result, suite or hook: what an unmutated run must be.
export const passed = (run) => run.incomplete === null && run.exit === 0 && run.notOk.length === 0;
// A caught mutant: a complete run in which a test failed. A failed suite or hook alone is not one.
export const killed = (run) => run.incomplete === null && run.exit === 1 && run.fail > 0;

// `expected` is required: the names from expectedTests, or null only for the
// unmutated run that supplies them, whose caller must require passed(). A
// complete run reports at least one result, so an empty list is refused.
export function runNodeTest(file, { args = [], cwd = process.cwd(), env = process.env, timeoutMs, maxBuffer = 1024 * 1024, onSpawn, expected } = {}) {
  if (!(timeoutMs > 0)) throw new TypeError('timeoutMs is required');
  if (expected !== null && !(Array.isArray(expected) && expected.length)) throw new TypeError('expected is required: names from expectedTests, or null for the unmutated run');
  guard();
  const childEnv = { ...env };
  // Inside a test process this would make the file report to it instead of in TAP.
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise((done) => {
    const started = Date.now(), out = [], err = [], dir = mkdtempSync(join(tmpdir(), 'node-test-child-')), report = join(dir, 'report.tap');
    let bytes = 0, stopped = null;
    const child = spawn(process.execPath, ['--test-reporter=tap', '--test-reporter-destination=stdout',
      '--test-reporter=tap', `--test-reporter-destination=${report}`, ...args, file],
    { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (reason) => { stopped ??= `${reason}; process group killed`; killGroup(child); };
    const timer = setTimeout(() => stop(`no exit within ${timeoutMs / 1000} s`), timeoutMs);
    const collect = (chunks) => (chunk) => { chunks.push(chunk); if ((bytes += chunk.length) > maxBuffer) stop(`output over ${maxBuffer} bytes`); };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (error) => { stopped ??= `could not run: ${error.message}`; });
    if (child.pid) { running.set(child, dir); onSpawn?.(child.pid); }
    let grace;
    child.on('exit', () => {
      if (child.pid) killGroup(child);
      // A process that left the group can still hold the pipes open: stop waiting for them.
      grace = setTimeout(() => { stopped ??= 'output held open 5 s after the file exited'; child.stdout.destroy(); child.stderr.destroy(); }, 5000);
    });
    child.on('close', async (exit, signal) => {
      clearTimeout(timer);
      clearTimeout(grace);
      // SIGKILL takes a moment to end a process and its parent's exit to reap it: resolve once the group is gone.
      for (let waited = 0; child.pid && !groupGone(child); waited += 10) {
        if (waited >= 2000) { stopped ??= 'process group still present 2 s after the file exited'; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      running.delete(child);
      let tap = '';
      try {
        if (statSync(report).size > maxBuffer) stopped ??= `reporter output over ${maxBuffer} bytes`;
        else tap = readFileSync(report, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') stopped ??= `reporter output unreadable: ${error.message}`; }
      rmSync(dir, { recursive: true, force: true });
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      done({ file, nodeVersion: process.version, exit, signal, ms: Date.now() - started, stdout, stderr, tap, ...account({ tap, exit, signal, stopped, expected }) });
    });
  });
}

const inventories = new Map();
// Runs the file once per cwd, file and arguments against unmutated code (env and
// cwd must point it there) and returns the names its complete, passing run
// reported: the `expected` of every mutant run of the same file and arguments.
export function expectedTests(file, options = {}) {
  const key = JSON.stringify([options.cwd ?? process.cwd(), file, options.args ?? []]);
  if (!inventories.has(key)) inventories.set(key, runNodeTest(file, { ...options, expected: null }).then((run) => {
    // A complete run that did not pass has a not-ok result: exit 1 needs one.
    if (!passed(run)) throw new Error(`unmutated ${[file, ...options.args ?? []].join(' ')} must pass with complete results: ${run.incomplete ?? `not ok: ${run.notOk.join(', ')}`}\n${run.stdout}\n${run.stderr}`);
    return run.names;
  }));
  return inventories.get(key);
}
