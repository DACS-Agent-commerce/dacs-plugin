import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gateRevision, loadConfig } from '../../scripts/public-gate/gate.mjs';
import { createSecretInput } from '../../scripts/public-gate/history-secrets.mjs';
import { readCommitObjects, readHistory } from '../../scripts/public-gate/objects.mjs';
import {
  cleanScannerArgs, createAnnotatedTag, createHistory, gateArgs, git, historyArgs, makeTempDir, runGate, runHistory, sha256, writeList,
} from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const OTHER = ['onyx', 'meridian'].join('-');
const THIRD = ['harbornode', 'seven'].join('');
const ALLOWED = 'Project <project@example.invalid>';
const INTERNAL_HOST = ['node7', 'harbor', 'dev'].join('.');
const INTERNAL_EMAIL = ['ops', ['harbor', 'dev'].join('.')].join('@');
const PUBLIC_V4 = [8, 8, 4, 4].join('.');
const UNLISTED_HOST = ['unlisted-real-host', 'io'].join('.');
const outputOf = (run) => `${run.stdout}${run.stderr}`;
const brief = (report) => report.findings.map((finding) => `${finding.rule} ${finding.kind} ${finding.location.replace(/^[0-9a-f]{40}:/, '')} ${finding.line ?? '-'}`);

test('a clean history passes with every commit read; an entry that an early commit added and a later one removed is found though the tip is clean', () => {
  const clean = createHistory([{}, { message: 'second' }, { message: 'third' }]);
  const run = runHistory(historyArgs(clean, writeList([PLANTED])));
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.scope, 'history');
  assert.deepEqual(report.target, { heads: [clean.commits[2]], refs: [{ ref: 'refs/heads/main', object: clean.commits[2], commit: clean.commits[2] }], commits: 3 });
  assert.deepEqual(report.rules.map(({ id, status }) => `${id} ${status}`), [
    'R-ACCOUNT passed', 'R-ARCHIVE passed', 'R-ENV passed', 'R-EVAL passed', 'R-HOST passed', 'R-HOSTING passed', 'R-IDENTITY not-run', 'R-IP passed', 'R-ISSUE passed', 'R-PRIVATE passed', 'R-REPORT passed', 'R-SECRET passed',
  ]);
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

test('the address, env, hosting and archive rules read every commit tree: what an early commit added and a later one removed is found though the tip is clean', () => {
  const planted = {
    'a.txt': 'ok\n',
    'deploy/Caddyfile': 'x\n',
    '.env.example': `ZORBLAT_QUIM=${['wombat', 'quartz', 'ember', '7731'].join('-')}\n`,
    'bundle.txt': 'PK\u0003\u0004 not a text file\n',
    'notes.md': `host https://${INTERNAL_HOST}/rpc\nip ${PUBLIC_V4}\nmail ${INTERNAL_EMAIL}\n`,
  };
  const history = createHistory([{}, { files: planted }, { files: { 'a.txt': 'ok\n' } }]);
  const listFile = writeList([PLANTED]);
  const tip = runGate(gateArgs({ dir: history.dir, commit: history.commits[2] }, 'complete', ['--private-list', listFile, '--expected-root', history.commits[0]]));
  assert.equal(tip.status, 0, 'the tip tree alone holds nothing');

  const run = runHistory(historyArgs(history, listFile));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.rules.map(({ id }) => id), ['R-ACCOUNT', 'R-ARCHIVE', 'R-ENV', 'R-EVAL', 'R-HOST', 'R-HOSTING', 'R-IDENTITY', 'R-IP', 'R-ISSUE', 'R-PRIVATE', 'R-REPORT', 'R-SECRET']);
  assert.deepEqual(report.rules.map(({ status }) => status), ['findings', 'findings', 'findings', 'passed', 'findings', 'findings', 'not-run', 'findings', 'passed', 'passed', 'passed', 'passed']);
  assert.deepEqual(brief(report), [
    'R-ACCOUNT content 5 3', 'R-ARCHIVE content 3 -', 'R-ENV content 1 1', 'R-HOST content 5 1', 'R-HOSTING path 4 -', 'R-IP content 5 2',
  ]);
  assert.ok(report.findings.every((finding) => finding.commit === history.commits[1]));
  for (const value of [INTERNAL_HOST, PUBLIC_V4, INTERNAL_EMAIL, 'ZORBLAT_QUIM']) assert.ok(!outputOf(run).includes(value), value);
});

