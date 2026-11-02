import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The live operator has no authorize callback, so a manual seller approval is
// the terminal prompt `Type APPROVE <hash>`. The owned stop aborts its signal:
// the waiting prompt must then end undecided (operator_closing, no evidence
// line, never rejected), and an exact APPROVE <hash>
// typed after that must be ignored. A real pseudo-terminal drives it (Python
// pty; there is no expect on every host). Children get process.execPath and an
// explicit PATH. The driver needs Python 3.9 or newer (os.waitstatus_to_exitcode).
// Without a usable python3 the tests skip, except when CI is set: there they
// fail, so this only coverage of the terminal prompt cannot silently disappear.
const PATH = '/usr/local/bin:/usr/bin:/bin';
const usable = (path) => existsSync(path) && spawnSync(path, ['-I', '-c', 'import os, pty, sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { env: { PATH }, timeout: 10000 }).status === 0;
const python = PATH.split(':').map((dir) => join(dir, 'python3')).find(usable);
const helper = (name) => fileURLToPath(new URL(`./helpers/${name}`, import.meta.url));

async function runDriver(t, child, mode, timeout) {
  assert.ok(python, `CI is set and no python3 3.9 or newer with pty is installed in ${PATH}`);
  const root = await mkdtemp(join(tmpdir(), 'approval-tty-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH, HOME: process.env.HOME ?? root, TMPDIR: process.env.TMPDIR ?? tmpdir(), ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) };
  return spawnSync(python, ['-I', helper('approval-tty-driver.py'), process.execPath, helper(child), join(root, 'evidence', 'seller-approvals.jsonl'), mode],
    { encoding: 'utf8', timeout, env });
}

async function drive(t, mode) {
  const run = await runDriver(t, 'approval-tty-child.mjs', mode, 60000);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const line = (name) => run.stdout.match(new RegExp(`^TTY-${name} (.*)$`, 'm'))?.[1];
  return { output: run.stdout + run.stderr, exit: line('EXIT'), prompts: Number(line('PROMPTS')), result: line('RESULT') ? JSON.parse(line('RESULT')) : null };
}

const skip = python || process.env.CI ? false : 'no python3 3.9 or newer with pty is installed';

test('terminal approval: the exact APPROVE typed while the prompt waits is approved (the harness reaches the real prompt)', { skip, timeout: 90000 }, async (t) => {
  const run = await drive(t, 'control');
  assert.equal(run.exit, '0', run.output);
  assert.equal(run.prompts, 1, run.output);
  assert.deepEqual(run.result, { first: true, final: ['approved'] }, run.output);
});

test('terminal approval: after the stop aborts the prompt, a late exact APPROVE is ignored and nothing is decided or recorded', { skip, timeout: 90000 }, async (t) => {
  const run = await drive(t, 'late');
  assert.equal(run.exit, '0', run.output);
  assert.deepEqual(run.result, {
    first: 'operator_closing', // the aborted prompt ended undecided
    lateSeen: true, // the late APPROVE <hash> reached the process
    afterLate: [], // and changed nothing: no line, approved or rejected
    second: 'operator_closing', // a later approval is not asked
    final: [],
  }, run.output);
  assert.equal(run.prompts, 1, `the refused later approval asks no prompt: ${run.output}`);
});

test('terminal approval driver: a child that never closes the terminal ends with the driver\'s own error and its output kept', { skip, timeout: 90000 }, async (t) => {
  const started = Date.now();
  const run = await runDriver(t, 'approval-tty-hang-child.mjs', 'control', 30000);
  const output = run.stdout + run.stderr;
  assert.equal(run.error, undefined, `the driver ends by itself, before the caller's timeout: ${output}`);
  assert.equal(run.status, 2, output);
  assert.match(run.stdout, /^TTY-RESULT \{"hang":true\}$/m, 'what the child printed is kept');
  assert.match(run.stdout, /^TTY-EXIT -9$/m, 'the driver killed and reaped the child');
  assert.match(run.stdout, /^TTY-DRIVER-ERROR the child did not close the terminal/m);
  assert.ok(Date.now() - started < 25000, `took ${Date.now() - started} ms`);
});
