// The SDK pin: package.json and package-lock.json name the candidate's exact versions and sha512 values.
// Tests that compare with the candidate need DACS_SDK_CANDIDATE_DIR (see docs/CI.md) and are skipped without it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_DIR_ENV, installOffline, isolatedNpmEnv, lockedClosure, readCandidate, seedOfflineCache } from '../scripts/candidate-archives.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SDK_SCOPE = '@kynesyslabs/';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];
const CLIENT_NAMES = ['createSqlitePurchaseStore', 'PURCHASE_STATE_SCHEMA', 'sellerSessionTransitionState', 'OperationError', 'OutboundError', 'WalletFormatError', 'purchaseNext', 'networkIdentityLabel', 'PURCHASE_STATUS_HELP'];
const CORE_NAMES = ['canonicalize'];

const candidateDir = process.env[CANDIDATE_DIR_ENV];
const skip = candidateDir ? false : `${CANDIDATE_DIR_ENV} names no archive directory`;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pkg = readJson(join(PACKAGE_ROOT, 'package.json'));
const lock = readJson(join(PACKAGE_ROOT, 'package-lock.json'));

test('package.json pins the SDK packages to exact candidate versions with no file:, vendor or bundled dependency', async (t) => {
  const specs = DEPENDENCY_SECTIONS.flatMap((section) => Object.entries(pkg[section] ?? {}).map(([name, spec]) => ({ section, name, spec })));
  const sdkSpecs = specs.filter(({ name }) => name.startsWith(SDK_SCOPE));
  assert.deepEqual(sdkSpecs.filter(({ section }) => section === 'dependencies').map(({ name }) => name).sort(), ['@kynesyslabs/dacs', '@kynesyslabs/dacs-client']);
  for (const { section, name, spec } of sdkSpecs) assert.match(spec, EXACT_VERSION, `${section} ${name}`);
  assert.deepEqual(specs.filter(({ spec }) => /^(file|link|git|https?):|vendor|\//.test(spec)), []);
  assert.equal(pkg.bundleDependencies, undefined);
  assert.equal(pkg.bundledDependencies, undefined);
  assert.equal(existsSync(join(PACKAGE_ROOT, 'vendor')), false);
  assert.equal(execFileSync('git', ['ls-files', '*.tgz'], { cwd: REPO_ROOT, encoding: 'utf8' }), '', 'no archive is committed');
  assert.equal(pkg.overrides['@kynesyslabs/demosdk'], '4.0.20');
  assert.equal(pkg.dependencies.viem, '2.57.18');

  await t.test('the versions equal the candidate manifest', { skip }, () => {
    const { sdk } = readCandidate(candidateDir, REPO_ROOT);
    for (const name of ['@kynesyslabs/dacs', '@kynesyslabs/dacs-client']) assert.equal(pkg.dependencies[name], sdk.get(name).version, name);
  });
});

test('package-lock.json integrity for each SDK package equals the candidate manifest\'s sha512', { skip }, async (t) => {
  const candidate = readCandidate(candidateDir, REPO_ROOT);
  assert.deepEqual([...candidate.sdk.keys()].sort(), ['@kynesyslabs/dacs', '@kynesyslabs/dacs-client', '@kynesyslabs/dacs-node']);
  for (const [name, { version, integrity }] of candidate.sdk) {
    const record = lock.packages[`node_modules/${name}`];
    assert.equal(record.version, version, name);
    assert.equal(record.integrity, integrity, name);
    assert.equal(record.resolved, `https://registry.npmjs.org/${name}/-/${name.slice(SDK_SCOPE.length)}-${version}.tgz`, name);
  }
  assert.equal(lockedClosure(lock, candidate).size > candidate.sdk.size, true, 'the lock closure holds more than the SDK');

  for (const name of candidate.sdk.keys()) {
    await t.test(`one altered integrity of ${name} in the lockfile fails the closure check`, () => {
      const altered = structuredClone(lock);
      altered.packages[`node_modules/${name}`].integrity = `sha512-${'A'.repeat(86)}==`;
      assert.throws(() => lockedClosure(altered, candidate), /differs from the candidate manifest/);
    });
  }
});

test('every SDK name chat-02a imports (the P41a2a and P41a2b rows of the measured table) resolves from the installed interim candidate without loading better-sqlite3', { skip }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'candidate-pin-'));
  try {
    const seed = await seedOfflineCache({ archiveDir: candidateDir, lock, repoRoot: REPO_ROOT, env: isolatedNpmEnv(work) });
    const project = join(work, 'project');
    mkdirSync(project);
    for (const file of ['package.json', 'package-lock.json']) cpSync(join(PACKAGE_ROOT, file), join(project, file));
    await installOffline(seed, ['ci', '--omit=dev'], { cwd: project });
    const probe = `
      const client = await import('@kynesyslabs/dacs-client');
      const core = await import('@kynesyslabs/dacs');
      const { createRequire } = await import('node:module');
      const missing = [...${JSON.stringify(CLIENT_NAMES)}.filter((name) => client[name] === undefined), ...${JSON.stringify(CORE_NAMES)}.filter((name) => core[name] === undefined)];
      let sqlite = 'absent';
      try { createRequire(process.cwd() + '/probe.cjs').resolve('better-sqlite3'); sqlite = 'resolves'; } catch { /* not installed */ }
      console.log(JSON.stringify({ missing, sqlite }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: project, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { missing: [], sqlite: 'absent' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
