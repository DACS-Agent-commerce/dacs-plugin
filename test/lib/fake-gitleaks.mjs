import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './gate-fixtures.mjs';

export const FAKE_VERSION = '1.2.3';
export const FAKE_URL = 'https://download.example.invalid/fake-gitleaks.tar.gz';

/** Builds a tar.gz holding a `gitleaks` script that prints `version` (a symlink to /bin/sh when `asLink`); returns its bytes. */
export function buildFakeArchive({ version = FAKE_VERSION, asLink = false } = {}) {
  const source = makeTempDir('archive-source');
  const binary = path.join(source, 'gitleaks');
  if (asLink) symlinkSync('/bin/sh', binary);
  else writeFileSync(binary, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  writeFileSync(path.join(source, 'README.md'), 'not extracted\n');
  const archive = path.join(makeTempDir('archive'), 'fake.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', source, 'gitleaks', 'README.md']);
  return readFileSync(archive);
}

/** A pin for the fake archive `bytes` that this host can use. */
export const fakePin = (bytes, overrides) => ({
  version: FAKE_VERSION, platform: process.platform, arch: process.arch, archiveUrl: FAKE_URL,
  archiveSha256: createHash('sha256').update(bytes).digest('hex'), ...overrides,
});

/** A transport that serves `bytes` at FAKE_URL in two chunks. */
export function archiveTransport(bytes) {
  const middle = Math.floor(bytes.length / 2);
  return async (url) => {
    if (url !== FAKE_URL) return { status: 404, location: null, contentLength: null, body: null, release() {} };
    const body = (async function* serve() { yield bytes.subarray(0, middle); yield bytes.subarray(middle); }());
    return { status: 200, location: null, contentLength: bytes.length, body, release() {} };
  };
}

/** A fresh folder to install into. */
export function installFolder() {
  const folder = path.join(makeTempDir('install'), 'bin');
  mkdirSync(folder);
  return folder;
}
