import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runBounded } from '../../scripts/lib/run-bounded.mjs';

const NODE = process.execPath;
const LIMITS = { maxOutputBytes: 4096, deadlineMs: 5000, graceMs: 200 };
const SURVIVOR_WAIT_MS = 5000;
const POLL_MS = 20;

const runNode = (script, overrides) => runBounded({ command: NODE, args: ['-e', script], ...LIMITS, ...overrides });

/** Returns the rejection of `promise`; fails the test when it resolves. */
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);

/**
 * Whether `pid` is a zombie of the child group `pgrp`. /proc may belong to another pid namespace (a sandbox with
 * `--unshare-pid --ro-bind /proc /proc` shows the box's processes, not ours), so a /proc entry only counts when its stat
 * names the expected process: same pid, our command name and process group `pgrp` (run-bounded starts the leader detached,
 * so the leader's pid is the group of the leader and of its grandchild).
 */
function isZombieOfGroup(pid, pgrp) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return false;
  }
  const [, statPid, command, rest] = stat.match(/^(\d+) \((.*)\) (.*)$/s) ?? [];
  const [state, , statPgrp] = (rest ?? '').split(' ');
  return Number(statPid) === pid && command === basename(NODE).slice(0, 15) && Number(statPgrp) === pgrp && state === 'Z';
}

/**
 * Whether `pid` still runs. kill(pid, 0) resolves the pid in our own pid namespace, the one the children printed it from;
 * ESRCH means it is gone. A zombie still answers, and nothing may reap it (the leader is reaped by run-bounded's spawn, the
 * grandchild by the namespace's pid 1, which a container without an init does not do), so a zombie of group `pgrp` counts as stopped.
 */
function isRunning(pid, pgrp) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code !== 'ESRCH';
  }
  return !isZombieOfGroup(pid, pgrp);
}

/** Waits until `pid` is gone or a zombie of group `pgrp`; returns whether it is. SIGKILL takes effect asynchronously, so this polls with a cap. */
async function exitsSoon(pid, pgrp) {
  for (let waited = 0; waited < SURVIVOR_WAIT_MS; waited += POLL_MS) {
    if (!isRunning(pid, pgrp)) return true;
    await delay(POLL_MS);
  }
  return false;
}

// The leader and its grandchild both ignore SIGTERM; the leader prints LATE-OUTPUT if it ever receives one.
const GRANDCHILD = "process.on('SIGTERM', () => {}); console.log('grandchild ' + process.pid); setInterval(() => {}, 1000);";
const LEADER = `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => process.stdout.write('LATE-OUTPUT\\n'));
  console.log('leader ' + process.pid);
  spawn(process.execPath, ['-e', ${JSON.stringify(GRANDCHILD)}], { stdio: ['ignore', 'inherit', 'inherit'] });
  setInterval(() => {}, 1000);
`;

test('run-bounded returns the exit status and both output streams without judging the status', async () => {
  const result = await runNode("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;");
  assert.equal(result.status, 3);
  assert.equal(result.stdout.toString(), 'out');
  assert.equal(result.stderr.toString(), 'err');
});

test('run-bounded passes input to the child and the given environment only', async () => {
  const script = "process.stdin.on('data', (chunk) => process.stdout.write(chunk + ':' + process.env.BOUNDED_PROBE + ':' + process.env.HOME));";
  const result = await runNode(script, { input: 'fed', env: { BOUNDED_PROBE: 'set' } });
  assert.equal(result.stdout.toString(), 'fed:set:undefined');
});

test('run-bounded refuses a command that cannot start with the spawn-failed cause', async () => {
  const error = await rejection(runBounded({ command: '/nonexistent/binary', args: [], ...LIMITS }));
  assert.equal(error.cause, 'subprocess-spawn-failed');
});

test('run-bounded stops a child that writes past the output cap and keeps no more than the cap', async () => {
  const error = await rejection(runNode("setInterval(() => process.stdout.write('x'.repeat(1024)), 1);", { maxOutputBytes: 2048 }));
  assert.equal(error.cause, 'subprocess-output-limit');
  assert.ok(error.stdout.length <= 2048);
});

test('run-bounded stops a child when the caller aborts and names the interruption', async () => {
  const controller = new AbortController();
  const running = runNode('setInterval(() => {}, 1000);', { signal: controller.signal });
  controller.abort();
  assert.equal((await rejection(running)).cause, 'interrupted');
});

test('run-bounded kills the process group at the deadline, caps output and keeps the cause; a child and its grandchild ignore SIGTERM: escalate their process group to SIGKILL, settle once with the timeout cause, leave no surviving process and append no output received after the deadline', async () => {
  const started = performance.now();
  const error = await rejection(runNode(LEADER, { deadlineMs: 1000, graceMs: 300 }));
  assert.equal(error.cause, 'subprocess-timeout');
  assert.ok(performance.now() - started >= 1300, 'settled before the grace limit let the group escape SIGTERM');
  const output = error.stdout.toString();
  const pids = [...output.matchAll(/^(?:leader|grandchild) (\d+)$/gm)].map(([, pid]) => Number(pid));
  assert.equal(pids.length, 2, output);
  assert.ok(!output.includes('LATE-OUTPUT'), 'output received after the deadline was appended');
  for (const pid of pids) assert.ok(await exitsSoon(pid, pids[0]), `process ${pid} survived`);
});

test('the survivor check counts a live process as running and a killed one as stopped', async () => {
  const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.ok(isRunning(child.pid, child.pid), 'a live process was counted as stopped');
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.ok(await exitsSoon(child.pid, child.pid), 'a killed and reaped process was counted as running');
  } finally {
    child.kill('SIGKILL');
  }
});
