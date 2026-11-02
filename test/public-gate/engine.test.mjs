import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyBlob } from '../../scripts/public-gate/classify.mjs';
import { GateInputError, readCommitObjects } from '../../scripts/public-gate/objects.mjs';
import { CONFIG_FILE, createRepo, makeTempDir, sha256 } from '../lib/gate-fixtures.mjs';

const LIMITS = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).limits;
const PLANTED = ['quartz', 'lantern'].join('-');
const readTarget = (repo, limits = LIMITS) => readCommitObjects({ repo: repo.dir, commit: repo.commit, limits });
const byPath = (target) => Object.fromEntries(target.entries.map((entry) => [entry.path, entry]));

test('the reader takes paths, modes and blobs from Git objects at the given commit and returns that commit and its tree', async () => {
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
});

test('paths are NUL-separated, so names with spaces or newlines are read exactly; two tracked names differing only in invalid UTF-8 bytes are both returned as invalid-utf8-path with distinct path bytes, and neither is merged, dropped or overwritten', async () => {
  const awkward = 'dir with space/line\nbreak.txt';
  const readable = createRepo([{ path: awkward, content: `${PLANTED}\n` }]);
  assert.equal((await readTarget(readable)).entries[0].path, awkward);

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
});

test('a tracked symlink is read as its link text and never followed; a submodule is a problem entry', async () => {
  const repo = createRepo([
    { path: 'link', content: `../${PLANTED}`, mode: '120000' },
    { path: 'vendor/module', content: 'b'.repeat(40), mode: '160000' },
  ]);
  const files = byPath(await readTarget(repo));
  assert.equal(files.link.kind, 'symlink');
  assert.equal(files.link.bytes.toString(), `../${PLANTED}`);
  assert.equal(files['vendor/module'].problem, 'submodule');
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

test('the total-bytes limit counts every path, so identical blobs under several paths add up', async () => {
  const repeated = createRepo([{ path: 'a.txt', content: 'abcd' }, { path: 'b.txt', content: 'abcd' }]);
  await assert.rejects(readTarget(repeated, { ...LIMITS, maxTotalBlobBytes: 5 }), { cause: 'limit:maxTotalBlobBytes' });
  const target = await readTarget(repeated, { ...LIMITS, maxTotalBlobBytes: 8 });
  assert.deepEqual(target.entries.map((entry) => entry.bytes.toString()), ['abcd', 'abcd']);
});

test('a code, config or doc file holding a NUL byte or invalid UTF-8 is unscannable; a binary asset without a reviewed disposition is unscannable', () => {
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
});

test('an empty tree or an unknown commit fails closed', async () => {
  await assert.rejects(readTarget(createRepo([])), { cause: 'empty-tree' });
  const repo = createRepo([{ path: 'a.txt', content: 'a\n' }]);
  await assert.rejects(readCommitObjects({ repo: repo.dir, commit: 'c'.repeat(40), limits: LIMITS }), { cause: 'unknown-commit' });
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