test('an email in an earlier commit message, author or committer line is refused by the account rule and located by commit and field; the publication identity passes', () => {
  const history = createHistory([
    {},
    { message: `subject\n\nwrite to ${INTERNAL_EMAIL}` },
    { author: { name: 'Project', email: INTERNAL_EMAIL } },
    { committer: { name: 'Project', email: INTERNAL_EMAIL } },
    { author: { name: 'DACS Agent Commerce', email: 'dacs-plugin@users.noreply.invalid' } },
  ]);
  const run = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings.map(({ kind, commit, location }) => [kind, history.commits.indexOf(commit), location.replace(commit, '')]), [
    ['author', 2, ':author'], ['committer', 3, ':committer'], ['message', 1, ':message'],
  ]);
  assert.deepEqual(brief(report), ['R-ACCOUNT author author -', 'R-ACCOUNT committer committer -', 'R-ACCOUNT message message 3']);
  assert.ok(!outputOf(run).includes(INTERNAL_EMAIL));
});

test('an unlisted host or a public IP in a commit message is refused by the host and IP rules and located by commit, field and line; the rules report findings, not passed', () => {
  const history = createHistory([{}, { message: `subject\n\nReach https://${UNLISTED_HOST} at ${PUBLIC_V4}` }]);
  const run = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(brief(report), ['R-HOST message message 3', 'R-IP message message 3']);
  assert.deepEqual(report.findings.map(({ commit }) => history.commits.indexOf(commit)), [1, 1]);
  assert.deepEqual(report.rules.filter(({ id }) => ['R-HOST', 'R-IP'].includes(id)).map(({ id, status }) => `${id} ${status}`), ['R-HOST findings', 'R-IP findings']);
  for (const value of [UNLISTED_HOST, PUBLIC_V4]) assert.ok(!outputOf(run).includes(value), value);
});

test('a percent-encoded dot in a commit message URL host does not hide an unlisted host or a public IP from the host and IP rules', () => {
  const history = createHistory([{}, { message: `subject\n\nReach https://${UNLISTED_HOST.replace('.', '%2e')} and http://${PUBLIC_V4.replaceAll('.', '%2e')}/` }]);
  const run = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(brief(JSON.parse(run.stdout)), ['R-HOST message message 3', 'R-IP message message 3']);
});

test('an unlisted host or a public IP in an author, committer or other header line is refused by the host and IP rules and located by field', () => {
  const history = createHistory([
    {},
    { author: { name: INTERNAL_HOST, email: 'project@example.invalid' } },
    { committer: { name: PUBLIC_V4, email: 'project@example.invalid' } },
  ]);
  const run = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(brief(report), ['R-HOST author author -', 'R-IP committer committer -']);
  assert.deepEqual(report.findings.map(({ commit }) => history.commits.indexOf(commit)), [1, 2]);
});

test('a listed host, a reserved name, a loopback address and a documentation address in a commit message pass the host and IP rules', () => {
  const history = createHistory([{}, { message: 'subject\n\nSee https://github.com/x, https://www.example.com/y, 127.0.0.1 and 192.0.2.7' }]);
  const run = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.rules.filter(({ id }) => ['R-HOST', 'R-IP'].includes(id)).map(({ status }) => status), ['passed', 'passed']);
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
  assert.ok(JSON.parse(off.stdout).rules.some((rule) => rule.id === 'R-IDENTITY' && rule.status === 'not-run'));

  const run = runHistory(historyArgs(history, listFile, ['--allowed-identity', ALLOWED]));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.rules.filter((rule) => ['R-IDENTITY', 'R-PRIVATE'].includes(rule.id)), [{ id: 'R-IDENTITY', status: 'findings' }, { id: 'R-PRIVATE', status: 'passed' }]);
  assert.deepEqual(report.findings.map((finding) => [finding.kind, history.commits.indexOf(finding.commit)]), [
    ['author', 1], ['committer', 2], ['timezone', 3], ['timezone', 3],
  ]);
  assert.ok(!outputOf(run).includes('someone@'));

  const clean = createHistory([{}, {}]);
  assert.equal(runHistory(historyArgs(clean, listFile, ['--allowed-identity', ALLOWED])).status, 0);
  assert.equal(runHistory(historyArgs(clean, listFile, ['--allowed-identity', 'no angle brackets'])).status, 2);
});

