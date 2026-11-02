import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gateRevision } from '../../scripts/public-gate/gate.mjs';
import {
  createHistory, gateArgs, git, historyArgs, makeTempDir, runGate, runHistory, sha256, writeList,
} from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const OTHER = ['onyx', 'meridian'].join('-');
const THIRD = ['harbornode', 'seven'].join('');
const ALLOWED = 'Project <project@example.invalid>';
const outputOf = (run) => `${run.stdout}${run.stderr}`;
const brief = (report) => report.findings.map((finding) => `${finding.rule} ${finding.kind} ${finding.location.replace(/^[0-9a-f]{40}:/, '')} ${finding.line ?? '-'}`);

test('a clean history passes with every commit read; an entry that an early commit added and a later one removed is found though the tip is clean', () => {
  const clean = createHistory([{}, { message: 'second' }, { message: 'third' }]);
  const run = runHistory(historyArgs(clean, writeList([PLANTED])));
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.scope, 'history');
  assert.deepEqual(report.target, { heads: [clean.commits[2]], commits: 3 });
  assert.deepEqual(report.rules, [{ id: 'R-IDENTITY', status: 'not-run' }, { id: 'R-PRIVATE', status: 'passed' }]);
  assert.equal(report.scanner.gateRevision, gateRevision());
  assert.equal(report.scanner.expectedRoot, clean.commits[0]);

  const history = createHistory([{}, { files: { 'a.txt': 'ok\n', 'leak.txt': `before\n${PLANTED}\n` } }, { files: { 'a.txt': 'ok\n' } }]);
  const listFile = writeList([PLANTED]);
  const tip = runGate(gateArgs({ dir: history.dir, commit: history.commits[2] }, 'complete', ['--private-list', listFile, '--expected-root', history.commits[0]]));
  assert.equal(tip.status, 0, 'the tip tree alone holds nothing');
  const found = runHistory(historyArgs(history, listFile));
  assert.equal(found.status, 1);
  assert.deepEqual(JSON.parse(found.stdout).findings, [{ rule: 'R-PRIVATE', kind: 'content', commit: history.commits[1], location: `${history.commits[1]}:2`, line: 2 }]);
  assert.ok(!outputOf(found).includes(PLANTED));
});

test('messages, author and committer lines and other headers are scanned and located by commit and kind, never by value', () => {
  const history = createHistory([
    {},
    { message: `subject\n\nbody line\n${PLANTED}` },
    { author: { name: OTHER, email: 'a@example.invalid' } },
    { committer: { name: 'Project', email: `${THIRD}@example.invalid` } },
  ]);
  const tree = git(history.dir, ['rev-parse', `${history.commits[3]}^{tree}`]);
  const raw = `tree ${tree}\nparent ${history.commits[3]}\nauthor ${ALLOWED} 1700000000 +0000\ncommitter ${ALLOWED} 1700000000 +0000\nx-note ${PLANTED}\n\nplain\n`;
  const withHeader = git(history.dir, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: Buffer.from(raw) });
  git(history.dir, ['update-ref', 'refs/heads/main', withHeader]);
  const run = runHistory(historyArgs(history, writeList([PLANTED, OTHER, THIRD]), [], withHeader));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings.map((finding) => [finding.kind, finding.commit]), [
    ['author', history.commits[2]], ['committer', history.commits[3]], ['header', withHeader], ['message', history.commits[1]],
  ]);
  assert.deepEqual(brief(report), ['R-PRIVATE author author -', 'R-PRIVATE committer committer -', 'R-PRIVATE header header -', 'R-PRIVATE message message 4']);
  for (const value of [PLANTED, OTHER, THIRD]) assert.ok(!outputOf(run).includes(value));
});

test('the identity rule finds any other identity and any time zone but +0000, and is not-run without the flag', () => {
  const history = createHistory([
    {},
    { author: { name: 'Someone', email: 'someone@example.invalid' } },
    { committer: { name: 'Someone', email: 'someone@example.invalid' } },
    { tz: '+0100' },
  ]);
  const listFile = writeList([PLANTED]);
  const off = runHistory(historyArgs(history, listFile));
  assert.equal(off.status, 0);
  assert.deepEqual(JSON.parse(off.stdout).rules[0], { id: 'R-IDENTITY', status: 'not-run' });

  const run = runHistory(historyArgs(history, listFile, ['--allowed-identity', ALLOWED]));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.rules, [{ id: 'R-IDENTITY', status: 'findings' }, { id: 'R-PRIVATE', status: 'passed' }]);
  assert.deepEqual(report.findings.map((finding) => [finding.kind, history.commits.indexOf(finding.commit)]), [
    ['author', 1], ['committer', 2], ['timezone', 3], ['timezone', 3],
  ]);
  assert.ok(!outputOf(run).includes('someone@'));

  const clean = createHistory([{}, {}]);
  assert.equal(runHistory(historyArgs(clean, listFile, ['--allowed-identity', ALLOWED])).status, 0);
  assert.equal(runHistory(historyArgs(clean, listFile, ['--allowed-identity', 'no angle brackets'])).status, 2);
});

