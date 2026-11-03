import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { completeArgs, createRepo, makeTempDir, runGate, writeList } from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const LABEL = ['harbor', 'node', 'seven'].join('');

test('a private-list hit fails and the report names only kind, opaque location and line, never the value or the path', () => {
  const repo = createRepo([{ path: 'src/app.mjs', content: `// ok\nconst name = '${PLANTED.toUpperCase()}';\n` }]);
  const result = runGate(completeArgs(repo, writeList([PLANTED])));
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [{ rule: 'R-PRIVATE', kind: 'content', location: `${repo.commit}:1`, line: 2 }]);
  for (const text of [PLANTED, 'src/app.mjs']) assert.ok(!`${result.stdout}${result.stderr}`.toLowerCase().includes(text));
});

test('list entries are exact text: regex characters match literally', () => {
  const entry = 'host.(one)+[x]';
  const repo = createRepo([
    { path: 'literal.txt', content: `before ${entry.toUpperCase()} after\n` },
    { path: 'lookalike.txt', content: 'hostX(one)x\n' },
  ]);
  const report = JSON.parse(runGate(completeArgs(repo, writeList(['# a comment', '', entry]))).stdout);
  assert.deepEqual(report.findings.map((finding) => finding.location), [`${repo.commit}:1`]);
});

test('a bare machine label fails only when the private list names it, in any file or path', () => {
  const repo = createRepo([
    { path: 'docs/guide.md', content: `Run on ${LABEL} today\n` },
    { path: 'docs/other.md', content: 'nothing here\n' },
    { path: `notes/${LABEL}.md`, content: 'label in a path\n' },
  ]);
  const named = runGate(completeArgs(repo, writeList([LABEL])));
  assert.equal(named.status, 1);
  assert.deepEqual(JSON.parse(named.stdout).findings.map(({ kind, location }) => [kind, location]), [
    ['content', `${repo.commit}:1`],
    ['path', `${repo.commit}:3`],
  ]);
  assert.equal(runGate(completeArgs(repo, writeList(['some-other-label']))).status, 0);
});

test('a non-ASCII entry is found case-insensitively in a blob that is not valid UTF-8, on the right line', () => {
  const invalidByte = Buffer.from([0xff]);
  const repo = createRepo([
    { path: 'first.bin', content: Buffer.concat([invalidByte, Buffer.from('ÉCLAIR\n')]) },
    { path: 'second.bin', content: Buffer.concat([invalidByte, Buffer.from('\nplain\rÉclair\n')]) },
    { path: 'third.bin', content: Buffer.concat([invalidByte, Buffer.from('nothing here\n')]) },
  ]);
  const report = JSON.parse(runGate(completeArgs(repo, writeList(['éclair']))).stdout);
  const privateFindings = report.findings.filter((finding) => finding.rule === 'R-PRIVATE');
  assert.deepEqual(privateFindings.map(({ location, line }) => [location, line]), [[`${repo.commit}:1`, 1], [`${repo.commit}:2`, 3]]);
});

test('at the largest list, an 8 MiB blob with no hit scans within the deadline and passes', () => {
  const prefix = 'shared-prefix-for-entries-';
  const entries = Array.from({ length: 2000 }, (_, index) => `${prefix}${String(index).padStart(4, '0')}`);
  const repo = createRepo([{ path: 'big.txt', content: `${prefix}x `.repeat(Math.floor((8 << 20) / (prefix.length + 2))) }]);
  const result = runGate(completeArgs(repo, writeList(entries)), { timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
});

test('a list entry that is also a report word gives a clean pass', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const result = runGate(completeArgs(repo, writeList(['commit', 'scope', 'status', 'target'])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).rules.find((rule) => rule.id === 'R-PRIVATE'), { id: 'R-PRIVATE', status: 'passed' });
});

test('a malformed, oversized, in-repository or special-file list exits 2 with only its cause and fixed text, before any report', () => {
  const repo = createRepo([{ path: 'a.txt', content: `hello ${PLANTED}\n` }]);
  const padded = writeList(['first-entry', ` ${PLANTED}`]);
  const oversized = writeList(['e'.repeat(70_000)]);
  const inRepo = path.join(repo.dir, 'private-list.txt');
  writeFileSync(inRepo, `${PLANTED}\n`);
  const fifo = path.join(makeTempDir('fifo'), 'list');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const cases = [[padded, 'private-list-malformed'], [oversized, 'limit:maxPrivateListBytes'], [inRepo, 'private-list-in-repo'], [fifo, 'private-list-unreadable']];
  for (const [file, cause] of cases) {
    const result = runGate(completeArgs(repo, file));
    assert.equal(result.status, 2, cause);
    assert.match(result.stderr, new RegExp(`^${cause}: [\\w -]+$`, 'm'));
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
  assert.deepEqual(JSON.parse(result.stdout).findings, [{ rule: 'R-PRIVATE', kind: 'content', location: `${repo.commit}:1`, line: 4 }]);
  for (const form of [parts.join('.'), parts.join('\\.')]) assert.ok(!result.stdout.includes(form) && !result.stderr.includes(form));
});