test('an annotated tag among the refs has its name, tagger line and message scanned by the private, account, host and IP rules and is located by tag and field', () => {
  const history = createHistory([{}, {}]);
  const message = `subject\n\n${PLANTED}\nReach https://${UNLISTED_HOST}\nat ${PUBLIC_V4}\nwrite to ${INTERNAL_EMAIL}`;
  const tag = createAnnotatedTag(history.dir, THIRD, history.commits[1], { message, tagger: { name: OTHER, email: 'project@example.invalid' } });
  const run = runHistory(historyArgs(history, writeList([PLANTED, OTHER, THIRD]), [], THIRD));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(brief(report), [
    'R-ACCOUNT message message 6', 'R-HOST message message 4', 'R-IP message message 5', 'R-PRIVATE header header -', 'R-PRIVATE message message 3', 'R-PRIVATE ref ref-1 -', 'R-PRIVATE tagger tagger -',
  ]);
  assert.ok(report.findings.filter((finding) => finding.kind !== 'ref').every((finding) => finding.commit === tag));
  assert.deepEqual(report.target, { heads: [history.commits[1]], refs: [{ ref: 'withheld', object: tag, commit: history.commits[1] }], commits: 2 });
  for (const value of [PLANTED, OTHER, THIRD, UNLISTED_HOST, PUBLIC_V4, INTERNAL_EMAIL]) assert.ok(!outputOf(run).includes(value), value);
});

