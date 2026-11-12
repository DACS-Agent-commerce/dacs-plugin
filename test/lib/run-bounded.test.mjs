import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runBounded } from '../../scripts/lib/run-bounded.mjs';

const NODE = process.execPath;
const LIMITS = { maxOutputBytes: 4096, deadlineMs: 5000, graceMs: 200 };
const SURVIVOR_WAIT_MS = 5000;
const POLL_MS = 20;
/** Linux task flag (include/linux/sched.h) set once a process has started to exit. */
const PF_EXITING = 0x4;
/** SIGKILL is signal 9: bit 8 of the pending-signal masks in /proc/<pid>/status. */
const SIGKILL_BIT = 1n << 8n;

const runNode = (script, overrides) => runBounded({ command: NODE, args: ['-e', script], ...LIMITS, ...overrides });

/** Returns the rejection of `promise`; fails the test when it resolves. */
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);

/**
 * Whether `pid` can still run on: it exists, is not a zombie, has not started to exit and has no SIGKILL pending.
 * A process that was sent SIGKILL counts as stopped even while it is still being torn down: under a CPU limit that teardown
 * can take seconds, so the wall time until it leaves /proc says nothing about whether the group kill reached it.
 */
function canRunOn(pid) {
  let stat;
  let status;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    status = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return false;
  }
  // After the command name: state, ppid, pgrp, session, tty_nr, tpgid, flags.
  const [state, , , , , , flags] = stat.replace(/^.*\) /, '').split(' ');
  if (state === 'Z' || state === 'X' || (Number(flags) & PF_EXITING) !== 0) return false;
  const pending = (field) => BigInt(`0x${status.match(new RegExp(`^${field}:\\s*([0-9a-f]+)$`, 'm'))?.[1] ?? '0'}`);
  return ((pending('SigPnd') | pending('ShdPnd')) & SIGKILL_BIT) === 0n;
}

/** Waits until `pid` is gone, a zombie, exiting or has SIGKILL pending; returns whether it is. Signal delivery is asynchronous, so this polls with a cap. */
async function stopsSoon(pid) {
  for (let waited = 0; waited < SURVIVOR_WAIT_MS; waited += POLL_MS) {
    if (!canRunOn(pid)) return true;
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
  for (const pid of pids) assert.ok(await stopsSoon(pid), `process ${pid} survived without SIGKILL`);
});
