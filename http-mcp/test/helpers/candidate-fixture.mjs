// A small stand-in for the SDK candidate: three SDK archives, one ordinary archive, the manifest that
// pins the SDK archives and a lockfile that records all four, built with the system `tar`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

const PACKAGES = [
  { name: '@kynesyslabs/dacs', version: '0.0.1', sdk: true, dependencies: {} },
  { name: '@kynesyslabs/dacs-client', version: '0.0.1', sdk: true, dependencies: { '@kynesyslabs/dacs-node': '0.0.1', 'plain-dep': '^1.0.0' } },
  { name: '@kynesyslabs/dacs-node', version: '0.0.1', sdk: true, dependencies: {} },
  { name: 'plain-dep', version: '1.0.0', sdk: false, dependencies: {} },
];

export const filenameOf = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
export const registryUrlOf = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;

/** Writes an npm-style archive of a package holding `files` (path in the package -> text) into `directory` and returns its bytes. */
export function packArchive(directory, { name, version }, files) {
  const stage = mkdtempSync(join(tmpdir(), 'candidate-stage-'));
  mkdirSync(join(stage, 'package'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(stage, 'package', path), text);
  const file = join(directory, filenameOf(name, version));
  execFileSync('tar', ['-czf', file, '-C', stage, 'package']);
  return readFileSync(file);
}

const packageFiles = ({ name, version, dependencies }) => ({ 'package.json': JSON.stringify({ name, version, dependencies, main: 'index.js' }), 'index.js': `module.exports = ${JSON.stringify(name)};\n` });

/** Builds the stand-in and returns { archiveDir, work, manifest, lock, packages }. Everything lives under one fresh directory in the system temp folder. */
export function makeCandidateFixture() {
  const work = mkdtempSync(join(tmpdir(), 'candidate-fixture-'));
  const archiveDir = join(work, 'archives');
  mkdirSync(archiveDir);
  const packed = PACKAGES.map((entry) => ({ ...entry, integrity: sha512(packArchive(archiveDir, entry, packageFiles(entry))) }));
  const manifest = { archives: packed.filter(({ sdk }) => sdk).map(({ name, version, integrity }) => ({ package: name, version, filename: filenameOf(name, version), integrity })) };
  writeFileSync(join(archiveDir, 'MANIFEST.json'), JSON.stringify(manifest));
  const lock = {
    name: 'consumer',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'consumer', dependencies: { '@kynesyslabs/dacs': '0.0.1', '@kynesyslabs/dacs-client': '0.0.1' } },
      ...Object.fromEntries(packed.map(({ name, version, integrity, dependencies }) => [`node_modules/${name}`, {
        version, resolved: registryUrlOf(name, version), integrity, ...(Object.keys(dependencies).length ? { dependencies } : {}),
      }])),
    },
  };
  return { archiveDir, work, manifest, lock, packages: packed };
}

/** A consumer project directory under `work` whose package.json depends on the two root SDK packages. */
export function makeConsumerProject(work, extraDependencies = {}) {
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true, dependencies: { '@kynesyslabs/dacs': '0.0.1', '@kynesyslabs/dacs-client': '0.0.1', ...extraDependencies } }));
  return project;
}