test('with an allowed identity, an annotated tag by another identity or in another time zone is refused as the tagger and a tag by the allowed identity passes', () => {
  const history = createHistory([{}, {}]);
  const listFile = writeList([PLANTED]);
  const [head] = history.commits.slice(-1);
  createAnnotatedTag(history.dir, 'by-other', head, { tagger: { name: 'Someone', email: 'someone@example.invalid' } });
  createAnnotatedTag(history.dir, 'in-zone', head, { tz: '+0100' });
  createAnnotatedTag(history.dir, 'by-allowed', head);
  const runWithIdentity = (name) => runHistory(historyArgs(history, listFile, ['--allowed-identity', ALLOWED], name));
  const other = runWithIdentity('by-other');
  assert.equal(other.status, 1, other.stderr);
  assert.deepEqual(brief(JSON.parse(other.stdout)), ['R-IDENTITY tagger tagger -']);
  assert.ok(!outputOf(other).includes('someone@'));
  assert.deepEqual(brief(JSON.parse(runWithIdentity('in-zone').stdout)), ['R-IDENTITY timezone tagger -']);
  const allowed = runWithIdentity('by-allowed');
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('an annotated tag with no tagger line is refused when an allowed identity is given', () => {
  const history = createHistory([{}, {}]);
  const raw = `object ${history.commits[1]}\ntype commit\ntag unsigned\n\nno tagger here\n`;
  const tag = git(history.dir, ['hash-object', '-t', 'tag', '-w', '--literally', '--stdin'], { input: Buffer.from(raw) });
  const run = runHistory(historyArgs(history, writeList([PLANTED]), ['--allowed-identity', ALLOWED], tag));
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(brief(JSON.parse(run.stdout)), ['R-IDENTITY tagger tagger -']);
});

test('a tag of a tag is read through: every tag object in the chain is scanned, and a ref that is a full tag object id is read too', () => {
  const history = createHistory([{}, {}]);
  const inner = createAnnotatedTag(history.dir, 'inner', history.commits[1], { message: `subject\n\n${PLANTED}` });
  const outer = createAnnotatedTag(history.dir, 'outer', inner, { tagger: { name: OTHER, email: 'project@example.invalid' } });
  assert.notEqual(inner, outer);
  const run = runHistory(historyArgs(history, writeList([PLANTED, OTHER]), [], outer));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings.map(({ kind, commit }) => [kind, commit]), [['message', inner], ['tagger', outer]]);
  assert.deepEqual(report.target.heads, [history.commits[1]]);
});

test('a chain of tags longer than the limit exits 2 instead of being read without end', () => {
  const history = createHistory([{}, {}]);
  let target = history.commits[1];
  for (let depth = 0; depth < 20; depth += 1) target = createAnnotatedTag(history.dir, `link-${depth}`, target);
  const run = runHistory(historyArgs(history, writeList([PLANTED]), [], target));
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
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
    { rule: 'R-PRIVATE', kind: 'pr-text', location: 'pr-1:4', line: 2 },
    { rule: 'R-PRIVATE', kind: 'pr-text', location: 'pr-1:8', line: 1 },
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

test('pull-request text keys, nested keys, keys written with escapes and the earlier value of a repeated key are scanned, and strings are numbered in file order', () => {
  const history = createHistory([{}, {}]);
  const listFile = writeList([PLANTED]);
  const file = path.join(makeTempDir('pr'), 'prs.json');
  const escaped = [...PLANTED].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const cases = [
    [`[{"${PLANTED}":"harmless"}]`, ['pr-1:1']],
    [`[{"a":{"b":[{"${PLANTED}":1}]}}]`, ['pr-1:3']],
    [`[{"${escaped}":"harmless"}]`, ['pr-1:1']],
    [`[{"body":"leak ${PLANTED}","body":"clean"}]`, ['pr-1:2']],
    [`[{"x":"clean"},{"${PLANTED}":"clean","1":"${PLANTED}"}]`, ['pr-2:1', 'pr-2:4']],
    [`[{"b":"clean","1":"${PLANTED}"}]`, ['pr-1:4']],
  ];
  for (const [body, locations] of cases) {
    writeFileSync(file, body);
    const run = runHistory(historyArgs(history, listFile, ['--pr-text', file]));
    assert.equal(run.status, 1, body);
    assert.deepEqual(JSON.parse(run.stdout).findings.map((finding) => finding.location), locations, body);
    assert.ok(!outputOf(run).includes(PLANTED));
  }
  writeFileSync(file, `[{"quote":"say \\"hi\\" and \\\\","${PLANTED}":"x"}]`);
  assert.deepEqual(JSON.parse(runHistory(historyArgs(history, listFile, ['--pr-text', file])).stdout).findings.map((finding) => finding.location), ['pr-1:3']);
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
    ['content', `${commit}:2`, 2], ['message', `${commit}:message`, 3], ['path', `${commit}:2`, undefined], ['pr-text', 'pr-1:5', 1], ['pr-text', 'pr-1:6', 1], ['pr-text', 'pr-1:7', 1],
  ]);
  const fixed = /^(?:[0-9a-f]{40}(?::(?:[1-9][0-9]*|author|committer|header|message))?|[0-9a-f]{64}|\d+\.\d+\.\d+|pr-[1-9][0-9]*:[1-9][0-9]*|ref-[1-9][0-9]*|refs\/heads\/main|history|R-[A-Z]+|path|content|message|pr-text|ref|passed|not-run|findings)$/;
  const keys = new Set(['scope', 'target', 'heads', 'refs', 'ref', 'object', 'commits', 'scanner', 'gateRevision', 'configSha256', 'scannerVersion', 'scannerPolicySha256', 'secretExceptionsSha256', 'expectedRoot', 'prTextSha256', 'rules', 'id', 'status', 'unscannable', 'findings', 'rule', 'kind', 'commit', 'location', 'line']);
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
  const wrongRoot = runHistory(['--repo', history.dir, '--refs', 'main', '--private-list', listFile, '--expected-root', 'b'.repeat(40), ...cleanScannerArgs()]);
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
  assert.equal(runHistory(['--repo', history.dir, '--refs', 'main', '--private-list', listFile, '--expected-root', history.commits[0]]).status, 2, 'no scanner');
  assert.equal(runHistory(['--repo', history.dir, '--refs', 'main', '--expected-root', history.commits[0], ...cleanScannerArgs()]).status, 2, 'no private list');
  assert.equal(runHistory(['--repo', history.dir, '--refs', 'main', '--private-list', listFile, '--expected-root', 'abc', ...cleanScannerArgs()]).status, 2, 'an abbreviated root');
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
  assert.deepEqual(report.rules.find((rule) => rule.id === 'R-PRIVATE'), { id: 'R-PRIVATE', status: 'unscannable' });
  assert.deepEqual(report.rules.find((rule) => rule.id === 'R-IDENTITY'), { id: 'R-IDENTITY', status: 'not-run' });
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

const CONFIG = loadConfig();
const ENV_VALUE = `ZORBLAT_QUIM=${['wombat', 'quartz', 'ember', '7731'].join('-')}\n`;

/** Every (path, mode, blob) of the history as `<mode> <blob> <path>`, in the order the occurrence index is given the commits; `limits` bound the index only. */
async function indexedOccurrences(history, { reversed = false, limits = CONFIG.limits } = {}) {
  const { commits } = await readHistory({ repo: history.dir, refs: ['main'], limits: CONFIG.limits });
  const input = createSecretInput(limits);
  for (const commit of reversed ? [...commits].reverse() : commits) {
    input.addTree(commit.sha, (await readCommitObjects({ repo: history.dir, commit: commit.sha, limits: CONFIG.limits })).entries);
  }
  return input.treeOccurrences().map(({ path: file, mode, oid }) => `${mode} ${oid} ${file}`).sort();
}

/** The same set from `diff-tree -r -z --no-renames --root -m`: the full tree of a root and each commit's raw diff against each parent. */
function diffTreeOccurrences(history) {
  const raw = git(history.dir, ['log', '--format=', '--no-abbrev', '--raw', '-z', '-m', '--root', '--no-renames', 'main']);
  const fields = raw.split('\0').filter(Boolean);
  const found = new Set();
  for (let index = 0; index < fields.length; index += 2) {
    const [, , mode, , oid, status] = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(fields[index]);
    if (status !== 'D') found.add(`${mode} ${oid} ${fields[index + 1]}`);
  }
  return [...found].sort();
}

test('history mode applies every rule to each reachable occurrence and to every commit message; a value added and removed in earlier commits fails; the per-parent diff enumeration equals full-tree enumeration on a history with merges and renames', async () => {
  const history = createHistory([
    {},
    { files: { 'a.txt': 'ok\n', 'leak.txt': `before\n${PLANTED}\n` } },
    { files: { 'a.txt': 'ok\n', 'side.txt': 'side\n' }, parents: [0] },
    { files: { 'a.txt': 'ok\n', 'leak.txt': `before\n${PLANTED}\n`, 'side.txt': 'side\n' }, parents: [1, 2], message: `merge\n\n${PLANTED}` },
    { files: { 'a.txt': 'ok\n', 'moved-side.txt': 'side\n' } },
  ]);
  const run = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.kind, history.commits.indexOf(finding.commit)]), [
    ['R-PRIVATE', 'content', 1], ['R-PRIVATE', 'content', 3], ['R-PRIVATE', 'message', 3],
  ]);
  assert.ok(!outputOf(run).includes(PLANTED));
  const occurrences = await indexedOccurrences(history);
  assert.deepEqual(occurrences, diffTreeOccurrences(history));
  assert.deepEqual(await indexedOccurrences(history, { reversed: true }), occurrences);
});

