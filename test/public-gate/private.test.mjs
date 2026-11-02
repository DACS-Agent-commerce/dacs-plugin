import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { completeArgs, createRepo, runGate, sha256, writeList } from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const LABEL = ['harbor', 'node', 'seven'].join('');

test('a private-list hit fails and the report names only kind, file and line, never the value', () => {
  const repo = createRepo([{ path: 'src/app.mjs', content: `// ok\nconst name = '${PLANTED.toUpperCase()}';\n` }]);
  const result = runGate(completeArgs(repo, writeList([PLANTED])));
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, [{ rule: 'R-PRIVATE', kind: 'content', location: 'src/app.mjs', line: 2 }]);
  assert.ok(!result.stdout.toLowerCase().includes(PLANTED));
  assert.ok(!result.stderr.toLowerCase().includes(PLANTED));
});

test('list entries are exact text: regex characters match literally, comment and blank lines are ignored, CRLF lists work', () => {
  const entry = 'host.(one)+[x]';
  const repo = createRepo([
    { path: 'literal.txt', content: `before ${entry.toUpperCase()} after\n` },
    { path: 'lookalike.txt', content: 'hostX(one)x\n' },
  ]);
  const list = writeList(['# a comment', '', entry]);
  const crlf = writeList([`${entry}\r`]);
  for (const file of [list, crlf]) {
    const report = JSON.parse(runGate(completeArgs(repo, file)).stdout);
    assert.deepEqual(report.findings.map((finding) => finding.location), ['literal.txt']);
  }
  assert.equal(runGate(completeArgs(repo, writeList(['# only a comment']))).status, 2);
});

test('a bare machine label fails only when the private list names it, in any file or path', () => {
  const repo = createRepo([
    { path: `notes/${LABEL}.md`, content: 'label in a path\n' },
    { path: 'docs/guide.md', content: `Run on ${LABEL} today\n` },
    { path: 'docs/other.md', content: 'nothing here\n' },
  ]);
  const named = runGate(completeArgs(repo, writeList([LABEL])));
  assert.equal(named.status, 1);
  assert.deepEqual(JSON.parse(named.stdout).findings.map(({ kind, location }) => [kind, location]), [
    ['content', 'docs/guide.md'],
    ['path', `${repo.commit}:entry-1`],
  ]);
  const unnamed = runGate(completeArgs(repo, writeList(['some-other-label'])));
  assert.equal(unnamed.status, 0);
});

test('a non-ASCII entry is found case-insensitively in a blob that is not valid UTF-8, on the right line', () => {
  const invalidByte = Buffer.from([0xff]);
  const repo = createRepo([
    { path: 'first.bin', content: Buffer.concat([invalidByte, Buffer.from('ÉCLAIR\n')]) },
    { path: 'second.bin', content: Buffer.concat([invalidByte, Buffer.from('\nplain\nÉclair\n')]) },
    { path: 'third.bin', content: Buffer.concat([invalidByte, Buffer.from('nothing here\n')]) },
  ]);
  const result = runGate(completeArgs(repo, writeList(['éclair'])));
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings.map(({ location, line }) => [location, line]), [['first.bin', 1], ['second.bin', 3]]);
});

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function writeListWithBom(entries) {
  const file = writeList(entries);
  writeFileSync(file, Buffer.concat([BOM, readFileSync(file)]));
  return file;
}

test('a list that starts with a byte-order mark still matches its first entry, and the digest covers the exact bytes', () => {
  const repo = createRepo([{ path: 'a.txt', content: `hello ${PLANTED} here\n` }]);
  const file = writeListWithBom([PLANTED, 'other-entry']);
  const result = runGate(completeArgs(repo, file));
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, [{ rule: 'R-PRIVATE', kind: 'content', location: 'a.txt', line: 1 }]);
  assert.equal(report.scanner.privateListSha256, sha256(readFileSync(file)));
});

test('a list holding only a byte-order mark and a comment holds no entry and exits 2', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'nothing here\n' }]);
  const result = runGate(completeArgs(repo, writeListWithBom(['# only a comment'])));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /private-list-empty/);
});

test('a list line with leading or trailing whitespace is refused instead of being matched as written', () => {
  const repo = createRepo([{ path: 'a.txt', content: `hello ${PLANTED} here\n` }]);
  for (const line of [`${PLANTED} `, ` ${PLANTED}`, `${PLANTED}\t`, ' ']) {
    const result = runGate(completeArgs(repo, writeList(['first-entry', line])));
    assert.equal(result.status, 2, JSON.stringify(line));
    assert.match(result.stderr, /private-list-malformed: line 2 of the private list/);
    assert.ok(!result.stderr.includes(PLANTED));
    assert.equal(result.stdout, '');
  }
});

test('a list that separates entries with a lone carriage return keeps every entry', () => {
  const repo = createRepo([{ path: 'a.txt', content: `hello ${PLANTED} here\n` }]);
  const file = writeList([]);
  writeFileSync(file, `first-entry\r${PLANTED}\r`);
  assert.equal(runGate(completeArgs(repo, file)).status, 1);
});

test('an entry written with backslash escapes in a text blob is found on the blob\'s own line, and a near miss is not', () => {
  const parts = ['maple', 'harbor', 'test'];
  const repo = createRepo([
    { path: 'src/guard.test.mjs', content: `// guard\nconst long = 'a' + \\\n  'b';\nassert.doesNotMatch(doc, /${parts.join('\\.')}/, 'names no host');\n` },
    { path: 'src/near.mjs', content: `const pattern = /${['maple', 'harbour', 'test'].join('\\.')}/;\n` },
  ]);
  const result = runGate(completeArgs(repo, writeList([parts.join('.')])));
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [{ rule: 'R-PRIVATE', kind: 'content', location: 'src/guard.test.mjs', line: 4 }]);
  for (const form of [parts.join('.'), parts.join('\\.')]) assert.ok(!result.stdout.includes(form) && !result.stderr.includes(form));
});