test('pull-request text is scanned in every string at any depth and located by object and string number; a file that is not an array of objects exits 2', () => {
  const history = createHistory([{}, {}]);
  const listFile = writeList([PLANTED]);
  const file = path.join(makeTempDir('pr'), 'prs.json');
  const body = `[{"title":"fine","body":"first\\nsecond ${PLANTED}","notes":{"list":["x","${PLANTED}"]},"number":7}]`;
  writeFileSync(file, body);
  const run = runHistory(historyArgs(history, listFile, ['--pr-text', file]));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings, [
    { rule: 'R-PRIVATE', kind: 'pr-text', location: 'pr-1:2', line: 2 },
    { rule: 'R-PRIVATE', kind: 'pr-text', location: 'pr-1:4', line: 1 },
  ]);
  assert.equal(report.scanner.prTextSha256, sha256(readFileSync(file)));
  assert.ok(!outputOf(run).includes(PLANTED));

  writeFileSync(file, '[{"title":"fine","body":"nothing here"}]');
  assert.equal(runHistory(historyArgs(history, listFile, ['--pr-text', file])).status, 0);
  for (const unusable of ['{"title":"x"}', '["text"]', '[null]', '[[]]', 'not json']) {
    writeFileSync(file, unusable);
    const refused = runHistory(historyArgs(history, listFile, ['--pr-text', file]));
    assert.equal(refused.status, 2, unusable);
    assert.equal(refused.stdout, '');
  }
  assert.equal(runHistory(historyArgs(history, listFile, ['--pr-text', path.join(makeTempDir('pr'), 'missing.json')])).status, 2);
});

test('the history report holds no pull-request key path and nothing derived from the list: different, reordered, repeated or overlapping lists give byte-identical reports of fixed words, object ids, digests and numbers', () => {
  const history = createHistory([{}, { files: { 'a.txt': 'ok\n', [`${PLANTED}.txt`]: `x\n${PLANTED}\n` }, message: `subject\n\n${PLANTED}` }]);
  const file = path.join(makeTempDir('pr'), 'prs.json');
  writeFileSync(file, JSON.stringify([{ title: 'fine', 'reviewer-thread': { nested: `see ${PLANTED}` }, [`${PLANTED}-notes`]: `also ${PLANTED}` }]));
  const lists = [[PLANTED], [OTHER, PLANTED, THIRD], [THIRD, PLANTED, PLANTED.slice(0, 9), PLANTED, OTHER]].map(writeList);
  const runs = lists.map((list) => runHistory(historyArgs(history, list, ['--pr-text', file, '--allowed-identity', ALLOWED])));
  for (const [index, run] of runs.entries()) {
    assert.equal(run.status, 1, run.stderr);
    assert.equal(run.stdout, runs[0].stdout);
    for (const value of [PLANTED, OTHER, THIRD, 'reviewer-thread', 'nested', 'title', ALLOWED, lists[index], sha256(readFileSync(lists[index]))]) {
      assert.ok(!outputOf(run).includes(value), value);
    }
  }
  const report = JSON.parse(runs[0].stdout);
  const commit = history.commits[1];
  assert.deepEqual(report.findings.map(({ kind, location, line }) => [kind, location, line]), [
    ['content', `${commit}:2`, 2], ['message', `${commit}:message`, 3], ['path', `${commit}:2`, undefined], ['pr-text', 'pr-1:2', 1], ['pr-text', 'pr-1:3', 1],
  ]);
  const fixed = /^(?:[0-9a-f]{40}(?::(?:[1-9][0-9]*|author|committer|header|message))?|[0-9a-f]{64}|pr-[1-9][0-9]*:[1-9][0-9]*|history|R-IDENTITY|R-PRIVATE|path|content|message|pr-text|passed|findings)$/;
  const keys = new Set(['scope', 'target', 'heads', 'commits', 'scanner', 'gateRevision', 'configSha256', 'expectedRoot', 'prTextSha256', 'rules', 'id', 'status', 'unscannable', 'findings', 'rule', 'kind', 'commit', 'location', 'line']);
  const walk = (value) => {
    if (typeof value === 'string') assert.match(value, fixed);
    else if (typeof value === 'number') assert.ok(Number.isSafeInteger(value) && value > 0);
    else for (const [key, item] of Object.entries(value)) {
      if (!Array.isArray(value)) assert.ok(keys.has(key), key);
      walk(item);
    }
  };
  walk(report);
});

