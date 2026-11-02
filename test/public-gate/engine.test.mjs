import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyBlob } from '../../scripts/public-gate/classify.mjs';
import { GateInputError, readCommitObjects } from '../../scripts/public-gate/objects.mjs';
import {
  CONFIG_FILE, REPO_ROOT, completeArgs, createRepo, gateArgs, makeTempDir, runGate, sha256, snapshotTree,
  writeList,
} from '../lib/gate-fixtures.mjs';

const LIMITS = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).limits;
const PLANTED = ['quartz', 'lantern'].join('-');
const readTarget = (repo, limits = LIMITS) => readCommitObjects({ repo: repo.dir, commit: repo.commit, limits });
const byPath = (target) => Object.fromEntries(target.entries.map((entry) => [entry.path, entry]));

test('the gate reads paths, modes and blobs from Git objects at the given commit and reports that commit and its tree', async () => {
  const repo = createRepo([
    { path: 'a.txt', content: 'alpha\n' },
    { path: 'dir/run.mjs', content: 'export {};\n', mode: '100755' },
  ]);
  const target = await readTarget(repo);
  assert.equal(target.commit, repo.commit);
  assert.equal(target.tree, repo.tree);
  const files = byPath(target);
  assert.equal(files['a.txt'].mode, '100644');
  assert.equal(files['dir/run.mjs'].mode, '100755');
  assert.equal(files['a.txt'].bytes.toString(), 'alpha\n');
  const report = JSON.parse(runGate(gateArgs(repo, 'generic')).stdout);
  assert.deepEqual(report.target, { commit: repo.commit, tree: repo.tree });
});

test('a planted value in the committed blob fails even when the checkout differs; a value only in the working tree is not the candidate\'s', () => {
  const list = writeList([PLANTED]);
  const committed = createRepo([{ path: 'notes.txt', content: `see ${PLANTED}\n` }]);
  writeFileSync(path.join(committed.dir, 'notes.txt'), 'clean checkout\n');
  assert.equal(runGate(completeArgs(committed, list)).status, 1);
  const clean = createRepo([{ path: 'notes.txt', content: 'clean\n' }]);
  writeFileSync(path.join(clean.dir, 'notes.txt'), `${PLANTED} only in the checkout\n`);
  writeFileSync(path.join(clean.dir, 'untracked.txt'), `${PLANTED}\n`);
  assert.equal(runGate(completeArgs(clean, list)).status, 0);
});

test('a path name is public content: a private-list value in a file name fails, and the finding names the path only by its opaque location identifier', () => {
  const repo = createRepo([{ path: `docs/${PLANTED}.md`, content: 'harmless\n' }]);
  const result = runGate(completeArgs(repo, writeList([PLANTED])));
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings.map(({ rule, kind, location }) => ({ rule, kind, location })), [
    { rule: 'R-PRIVATE', kind: 'path', location: `${repo.commit}:entry-1` },
  ]);
  assert.ok(!result.stdout.includes(PLANTED));
});

test('paths are NUL-separated, so names with spaces or newlines are handled exactly internally, and harmless ones are reported exactly; two temporary-repo tracked names differing only in invalid UTF-8 bytes exit 2 as unscannable before keying, name only opaque locations, and neither occurrence is merged, dropped or overwritten; history uses this same decoder', async () => {
  const awkward = 'dir with space/line\nbreak.txt';
  const readable = createRepo([{ path: awkward, content: `${PLANTED}\n` }]);
  assert.equal((await readTarget(readable)).entries[0].path, awkward);
  const listed = runGate(completeArgs(readable, writeList([PLANTED])));
  assert.equal(JSON.parse(listed.stdout).findings[0].location, awkward);

  const invalid = createRepo([
    { path: Buffer.from([0x78, 0xff, 0x79]), content: 'one\n' },
    { path: Buffer.from([0x78, 0xfe, 0x79]), content: 'two\n' },
  ]);
  const target = await readTarget(invalid);
  assert.deepEqual(target.entries.map((entry) => [entry.path, entry.problem]), [
    [null, 'invalid-utf8-path'],
    [null, 'invalid-utf8-path'],
  ]);
  assert.notDeepEqual(target.entries[0].pathBytes, target.entries[1].pathBytes);
  const result = runGate(gateArgs(invalid, 'generic'));
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.unscannable, [
    { location: `${invalid.commit}:invalid-path-1`, cause: 'invalid-utf8-path' },
    { location: `${invalid.commit}:invalid-path-2`, cause: 'invalid-utf8-path' },
  ]);
  assert.ok(report.rules.every((rule) => rule.status !== 'passed'));
});

test('a tracked symlink is reported by its link text and never followed; a submodule is unscannable', async () => {
  const repo = createRepo([
    { path: 'link', content: `../${PLANTED}`, mode: '120000' },
    { path: 'vendor/module', content: 'b'.repeat(40), mode: '160000' },
  ]);
  const files = byPath(await readTarget(repo));
  assert.equal(files.link.kind, 'symlink');
  assert.equal(files.link.bytes.toString(), `../${PLANTED}`);
  assert.equal(files['vendor/module'].problem, 'submodule');
  const result = runGate(completeArgs(repo, writeList([PLANTED])));
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings.map(({ location, line }) => [location, line]), [['link', 1]]);
  assert.deepEqual(report.unscannable, [{ location: 'vendor/module', cause: 'submodule' }]);
});

