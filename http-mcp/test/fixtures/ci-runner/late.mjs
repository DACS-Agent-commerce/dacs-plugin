import { test, describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
// CI_RUNNER_LATE: an error no test catches, after the tests end: exit (thrown in an
// exit handler, after the file's summary), timer (uncaught exception) or reject
// (unhandled rejection); or an exit status set in an exit handler: kill (SIGKILL),
// abort (SIGABRT), exit-code (process.exitCode = 9) or exit-call (process.exit(42)).
// child and version write Node's fatal-error line before the summary or inside
// another line, which is no late error. suite-after fails a suite's after hook,
// which Node counts as neither a pass nor a failure: the file's summary stays
// successful and it exits 0. CI_RUNNER_PASS=1 leaves out the failing test.
const mode = process.env.CI_RUNNER_LATE;
if (process.env.CI_RUNNER_PASS !== '1') test('exact failure # name: café', () => assert.equal(1, 2));
test('passes', () => {});
if (mode === 'exit') process.on('exit', () => { throw new Error('new crash in an exit handler'); });
if (mode === 'timer') setTimeout(() => { throw new Error('new late exception'); }, 300);
if (mode === 'reject') setTimeout(() => { Promise.reject(new Error('new late rejection')); }, 300);
if (mode === 'kill') process.on('exit', () => { process.kill(process.pid, 'SIGKILL'); });
if (mode === 'abort') process.on('exit', () => { process.abort(); });
if (mode === 'exit-code') process.on('exit', () => { process.exitCode = 9; });
if (mode === 'exit-call') process.on('exit', () => { process.exit(42); });
if (mode === 'child') spawnSync(process.execPath, ['-e', 'throw new Error("a child process crashes")'], { stdio: 'inherit' });
if (mode === 'version') process.on('exit', () => { process.stderr.write(`running on Node.js ${process.version}\n`); });
if (mode === 'suite-after') describe('a suite whose after hook fails', () => {
  it('passes', () => {});
  after(() => { throw new Error('suite after hook failed'); });
});
