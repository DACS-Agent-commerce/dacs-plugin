import { spawn } from 'node:child_process';
import { GateInputError } from '../public-gate/objects.mjs';

/** How long a process group gets to leave after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 2000;

/** A subprocess that was stopped or never started; `cause` is subprocess-timeout, subprocess-output-limit, subprocess-spawn-failed or interrupted, `stdout` and `stderr` hold what arrived before it was stopped. */
export class RunBoundedError extends GateInputError {
  constructor(cause, message, output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) {
    super(cause, message);
    this.name = 'RunBoundedError';
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }
}

/**
 * Runs `command` with `args` in its own process group under a deadline and an output cap (stdout and stderr together).
 * Resolves { status, signal, stdout, stderr } when the child exits on its own, whatever its status, and kills what it left behind.
 * When the deadline passes, the output cap is exceeded or `signal` aborts, it stops appending output, sends SIGTERM to the
 * whole group, SIGKILL after `graceMs`, and rejects once, after the child has exited, with a RunBoundedError holding the cause
 * and the output received up to that moment. Rejects with subprocess-spawn-failed when the command cannot start.
 */
export function runBounded({ command, args, cwd, env, input, maxOutputBytes, deadlineMs, graceMs = KILL_GRACE_MS, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    const timers = [];
    let received = 0;
    let failure = null;
    let killed = false;
    let exited = false;
    let settled = false;

    const killGroup = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch { /* the group is already gone */ }
    };
    const captured = () => ({ stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr) });
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    };
    const rejectWhenGone = () => {
      if (killed && exited) settle(() => reject(new RunBoundedError(failure.cause, failure.message, captured())));
    };
    const stop = (cause, message) => {
      if (failure) return;
      failure = { cause, message };
      killGroup('SIGTERM');
      timers.push(setTimeout(() => {
        killGroup('SIGKILL');
        killed = true;
        rejectWhenGone();
      }, graceMs));
    };
    function onAbort() {
      stop('interrupted', `${command} was interrupted`);
    }
    const collect = (stream) => (chunk) => {
      if (failure) return;
      received += chunk.length;
      if (received > maxOutputBytes) stop('subprocess-output-limit', `${command} wrote more than ${maxOutputBytes} bytes`);
      else output[stream].push(chunk);
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.on('error', (error) => settle(() => reject(new RunBoundedError('subprocess-spawn-failed', `${command} could not start (${error.code ?? error.name})`))));
    child.on('exit', () => {
      exited = true;
      rejectWhenGone();
    });
    child.on('close', (status, signalName) => {
      if (failure) return;
      killGroup('SIGKILL');
      settle(() => resolve({ status, signal: signalName, ...captured() }));
    });
    timers.push(setTimeout(() => stop('subprocess-timeout', `${command} did not finish within ${deadlineMs} ms`), deadlineMs));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(input);
  });
}