test('a blob over the size limit or a tree over the object-count limit fails as unscannable, naming the limit', async () => {
  const bigBlob = createRepo([{ path: 'big.txt', content: 'x'.repeat(64) }, { path: 'small.txt', content: 'y' }]);
  const sized = await readTarget(bigBlob, { ...LIMITS, maxBlobBytes: 16 });
  const problems = Object.fromEntries(sized.entries.map((entry) => [entry.path, entry.problem]));
  assert.deepEqual(problems, { 'big.txt': 'limit:maxBlobBytes', 'small.txt': null });
  const crowded = createRepo([{ path: 'a', content: '1' }, { path: 'b', content: '2' }, { path: 'c', content: '3' }]);
  await assert.rejects(readTarget(crowded, { ...LIMITS, maxTreeObjects: 2 }), (error) => {
    assert.ok(error instanceof GateInputError);
    assert.equal(error.cause, 'limit:maxTreeObjects');
    return true;
  });
  await assert.rejects(readTarget(crowded, { ...LIMITS, maxTotalBlobBytes: 2 }), { cause: 'limit:maxTotalBlobBytes' });
});

test('a code, config or doc file holding a NUL byte or invalid UTF-8 is unscannable; a binary asset without a reviewed disposition is unscannable; binary classification never skips the path or private-list checks', () => {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  const textTypes = ['code.mjs', 'settings.json', 'guide.md'];
  for (const name of textTypes) {
    assert.deepEqual(classifyBlob(name, Buffer.from('ok\0bad'), config), { problem: 'nul-or-invalid-utf8-text' });
    assert.deepEqual(classifyBlob(name, Buffer.from([0x61, 0xff]), config), { problem: 'nul-or-invalid-utf8-text' });
  }
  const asset = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  assert.deepEqual(classifyBlob('logo.bin', asset, config), { problem: 'binary-without-disposition' });
  const reviewed = { ...config, binaryDispositions: [{ path: 'logo.bin', sha256: sha256(asset), reason: 'reviewed fixture asset' }] };
  assert.deepEqual(classifyBlob('logo.bin', asset, reviewed), { binary: true });
  assert.deepEqual(classifyBlob('other.bin', asset, reviewed), { problem: 'binary-without-disposition' });
  assert.deepEqual(classifyBlob('logo.bin', Buffer.concat([asset, Buffer.from([1])]), reviewed), { problem: 'binary-without-disposition' });
  assert.deepEqual(classifyBlob('notes.txt', Buffer.from('plain\n'), config), { binary: false });

  const list = writeList([PLANTED]);
  const repo = createRepo([{ path: `blob-${PLANTED}.bin`, content: Buffer.concat([asset, Buffer.from(PLANTED.toUpperCase())]) }]);
  const result = runGate(completeArgs(repo, list));
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 2);
  assert.deepEqual(report.unscannable.map((entry) => entry.cause), ['binary-without-disposition']);
  assert.deepEqual(report.findings.map((finding) => finding.kind).sort(), ['content', 'path']);
});

test('an empty tree or an unknown commit fails closed', () => {
  const empty = createRepo([]);
  const emptyRun = runGate(gateArgs(empty, 'generic'));
  assert.equal(emptyRun.status, 2);
  assert.match(emptyRun.stderr, /empty-tree/);
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  const unknown = runGate(['--repo', repo.dir, '--commit', 'c'.repeat(40), '--scope', 'generic']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown-commit/);
  assert.equal(unknown.stdout, '');
});

test('two runs give byte-identical reports, and the checkout is unchanged after a run', () => {
  const repo = createRepo([{ path: 'b.txt', content: 'b\n' }, { path: 'a/c.txt', content: `${PLANTED}\n` }]);
  const list = writeList([PLANTED]);
  const before = snapshotTree(repo.dir);
  const first = runGate(completeArgs(repo, list));
  const second = runGate(completeArgs(repo, list));
  assert.equal(first.status, 1);
  assert.equal(first.stdout, second.stdout);
  assert.equal(snapshotTree(repo.dir), before);
});

test('the gate passes on its own sources and tests', () => {
  const own = ['scripts/public-gate', 'scripts/lib', 'test/public-gate', 'test/lib', 'public-gate.config.json', 'docs/PUBLIC-GATE.md']
    .flatMap((entry) => walkFiles(path.join(REPO_ROOT, entry)));
  assert.ok(own.length > 8);
  const repo = createRepo(own.map((file) => ({ path: path.relative(REPO_ROOT, file), content: readFileSync(file) })));
  const result = runGate(gateArgs(repo, 'generic'));
  assert.equal(result.status, 0, result.stdout);
});

test('a git call that outlives its deadline fails with the timeout cause, and an over-cap reply with the output-limit cause', async () => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  await assert.rejects(readTarget(repo, { ...LIMITS, maxListingBytes: 8 }), { cause: 'output-limit' });
  const binDir = makeTempDir('slow-git');
  writeFileSync(path.join(binDir, 'git'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  try {
    await assert.rejects(readTarget(repo, { ...LIMITS, gitDeadlineMs: 50 }), { cause: 'timeout' });
  } finally {
    process.env.PATH = originalPath;
  }
});

test('a directory that is not a repository fails as git-refused, not as an unknown commit', async () => {
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  await assert.rejects(readCommitObjects({ repo: makeTempDir('plain'), commit: repo.commit, limits: LIMITS }), { cause: 'git-refused' });
});

test('git variables in the caller\'s environment cannot redirect the read to another repository', async () => {
  const wanted = createRepo([{ path: 'wanted.txt', content: 'wanted\n' }]);
  const other = createRepo([{ path: 'other.txt', content: 'other\n' }]);
  const originalGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other.dir, '.git');
  try {
    assert.deepEqual((await readTarget(wanted)).entries.map((entry) => entry.path), ['wanted.txt']);
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
  }
});

function walkFiles(entry) {
  const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-co', '--exclude-standard', '--', entry], { encoding: 'utf8' });
  return listing.split('\n').filter(Boolean).map((file) => path.join(REPO_ROOT, file));
}
