// The isolated install checks: the cache is seeded from archives through a loopback registry that is closed
// before an offline install. Cases on the stand-in candidate run everywhere; those that use the real archive
// directory need DACS_SDK_CANDIDATE_DIR (see docs/CI.md) and are skipped without it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_DIR_ENV, installOffline, isolatedNpmEnv, lockProblems, lockedClosure, readCandidate, seedOfflineCache, startClosureRegistry } from '../scripts/candidate-archives.mjs';
import { filenameOf, makeCandidateFixture, makeConsumerProject, packArchive, registryUrlOf, sha512 } from './helpers/candidate-fixture.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SDK_NAMES = ['@kynesyslabs/dacs', '@kynesyslabs/dacs-client', '@kynesyslabs/dacs-node'];
const CHECKER_RUN_MS = 300_000;

const candidateDir = process.env[CANDIDATE_DIR_ENV];
const skipWithoutCandidate = candidateDir ? false : `${CANDIDATE_DIR_ENV} names no archive directory`;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const scratch = [];
const scratchDir = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
};
after(() => scratch.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const made = makeCandidateFixture();
  scratch.push(made.work);
  return made;
}

/** A loopback server standing in for the public registry and for any proxy: it records every request and serves nothing. */
async function startCanary() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(503).end();
  });
  server.on('connect', (request, socket) => {
    requests.push(`CONNECT ${request.url}`);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

/** The isolated npm environment with the canary as default registry and as proxy for everything but loopback. */
const guardedEnv = (work, canary) => ({ ...isolatedNpmEnv(work), npm_config_registry: canary.url, npm_config_proxy: canary.url, npm_config_https_proxy: canary.url, npm_config_noproxy: '127.0.0.1' });

async function withCanary(run) {
  const canary = await startCanary();
  try {
    return await run(canary);
  } finally {
    await canary.close();
  }
}

/** Seeds the stand-in's cache and installs the consumer project offline. Returns { seed, project }. */
async function seedAndInstall(made, canary) {
  const seed = await seedOfflineCache({ archiveDir: made.archiveDir, lock: made.lock, repoRoot: REPO_ROOT, env: guardedEnv(made.work, canary) });
  const project = makeConsumerProject(made.work);
  await installOffline(seed, ['install'], { cwd: project });
  return { seed, project };
}

/** Writes an `npm` that records each call and only runs the install, `ci` and `cache add` commands as no-ops. */
function writeNpmRecorder(directory, log) {
  const file = join(directory, 'npm');
  writeFileSync(file, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cache: process.env.npm_config_cache, ignoreScripts: process.env.npm_config_ignore_scripts }) + '\\n');
const recordedOnly = ['install', 'ci'].includes(args[0]) || (args[0] === 'cache' && args[1] === 'add');
process.exit(recordedOnly ? 0 : spawnSync('npm', args, { stdio: 'inherit', env: { ...process.env, PATH: process.env.REAL_PATH } }).status ?? 1);
`);
  chmodSync(file, 0o755);
}

const CHECKERS = [
  { script: 'check-package.mjs', installs: ['install', 'ci'] },
  { script: 'check-embedded-wallet-package.mjs', installs: ['install'] },
];

test('each isolated package checker seeds a fresh cache with the package-version metadata and archives of exactly the SDK candidate and the locked production closure, and installs offline with lifecycle scripts disabled', { skip: skipWithoutCandidate }, async (t) => {
  const expected = [...lockedClosure(readJson(join(PACKAGE_ROOT, 'package-lock.json')), readCandidate(candidateDir, REPO_ROOT)).keys()].sort();
  for (const { script, installs } of CHECKERS) {
    await t.test(`${script} seeds the closure once and runs every install offline against the closed registry`, () => {
      const work = scratchDir('candidate-checker-');
      const log = join(work, 'npm-calls.jsonl');
      writeNpmRecorder(work, log);
      const env = { ...process.env, PATH: `${work}:${process.env.PATH}`, REAL_PATH: process.env.PATH, TMPDIR: work, [CANDIDATE_DIR_ENV]: candidateDir };
      spawnSync(process.execPath, [join(PACKAGE_ROOT, 'scripts', script)], { cwd: PACKAGE_ROOT, env, encoding: 'utf8', timeout: CHECKER_RUN_MS });
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

      const seeds = calls.filter(({ args }) => args[0] === 'cache' && args[1] === 'add');
      assert.equal(seeds.length, 1, 'one seeding per run');
      const [seed] = seeds;
      const registryAt = seed.args.indexOf('--registry');
      assert.deepEqual(seed.args.slice(2, registryAt).sort(), expected, 'exactly the SDK candidate and the locked closure');
      const registry = seed.args[registryAt + 1];
      assert.match(registry, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.ok(seed.cache.startsWith(work), 'a fresh cache inside the run\'s own directory');

      const installCalls = calls.filter(({ args }) => ['install', 'ci'].includes(args[0]));
      assert.deepEqual(installCalls.map(({ args }) => args[0]), installs);
      for (const call of installCalls) {
        for (const flag of ['--offline', '--ignore-scripts', '--omit=optional']) assert.ok(call.args.includes(flag), `${call.args[0]} ${flag}`);
        assert.equal(call.args.includes('--prefer-offline'), false);
        assert.equal(call.args[call.args.indexOf('--registry') + 1], registry);
        assert.equal(call.cache, seed.cache);
        assert.equal(call.ignoreScripts, 'true');
      }
    });
  }
});

const FAILURES = [
  ['an empty archive directory', (made) => readdirSync(made.archiveDir).filter((file) => file.endsWith('.tgz')).forEach((file) => rmSync(join(made.archiveDir, file))), /archive missing/],
  ['a missing SDK archive', (made) => rmSync(join(made.archiveDir, filenameOf('@kynesyslabs/dacs-client', '0.0.1'))), /archive missing: kynesyslabs-dacs-client-0\.0\.1\.tgz/],
  ['one missing ordinary transitive archive', (made) => rmSync(join(made.archiveDir, filenameOf('plain-dep', '1.0.0'))), /archive missing: plain-dep-1\.0\.0\.tgz/],
  ['missing package-version metadata', (made) => {
    const bytes = packArchive(made.archiveDir, { name: 'plain-dep', version: '1.0.0' }, { 'index.js': 'module.exports = 1;\n' });
    made.lock.packages['node_modules/plain-dep'].integrity = sha512(bytes);
  }, /archive has no package\.json: plain-dep-1\.0\.0\.tgz/],
  ['an altered SDK archive', (made) => alterArchive(made, '@kynesyslabs/dacs-node', '0.0.1'), /sha512 differs from its pin: kynesyslabs-dacs-node-0\.0\.1\.tgz/],
  ['an altered ordinary archive', (made) => alterArchive(made, 'plain-dep', '1.0.0'), /sha512 differs from its pin: plain-dep-1\.0\.0\.tgz/],
];

function alterArchive(made, name, version) {
  const file = join(made.archiveDir, filenameOf(name, version));
  const bytes = readFileSync(file);
  bytes[bytes.length >> 1] ^= 0xff;
  writeFileSync(file, bytes);
}

test('an empty archive directory, a missing SDK archive, one missing ordinary transitive archive, missing package-version metadata or an altered archive fails the install with no registry request and no other build installed', async (t) => {
  for (const [label, damage, message] of FAILURES) {
    await t.test(label, () => withCanary(async (canary) => {
      const made = fixture();
      damage(made);
      const env = guardedEnv(made.work, canary);
      await assert.rejects(seedOfflineCache({ archiveDir: made.archiveDir, lock: made.lock, repoRoot: REPO_ROOT, env }), message);
      assert.equal(existsSync(join(env.npm_config_cache, '_cacache')), false, 'nothing was cached');

      // An install attempted anyway finds nothing to install and has no registry to fall back to.
      const project = makeConsumerProject(made.work);
      await assert.rejects(installOffline({ env, registryUrl: 'http://127.0.0.1:9/' }, ['install'], { cwd: project }), /ENOTCACHED/);
      assert.equal(existsSync(join(project, 'node_modules')), false, 'no build was installed');
      assert.deepEqual(canary.requests, [], 'no registry request');
    }));
  }
});

test('the child lockfile\'s integrity for each SDK package equals the manifest\'s and every other package\'s equals the frozen lockfile\'s, and a mismatch fails the check', async (t) => {
  await withCanary(async (canary) => {
    const made = fixture();
    const { seed, project } = await seedAndInstall(made, canary);
    const lockFile = join(project, 'package-lock.json');
    const child = readJson(lockFile);
    for (const { name, integrity } of made.manifest.archives.map(({ package: name, integrity }) => ({ name, integrity }))) {
      assert.equal(child.packages[`node_modules/${name}`].integrity, integrity, name);
    }
    assert.equal(child.packages['node_modules/plain-dep'].integrity, made.lock.packages['node_modules/plain-dep'].integrity);
    assert.deepEqual(lockProblems(seed, lockFile), []);

    const problemsAfter = (change) => {
      const altered = structuredClone(child);
      change(altered.packages);
      const file = join(made.work, 'altered-lock.json');
      writeFileSync(file, JSON.stringify(altered));
      return lockProblems(seed, file);
    };
    const wrongIntegrity = `sha512-${'B'.repeat(86)}==`;
    await t.test('an SDK package with another integrity than the manifest\'s is a problem', () => {
      assert.match(problemsAfter((packages) => { packages['node_modules/@kynesyslabs/dacs'].integrity = wrongIntegrity; }).join('\n'), /@kynesyslabs\/dacs@0\.0\.1 has integrity/);
    });
    await t.test('an ordinary package with another integrity than the frozen lockfile\'s is a problem', () => {
      assert.match(problemsAfter((packages) => { packages['node_modules/plain-dep'].integrity = wrongIntegrity; }).join('\n'), /plain-dep@1\.0\.0 has integrity/);
    });
    await t.test('a package outside the locked closure is a problem', () => {
      assert.deepEqual(problemsAfter((packages) => { packages['node_modules/stranger'] = { version: '9.9.9', integrity: wrongIntegrity }; }), ['stranger@9.9.9 is not in the locked closure']);
    });
    await t.test('a frozen lockfile whose SDK integrity differs from the manifest is refused before anything is seeded', async () => {
      const mismatched = structuredClone(made.lock);
      mismatched.packages['node_modules/@kynesyslabs/dacs-client'].integrity = wrongIntegrity;
      await assert.rejects(seedOfflineCache({ archiveDir: made.archiveDir, lock: mismatched, repoRoot: REPO_ROOT, env: guardedEnv(scratchDir('candidate-lock-'), canary) }), /@kynesyslabs\/dacs-client in the lockfile differs from the candidate manifest/);
    });
  });
});

test('an archive directory inside the repository is refused', () => {
  const link = join(scratchDir('candidate-link-'), 'archives');
  symlinkSync(join(REPO_ROOT, 'http-mcp'), link);
  for (const directory of [REPO_ROOT, join(REPO_ROOT, 'http-mcp'), link]) {
    assert.throws(() => readCandidate(directory, REPO_ROOT), /inside the repository/, directory);
  }
  const outside = makeCandidateFixture();
  scratch.push(outside.work);
  assert.deepEqual([...readCandidate(outside.archiveDir, REPO_ROOT).sdk.keys()].sort(), SDK_NAMES);
});

test('no archive is committed to the repository', () => {
  assert.equal(execFileSync('git', ['ls-files', '*.tgz', '*.tar', '*.tar.gz'], { cwd: REPO_ROOT, encoding: 'utf8' }), '');
});

test('the packed plugin installs into an empty child project from a completely fresh cache with the network disabled, and its installed SDK versions and integrity equal the manifest\'s', { skip: skipWithoutCandidate }, () => withCanary(async (canary) => {
  const work = scratchDir('candidate-child-');
  const pack = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: PACKAGE_ROOT, encoding: 'utf8' }))[0];
  const seed = await seedOfflineCache({ archiveDir: candidateDir, lock: readJson(join(PACKAGE_ROOT, 'package-lock.json')), repoRoot: REPO_ROOT, env: guardedEnv(work, canary) });
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'child', version: '1.0.0', private: true }));
  await installOffline(seed, ['install', join(work, pack.filename), '--omit=dev'], { cwd: project });

  const { sdk } = readCandidate(candidateDir, REPO_ROOT);
  const child = readJson(join(project, 'package-lock.json'));
  for (const [name, { version, integrity }] of sdk) {
    assert.equal(readJson(join(project, 'node_modules', name, 'package.json')).version, version, name);
    assert.equal(child.packages[`node_modules/${name}`].integrity, integrity, name);
  }
  assert.deepEqual(lockProblems(seed, join(project, 'package-lock.json'), 'node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin'), []);
  assert.deepEqual(canary.requests, [], 'no request left the machine');
}));

test('the lockfile npm ci replay installs offline from the seeded cache, and fails without fallback when a closure archive is missing', async (t) => {
  await t.test('the frozen lockfile installs from the seeded cache', { skip: skipWithoutCandidate }, () => withCanary(async (canary) => {
    const work = scratchDir('candidate-replay-');
    const seed = await seedOfflineCache({ archiveDir: candidateDir, lock: readJson(join(PACKAGE_ROOT, 'package-lock.json')), repoRoot: REPO_ROOT, env: guardedEnv(work, canary) });
    const project = join(work, 'project');
    mkdirSync(project);
    for (const file of ['package.json', 'package-lock.json']) cpSync(join(PACKAGE_ROOT, file), join(project, file));
    await installOffline(seed, ['ci', '--omit=dev'], { cwd: project });
    for (const name of SDK_NAMES) assert.ok(existsSync(join(project, 'node_modules', name, 'package.json')), name);
    assert.deepEqual(canary.requests, []);
  }));

  await t.test('a closure archive missing from the archive directory fails before any install', { skip: skipWithoutCandidate }, () => withCanary(async (canary) => {
    const work = scratchDir('candidate-missing-');
    const directory = join(work, 'archives');
    mkdirSync(directory);
    const omitted = filenameOf('express', '5.2.1');
    for (const file of readdirSync(candidateDir).filter((name) => name !== omitted)) symlinkSync(join(candidateDir, file), join(directory, file));
    await assert.rejects(seedOfflineCache({ archiveDir: directory, lock: readJson(join(PACKAGE_ROOT, 'package-lock.json')), repoRoot: REPO_ROOT, env: guardedEnv(work, canary) }), /archive missing: express-5\.2\.1\.tgz/);
    assert.deepEqual(canary.requests, []);
  }));

  await t.test('a lockfile package that the seeded cache lacks fails offline with no registry request', () => withCanary(async (canary) => {
    const made = fixture();
    const seed = await seedOfflineCache({ archiveDir: made.archiveDir, lock: made.lock, repoRoot: REPO_ROOT, env: guardedEnv(made.work, canary) });
    const project = makeConsumerProject(made.work, { 'ghost-dep': '1.0.0' });
    const lock = structuredClone(made.lock);
    lock.packages[''].dependencies['ghost-dep'] = '1.0.0';
    lock.packages['node_modules/ghost-dep'] = { version: '1.0.0', resolved: registryUrlOf('ghost-dep', '1.0.0'), integrity: sha512(Buffer.from('ghost')) };
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify(lock));
    await assert.rejects(installOffline(seed, ['ci', '--omit=dev'], { cwd: project }), /ENOTCACHED/);
    assert.equal(existsSync(join(project, 'node_modules', 'ghost-dep')), false);
    assert.deepEqual(canary.requests, []);
  }));
});

test('the seeding registry is loopback-only, serves only the closure, answers any other name 404 and is closed before the child install starts', async (t) => {
  const made = fixture();
  const served = made.packages.map(({ name, version, integrity, dependencies }) => ({
    entry: { name, version, integrity, filename: filenameOf(name, version) },
    archive: readFileSync(join(made.archiveDir, filenameOf(name, version))),
    packageJson: { name, version, dependencies },
  }));
  const registry = await startClosureRegistry(served);
  try {
    const base = new URL(registry.url);
    assert.equal(base.hostname, '127.0.0.1');

    await t.test('each closure package answers with its metadata and its archive', async () => {
      for (const { entry, archive } of served) {
        const metadata = await (await fetch(new URL(encodeURIComponent(entry.name), base))).json();
        assert.equal(metadata.versions[entry.version].dist.integrity, entry.integrity);
        const tarball = await fetch(metadata.versions[entry.version].dist.tarball);
        assert.equal(sha512(Buffer.from(await tarball.arrayBuffer())), sha512(archive), entry.name);
      }
    });

    await t.test('any other name, path or method answers 404', async () => {
      for (const [method, path] of [['GET', 'left-pad'], ['GET', encodeURIComponent('@kynesyslabs/other')], ['GET', '-/other-1.0.0.tgz'], ['GET', ''], ['POST', encodeURIComponent('@kynesyslabs/dacs')], ['PUT', 'plain-dep']]) {
        const response = await fetch(new URL(path, base), { method });
        assert.equal(response.status, 404, `${method} /${path}`);
      }
    });

    await t.test('it does not listen on a non-loopback address', async () => {
      const outside = Object.values(networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal);
      if (!outside) return;
      await assert.rejects(fetch(`http://${outside.address}:${base.port}/`, { signal: AbortSignal.timeout(5000) }));
    });
  } finally {
    await registry.close();
  }

  await t.test('the registry is closed when seeding returns, before any install starts', () => withCanary(async (canary) => {
    const other = fixture();
    const seed = await seedOfflineCache({ archiveDir: other.archiveDir, lock: other.lock, repoRoot: REPO_ROOT, env: guardedEnv(other.work, canary) });
    await assert.rejects(fetch(seed.registryUrl, { signal: AbortSignal.timeout(5000) }), (error) => error.cause?.code === 'ECONNREFUSED');
    assert.deepEqual(canary.requests, []);
  }));
});
