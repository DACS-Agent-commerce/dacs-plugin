import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../scripts/public-gate/gate.mjs';
import { createSecretInput } from '../../scripts/public-gate/history-secrets.mjs';
import { readCommitObjects, readHistory } from '../../scripts/public-gate/objects.mjs';
import { scanSecrets } from '../../scripts/public-gate/secret-scan.mjs';
import { createHistory, historyArgs, runHistory, writeList } from '../lib/gate-fixtures.mjs';
import { findPinnedGitleaks, plantedKey, skipWithoutScanner, writeStubGitleaks } from '../lib/stub-gitleaks.mjs';

const CONFIG = loadConfig();
const MARKER = ['marker', 'value'].join('-');
const SAMPLE_RULE = 'generic-api-key';
const NEUTRAL_NAME = /^o[1-9][0-9]*$/;
const OK = { 'a.txt': 'ok\n' };
const markerStub = () => writeStubGitleaks({ finds: [{ marker: MARKER, rule: SAMPLE_RULE }] });
const scanHistory = (history, stub, extra = []) => runHistory(historyArgs(history, writeList(['unrelated-word']), ['--gitleaks', stub.binary, '--gitleaks-sha256', stub.sha256, ...extra]));
const secretFindings = (run) => JSON.parse(run.stdout).findings.filter((finding) => finding.rule === 'R-SECRET');
const scannedNames = (stub) => Object.keys(stub.calls().find((call) => call.args[0] === 'dir').blobs);

/** Gives a secret input every commit of `history`, in the given order, as the history mode does. */
async function inputOf(history, { reversed = false } = {}) {
  const { commits } = await readHistory({ repo: history.dir, refs: ['main'], limits: CONFIG.limits });
  const input = createSecretInput(CONFIG.limits);
  for (const commit of reversed ? [...commits].reverse() : commits) {
    input.addTree(commit.sha, (await readCommitObjects({ repo: history.dir, commit: commit.sha, limits: CONFIG.limits })).entries);
    input.addObject(commit, ['author', 'committer']);
  }
  return input;
}

test('history secret scan: a value in a deleted file, at two paths, in an author field and in a commit message is found once per occurrence under neutral names and located without any path or value', () => {
  const history = createHistory([
    { author: { name: MARKER, email: 'a@example.invalid' } },
    { files: { ...OK, 'leak.txt': `${MARKER}\n` } },
    { files: { ...OK, 'copy/leak2.txt': `${MARKER}\n` } },
    { files: OK, message: `subject\n\nnote\n${MARKER}` },
  ]);
  const stub = markerStub();
  const run = scanHistory(history, stub);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.rules.find((rule) => rule.id === 'R-SECRET'), { id: 'R-SECRET', status: 'findings' });
  assert.deepEqual(secretFindings(run).map(({ kind, commit, location, line }) => [kind, history.commits.indexOf(commit), location.split(':')[1], line]).sort(), [
    ['author', 0, 'author', undefined], ['content', 1, '2', 1], ['content', 2, '2', 1], ['message', 3, 'message', 4],
  ].sort());
  assert.equal(stub.calls().filter((call) => call.args[0] === 'dir').length, 1, 'one scan for the whole history');
  const names = scannedNames(stub);
  assert.equal(names.length, 4 + 4, 'four distinct occurrences and four commit objects');
  assert.ok(names.every((name) => NEUTRAL_NAME.test(name)), names.join(' '));
  for (const value of ['leak', 'copy', MARKER]) assert.ok(!`${run.stdout}${run.stderr}`.includes(value), value);
});

test('history secret scan: an exception names one history occurrence and leaves the same bytes at another path found', async () => {
  const history = createHistory([{ files: { ...OK, 'one.txt': `${MARKER}\n` } }, { files: { ...OK, 'two.txt': `${MARKER}\n` } }]);
  const input = await inputOf(history);
  const entries = input.scanEntries();
  const occurrence = entries.find((entry) => entry.path === 'one.txt');
  const exception = { path: 'one.txt', blob: occurrence.oid, rule: SAMPLE_RULE, line: 1, reason: 'test occurrence' };
  const stub = markerStub();
  const scanner = { binary: stub.binary, sha256: stub.sha256 };
  const found = await scanSecrets({ entries, config: { ...CONFIG, secretExceptions: [exception] }, scanner });
  assert.deepEqual(found.map(({ entry }) => entry.path), ['two.txt']);
  assert.deepEqual(input.locate(found[0]), { rule: 'R-SECRET', kind: 'content', commit: history.commits[1], entry: { position: 2 }, line: 1 });
});

