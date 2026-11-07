import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gateRevision } from '../../scripts/public-gate/gate.mjs';
import {
  CONFIG_FILE, completeArgs, createRepo, expectedScanIdentity, expectedWordingListSha256, gateArgs, makeTempDir, runCheckReport, runGate, sha256, writeList,
} from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const OTHER_DIGEST = sha256('another policy');
const OTHER_COMMIT = 'c'.repeat(40);

const writeJson = (value) => {
  const file = path.join(makeTempDir('check'), 'input.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

/** A real complete report for a clean commit, the same commit, and the review context that matches it. */
function completeCase() {
  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const run = runGate(completeArgs(repo, writeList([PLANTED])));
  assert.equal(run.status, 0, run.stderr);
  const context = { gateRevision: gateRevision(), configSha256: sha256(readFileSync(CONFIG_FILE)), ...expectedScanIdentity(), expectedRoot: repo.commit, wordingListSha256: expectedWordingListSha256() };
  return { repo, report: JSON.parse(run.stdout), context };
}

const check = ({ report, head, context }) => runCheckReport(['--report', writeJson(report), '--head', head, '--context', writeJson(context)]);

const refused = (result, status, cause) => {
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^${cause}: [^\\n]+\\n$`));
};

test('check-report refuses a generic report, a report for another head, a complete report whose rule ids differ from the checking gate\'s, and a same-head complete report made under another policy identity than the review context\'s (a corrected private list, a changed configuration, scanner policy or exception entries, or another expected root), even with unchanged rule ids; it takes expected values from the context, not the report, and accepts a complete passing report for the exact head under the current context', async (t) => {
  const { repo, report, context } = completeCase();
  const head = repo.commit;

  await t.test('accepts a complete passing report for the exact head under the current context, silently and repeatably', () => {
    const accepted = check({ report, head, context });
    assert.deepEqual([accepted.status, accepted.stdout, accepted.stderr], [0, '', '']);
    assert.deepEqual(check({ report, head, context }), accepted);
  });

  await t.test('refuses a generic report', () => {
    const generic = JSON.parse(runGate(gateArgs(repo, 'generic')).stdout);
    refused(check({ report: generic, head, context }), 1, 'report-not-complete');
  });

  await t.test('refuses a report for another head', () => {
    refused(check({ report, head: OTHER_COMMIT, context }), 1, 'report-other-head');
    refused(check({ report: { ...report, target: { ...report.target, commit: OTHER_COMMIT } }, head, context }), 1, 'report-other-head');
  });

  await t.test('refuses a report whose rule ids differ from the checking gate\'s, whether one is added, missing or renamed', () => {
    const rules = [
      [...report.rules, { id: 'R-EXTRA', status: 'passed' }],
      [],
      [{ id: 'R-OTHER', status: 'passed' }],
      [...report.rules, ...report.rules],
    ];
    for (const changed of rules) refused(check({ report: { ...report, rules: changed }, head, context }), 1, 'report-rules-differ');
  });

  await t.test('refuses a complete report made under another gate revision, configuration, scanner policy, exception entries, scanner version or expected root than the context\'s', () => {
    for (const field of ['gateRevision', 'configSha256', 'scannerPolicySha256', 'secretExceptionsSha256', 'wordingListSha256']) {
      refused(check({ report, head, context: { ...context, [field]: OTHER_DIGEST } }), 1, 'report-policy-differs');
      refused(check({ report: { ...report, scanner: { ...report.scanner, [field]: OTHER_DIGEST } }, head, context }), 1, 'report-policy-differs');
    }
    refused(check({ report, head, context: { ...context, scannerVersion: '9.9.9' } }), 1, 'report-policy-differs');
    refused(check({ report, head, context: { ...context, expectedRoot: OTHER_COMMIT } }), 1, 'report-policy-differs');
    refused(check({ report: { ...report, scanner: { ...report.scanner, expectedRoot: OTHER_COMMIT } }, head, context }), 1, 'report-policy-differs');
  });

  await t.test('refuses a report whose scanner holds a field the context does not name, or lacks one it does', () => {
    refused(check({ report: { ...report, scanner: { ...report.scanner, unnamedField: OTHER_DIGEST } }, head, context }), 1, 'report-policy-differs');
    const { expectedRoot, ...withoutRoot } = report.scanner;
    assert.equal(expectedRoot, head);
    refused(check({ report: { ...report, scanner: withoutRoot }, head, context }), 1, 'report-policy-differs');
  });

  await t.test('takes the expected values from the context: a report that agrees only with itself is refused', () => {
    const selfConsistent = { ...report, scanner: { ...report.scanner, gateRevision: OTHER_DIGEST, configSha256: OTHER_DIGEST, expectedRoot: OTHER_COMMIT } };
    refused(check({ report: selfConsistent, head, context }), 1, 'report-policy-differs');
    assert.equal(check({ report: selfConsistent, head, context: selfConsistent.scanner }).status, 0);
  });

  await t.test('refuses a complete report that has a finding, an unscannable entry or a rule that did not pass', () => {
    const location = `${head}:1`;
    const changes = [
      { findings: [{ rule: 'R-PRIVATE', kind: 'path', location }] },
      { unscannable: [{ location, cause: 'submodule' }] },
      { rules: report.rules.map((rule) => ({ ...rule, status: 'unscannable' })) },
      { rules: report.rules.map((rule) => ({ ...rule, status: 'not-run' })) },
    ];
    for (const change of changes) refused(check({ report: { ...report, ...change }, head, context }), 1, 'report-not-passing');
  });

  await t.test('refuses a report with a top-level field the schema does not have', () => {
    refused(check({ report: { ...report, verdict: 'ok' }, head, context }), 2, 'report-malformed');
  });

  await t.test('refuses a report whose target is not exactly a commit and a tree object id', () => {
    const { tree, ...withoutTree } = report.target;
    assert.match(tree, /^[0-9a-f]{40}$/);
    const targets = [withoutTree, { ...report.target, tree: 'nope' }, { ...report.target, note: 'x' }, { tree }, null, 'x', [report.target.commit, tree]];
    for (const target of targets) refused(check({ report: { ...report, target }, head, context }), 2, 'report-malformed');
  });

  await t.test('refuses a report whose rules are not a list of exactly an id and a known status', () => {
    const [first, ...others] = report.rules;
    const rules = [
      [{ ...first, note: 'x' }, ...others],
      [{ id: first.id }, ...others],
      [{ status: first.status }, ...others],
      [{ ...first, status: 'ok' }, ...others],
      [{ ...first, id: 7 }, ...others],
      [null, ...others],
      [[first.id, first.status], ...others],
      'passed',
      null,
    ];
    for (const changed of rules) refused(check({ report: { ...report, rules: changed }, head, context }), 2, 'report-malformed');
  });

  await t.test('refuses a report whose findings or unscannable entries are not lists', () => {
    for (const field of ['findings', 'unscannable']) {
      for (const changed of [null, {}, 'none']) refused(check({ report: { ...report, [field]: changed }, head, context }), 2, 'report-malformed');
    }
  });
});

test('an unusable report or context, or a malformed command line, exits 2 with its own cause and never accepts', () => {
  const { repo, report, context } = completeCase();
  const head = repo.commit;
  const report0 = writeJson(report);
  const context0 = writeJson(context);
  const missing = path.join(makeTempDir('check'), 'missing.json');
  const fifo = path.join(makeTempDir('check'), 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  const cases = [
    [['--report', missing, '--head', head, '--context', context0], 'report-unreadable'],
    [['--report', makeTempDir('check'), '--head', head, '--context', context0], 'report-unreadable'],
    [['--report', fifo, '--head', head, '--context', context0], 'report-unreadable'],
    [['--report', writeJson('{'), '--head', head, '--context', context0], 'report-malformed'],
    [['--report', writeJson('[]'), '--head', head, '--context', context0], 'report-malformed'],
    [['--report', writeJson('null'), '--head', head, '--context', context0], 'report-malformed'],
    [['--report', report0, '--head', head, '--context', missing], 'context-unreadable'],
    [['--report', report0, '--head', head, '--context', writeJson('{')], 'context-malformed'],
    [['--report', report0, '--head', head, '--context', writeJson({ ...context, extra: OTHER_DIGEST })], 'context-malformed'],
    [['--report', report0, '--head', head, '--context', writeJson({ gateRevision: context.gateRevision, configSha256: context.configSha256 })], 'context-malformed'],
    [['--report', report0, '--head', head, '--context', writeJson({ ...context, configSha256: 'ABC' })], 'context-malformed'],
    [['--report', report0, '--head', head, '--context', writeJson({ ...context, expectedRoot: 'main' })], 'context-malformed'],
    [['--report', report0, '--head', 'HEAD', '--context', context0], 'bad-arguments'],
    [['--report', report0, '--head', head.toUpperCase(), '--context', context0], 'bad-arguments'],
    [['--report', report0, '--context', context0], 'bad-arguments'],
    [['--head', head, '--context', context0], 'bad-arguments'],
    [['--report', report0, '--head', head], 'bad-arguments'],
    [['--report', report0, '--head', head, '--context', context0, '--extra', 'x'], 'bad-arguments'],
    [[], 'bad-arguments'],
  ];
  for (const [args, cause] of cases) refused(runCheckReport(args), 2, cause);
});

test('an oversized report or context is refused before it is read, naming the limit', () => {
  const { repo, report, context } = completeCase();
  const oversized = writeJson(`"${'x'.repeat(2 * 1024 * 1024)}"`);
  const head = repo.commit;
  refused(runCheckReport(['--report', oversized, '--head', head, '--context', writeJson(context)]), 2, 'limit:maxCheckFileBytes');
  refused(runCheckReport(['--report', writeJson(report), '--head', head, '--context', oversized]), 2, 'limit:maxCheckFileBytes');
});
