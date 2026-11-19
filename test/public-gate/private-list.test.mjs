import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readPrivateList } from '../../scripts/public-gate/rules-private.mjs';
import { hermeticGitEnvironment, makeTempDir } from '../lib/gate-fixtures.mjs';

const ENTRY = ['quartz', 'lantern'].join('-');
const LIMITS = { maxPrivateListBytes: 65_536, maxPrivateEntries: 2000, gitDeadlineMs: 20_000 };
const RULES_FILE = new URL('../../scripts/public-gate/rules-private.mjs', import.meta.url).href;

function listFile(content, dir = makeTempDir('list')) {
  const file = path.join(dir, 'private-list.txt');
  writeFileSync(file, content);
  return file;
}

const read = (file, repo = makeTempDir('repo')) => readPrivateList(file, { repo, limits: LIMITS });

test('entries are exact lines: CRLF, LF and a lone CR end a line; blank and # lines and a leading byte-order mark are ignored', () => {
  assert.deepEqual(read(listFile('﻿host.(one)+[x]\r\n# comment\n\nsecond\rthird\r')), ['host.(one)+[x]', 'second', 'third']);
});

test('the rules source spells every irregular whitespace character as an escape, as the repo lint requires', () => {
  const irregularWhitespace = /[\f\v\u0085\uFEFF\u00A0\u1680\u180E\u2000-\u200B\u2028\u2029\u202F\u205F\u3000]/u;
  assert.doesNotMatch(readFileSync(new URL(RULES_FILE), 'utf8'), irregularWhitespace);
});

test('fixed report words are ordinary entries', () => {
  assert.deepEqual(read(listFile('commit\nscope\nstatus\n')), ['commit', 'scope', 'status']);
});

test('a line with leading or trailing whitespace, or a list that is not UTF-8, is malformed', () => {
  for (const line of [`${ENTRY} `, ` ${ENTRY}`, `${ENTRY}\t`, ' ']) {
    assert.throws(() => read(listFile(`first\n${line}\n`)), { cause: 'private-list-malformed' }, JSON.stringify(line));
  }
  assert.throws(() => read(listFile(Buffer.from([0x61, 0xff, 0x0a]))), { cause: 'private-list-malformed' });
});

test('a list with no entry is empty, and one over the entry or byte limit names that limit', () => {
  assert.throws(() => read(listFile('﻿# only a comment\n\n')), { cause: 'private-list-empty' });
  assert.throws(() => read(listFile(Array.from({ length: 2001 }, (_, index) => `entry-${index}`).join('\n'))), { cause: 'limit:maxPrivateEntries' });
  assert.deepEqual(read(listFile('e'.repeat(65_536))), ['e'.repeat(65_536)]);
  assert.throws(() => read(listFile('e'.repeat(65_537))), { cause: 'limit:maxPrivateListBytes' });
});

test('a list inside the repository is refused, also when the repository or the list is reached through a symlink', () => {
  const repo = makeTempDir('repo');
  mkdirSync(path.join(repo, 'notes'));
  const inside = listFile(`${ENTRY}\n`, path.join(repo, 'notes'));
  assert.throws(() => read(inside, repo), { cause: 'private-list-in-repo' });
  const repoAlias = path.join(makeTempDir('alias'), 'repo');
  symlinkSync(repo, repoAlias);
  assert.throws(() => read(inside, repoAlias), { cause: 'private-list-in-repo' });
  const listAlias = path.join(makeTempDir('alias'), 'list.txt');
  symlinkSync(inside, listAlias);
  assert.throws(() => read(listAlias, repo), { cause: 'private-list-in-repo' });
  assert.deepEqual(read(listFile(`${ENTRY}\n`, makeTempDir('beside')), repo), [ENTRY]);
});

