import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createScanDeadline, gateRevision } from '../../scripts/public-gate/gate.mjs';
import {
  CONFIG_FILE, ROOT_COMMIT, completeArgs, createRepo, gateArgs, makeTempDir, runGate, sha256, writeList,
} from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const configSha256 = () => sha256(readFileSync(CONFIG_FILE));

/** Every key path in `value`, array items as `[]`, sorted and without repeats. */
function keyPaths(value, prefix = '') {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => keyPaths(item, `${prefix}[]`)))].sort();
  if (value === null || typeof value !== 'object') return [];
  return [...new Set(Object.entries(value).flatMap(([key, item]) => [`${prefix}.${key}`, ...keyPaths(item, `${prefix}.${key}`)]))].sort();
}

const REPORT_KEYS = ['.findings', '.findings[].kind', '.findings[].line', '.findings[].location', '.findings[].rule', '.rules', '.rules[].id', '.rules[].status',
  '.scanner', '.scanner.configSha256', '.scanner.expectedRoot', '.scanner.gateRevision', '.scope', '.target', '.target.commit', '.target.tree',
  '.unscannable', '.unscannable[].cause', '.unscannable[].location'];

test('generic scope exits 0 with the private rule not-run; complete scope without the list exits 2; both reports carry scope, target, scanner identity and each rule\'s status', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const generic = runGate(gateArgs(repo, 'generic'));
  assert.equal(generic.status, 0);
  const report = JSON.parse(generic.stdout);
  assert.equal(report.scope, 'generic');
  assert.deepEqual(report.target, { commit: repo.commit, tree: repo.tree });
  assert.deepEqual(report.scanner, { gateRevision: gateRevision(), configSha256: configSha256() });
  assert.deepEqual(report.rules, [{ id: 'R-ACCOUNT', status: 'passed' }, { id: 'R-ARCHIVE', status: 'passed' }, { id: 'R-ENV', status: 'passed' }, { id: 'R-HOST', status: 'passed' }, { id: 'R-HOSTING', status: 'passed' }, { id: 'R-IP', status: 'passed' }, { id: 'R-PRIVATE', status: 'not-run' }]);

  const missingList = runGate(gateArgs(repo, 'complete', ['--expected-root', ROOT_COMMIT]));
  assert.equal(missingList.status, 2);
  assert.equal(missingList.stdout, '');

  const complete = JSON.parse(runGate(completeArgs(repo, writeList([PLANTED]))).stdout);
  assert.equal(complete.scope, 'complete');
  assert.deepEqual(complete.scanner, { gateRevision: gateRevision(), configSha256: configSha256(), expectedRoot: repo.commit });
  assert.deepEqual(complete.rules, [{ id: 'R-ACCOUNT', status: 'passed' }, { id: 'R-ARCHIVE', status: 'passed' }, { id: 'R-ENV', status: 'passed' }, { id: 'R-HOST', status: 'passed' }, { id: 'R-HOSTING', status: 'passed' }, { id: 'R-IP', status: 'passed' }, { id: 'R-PRIVATE', status: 'passed' }]);
});

test('the report holds nothing derived from the list: different, reordered, repeated or overlapping lists give byte-identical reports with only the fixed keys and no list digest', () => {
  const clean = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const found = createRepo([{ path: 'a.txt', content: 'clean\n' }, { path: `b/${PLANTED}.txt`, content: `x\n${PLANTED}\n` }]);
  const lists = [
    writeList([PLANTED]),
    writeList(['other-entry', PLANTED, 'third-entry']),
    writeList(['third-entry', PLANTED, PLANTED.slice(0, 9), PLANTED, 'other-entry']),
  ];
  for (const repo of [clean, found]) {
    const outputs = lists.map((list) => runGate(completeArgs(repo, list)));
    assert.deepEqual(outputs.map((output) => output.status), repo === clean ? [0, 0, 0] : [1, 1, 1]);
    outputs.forEach((output) => assert.equal(output.stdout, outputs[0].stdout));
    for (const list of lists) assert.ok(!outputs[0].stdout.includes(sha256(readFileSync(list))));
  }
  const report = JSON.parse(runGate(completeArgs(found, lists[2])).stdout);
  assert.deepEqual(report.findings.map((finding) => finding.location), [`${found.commit}:2`, `${found.commit}:2`]);
  const submodule = createRepo([{ path: 'm', content: 'b'.repeat(40), mode: '160000' }, { path: PLANTED, content: `${PLANTED}\n` }]);
  const full = JSON.parse(runGate(completeArgs(submodule, lists[0])).stdout);
  assert.deepEqual(keyPaths(full), REPORT_KEYS);
});

test('findings sort by position and line as numbers', () => {
  const files = Array.from({ length: 11 }, (_, index) => ({ path: `f${String(index).padStart(2, '0')}.txt`, content: 'clean\n' }));
  files[1].content = `${PLANTED}\n`;
  files[9].content = `${'x\n'.repeat(9)}${PLANTED}\n${PLANTED}\n`;
  const repo = createRepo(files);
  const report = JSON.parse(runGate(completeArgs(repo, writeList([PLANTED]))).stdout);
  assert.deepEqual(report.findings.map(({ location, line }) => [location, line]), [[`${repo.commit}:2`, 1], [`${repo.commit}:10`, 10], [`${repo.commit}:10`, 11]]);
});

test('an empty --out or --private-evidence value is refused instead of being treated as absent', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const listFile = writeList([PLANTED]);
  assert.equal(runGate(gateArgs(repo, 'generic', ['--out', ''])).status, 2);
  const emptyEvidence = runGate(completeArgs(repo, listFile, ['--private-evidence', '']));
  assert.equal(emptyEvidence.status, 2);
  assert.equal(emptyEvidence.stdout, '');
});

test('an interrupted run or an unscannable target in complete scope exits 2 and never writes a passing report', () => {
  const listFile = writeList([PLANTED]);
  const submodule = createRepo([{ path: 'm', content: 'b'.repeat(40), mode: '160000' }]);
  const unscannableOut = path.join(makeTempDir('out'), 'report.json');
  assert.equal(runGate(completeArgs(submodule, listFile, ['--out', unscannableOut])).status, 2);
  const written = JSON.parse(readFileSync(unscannableOut, 'utf8'));
  assert.ok(written.rules.every((rule) => rule.status !== 'passed'));

  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const binDir = makeTempDir('fake-git');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const fake = path.join(binDir, 'git');
  writeFileSync(fake, `#!/bin/sh\ncase "$*" in *cat-file*) kill -TERM $PPID; exec sleep 60;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(fake, 0o755);
  const interruptedOut = path.join(makeTempDir('out'), 'report.json');
  const interrupted = runGate(completeArgs(repo, listFile, ['--out', interruptedOut]), {
    env: { PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(interrupted.status, 2);
  assert.match(interrupted.stderr, /^interrupted: /m);
  assert.ok(!existsSync(interruptedOut));
});

test('the scan deadline passes while the clock is within it and throws limit:scanDeadlineMs once the clock is past it', () => {
  let now = 1000;
  const checkpoint = createScanDeadline({ deadlineMs: 500, clock: () => now });
  checkpoint();
  now = 1500;
  checkpoint();
  now = 1501;
  assert.throws(checkpoint, { cause: 'limit:scanDeadlineMs' });
});
