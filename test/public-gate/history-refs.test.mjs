import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gateRevision } from '../../scripts/public-gate/gate.mjs';
import {
  CONFIG_FILE, createAnnotatedTag, createHistory, expectedScanIdentity, git, historyArgs, makeTempDir, runCheckReport, runHistory, sha256, writeList,
} from '../lib/gate-fixtures.mjs';

const LISTED = ['quartz', 'lantern'].join('-');
const ALLOWED = ['--allowed-identity', 'Project <project@example.invalid>'];
const OTHER_OBJECT = 'd'.repeat(40);

const outputOf = (run) => `${run.stdout}${run.stderr}`;
const writeJson = (value) => {
  const file = path.join(makeTempDir('refs'), 'input.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
};

/** Runs history mode on `refs`, expects `status`, and returns the parsed report (or the run when it wrote none). */
function runRefs(history, refs, { status, list = [LISTED], extra = [] }) {
  const run = runHistory(historyArgs(history, writeList(list), extra, refs));
  assert.equal(run.status, status, run.stderr);
  return run;
}

test('a tag ref or a branch ref whose name holds a private-list entry fails, selected by its short name or its full name, and the entry never reaches the output', () => {
  const history = createHistory([{}, {}], { main: 1, [LISTED]: 1 });
  git(history.dir, ['tag', 'light', history.commits[1]]);
  git(history.dir, ['update-ref', `refs/tags/${LISTED}-tag`, history.commits[1]]);
  const listed = (ref, location) => {
    const run = runRefs(history, ref, { status: 1 });
    assert.deepEqual(JSON.parse(run.stdout).findings, [{ rule: 'R-PRIVATE', kind: 'ref', location }], ref);
    assert.ok(!outputOf(run).includes(LISTED), ref);
  };
  for (const ref of [LISTED, `refs/heads/${LISTED}`, `${LISTED}-tag`, `refs/tags/${LISTED}-tag`]) listed(ref, 'ref-1');
  listed(`main,refs/heads/${LISTED}`, 'ref-2');
  runRefs(history, 'main', { status: 0 });
  runRefs(history, 'light', { status: 0 });
});

test('a tag ref whose name differs from the tag name inside its tag object exits 2 as tag-name-mismatch, whether or not either name is on the list', () => {
  const history = createHistory([{}, {}]);
  const tag = createAnnotatedTag(history.dir, 'clean-tag', history.commits[1]);
  git(history.dir, ['update-ref', `refs/tags/${LISTED}`, tag]);
  git(history.dir, ['update-ref', 'refs/tags/renamed', tag]);
  for (const ref of [LISTED, `refs/tags/${LISTED}`, 'renamed', 'refs/tags/renamed']) {
    const run = runRefs(history, ref, { status: 2 });
    assert.equal(run.stdout, '', ref);
    assert.match(run.stderr, /^tag-name-mismatch: [^\n]+\n$/, ref);
    assert.ok(!outputOf(run).includes(LISTED), ref);
  }
  runRefs(history, 'clean-tag', { status: 0 });
});

test('a tag ref that matches its tag object and a clean branch pass, and the report names each selected ref once, by full name, with the object it points to and its commit', () => {
  const history = createHistory([{}, {}]);
  const tag = createAnnotatedTag(history.dir, 'release', history.commits[1]);
  const named = [
    { ref: 'refs/heads/main', object: history.commits[1], commit: history.commits[1] },
    { ref: 'refs/tags/release', object: tag, commit: history.commits[1] },
  ];
  for (const refs of ['release,main', 'main,refs/heads/main,refs/tags/release,release']) {
    const report = JSON.parse(runRefs(history, refs, { status: 0 }).stdout);
    assert.deepEqual(report.target.refs, named, refs);
    assert.deepEqual(report.target.heads, [history.commits[1]]);
  }
  const byId = JSON.parse(runRefs(history, `${history.commits[1]},${tag}`, { status: 0 }).stdout);
  const unnamed = [
    { ref: null, object: history.commits[1], commit: history.commits[1] },
    { ref: null, object: tag, commit: history.commits[1] },
  ];
  assert.deepEqual(byId.target.refs, unnamed.sort((first, second) => (first.object < second.object ? -1 : 1)));
});

test('two different annotated tags on one commit give different history reports, each naming its own tag object', () => {
  const history = createHistory([{}, {}]);
  const first = createAnnotatedTag(history.dir, 'first', history.commits[1], { message: 'one' });
  const second = createAnnotatedTag(history.dir, 'second', history.commits[1], { message: 'two' });
  const [reportFirst, reportSecond] = ['first', 'second'].map((ref) => runRefs(history, ref, { status: 0 }).stdout);
  assert.notEqual(reportFirst, reportSecond);
  assert.deepEqual(JSON.parse(reportFirst).target.refs, [{ ref: 'refs/tags/first', object: first, commit: history.commits[1] }]);
  assert.deepEqual(JSON.parse(reportSecond).target.refs, [{ ref: 'refs/tags/second', object: second, commit: history.commits[1] }]);
});

/** A saved passing history report for `refs`, the review context that matches it, and a checker for it against other refs. */
function savedReport() {
  const history = createHistory([{}, {}]);
  createAnnotatedTag(history.dir, 'first', history.commits[1], { message: 'one' });
  createAnnotatedTag(history.dir, 'second', history.commits[1], { message: 'two' });
  const report = JSON.parse(runRefs(history, 'first', { status: 0, extra: ALLOWED }).stdout);
  const context = { gateRevision: gateRevision(), configSha256: sha256(readFileSync(CONFIG_FILE)), ...expectedScanIdentity(), expectedRoot: history.commits[0] };
  const check = ({ saved = report, refs = 'first', head = history.commits[1], selection = ['--repo', history.dir, '--refs', refs] } = {}) => runCheckReport([
    '--report', writeJson(saved), '--head', head, '--context', writeJson(context), ...selection,
  ]);
  return { history, report, check };
}

const refused = (result, status, cause) => {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^${cause}: [^\\n]+\\n$`));
};

test('check-report accepts a saved history report for the refs of the run being checked, silently', () => {
  const { check } = savedReport();
  assert.deepEqual([check().status, check().stdout, check().stderr], [0, '', '']);
});

test('check-report refuses a saved history report when the run being checked selects other refs, or the same ref name now points to another tag object', () => {
  const { history, check } = savedReport();
  refused(check({ refs: 'second' }), 1, 'report-refs-differ');
  refused(check({ refs: 'first,second' }), 1, 'report-refs-differ');
  refused(check({ refs: 'main' }), 1, 'report-refs-differ');
  git(history.dir, ['tag', '-d', 'first']);
  createAnnotatedTag(history.dir, 'first', history.commits[1], { message: 'one, retagged' });
  refused(check(), 1, 'report-refs-differ');
});

test('check-report refuses a saved history report whose refs or tag object ids were edited', () => {
  const { report, check } = savedReport();
  const [selected] = report.target.refs;
  for (const edited of [{ ...selected, object: OTHER_OBJECT }, { ...selected, commit: OTHER_OBJECT }, { ...selected, ref: 'refs/tags/second' }]) {
    refused(check({ saved: { ...report, target: { ...report.target, refs: [edited] } } }), 1, 'report-refs-differ');
  }
  refused(check({ saved: { ...report, target: { ...report.target, refs: [] } } }), 1, 'report-refs-differ');
});

test('check-report refuses a saved history report that has a finding or whose head is not one of its heads, and needs --repo and --refs to judge one', () => {
  const { report, check } = savedReport();
  refused(check({ head: OTHER_OBJECT }), 1, 'report-other-head');
  const finding = { rule: 'R-PRIVATE', kind: 'ref', location: 'ref-1' };
  refused(check({ saved: { ...report, findings: [finding] } }), 1, 'report-not-passing');
  refused(check({ selection: [] }), 2, 'bad-arguments');
});