test('a missing file, a folder or a FIFO is unreadable, and a FIFO with no writer never hangs the read', () => {
  assert.throws(() => read(path.join(makeTempDir('missing'), 'none.txt')), { cause: 'private-list-unreadable' });
  assert.throws(() => read(makeTempDir('folder')), { cause: 'private-list-unreadable' });
  const fifo = path.join(makeTempDir('fifo'), 'list');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const script = `const { readPrivateList } = await import(${JSON.stringify(RULES_FILE)});
    try { readPrivateList(${JSON.stringify(fifo)}, { repo: '/nonexistent', limits: ${JSON.stringify(LIMITS)} }); } catch (error) { process.stdout.write(error.cause); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.signal, null, 'the read hung');
  assert.equal(child.stdout, 'private-list-unreadable');
});

function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], { env: hermeticGitEnvironment(), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

/** A git repository `main` with one commit and a `sub` folder, in a fresh base folder. */
function worktreeRepo() {
  const base = makeTempDir('git');
  const dir = path.join(base, 'main');
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
  return { base, dir };
}

function listIn(...parts) {
  const folder = path.join(...parts);
  mkdirSync(folder, { recursive: true });
  return listFile(`${ENTRY}\n`, folder);
}

const refused = (file, repo, label) => assert.throws(() => read(file, repo), { cause: 'private-list-in-repo' }, label);

test('a list anywhere in the worktree is refused when --repo is a folder below its top, also spelled relatively', () => {
  const { dir } = worktreeRepo();
  const list = listIn(dir, 'notes');
  refused(list, path.join(dir, 'sub'), 'absolute');
  refused(list, path.relative(process.cwd(), path.join(dir, 'sub')), 'relative');
});

test('a list in the worktree is refused when --repo is its .git folder', () => {
  const { dir } = worktreeRepo();
  refused(listIn(dir, 'notes'), path.join(dir, '.git'));
});

test('with --repo a linked worktree, a list in the main worktree or the main .git folder is refused', () => {
  const { base, dir } = worktreeRepo();
  const linked = path.join(base, 'linked');
  git(dir, ['worktree', 'add', '-q', linked, '-b', 'other']);
  refused(listIn(dir, 'notes'), linked, 'main worktree');
  refused(listIn(dir, '.git', 'x'), linked, 'common git dir');
  refused(listIn(linked, 'notes'), linked, 'linked worktree');
});

test('with --repo the main worktree, a list in a linked worktree outside it is refused', () => {
  const { base, dir } = worktreeRepo();
  const linked = path.join(base, 'linked');
  git(dir, ['worktree', 'add', '-q', linked, '-b', 'other']);
  refused(listIn(linked, 'notes'), dir);
});

test('with --repo a worktree whose git folder is elsewhere, a list in that git folder is refused', () => {
  const base = makeTempDir('git');
  const [dir, separate] = [path.join(base, 'wt'), path.join(base, 'sep.git')];
  mkdirSync(dir);
  git(dir, ['init', '-q', `--separate-git-dir=${separate}`]);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
  refused(listIn(separate, 'info'), dir, 'git folder');
  refused(listIn(dir, 'notes'), dir, 'worktree');
});

test('a GIT_DIR in the caller environment does not change which repository --repo names', () => {
  const { dir } = worktreeRepo();
  const bare = path.join(makeTempDir('git'), 'bare.git');
  git(makeTempDir('git'), ['init', '-q', '--bare', bare]);
  const list = listIn(dir, 'notes');
  const script = `const { readPrivateList } = await import(${JSON.stringify(RULES_FILE)});
    try { readPrivateList(${JSON.stringify(list)}, { repo: ${JSON.stringify(path.join(dir, 'sub'))}, limits: ${JSON.stringify(LIMITS)} }); } catch (error) { process.stdout.write(error.cause); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, GIT_DIR: bare }, timeout: 20_000 });
  assert.equal(child.stdout, 'private-list-in-repo');
});

/** The real git, found once, so a wrapper can hand every other call to it. */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/** Runs `body` with a `git` ahead of the real one on PATH: a shell script that runs `prelude` first, then the real git. */
function withWrappedGit(prelude, body) {
  const bin = makeTempDir('fake-git');
  const wrapper = path.join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh\n${prelude}\nexec ${REAL_GIT} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const original = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${original}`;
  try {
    return body();
  } finally {
    process.env.PATH = original;
  }
}

test('a repository whose worktree list git refuses is refused with git-refused, not read as if it had no other worktree', () => {
  const { base, dir } = worktreeRepo();
  const linked = path.join(base, 'linked');
  git(dir, ['worktree', 'add', '-q', linked, '-b', 'other']);
  const list = listIn(dir, 'notes');
  const refuseWorktreeList = 'case "$*" in *"worktree list"*) echo "unknown option: -z" >&2; exit 129;; esac';
  withWrappedGit(refuseWorktreeList, () => assert.throws(() => read(list, linked), { cause: 'git-refused' }));
});

const withDeadline = (gitDeadlineMs) => ({ ...LIMITS, gitDeadlineMs });

test('a git query that does not finish within the deadline is refused with timeout, also the last one', () => {
  const { dir } = worktreeRepo();
  const list = listIn(makeTempDir('beside'));
  withWrappedGit('case "$*" in *"worktree list"*) exec sleep 30;; esac', () => assert.throws(() => readPrivateList(list, { repo: dir, limits: withDeadline(200) }), { cause: 'timeout' }));
});

test('the three git queries share one deadline: slow queries that each fit it but not together are refused with timeout', () => {
  const { dir } = worktreeRepo();
  const list = listIn(makeTempDir('beside'));
  withWrappedGit('sleep 0.5', () => assert.throws(() => readPrivateList(list, { repo: dir, limits: withDeadline(800) }), { cause: 'timeout' }));
});

test('a git query that prints more than the byte cap is refused with output-limit', () => {
  const { dir } = worktreeRepo();
  const list = listIn(makeTempDir('beside'));
  const printTooMuch = 'case "$*" in *"git-common-dir"*) head -c 2097152 /dev/zero; exit 0;; esac';
  withWrappedGit(printTooMuch, () => assert.throws(() => readPrivateList(list, { repo: dir, limits: LIMITS }), { cause: 'output-limit' }));
});

test('a --repo that does not exist is still read when worktree list is refused', () => {
  const refuseWorktreeList = 'case "$*" in *"worktree list"*) exit 129;; esac';
  const missing = path.join(makeTempDir('missing'), 'none');
  withWrappedGit(refuseWorktreeList, () => assert.deepEqual(read(listIn(makeTempDir('beside')), missing), [ENTRY]));
});

test('a list outside every folder of the repository is read, also when --repo is a plain folder of another repository or does not exist', () => {
  const { base, dir } = worktreeRepo();
  assert.deepEqual(read(listIn(makeTempDir('beside')), dir), [ENTRY]);
  assert.deepEqual(read(listIn(base, 'main-notes'), dir), [ENTRY], 'a folder sharing only a name prefix');
  assert.deepEqual(read(listIn(base, 'main-notes'), path.join(dir, 'sub')), [ENTRY]);
  assert.deepEqual(read(listIn(makeTempDir('beside')), makeTempDir('plain-folder')), [ENTRY]);
  assert.deepEqual(read(listIn(makeTempDir('beside')), path.join(base, 'missing')), [ENTRY]);
});
