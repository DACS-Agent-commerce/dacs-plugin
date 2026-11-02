// test/helpers/mutate-dcr.mjs's verdicts, checked with a stub in place of the file it runs
// (test/oauth-logout.test.mjs): DCR_STUB chooses how the stub's baseline, mutant and restored
// runs end, and each case requires the helper's exit code and message. Not in
// oauth-logout.test.mjs, which the helper runs once per mutant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// A run is a mutant's when the source differs from the original; an unmutated run after the first is the restored one.
const stub = `
import { test, after } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const mutated = readFileSync('src/auth/authorization-server.mjs', 'utf8') !== readFileSync(process.env.DCR_STUB_ORIGINAL, 'utf8');
const counter = process.env.DCR_STUB_COUNTER, runs = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(runs));
const mode = process.env.DCR_STUB, restored = !mutated && runs > 1;
if (mode === 'hang') {
  await import('./fixtures/node-test-child/hang-deadline.mjs');
  writeFileSync(process.env.DCR_STUB_READY, String(process.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'root-after' || (mode === 'hook-kill' && mutated) || (mode === 'restored-hook' && restored)) after(() => { throw new Error('root after hook failed'); });
test(mode === 'renamed' && mutated ? 'a2' : 'a', () => {
  if (mode === 'survive' || mode === 'hook-kill') return;
  if (mode === 'exit-midway' && mutated) process.exit(0);
  if (mutated || (mode === 'restored-fails' && restored)) throw new Error('caught');
});
if (mode === 'fewer' && mutated) await new Promise(() => {});
test('b', (t) => { if (mode === 'skip' && mutated) t.skip('skipped on a mutant'); });
`;
// The stub's file name: Node names a failed root hook's result after the file.
const hook = /\/test\/oauth-logout\.test\.mjs/.source;
const scenarios = [
  ['good', 'catches every mutant that fails a test, between a passing baseline and restored run', 0, /^restored: 2 passed; \d+ mutants caught; logs: /m],
  ['root-after', 'refuses a baseline whose root after hook fails', 1, new RegExp(`clean baseline must pass: not ok: \\S*${hook}$`, 'm')],
  ['survive', 'refuses a mutant that fails no test', 1, /: mutant survived: no regression assertion failed \(exit 0, not ok: \)$/m],
  ['hook-kill', 'refuses a mutant that fails only a hook', 1, new RegExp(`: mutant survived: no regression assertion failed \\(exit 0, not ok: \\S*${hook}\\)$`, 'm')],
  ['skip', 'refuses a mutant run that skips a test', 1, /: skipped tests$/m],
  ['renamed', 'refuses a mutant run that renames a test and keeps the count', 1, /: missing test results \(1 expected test\(s\) have no result, first: a\)$/m],
  ['fewer', 'refuses a mutant run that ends before registering a test', 1, /: missing test results \(/],
  ['exit-midway', 'refuses a mutant run that exits part-way', 1, /: missing test results \(no closing test summary/],
  ['restored-fails', 'refuses a restored run that fails a test', 1, /restored source must pass: not ok: a$/m],
  ['restored-hook', 'refuses a restored run whose root after hook fails', 1, new RegExp(`restored source must pass: not ok: \\S*${hook}$`, 'm')],
];

let dir, source, original;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dcr-verdicts-'));
  for (const name of ['src', 'test', 'public', 'package.json']) cpSync(join(root, name), join(dir, name), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  source = join(dir, 'src/auth/authorization-server.mjs');
  original = readFileSync(source, 'utf8');
  writeFileSync(join(dir, 'original.mjs'), original);
  writeFileSync(join(dir, 'test/oauth-logout.test.mjs'), stub);
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function runHelper(mode, signal, onSpawn = () => {}) {
  // TMPDIR=dir puts the helper's private copy under dir.
  const env = { ...process.env, TMPDIR: dir, DCR_STUB: mode, DCR_STUB_ORIGINAL: join(dir, 'original.mjs'), DCR_STUB_COUNTER: join(dir, `${mode}.count`), DCR_STUB_READY: join(dir, `${mode}.ready`) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['test/helpers/mutate-dcr.mjs', join(dir, `${mode}-logs`)], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  onSpawn(child.pid);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const stop = () => {
    const groups = [...output.matchAll(/^\S+: process group (\d+)$/gm)].map((match) => Number(match[1]));
    if (child.pid && child.exitCode === null && child.signalCode === null) groups.unshift(child.pid);
    for (const group of groups) try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  // A test timeout aborts t.signal while its body is still awaiting close. Kill both the
  // detached helper and its reported child groups immediately, so that await can finish.
  signal.addEventListener('abort', stop, { once: true });
  try {
    const closed = new Promise((resolve, reject) => { child.once('close', (code, signal) => resolve({ code, signal, output })); child.once('error', reject); });
    if (signal.aborted) stop();
    return await closed;
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}

for (const [mode, title, wantExit, wantText] of scenarios) {
  test(`mutate-dcr ${title}`, { timeout: 120_000 }, async (t) => {
    const { code, output } = await runHelper(mode, t.signal);
    assert.equal(code, wantExit, output);
    assert.match(output, wantText);
    assert.equal(readFileSync(source, 'utf8'), original, 'the invoking checkout must stay unmutated');
  });
}

test('mutate-dcr test cancellation kills a hanging helper and its active child group', { timeout: 15000 }, async (t) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  t.signal.addEventListener('abort', abort, { once: true });
  let helperPid, pid, deadline;
  const running = runHelper('hang', controller.signal, (value) => { helperPid = value; });
  const ready = join(dir, 'hang.ready');
  try {
    for (let i = 0; i < 300 && !existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(ready), 'the baseline child did not reach its hanging state');
    pid = Number(readFileSync(ready, 'utf8'));
    process.kill(-pid, 0);
    controller.abort();
    const { code, signal, output } = await Promise.race([running, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('the helper did not close after cancellation')), 3000);
    })]);
    clearTimeout(deadline);
    assert.deepEqual([code, signal], [null, 'SIGKILL'], output);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(-pid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); }
      catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
    }
    assert.equal(alive, false, 'the hanging baseline process group survived cancellation');
  } finally {
    clearTimeout(deadline);
    controller.abort();
    // Independent cleanup also bounds this regression if cancellation ever stops working.
    for (const group of [helperPid, pid]) if (group) try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await running;
    t.signal.removeEventListener('abort', abort);
  }
});
