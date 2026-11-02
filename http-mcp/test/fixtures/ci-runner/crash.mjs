import { test } from 'node:test';
import assert from 'node:assert/strict';
// CI_RUNNER_CRASH: kill (SIGKILL, as an OOM kill), exit1, exit0 or exitcode.
test('exact failure # name: café', () => assert.equal(1, 2));
test('passes before the crash', () => {});
test('crashes', async () => {
  await new Promise((done) => setTimeout(done, 200));
  const mode = process.env.CI_RUNNER_CRASH;
  if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
  else if (mode === 'exitcode') process.exitCode = 3;
  else process.exit(mode === 'exit0' ? 0 : 1);
});
test('never reported after a crash', () => assert.fail('hidden regression'));