test('the same bytes in an ordinary text file and in an env template are two occurrences: the template occurrence fails even when it was removed before the target and whatever the traversal order; a benign rename passes', async () => {
  const listFile = writeList([PLANTED]);
  const files = (extra) => ({ 'a.txt': 'ok\n', ...extra });
  const templateFirst = createHistory([{}, { files: files({ '.env.example': ENV_VALUE }) }, { files: files({ 'notes.txt': ENV_VALUE }) }]);
  const textFirst = createHistory([{}, { files: files({ 'notes.txt': ENV_VALUE }) }, { files: files({ 'notes.txt': ENV_VALUE, '.env.example': ENV_VALUE }) }, { files: files({ 'notes.txt': ENV_VALUE }) }]);
  for (const [history, flagged] of [[templateFirst, 1], [textFirst, 2]]) {
    const run = runHistory(historyArgs(history, listFile));
    assert.equal(run.status, 1, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).findings.map((finding) => [finding.rule, history.commits.indexOf(finding.commit)]), [['R-ENV', flagged]]);
    const forward = await indexedOccurrences(history);
    assert.equal(forward.filter((occurrence) => occurrence.endsWith('.env.example') || occurrence.endsWith('notes.txt')).length, 2);
    assert.deepEqual(await indexedOccurrences(history, { reversed: true }), forward);
  }
  const renamed = createHistory([{ files: files({ 'old-name.txt': 'clean\n' }) }, { files: files({ 'new-name.txt': 'clean\n' }) }]);
  assert.equal(runHistory(historyArgs(renamed, listFile)).status, 0);
});

