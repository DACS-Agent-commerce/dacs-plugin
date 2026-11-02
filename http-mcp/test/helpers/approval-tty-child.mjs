// Runs on a real pseudo-terminal under approval-tty-driver.py. It asks the
// exact seller approval's terminal prompt (no authorize callback, as the live
// operator does) with a shutdown signal that SIGUSR2 aborts.
// argv: <evidence path> <late|control>
import { existsSync, readFileSync } from 'node:fs';
import { createExactOperatorApproval } from '../../src/devnet-demo/operator-approval.mjs';

const [evidencePath, mode] = process.argv.slice(2);
const stop = new AbortController();
process.on('SIGUSR2', () => { stop.abort(); process.stdout.write('TTY-ABORTED\n'); });
const approve = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath, signal: stop.signal, now: () => 1 });
const request = (n) => ({ method: 'sendTransaction', address: `0x${'ab'.repeat(32)}`, content: { artifactKind: 'CompositeVerificationRecord', jobId: `tty-job-${n}`, debit: { totalOs: '1000' } } });
const decisions = () => existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).decision) : [];

// A cut approval throws operator_closing; it is reported by that code.
const answer = (asked) => asked.then((value) => value, (error) => error?.code ?? 'error');
const first = await answer(approve(request(1)));
process.stdout.write(`TTY-FIRST ${first}\n`);
if (mode === 'control') {
  process.stdout.write(`TTY-RESULT ${JSON.stringify({ first, final: decisions() })}\n`);
  process.exit(0);
}
// The late answer reaches this process (the prompt is gone, so this listener
// takes it); then nothing may have changed. The prompt's close paused stdin.
const lateSeen = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 5000);
  process.stdin.once('data', () => { clearTimeout(timer); resolve(true); }).resume();
});
await new Promise((resolve) => setTimeout(resolve, 300));
const afterLate = decisions();
// After the stop, a new approval is refused without a prompt.
const second = await answer(approve(request(2)));
process.stdout.write(`TTY-RESULT ${JSON.stringify({ first, lateSeen, afterLate, second, final: decisions() })}\n`);
process.exit(0);
