import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KILL_GRACE_MS } from '../lib/run-bounded.mjs';
import { writeRecord } from '../public-gate/redact.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const SDK_INPUT = path.join(SCRIPT_DIRECTORY, 'sdk-input.mjs');
/** Each result line is built only from the fixed suite names, results and causes below, so it carries nothing from the checkout. */
const RESULT_PREFIX = 'test-all: ';
const RESULT_ROUTE = 'test-all.stdout';
/** Exit statuses, as sdk-input's: 1 for a failure, 2 for what could not be verified. */
const EXIT = { pass: 0, fail: 1, unverifiable: 2 };
const SDK_INPUT_EXIT = { refused: 1, unavailable: 2 };
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };
const PENDING_OWNER = 'P54c2';

/**
 * The rows of the command matrix in README.md, in its order. A delivered row names the directory it runs in, the SDK input
 * preparation `sdk-input` validates for it, its commands and the runtimes its job runs on (`needsBrowser` marks a suite whose
 * browser files skip without a browser); a pending row names the card that delivers it. The README's rows are checked against
 * this list in test/ci/matrix.test.mjs.
 */
export const MATRIX = [
  { suite: 'Root gate, lib and CI tests', directory: '.', prepare: 'root', commands: ['npm test'], runtimes: ['22.23.3'] },
  { suite: 'http-mcp, browser files included', directory: 'http-mcp', prepare: 'http-mcp', commands: ['npm run test:ci'], runtimes: ['22.23.3'], needsBrowser: true },
  { suite: 'stdio typecheck and unit tests', directory: 'stdio-mcp', prepare: 'stdio', commands: ['npm run typecheck', 'npm test'], runtimes: ['20.19.0', '22.23.3'] },
  { suite: 'Checker regression suite', pending: PENDING_OWNER },
  { suite: 'W-6 import check, both plugins', pending: PENDING_OWNER },
  { suite: 'Buyer execution suite', pending: PENDING_OWNER },
  { suite: 'Buyer runtime refusal on the floor', pending: PENDING_OWNER },
];

const outcome = (result, cause) => ({ result, cause });
function exitCause({ status, signal, spawnFailed }) {
  if (spawnFailed) return 'spawn-failed';
  return signal ? `signal-${signal}` : `exit-${status}`;
}

/** The child in progress, and the signal that interrupted this run, if one did. */
let running = null;
let interrupted = null;

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch { /* the group is already gone */ }
}

/** Stops the child in progress, with its whole process group: SIGTERM now, SIGKILL if it is still there after the grace period. */
function stopRunning(signal) {
  interrupted ??= signal;
  const child = running;
  if (child === null) return;
  signalGroup(child, 'SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL');
  }, KILL_GRACE_MS).unref();
}

/** Runs `command` in `cwd` in its own process group with this process's output and CI set, as in Actions; resolves { status, signal } or { spawnFailed } and never rejects. */
function runInGroup(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', detached: true, env: { ...process.env, CI: 'true' } });
    running = child;
    child.once('error', () => {
      running = null;
      resolve({ spawnFailed: true });
    });
    child.once('close', (status, signal) => {
      running = null;
      resolve({ status, signal });
    });
  });
}

const nodeMajor = (version) => version.split('.')[0];

/** The first runtime of the row's job whose Node major version this run is not on, or null: a row is credited only when every leg of its job ran. */
function runtimeNotRun(runtimes) {
  return runtimes.find((version) => nodeMajor(version) !== nodeMajor(process.versions.node)) ?? null;
}

/** The cause that stops a browser suite before it starts: DACS_TEST_CHROME must name an existing file, as the workflow's step sets it; else null. */
function browserCause() {
  const browser = process.env.DACS_TEST_CHROME;
  if (!browser) return 'browser-unset';
  return existsSync(browser) ? null : 'browser-absent';
}

/**
 * Runs one delivered row: the suite must be present, its browser (if it needs one) and its SDK input available before any of its
 * commands runs. A row whose commands all pass is a pass only when this run is on every runtime of the row's job.
 */
async function runDeliveredRow({ directory, prepare, commands, runtimes, needsBrowser = false }) {
  const cwd = path.join(REPO_ROOT, directory);
  if (!existsSync(path.join(cwd, 'package.json'))) return outcome('unverifiable', 'suite-absent');
  const missingBrowser = needsBrowser ? browserCause() : null;
  if (missingBrowser) return outcome('unverifiable', missingBrowser);
  const validation = await runInGroup(process.execPath, [SDK_INPUT, '--prepare', prepare], cwd);
  if (validation.status === SDK_INPUT_EXIT.unavailable) return outcome('unverifiable', 'sdk-input-unavailable');
  if (validation.status === SDK_INPUT_EXIT.refused) return outcome('fail', 'sdk-input-refused');
  if (validation.status !== 0) return outcome('fail', `sdk-input-${exitCause(validation)}`);
  for (const command of commands) {
    if (interrupted) return outcome('fail', 'interrupted');
    const [file, ...args] = command.split(' ');
    const run = await runInGroup(file, args, cwd);
    if (run.status !== 0) return outcome('fail', exitCause(run));
  }
  const missingRuntime = runtimeNotRun(runtimes);
  return missingRuntime ? outcome('unverifiable', `runtime-${missingRuntime}-not-run`) : outcome('pass');
}

const describe = ({ result, cause }) => (cause ? `${result} (${cause})` : result);

/**
 * Runs the matrix in order, one row at a time, and prints `test-all: <suite>: <result>` for each row. A failing row does not stop
 * the rows after it. It does not install anything: the preparation commands of the README matrix run first. Resolves the exit
 * status: 1 if any suite failed, else 2 if any row is unverifiable (an absent suite, a missing browser, an unavailable SDK input,
 * a runtime of the row's job this run is not on, or a pending row), else 0; after SIGINT or SIGTERM it stops the running suite and resolves 128 plus the signal number.
 */
async function main() {
  for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, () => stopRunning(signal));
  const results = [];
  for (const row of MATRIX) {
    if (interrupted) break;
    const rowOutcome = row.pending ? outcome('unverifiable', `pending-${row.pending}`) : await runDeliveredRow(row);
    if (interrupted) break;
    await writeRecord(`${RESULT_PREFIX}${row.suite}: ${describe(rowOutcome)}\n`, RESULT_ROUTE);
    results.push(rowOutcome.result);
  }
  if (interrupted) {
    await writeRecord(`${RESULT_PREFIX}interrupted by ${interrupted}\n`, RESULT_ROUTE);
    return SIGNAL_EXIT[interrupted];
  }
  if (results.includes('fail')) return EXIT.fail;
  return results.includes('unverifiable') ? EXIT.unverifiable : EXIT.pass;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