test('several refs are walked together and a commit reachable twice is read once; a merge keeps parents first', () => {
  const history = createHistory([{}, { message: 'left' }, { message: 'right', parents: [0] }, { message: 'merge', parents: [1, 2] }], { main: 3, left: 1, right: 2 });
  const run = runHistory(historyArgs(history, writeList([PLANTED]), [], 'left,right,main'));
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.target.commits, 4);
  assert.deepEqual(report.target.heads, [...history.commits.slice(1)].sort());
  assert.equal(runHistory(historyArgs(history, writeList([PLANTED]), [], 'left')).status, 0);
});

test('the root, the refs and the arguments are checked before anything is reported', () => {
  const history = createHistory([{}, {}]);
  const listFile = writeList([PLANTED]);
  const wrongRoot = runHistory(['--repo', history.dir, '--refs', 'main', '--private-list', listFile, '--expected-root', 'b'.repeat(40)]);
  assert.equal(wrongRoot.status, 2);
  assert.match(wrongRoot.stderr, /unexpected-root/);
  assert.equal(wrongRoot.stdout, '');

  const twoRoots = createHistory([{}, {}, { parents: [] }], { main: 1, other: 2 });
  assert.equal(runHistory(historyArgs(twoRoots, listFile, [], 'main,other')).status, 2);
  assert.equal(runHistory(historyArgs(twoRoots, listFile, [], 'main')).status, 0);

  for (const refs of ['missing-branch', '-n', '', 'main,']) {
    const refused = runHistory(historyArgs(history, listFile, [], refs));
    assert.equal(refused.status, 2, refs);
    assert.equal(refused.stdout, '');
  }
  assert.equal(runHistory(historyArgs(history, listFile, ['--expected-root', history.commits[0]])).status, 2, 'a repeated flag');
  assert.equal(runHistory(['--repo', history.dir, '--refs', 'main', '--expected-root', history.commits[0]]).status, 2, 'no private list');
  assert.equal(runHistory(['--repo', history.dir, '--refs', 'main', '--private-list', listFile, '--expected-root', 'abc']).status, 2, 'an abbreviated root');
});

test('--out creates a new file, never replaces one, and leaves stdout empty', () => {
  const history = createHistory([{}, {}]);
  const listFile = writeList([PLANTED]);
  const out = path.join(makeTempDir('out'), 'report.json');
  const first = runHistory(historyArgs(history, listFile, ['--out', out]));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  const written = readFileSync(out, 'utf8');
  assert.equal(JSON.parse(written).target.commits, 2);
  const second = runHistory(historyArgs(history, listFile, ['--out', out]));
  assert.equal(second.status, 2);
  assert.equal(readFileSync(out, 'utf8'), written);
});

test('an unscannable blob in any commit exits 2 and the report says so instead of passing', () => {
  const history = createHistory([{}, { files: { 'a.txt': 'ok\n', 'data.json': 'ok\n' } }, { files: { 'a.txt': 'ok\n' } }]);
  const blob = git(history.dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from([0x7b, 0x00, 0xff]) });
  const tree = git(history.dir, ['mktree'], { input: `100644 blob ${blob}\tdata.json\n` });
  const commit = git(history.dir, ['commit-tree', tree, '-p', history.commits[2], '-m', 'binary json'], {});
  git(history.dir, ['update-ref', 'refs/heads/main', commit]);
  const out = path.join(makeTempDir('out'), 'report.json');
  const run = runHistory(historyArgs(history, writeList([PLANTED]), ['--out', out]));
  assert.equal(run.status, 2);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.unscannable.length, 1);
  assert.equal(report.unscannable[0].commit, commit);
  assert.deepEqual(report.rules.map((rule) => rule.status), ['not-run', 'unscannable']);
});

test('complete scope checks --expected-root against the history behind the commit: another root, or two roots, exit 2 with no report', () => {
  const history = createHistory([{}, {}, { files: { 'b.txt': 'second root\n' }, parents: [] }, { parents: [1, 2] }], { main: 3 });
  const listFile = writeList([PLANTED]);
  const complete = (commit, root) => runGate(gateArgs({ dir: history.dir, commit }, 'complete', ['--private-list', listFile, '--expected-root', root]));
  const own = complete(history.commits[1], history.commits[0]);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(JSON.parse(own.stdout).scanner.expectedRoot, history.commits[0]);
  for (const [commit, root] of [[history.commits[1], history.commits[2]], [history.commits[1], 'b'.repeat(40)], [history.commits[3], history.commits[0]]]) {
    const refused = complete(commit, root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /unexpected-root/);
    assert.equal(refused.stdout, '');
  }
});
