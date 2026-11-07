import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GITLEAKS_PIN, installGitleaks } from '../../scripts/ci/install-gitleaks.mjs';
import { REPO_ROOT, makeTempDir } from '../lib/gate-fixtures.mjs';
import { archiveTransport, buildFakeArchive, fakePin, installFolder } from '../lib/fake-gitleaks.mjs';

const INSTALLER = path.join(REPO_ROOT, 'scripts', 'ci', 'install-gitleaks.mjs');
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);
const install = (directory, bytes, overrides) => installGitleaks({ directory, pin: fakePin(bytes), transport: archiveTransport(bytes), ...overrides });

test('the pin is the SDK\'s gitleaks version and linux x64 archive digest, over https', () => {
  assert.equal(GITLEAKS_PIN.version, '8.30.1');
  assert.equal(GITLEAKS_PIN.archiveSha256, '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb');
  assert.equal(GITLEAKS_PIN.archiveUrl, 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz');
  assert.deepEqual([GITLEAKS_PIN.platform, GITLEAKS_PIN.arch], ['linux', 'x64']);
});

test('a verified archive is extracted, version-checked and moved into place as the one file in the folder', async () => {
  const directory = installFolder();
  const binary = await install(directory, buildFakeArchive());
  assert.equal(binary, path.join(directory, 'gitleaks'));
  assert.ok(statSync(binary).mode & 0o111);
  assert.deepEqual(readdirSync(directory), ['gitleaks']);
});

test('a binary that reports another version is refused and nothing is left in the folder', async () => {
  const directory = installFolder();
  const error = await rejection(install(directory, buildFakeArchive({ version: '9.9.9' })));
  assert.equal(error.cause, 'install-version-mismatch');
  assert.deepEqual(readdirSync(directory), []);
});

test('an archive whose gitleaks member is a link is refused and nothing is left in the folder', async () => {
  const directory = installFolder();
  const error = await rejection(install(directory, buildFakeArchive({ asLink: true })));
  assert.equal(error.cause, 'install-binary-invalid');
  assert.deepEqual(readdirSync(directory), []);
});

test('a verified archive that tar cannot read is an extraction failure', async () => {
  const directory = installFolder();
  const bytes = buildFakeArchive();
  const hollow = Buffer.from(bytes);
  hollow.fill(0, 0, 4);
  const error = await rejection(install(directory, hollow));
  assert.equal(error.cause, 'install-extract-failed');
  assert.deepEqual(readdirSync(directory), []);
});

test('an existing binary is never replaced or trusted', async () => {
  const directory = installFolder();
  const existing = path.join(directory, 'gitleaks');
  writeFileSync(existing, 'earlier install\n');
  const error = await rejection(install(directory, buildFakeArchive()));
  assert.equal(error.cause, 'install-exists');
  assert.deepEqual(readdirSync(directory), ['gitleaks']);
});

test('a leftover work folder from a killed run does not affect a later install', async () => {
  const directory = installFolder();
  const leftover = path.join(directory, '.gitleaks-install-killed');
  mkdirSync(leftover);
  writeFileSync(path.join(leftover, 'gitleaks.tar.gz'), 'half a download');
  const binary = await install(directory, buildFakeArchive());
  assert.ok(existsSync(binary));
  assert.ok(existsSync(path.join(leftover, 'gitleaks.tar.gz')));
});

test('a host other than the pinned platform is refused before any download', async () => {
  const directory = installFolder();
  const bytes = buildFakeArchive();
  const error = await rejection(installGitleaks({ directory, pin: fakePin(bytes, { platform: 'plan9' }), transport: () => assert.fail('downloaded') }));
  assert.equal(error.cause, 'unsupported-platform');
  assert.deepEqual(readdirSync(directory), []);
});

test('a download failure leaves the folder empty and keeps the download cause', async () => {
  const directory = installFolder();
  const bytes = buildFakeArchive();
  const error = await rejection(installGitleaks({ directory, pin: fakePin(bytes, { archiveSha256: 'f'.repeat(64) }), transport: archiveTransport(bytes) }));
  assert.equal(error.cause, 'download-checksum-mismatch');
  assert.deepEqual(readdirSync(directory), []);
});

test('the command line refuses a missing, unknown or repeated option with a cause and no echo', () => {
  const secretLooking = path.join(makeTempDir('args'), 'seen-in-output');
  const cases = [
    [[], 'bad-arguments'],
    [['--dir'], 'bad-arguments'],
    [['--unknown', secretLooking], 'bad-arguments'],
    [['--dir', secretLooking, '--dir', secretLooking], 'bad-arguments'],
    [['--dir', ''], 'bad-arguments'],
    [['stray'], 'bad-arguments'],
  ];
  for (const [args, cause] of cases) {
    const result = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`^${cause}: [^\\n]+\\n$`));
    assert.ok(!result.stderr.includes('seen-in-output'));
  }
});