test('root check: complete scope needs --expect-root and fails when the target reaches a second root or a root other than F; generic scope fails on more than one root', () => {
  const twoRoots = createHistory([{}, {}, { files: { 'b.txt': 'second root\n' }, parents: [] }, { parents: [1, 2] }], { main: 3 });
  const listFile = writeList([PLANTED]);
  const [root, first, second, merged] = twoRoots.commits;
  const complete = (commit, expectedRoot) => runGate(gateArgs({ dir: twoRoots.dir, commit }, 'complete', ['--private-list', listFile, ...(expectedRoot ? ['--expected-root', expectedRoot] : [])]));
  const generic = (commit) => runGate(gateArgs({ dir: twoRoots.dir, commit }, 'generic'));
  assert.equal(complete(first).status, 2, 'complete scope without --expected-root');
  assert.equal(complete(first, root).status, 0);
  for (const refused of [complete(second, root), complete(first, second), complete(merged, root), complete(merged, second)]) {
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /unexpected-root/);
    assert.equal(refused.stdout, '');
  }
  assert.equal(generic(first).status, 0);
  const genericTwo = generic(merged);
  assert.equal(genericTwo.status, 2);
  assert.match(genericTwo.stderr, /unexpected-root/);
  assert.equal(runHistory(historyArgs(twoRoots, listFile)).status, 2);
});

test('a shallow clone is refused in generic, complete and history scope, so a cut-off history never passes the root check', async () => {
  const twoRoots = createHistory([{}, {}, { files: { 'b.txt': 'second root\n' }, parents: [] }, { parents: [1, 2] }], { main: 3 });
  const parent = makeTempDir('shallow');
  const shallow = path.join(parent, 'clone');
  git(parent, ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${twoRoots.dir}`, shallow]);
  assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']), 'true');
  const listFile = writeList([PLANTED]);
  const target = git(shallow, ['rev-parse', 'HEAD']);
  const view = { dir: shallow, commit: target, commits: [target] };
  await assert.rejects(readHistory({ repo: shallow, refs: ['main'], limits: CONFIG.limits }), (error) => error.name === 'GateInputError' && error.cause === 'shallow-history');
  const refusals = [
    runGate(gateArgs({ dir: shallow, commit: target }, 'generic')),
    runGate(gateArgs({ dir: shallow, commit: target }, 'complete', ['--private-list', listFile, '--expected-root', target])),
    runHistory(historyArgs(view, listFile)),
  ];
  for (const refused of refusals) {
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /shallow-history/);
    assert.equal(refused.stdout, '');
  }
  assert.equal((await readHistory({ repo: twoRoots.dir, refs: ['main'], limits: CONFIG.limits })).commits.length, 4);
});

test('a history over the commit or occurrence limit fails as unscannable, naming the limit', async () => {
  const history = createHistory([{}, { files: { 'a.txt': 'ok\n', 'b.txt': 'b\n' } }, { files: { 'a.txt': 'ok\n', 'c.txt': 'c\n' } }]);
  const limited = (limits) => ({ ...CONFIG.limits, ...limits });
  const refusedWith = (promise, cause) => assert.rejects(promise, (error) => error.name === 'GateInputError' && error.cause === cause);
  await refusedWith(readHistory({ repo: history.dir, refs: ['main'], limits: limited({ maxHistoryCommits: 2 }) }), 'limit:maxHistoryCommits');
  assert.equal((await readHistory({ repo: history.dir, refs: ['main'], limits: limited({ maxHistoryCommits: 3 }) })).commits.length, 3);
  await refusedWith(indexedOccurrences(history, { limits: limited({ maxHistoryOccurrences: 3 }) }), 'limit:maxHistoryOccurrences');
  assert.equal((await indexedOccurrences(history, { limits: limited({ maxHistoryOccurrences: 4 }) })).length, 4);
  await refusedWith(indexedOccurrences(history, { limits: limited({ maxTotalBlobBytes: 13 }) }), 'limit:maxTotalBlobBytes');
  assert.equal((await indexedOccurrences(history, { limits: limited({ maxTotalBlobBytes: 14 }) })).length, 4);
});
