import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DIAGNOSTIC_ROUTES, MAX_FIELD_CHARS } from '../../scripts/public-gate/redact.mjs';
import {
  REPO_ROOT, ROOT_COMMIT, completeArgs, createRepo, makeTempDir, runGate, writeList,
} from '../lib/gate-fixtures.mjs';

const PRIVATE_VALUE = ['onyx', 'meridian'].join('-');
const AWKWARD_PATH = `has space/${PRIVATE_VALUE}\nline.txt`;
const DIAGNOSTIC_DIRS = ['scripts/public-gate', 'scripts/ci'];
const EMITTER_FILE = path.join('scripts', 'public-gate', 'redact.mjs');
const OUTPUT_SINK = /\bconsole\.|process\.std(?:out|err)\b|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync)\b/;
// Exact-byte export and materialization writers are data writes, not diagnostics; later cards list theirs here.
const EXACT_BYTE_WRITERS = [];

function sourceFiles(dir) {
  const full = path.join(REPO_ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return relative.endsWith('.mjs') ? [relative] : [];
  });
}

const leaksNothing = (...texts) => texts.forEach((text) => assert.ok(!text.toLowerCase().includes(PRIVATE_VALUE), 'private value leaked'));

function leakRepo() {
  return createRepo([{ path: AWKWARD_PATH, content: `line one\n${PRIVATE_VALUE}\n` }]);
}

const scenarios = {
  'gate.stdout': () => {
    const repo = leakRepo();
    const result = runGate(completeArgs(repo, writeList([PRIVATE_VALUE])));
    leaksNothing(result.stdout, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.findings, [
      { rule: 'R-PRIVATE', kind: 'content', location: `${repo.commit}:entry-1`, line: 2 },
      { rule: 'R-PRIVATE', kind: 'path', location: `${repo.commit}:entry-1` },
    ]);
  },
  'gate.report-file': () => {
    const repo = leakRepo();
    const out = path.join(makeTempDir('out'), 'report.json');
    const result = runGate(completeArgs(repo, writeList([PRIVATE_VALUE]), ['--out', out]));
    assert.equal(result.status, 1);
    leaksNothing(readFileSync(out, 'utf8'), result.stdout, result.stderr);
  },
  'gate.stderr': () => {
    const result = runGate(['--repo', path.join(makeTempDir('missing'), AWKWARD_PATH), '--commit', ROOT_COMMIT, '--scope', 'complete',
      '--private-list', writeList([PRIVATE_VALUE]), '--expected-root', ROOT_COMMIT]);
    assert.equal(result.status, 2);
    leaksNothing(result.stdout, result.stderr);
  },
};

test('at this PR: gate `--scope` and the gate\'s own routes; later owners add their rows. A private value in a path, including one with spaces or a newline, appears in no report field, stdout or stderr record; the finding keeps rule id, location identifier, line and cause; the exact mapping is only in the private evidence file; one table enumerates gate, check-report, secret-scan, history, rules-eval child, run-bounded, install-gitleaks and import-check diagnostic routes under scripts/public-gate and scripts/ci; a static route check rejects direct console.*, process.std*.write or diagnostic writeFile sinks outside the emitter, with exact-byte export/materialization writes explicitly classified separately; a runtime-built list value on every registered route appears in no diagnostic report, stdout or stderr, and a 70,000-character path or message is truncated with a marker or refused at the named 4,096-character field limit; the intentional private mapping is the sole private-value output', async (t) => {
  await t.test('the route table holds exactly the routes this PR registers, each with a runtime scenario', () => {
    assert.deepEqual(Object.keys(DIAGNOSTIC_ROUTES).sort(), Object.keys(scenarios).sort());
  });

  for (const [route, scenario] of Object.entries(scenarios)) {
    await t.test(`a runtime-built list value does not reach ${route}`, scenario);
  }

  await t.test('no diagnostic sink exists outside the emitter', () => {
    const sinks = DIAGNOSTIC_DIRS.flatMap(sourceFiles)
      .filter((file) => file !== EMITTER_FILE && !EXACT_BYTE_WRITERS.includes(file))
      .filter((file) => OUTPUT_SINK.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')));
    assert.deepEqual(sinks, []);
  });

  await t.test('the private mapping is the only output that holds the exact path, and it is written once', () => {
    const repo = leakRepo();
    const evidence = path.join(makeTempDir('evidence'), 'mapping.json');
    const list = writeList([PRIVATE_VALUE]);
    const result = runGate(completeArgs(repo, list, ['--private-evidence', evidence]));
    assert.equal(result.status, 1);
    leaksNothing(result.stdout, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), { [`${repo.commit}:entry-1`]: [AWKWARD_PATH] });
    const again = runGate(completeArgs(repo, list, ['--private-evidence', evidence]));
    assert.equal(again.status, 2);
    assert.equal(JSON.parse(readFileSync(evidence, 'utf8'))[`${repo.commit}:entry-1`][0], AWKWARD_PATH);
    const generic = runGate(['--repo', repo.dir, '--commit', repo.commit, '--scope', 'generic', '--private-evidence', evidence]);
    assert.equal(generic.status, 2);
  });

  await t.test('the report file and the private evidence file must be different files, however the path is spelled, and nothing is written', () => {
    const repo = leakRepo();
    const list = writeList([PRIVATE_VALUE]);
    const dir = makeTempDir('destinations');
    const linkedDir = path.join(makeTempDir('destination-link'), 'link');
    symlinkSync(dir, linkedDir);
    const spellings = [
      [path.join(dir, 'same.json'), path.join(dir, 'same.json')],
      [path.join(dir, 'dot.json'), path.join(dir, '.', 'sub', '..', 'dot.json')],
      [path.join(dir, 'link.json'), path.join(linkedDir, 'link.json')],
    ];
    for (const [out, evidence] of spellings) {
      const result = runGate(completeArgs(repo, list, ['--out', out, '--private-evidence', evidence]));
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /^bad-arguments: /);
      assert.equal(result.stdout, '');
      leaksNothing(result.stdout, result.stderr);
      assert.deepEqual(readdirSync(dir), []);
    }
  });

  await t.test('a 70,000-character path or message is truncated with a marker at the field limit', () => {
    assert.equal(MAX_FIELD_CHARS, 4096);
    const longPath = `${'p'.repeat(70_000)}.txt`;
    const repo = createRepo([{ path: longPath, content: `${PRIVATE_VALUE}\n` }]);
    const result = runGate(completeArgs(repo, writeList([PRIVATE_VALUE])));
    const [finding] = JSON.parse(result.stdout).findings;
    assert.equal(finding.location.length, MAX_FIELD_CHARS);
    assert.ok(finding.location.endsWith('[truncated]'));
    const message = runGate(['--repo', 'm'.repeat(70_000), '--commit', ROOT_COMMIT, '--scope', 'generic']);
    assert.equal(message.status, 2);
    assert.ok(message.stderr.length <= MAX_FIELD_CHARS + 1, `stderr was ${message.stderr.length} characters`);
  });
});