test('real scanner: a key-shaped value built at test time, committed in a valid lockfile, in a file named .gitleaks.toml, beside a gitleaks:allow comment and in a file marked export-ignore and -diff, then deleted in a later commit, is found; so is one in an export-subst file and one in a commit message; in CI the test refuses to skip without the binary', async (t) => {
  const scanner = findPinnedGitleaks();
  if (skipWithoutScanner(t, scanner)) return;
  const keyed = (extra = '') => `const token = "${plantedKey()}";${extra}\n`;
  const lock = JSON.stringify({ name: 'planted', lockfileVersion: 3, packages: { '': { name: 'planted', description: plantedKey() } } }, null, 2);
  const planted = {
    'src/app.js': keyed(), 'package-lock.json': lock, 'config/.gitleaks.toml': keyed(), 'src/allowed.js': keyed(' // gitleaks:allow'),
    'src/hidden.txt': keyed(), 'src/subst.txt': `$Format:%H$\n${keyed()}`, 'node_modules/pkg/index.js': keyed(),
  };
  const policy = [['.gitattributes', 'src/hidden.txt export-ignore -diff\nsrc/subst.txt export-subst\n'], ['.gitleaks.toml', '[allowlist]\npaths = [\'\'\'.*\'\'\']\n']];
  const history = createHistory([{}, { files: { ...OK, ...planted, ...Object.fromEntries(policy) } }, { files: OK }, { files: OK, message: `subject\n\ntoken ${plantedKey()}` }, { files: OK }]);
  const run = scanHistory(history, scanner);
  assert.equal(run.status, 1, run.stderr);
  const { entries } = await readCommitObjects({ repo: history.dir, commit: history.commits[1], limits: CONFIG.limits });
  const positionOf = (file) => String(entries.find((entry) => entry.path === file).position);
  const found = secretFindings(run).map(({ kind, commit, location }) => `${kind} ${history.commits.indexOf(commit)} ${location.split(':')[1]}`).sort();
  assert.deepEqual(found, [...Object.keys(planted).map((file) => `content 1 ${positionOf(file)}`), 'message 3 message'].sort());
  const clean = scanHistory(createHistory([{}, { files: OK, message: 'a plain message' }]), scanner);
  assert.equal(clean.status, 0, clean.stderr);
});

test('a history that replaces a file with a directory of the same name, one that replaces a directory with a file, and a rename across such a transition, each enumerated in both orders: every occurrence is exported under its neutral name and none is dropped or overwritten; benign histories pass, and a planted historical credential is still found', async () => {
  const body = `planted ${MARKER}\n`;
  const cases = [
    { name: 'file then directory', steps: [{ files: { entry: 'file body\n' } }, { files: { 'entry/child.txt': body } }], occurrences: 2 },
    { name: 'directory then file', steps: [{ files: { 'entry/child.txt': body } }, { files: { entry: 'file body\n' } }], occurrences: 2 },
    { name: 'rename across', steps: [{ files: { 'entry/child.txt': body } }, { files: { entry: body } }], occurrences: 2 },
  ];
  for (const { name, steps, occurrences } of cases) {
    const history = createHistory(steps);
    const input = await inputOf(history);
    const stub = markerStub();
    const run = scanHistory(history, stub);
    assert.equal(run.status, 1, `${name}: ${run.stderr}`);
    const names = scannedNames(stub);
    assert.equal(names.length, occurrences + steps.length, `${name}: every occurrence and commit object is scanned`);
    assert.ok(names.every((each) => NEUTRAL_NAME.test(each)), name);
    assert.ok(secretFindings(run).length > 0, `${name}: the planted value is found`);
    assert.deepEqual(input.treeOccurrences().length, occurrences, name);
    const reversed = await inputOf(history, { reversed: true });
    const describe = (each) => each.treeOccurrences().map(({ path, mode, oid }) => `${mode} ${oid} ${path}`).sort();
    assert.deepEqual(describe(reversed), describe(input), `${name}: the order does not change what is enumerated`);
    const benign = createHistory(steps.map((step) => ({ files: Object.fromEntries(Object.entries(step.files).map(([file, content]) => [file, content.replace(MARKER, 'clean')])) })));
    assert.equal(scanHistory(benign, markerStub()).status, 0, `${name}: the same shapes pass when clean`);
  }
});
