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

test('generic scope exits 0 with the private rule not-run; complete scope without the list exits 2; both reports carry scope, target, scanner identity and each rule\'s status', () => {
  const repo = createRepo([{ path: 'a.txt', content: 'clean\n' }]);
  const generic = runGate(gateArgs(repo, 'generic'));
  assert.equal(generic.status, 0);
  const report = JSON.parse(generic.stdout);
  assert.equal(report.scope, 'generic');
  assert.deepEqual(report.target, { commit: repo.commit, tree: repo.tree });
  assert.deepEqual(report.scanner, { gateRevision: gateRevision(), configSha256: configSha256() });
  assert.deepEqual(report.rules, [{ id: 'R-PRIVATE', status: 'not-run' }]);

  const missingList = runGate(gateArgs(repo, 'complete', ['--expected-root', ROOT_COMMIT]));
  assert.equal(missingList.status, 2);
  assert.equal(missingList.stdout, '');

  const listFile = writeList([PLANTED]);
  const complete = JSON.parse(runGate(completeArgs(repo, listFile)).stdout);
  assert.equal(complete.scope, 'complete');
  assert.deepEqual(complete.scanner, {
    gateRevision: gateRevision(), configSha256: configSha256(), privateListSha256: sha256(readFileSync(listFile)), expectedRoot: ROOT_COMMIT,
  });
  assert.deepEqual(complete.rules, [{ id: 'R-PRIVATE', status: 'passed' }]);
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
