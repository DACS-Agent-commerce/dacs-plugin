#!/usr/bin/env node
// Re-derives test/fixtures/buyer-chain-readback-off-identity.json (the
// DACS_BUYER_CHAIN_READBACK=off byte-identity digests) from a merge base, so
// the fixture never compares a tree against itself:
//   1. archive the base revision's http-mcp/ into a scratch directory;
//   2. overlay only the capture test, its helpers and the live-composition
//      test hooks from this tree;
//   3. record the switch-off capture on the base and on this tree, --runs
//      times each;
//   4. compare every capture byte for byte;
//   5. only if all are identical, write the base's section digests (--write).
// Usage, from http-mcp/: node scripts/buyer-chain-readback-identity.mjs <base-rev> [--write] [--runs N] [--keep]
// Exit 1 (and nothing written) when the captures differ; the scratch
// directory then keeps every capture for diffing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST = 'test/buyer-chain-readback-off-identity.test.mjs';
const OVERLAY = [TEST, 'test/helpers/buyer-chain-readback-identity.mjs', 'test/helpers/buyer-chain-readback-flow.mjs', 'test/helpers/devnet-live-composition-app.mjs'];
const FIXTURE = join(HERE, 'test/fixtures/buyer-chain-readback-off-identity.json');

const args = process.argv.slice(2), flag = (name) => args.includes(name);
const base = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--runs');
const runs = Number(args[args.indexOf('--runs') + 1] ?? 1);
if (!base || (args.includes('--runs') && (!Number.isSafeInteger(runs) || runs < 1))) {
  process.stderr.write('usage: node scripts/buyer-chain-readback-identity.mjs <base-rev> [--write] [--runs N] [--keep]\n'); process.exit(2);
}
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-2000)}`);
  return result.stdout;
};
const root = run('git', ['rev-parse', '--show-toplevel'], { cwd: HERE }).trim();
const sha = run('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: root }).trim();
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'chain-readback-identity-'));

// 1-2. The base's tracked http-mcp/ plus only the overlay; dependencies are linked.
const tar = join(scratch, 'base.tar');
run('git', ['archive', '--format=tar', '-o', tar, sha, 'http-mcp'], { cwd: root });
run('tar', ['-xf', tar, '-C', scratch]);
const baseTree = join(scratch, 'http-mcp');
for (const file of OVERLAY) { mkdirSync(dirname(join(baseTree, file)), { recursive: true }); copyFileSync(join(HERE, file), join(baseTree, file)); }
symlinkSync(join(HERE, 'node_modules'), join(baseTree, 'node_modules'));

// As the repository's per-file test runner: inside a sandbox that reports /
// as uid 65534, the verification-only root-owner shim is preloaded.
const env = { ...process.env, NODE_ENV: 'test' };
delete env.DACS_BUYER_CHAIN_READBACK;
const shim = join(root, '.verification', 'root-owner-shim.mjs');
if (statSync('/').uid === 65534 && existsSync(shim) && !String(env.NODE_OPTIONS ?? '').includes(shim)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${shim}`.trim();

// 3. Record mode writes the whole normalized capture.
function record(tree, name) {
  const out = join(scratch, `${name}.json`);
  run(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', TEST], { cwd: tree, env: { ...env, DACS_TEST_RECORD_IDENTITY: out }, timeout: 900000 });
  if (!existsSync(out)) throw new Error(`${name}: the test wrote no capture`);
  process.stderr.write(`recorded ${name}\n`);
  return { name, out, text: readFileSync(out, 'utf8') };
}
const captures = [];
for (let i = 1; i <= runs; i++) captures.push(record(baseTree, `base-${i}`), record(HERE, `tree-${i}`));

// 4. Every capture must equal the first base capture byte for byte.
const [first] = captures, differing = captures.filter((capture) => capture.text !== first.text);
if (differing.length) {
  const sections = (text) => { const { rows, ...rest } = JSON.parse(text); return { ...rest, ...Object.fromEntries(Object.entries(rows).map(([key, value]) => [`rows.${key}`, value])) }; };
  const expected = sections(first.text);
  for (const capture of differing) {
    const actual = sections(capture.text), names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
    process.stderr.write(`${capture.name} differs from ${first.name} in: ${names.filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key])).join(', ')}\n`);
  }
  process.stderr.write(`captures kept in ${scratch}; nothing written\n`);
  process.exit(1);
}
process.stdout.write(`${captures.length} captures byte-identical (${first.text.length} bytes)\n`);

// 5. Digests of the base capture.
const { sectionDigests } = await import(join(HERE, 'test/helpers/buyer-chain-readback-identity.mjs'));
const fixture = { recordedFrom: `${base} (${sha.slice(0, 7)}) src/ with this tree's capture test overlaid; base and merged-tree captures byte-identical, ${runs} run(s) each`, sections: sectionDigests(JSON.parse(first.text)) };
if (flag('--write')) { writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`); process.stdout.write(`wrote ${FIXTURE}\n`); }
else process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
if (!flag('--keep')) rmSync(scratch, { recursive: true, force: true });
else process.stdout.write(`scratch kept in ${scratch}\n`);
