import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readPrivateList } from '../../scripts/public-gate/rules-private.mjs';
import { makeTempDir } from '../lib/gate-fixtures.mjs';

const ENTRY = ['quartz', 'lantern'].join('-');
const LIMITS = { maxPrivateListBytes: 65_536, maxPrivateEntries: 2000 };
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
