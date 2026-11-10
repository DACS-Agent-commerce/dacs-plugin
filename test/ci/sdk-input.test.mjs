import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, makeTempDir, snapshotTree } from '../lib/gate-fixtures.mjs';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'ci', 'sdk-input.mjs');
const SDK_SCOPE = '@kynesyslabs';
const DEMOSDK = `${SDK_SCOPE}/demosdk`;
const ROOTS = ['.', 'http-mcp', 'http-mcp/wallet-build', 'stdio-mcp', 'stdio-mcp/buyer'];
const CARRIED_ROOTS = ROOTS.filter((root) => root !== 'stdio-mcp/buyer');
const LEGACY_SPEC = 'file:vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz';
const REGISTRY = 'https://registry.npmjs.org';
const OVERSIZED_JSON_BYTES = 9 * 1024 * 1024;

const readJson = (root, file) => JSON.parse(readFileSync(path.join(REPO_ROOT, root, file), 'utf8'));
const carried = Object.fromEntries(CARRIED_ROOTS.map((root) => [root, { 'package.json': readJson(root, 'package.json'), 'package-lock.json': readJson(root, 'package-lock.json') }]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const registryUrl = (name, version) => `${REGISTRY}/${name}/-/${name.split('/')[1]}-${version}.tgz`;
const lockKey = (name) => `node_modules/${name}`;

/** A temporary checkout holding clones of the real carried manifest-and-lock pairs plus a small buyer root; `files` maps root -> file -> object. */
function makeCheckout() {
  const files = clone(carried);
  files['stdio-mcp/buyer'] = { 'package.json': { name: 'buyer', private: true }, 'package-lock.json': { lockfileVersion: 3, packages: { '': { name: 'buyer' } } } };
  return { dir: makeTempDir('sdk-input'), files };
}

function writeCheckout({ dir, files }) {
  for (const [root, pair] of Object.entries(files)) {
    for (const [name, value] of Object.entries(pair)) {
      const file = path.join(dir, root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return dir;
}

/** Adds an exact registry SDK dependency to a root's manifest and lock. */
function addPublished(checkout, root, name = DEMOSDK, version = '4.0.16') {
  const pair = checkout.files[root];
  pair['package.json'].dependencies = { ...pair['package.json'].dependencies, [name]: version };
  pair['package-lock.json'].packages[''].dependencies = { ...pair['package-lock.json'].packages[''].dependencies, [name]: version };
  pair['package-lock.json'].packages[lockKey(name)] = { version, resolved: registryUrl(name, version), integrity: integrityOf(`${root}:${name}`) };
}

const sdkRecord = (checkout, root, name = DEMOSDK) => checkout.files[root]['package-lock.json'].packages[lockKey(name)];

/** A PATH folder whose `npm` records each call; the checker must never reach it. */
function fakeNpm() {
  const dir = makeTempDir('fake-npm');
  const log = path.join(dir, 'calls.log');
  writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
  chmodSync(path.join(dir, 'npm'), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

/** Runs the checker on `repo` (omitted: the real repository) and returns its status, streams, parsed report and recorded npm calls. */
function runSdkInput(args, repo) {
  const npm = fakeNpm();
  const result = spawnSync(process.execPath, [SCRIPT, ...(repo ? ['--repo', repo] : []), ...args], {
    encoding: 'utf8', env: { PATH: `${npm.dir}:${process.env.PATH}` },
  });
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* a refused command line prints no report */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, report, npmCalls: npm.calls() };
}

const stateOf = (result, root) => result.report.roots.find((entry) => entry.root === root);

test('a published exact version is available, including wallet-build\'s approved exact registry version; the recorded legacy file:vendor entry is unavailable with its cause; candidate archives in an external directory matching the approved sha512 pins are available and the checkout is unchanged', async (t) => {
  await t.test('an exact registry version with lock integrity is published and available for stdio', () => {
    const result = runSdkInput(['--prepare', 'stdio'], writeCheckout(makeCheckout()));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stateOf(result, 'stdio-mcp'), { root: 'stdio-mcp', state: 'published', cause: 'registry-exact-version-with-integrity' });
    assert.equal(result.report.available, true);
  });

  await t.test('wallet-build\'s exact registry version is published and available for http-mcp once http-mcp holds no SDK input', () => {
    const checkout = makeCheckout();
    delete checkout.files['http-mcp']['package.json'].dependencies[`${SDK_SCOPE}/dacs`];
    delete checkout.files['http-mcp']['package-lock.json'].packages[''].dependencies[`${SDK_SCOPE}/dacs`];
    delete checkout.files['http-mcp']['package-lock.json'].packages[lockKey(`${SDK_SCOPE}/dacs`)];
    const result = runSdkInput(['--prepare', 'http-mcp'], writeCheckout(checkout));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(stateOf(result, 'http-mcp/wallet-build').state, 'published');
    assert.equal(stateOf(result, 'http-mcp').state, 'none');
  });

  await t.test('the recorded legacy file:vendor entry is legacy-unavailable with its cause and fails an http-mcp preparation with exit 2', () => {
    const result = runSdkInput(['--prepare', 'http-mcp'], writeCheckout(makeCheckout()));
    assert.equal(result.status, 2);
    assert.deepEqual(stateOf(result, 'http-mcp'), { root: 'http-mcp', state: 'legacy-unavailable', cause: 'recorded-legacy-file-vendor' });
    assert.equal(result.report.available, false);
    assert.match(result.stderr, /^sdk-input-unavailable: /m);
  });

  await t.test('the legacy spec is refused when it appears anywhere other than http-mcp\'s recorded entry', () => {
    const checkout = makeCheckout();
    checkout.files['stdio-mcp']['package.json'].dependencies[`${SDK_SCOPE}/dacs`] = LEGACY_SPEC;
    const result = runSdkInput(['--prepare', 'stdio'], writeCheckout(checkout));
    assert.equal(result.status, 1);
    assert.equal(stateOf(result, 'stdio-mcp').state, 'refused');
  });

  await t.test('candidate archives matching the lock sha512 are available and the checkout is unchanged', () => {
    const checkout = makeCheckout();
    const candidates = makeTempDir('candidates');
    const archive = 'candidate archive bytes';
    sdkRecord(checkout, 'stdio-mcp', DEMOSDK).integrity = integrityOf(archive);
    writeFileSync(path.join(candidates, 'kynesyslabs-demosdk-4.0.17.tgz'), archive);
    const dir = writeCheckout(checkout);
    const before = snapshotTree(dir);
    const result = runSdkInput(['--prepare', 'stdio', '--candidate-dir', candidates], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stateOf(result, 'stdio-mcp'), { root: 'stdio-mcp', state: 'candidate', cause: 'candidate-archive-sha512-match' });
    assert.deepEqual(snapshotTree(dir), before);
  });

  await t.test('a candidate archive that is missing or differs from the pin makes the preparation unavailable with its cause', () => {
    const candidates = makeTempDir('candidates');
    const missing = runSdkInput(['--prepare', 'stdio', '--candidate-dir', candidates], writeCheckout(makeCheckout()));
    assert.equal(missing.status, 2);
    assert.equal(stateOf(missing, 'stdio-mcp').cause, 'candidate-archive-missing');
    writeFileSync(path.join(candidates, 'kynesyslabs-demosdk-4.0.17.tgz'), 'other bytes');
    const differs = runSdkInput(['--prepare', 'stdio', '--candidate-dir', candidates], writeCheckout(makeCheckout()));
    assert.equal(differs.status, 2);
    assert.equal(stateOf(differs, 'stdio-mcp').cause, 'candidate-archive-sha512-mismatch');
  });

  await t.test('the buyer preparation covers stdio-mcp and an optional stdio-mcp/buyer, and an absent buyer root is reported absent', () => {
    const present = runSdkInput(['--prepare', 'buyer'], writeCheckout(makeCheckout()));
    assert.equal(present.status, 0, present.stderr);
    assert.equal(stateOf(present, 'stdio-mcp/buyer').state, 'none');
    const checkout = makeCheckout();
    delete checkout.files['stdio-mcp/buyer'];
    const absent = runSdkInput(['--prepare', 'buyer'], writeCheckout(checkout));
    assert.equal(absent.status, 0, absent.stderr);
    assert.deepEqual(stateOf(absent, 'stdio-mcp/buyer'), { root: 'stdio-mcp/buyer', state: 'absent', cause: 'optional-root-absent' });
  });
});

const REFUSALS = [
  ['a file: manifest spec', 'local-path-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = 'file:../sdk.tgz'; }],
  ['a link: manifest spec', 'local-path-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = 'link:../sdk'; }],
  ['a relative path manifest spec', 'local-path-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].devDependencies = { [DEMOSDK]: './sdk' }; }],
  ['a vendored manifest spec', 'local-path-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = 'file:vendor/other.tgz'; }],
  ['a git manifest spec', 'local-path-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = 'git+https://example.invalid/sdk.git'; }],
  ['a tarball URL manifest spec', 'local-path-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = 'https://example.invalid/sdk.tgz'; }],
  ['a file: lock resolution', 'lock-local-resolution', (c, root) => { addPublished(c, root); sdkRecord(c, root).resolved = 'file:vendor/sdk.tgz'; }],
  ['a link: lock record', 'lock-local-resolution', (c, root) => { addPublished(c, root); sdkRecord(c, root).link = true; }],
  ['a committed archive', 'committed-archive', (c, root) => { c.files[root]['vendor/sdk.tgz'] = 'archive'; }],
  ['an npm alias under an SDK key', 'alias-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = `npm:${SDK_SCOPE}/other@1.0.0`; }],
  ['a lock name differing from its SDK path key', 'lock-identity-mismatch', (c, root) => { addPublished(c, root); sdkRecord(c, root).name = `${SDK_SCOPE}/other`; }],
  ['a resolved registry URL naming another package', 'lock-identity-mismatch', (c, root) => { addPublished(c, root); sdkRecord(c, root).resolved = registryUrl(`${SDK_SCOPE}/other`, '4.0.16'); }],
];

test('a newly committed file:, link:, path or vendored SDK spec or lock resolution, or a committed archive, is refused in any inventoried root, wallet-build\'s manifest and lock included, even when every other root is valid; table-drive an SDK manifest key with npm:@kynesyslabs/other@1.0.0, a lock name differing from its SDK path key and a resolved registry URL naming another package, in every inventoried root: exit 1 before any instrumented npm call with the cause named; matching name and URL with valid pins pass', async (t) => {
  for (const root of ROOTS) {
    for (const [label, cause, plant] of REFUSALS) {
      await t.test(`${label} in ${root} is refused with ${cause} before any npm call`, () => {
        const checkout = makeCheckout();
        plant(checkout, root);
        const result = runSdkInput(['--prepare', 'stdio'], writeCheckout(checkout));
        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(stateOf(result, root), { root, state: 'refused', cause });
        assert.equal(result.report.available, false);
        assert.equal(result.npmCalls, '');
      });
    }
    await t.test(`a matching name and registry URL with valid pins passes in ${root}`, () => {
      const checkout = makeCheckout();
      addPublished(checkout, root);
      sdkRecord(checkout, root).name = DEMOSDK;
      const result = runSdkInput(['--prepare', 'stdio'], writeCheckout(checkout));
      assert.notEqual(result.status, 1, result.stderr);
      assert.equal(stateOf(result, root).state, root === 'http-mcp' ? 'legacy-unavailable' : 'published');
    });
  }
});

const MALFORMED = [
  ['a package.json that is not JSON', 'manifest-malformed', (c, root) => { c.files[root]['package.json'] = '{'; }],
  ['a package.json that is not an object', 'manifest-malformed', (c, root) => { c.files[root]['package.json'] = '[]'; }],
  ['a lock that is not JSON', 'lock-malformed', (c, root) => { c.files[root]['package-lock.json'] = '{'; }],
  ['a lock without a packages table', 'lock-malformed', (c, root) => { c.files[root]['package-lock.json'] = { lockfileVersion: 1 }; }],
  ['a missing lock', 'lock-unreadable', (c, root) => { delete c.files[root]['package-lock.json']; }],
  ['a missing package.json', 'manifest-unreadable', (c, root) => { delete c.files[root]['package.json']; }],
  ['an oversized lock', 'file-too-large', (c, root) => { c.files[root]['package-lock.json'] = ' '.repeat(OVERSIZED_JSON_BYTES); }],
  ['a non-string SDK spec', 'unclassifiable-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = 4; }],
  ['an SDK range that is no exact version', 'unclassifiable-spec', (c, root) => { addPublished(c, root); c.files[root]['package.json'].dependencies[DEMOSDK] = '^4.0.16'; }],
  ['an SDK dependency without a lock record', 'lock-record-missing', (c, root) => { addPublished(c, root); delete c.files[root]['package-lock.json'].packages[lockKey(DEMOSDK)]; }],
  ['an SDK lock record without integrity', 'lock-integrity-missing', (c, root) => { addPublished(c, root); delete sdkRecord(c, root).integrity; }],
];

test('a malformed package.json or lock in any inventoried root, wallet-build included, or an unclassifiable dependency spec, fails closed; register --prepare and its exact root/http-mcp/stdio/buyer enum in the single P54a1-T23 selector table, including absent, empty, unknown and oversized input', async (t) => {
  for (const root of ROOTS.filter((entry) => entry !== 'stdio-mcp/buyer')) {
    for (const [label, cause, plant] of MALFORMED) {
      await t.test(`${label} in ${root} fails closed with ${cause}`, () => {
        const checkout = makeCheckout();
        plant(checkout, root);
        const result = runSdkInput(['--prepare', 'root'], writeCheckout(checkout));
        assert.equal(result.status, 2, result.stderr);
        assert.deepEqual(stateOf(result, root), { root, state: 'unverifiable', cause });
        assert.equal(result.report.available, false);
        assert.equal(result.npmCalls, '');
      });
    }
  }

  await t.test('a refusal in one root outranks a malformed file in another', () => {
    const checkout = makeCheckout();
    checkout.files['stdio-mcp']['package-lock.json'] = '{';
    checkout.files['http-mcp/wallet-build']['vendor/sdk.tgz'] = 'archive';
    assert.equal(runSdkInput(['--prepare', 'root'], writeCheckout(checkout)).status, 1);
  });

  await t.test('--prepare and --candidate-dir refuse missing, unknown and repeated input before any report', () => {
    const dir = writeCheckout(makeCheckout());
    for (const args of [[], ['--prepare', 'all'], ['--prepare', 'root', '--prepare', 'root'], ['--prepare', 'root', '--candidate-dir'], ['--prepare', 'root', '--extra', 'x']]) {
      const result = runSdkInput(args, dir);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.stdout, '');
    }
  });
});

test('on the real carried manifest-and-lock pairs, http-mcp is legacy-unavailable while a stdio preparation is available and runs, and both reports exist with their causes; the optional registry peer range in http-mcp\'s lock is not a refused resolution; a forbidden spec planted in the unrelated http-mcp root still refuses before any installation; a path constraint in any position is refused', async (t) => {
  await t.test('the stdio preparation is available while http-mcp stays legacy-unavailable in the same report', () => {
    const result = runSdkInput(['--prepare', 'stdio']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.report.roots.map(({ root, state }) => [root, state]), [
      ['.', 'none'], ['http-mcp', 'legacy-unavailable'], ['http-mcp/wallet-build', 'published'], ['stdio-mcp', 'published'], ['stdio-mcp/buyer', 'absent'], ['tools/lint', 'none'],
    ]);
    assert.equal(stateOf(result, 'http-mcp').cause, 'recorded-legacy-file-vendor');
  });

  await t.test('the http-mcp preparation reports the same root causes and fails with exit 2', () => {
    const result = runSdkInput(['--prepare', 'http-mcp']);
    assert.equal(result.status, 2);
    assert.equal(stateOf(result, 'http-mcp').cause, 'recorded-legacy-file-vendor');
    assert.equal(stateOf(result, 'stdio-mcp').state, 'published');
  });

  await t.test('the root and buyer preparations are available on the carried pairs', () => {
    for (const prepare of ['root', 'buyer']) assert.equal(runSdkInput(['--prepare', prepare]).status, 0, prepare);
  });

  await t.test('the optional registry peer range in http-mcp\'s lock is not a refused resolution', () => {
    const peers = carried['http-mcp']['package-lock.json'].packages[lockKey(`${SDK_SCOPE}/dacs`)].peerDependencies;
    assert.equal(peers[DEMOSDK], '^4.0.16');
    assert.notEqual(stateOf(runSdkInput(['--prepare', 'stdio']), 'http-mcp').state, 'refused');
  });

  await t.test('a forbidden spec planted in the unrelated http-mcp root refuses a stdio preparation before any npm call', () => {
    const checkout = makeCheckout();
    addPublished(checkout, 'http-mcp');
    checkout.files['http-mcp']['package.json'].dependencies[DEMOSDK] = 'file:../sdk.tgz';
    const result = runSdkInput(['--prepare', 'stdio'], writeCheckout(checkout));
    assert.equal(result.status, 1);
    assert.equal(stateOf(result, 'http-mcp').state, 'refused');
    assert.equal(stateOf(result, 'stdio-mcp').state, 'published');
    assert.equal(result.npmCalls, '');
  });

  const CONSTRAINTS = [
    ['a manifest peerDependencies path', (c) => { c.files['stdio-mcp']['package.json'].peerDependencies = { [DEMOSDK]: 'file:../sdk' }; }],
    ['a manifest overrides path', (c) => { c.files['stdio-mcp']['package.json'].overrides = { [DEMOSDK]: './sdk' }; }],
    ['a lock record\'s peerDependencies link:', (c) => { sdkRecord(c, 'http-mcp', `${SDK_SCOPE}/dacs`).peerDependencies[DEMOSDK] = 'link:../sdk'; }],
    ['a lock record\'s optionalDependencies path', (c) => { c.files['stdio-mcp']['package-lock.json'].packages[lockKey('canonicalize')].optionalDependencies = { [DEMOSDK]: '../sdk' }; }],
    ['a lock root entry\'s file: dependency', (c) => { c.files['http-mcp/wallet-build']['package-lock.json'].packages[''].dependencies[DEMOSDK] = 'file:../sdk'; }],
  ];
  for (const [label, plant] of CONSTRAINTS) {
    await t.test(`${label} is refused`, () => {
      const checkout = makeCheckout();
      plant(checkout);
      const result = runSdkInput(['--prepare', 'root'], writeCheckout(checkout));
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.report.roots.some((entry) => entry.state === 'refused' && entry.cause === 'local-path-spec'));
    });
  }
});

const manifestOf = (c, root) => c.files[root]['package.json'];
const lockRootOf = (c, root) => c.files[root]['package-lock.json'].packages[''];

const LOCK_DISAGREEMENTS = [
  ['a manifest version newer than the lock root entry and the lock record', (c, root) => { addPublished(c, root); manifestOf(c, root).dependencies[DEMOSDK] = '4.0.18'; }],
  ['a manifest and lock root entry newer than the lock record', (c, root) => { addPublished(c, root); manifestOf(c, root).dependencies[DEMOSDK] = '4.0.18'; lockRootOf(c, root).dependencies[DEMOSDK] = '4.0.18'; }],
  ['a lock root entry that differs from the manifest and the lock record', (c, root) => { addPublished(c, root); lockRootOf(c, root).dependencies[DEMOSDK] = '4.0.18'; }],
  ['a manifest devDependencies entry the lock root lists under dependencies', (c, root) => {
    addPublished(c, root);
    delete manifestOf(c, root).dependencies[DEMOSDK];
    manifestOf(c, root).devDependencies = { [DEMOSDK]: '4.0.16' };
  }],
  ['a lock root SDK entry the manifest lacks', (c, root) => { addPublished(c, root); delete manifestOf(c, root).dependencies[DEMOSDK]; }],
  ['one SDK dependency at two exact versions in two manifest sections', (c, root) => {
    addPublished(c, root);
    manifestOf(c, root).devDependencies = { [DEMOSDK]: '4.0.17' };
    lockRootOf(c, root).devDependencies = { [DEMOSDK]: '4.0.17' };
  }],
  ['a lock without a root entry', (c, root) => { addPublished(c, root); delete c.files[root]['package-lock.json'].packages['']; }],
];

test('a manifest SDK pin that the lock root entry or the lock record does not repeat is unverifiable, not published', async (t) => {
  for (const root of ROOTS) {
    for (const [label, plant] of LOCK_DISAGREEMENTS) {
      await t.test(`${label} in ${root} is unverifiable with lock-version-mismatch before any npm call`, () => {
        const checkout = makeCheckout();
        plant(checkout, root);
        const result = runSdkInput(['--prepare', 'root'], writeCheckout(checkout));
        assert.equal(result.status, 2, result.stderr);
        assert.deepEqual(stateOf(result, root), { root, state: 'unverifiable', cause: 'lock-version-mismatch' });
        assert.equal(result.npmCalls, '');
      });
    }
  }

  await t.test('the recorded legacy entry with a lock root entry of another spec is unverifiable', () => {
    const checkout = makeCheckout();
    lockRootOf(checkout, 'http-mcp').dependencies[`${SDK_SCOPE}/dacs`] = '0.1.0-alpha.0';
    const result = runSdkInput(['--prepare', 'stdio'], writeCheckout(checkout));
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(stateOf(result, 'http-mcp'), { root: 'http-mcp', state: 'unverifiable', cause: 'lock-version-mismatch' });
  });
});

/** Writes a sparse file of `size` bytes of zeros. */
function writeSparse(file, size) {
  const descriptor = openSync(file, 'w');
  ftruncateSync(descriptor, size);
  closeSync(descriptor);
}

/** The sha512 pin of `size` zero bytes. */
function zerosIntegrity(size) {
  const hash = createHash('sha512');
  const chunk = Buffer.alloc(1024 * 1024);
  for (let left = size; left > 0; left -= chunk.length) hash.update(chunk.subarray(0, Math.min(left, chunk.length)));
  return `sha512-${hash.digest('base64')}`;
}

test('a candidate archive over the size cap is unverifiable even when its pin matches the bytes before the cap, and one at the cap is hashed whole', async (t) => {
  const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
  const stage = (size, pinnedBytes) => {
    const checkout = makeCheckout();
    const candidates = makeTempDir('candidates');
    sdkRecord(checkout, 'stdio-mcp').integrity = zerosIntegrity(pinnedBytes);
    writeSparse(path.join(candidates, 'kynesyslabs-demosdk-4.0.17.tgz'), size);
    return runSdkInput(['--prepare', 'stdio', '--candidate-dir', candidates], writeCheckout(checkout));
  };

  await t.test('an archive one byte over the cap is unverifiable with its size cause, though its pin matches the first cap-plus-one bytes', () => {
    const result = stage(MAX_ARCHIVE_BYTES + 1, MAX_ARCHIVE_BYTES + 1);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(stateOf(result, 'stdio-mcp'), { root: 'stdio-mcp', state: 'unverifiable', cause: 'candidate-archive-too-large' });
  });

  await t.test('an archive at the cap is accepted only when the pin matches all of its bytes', () => {
    const result = stage(MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(stateOf(result, 'stdio-mcp').state, 'candidate');
    const wrong = stage(MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES - 1);
    assert.equal(wrong.status, 2);
    assert.equal(stateOf(wrong, 'stdio-mcp').cause, 'candidate-archive-sha512-mismatch');
  });
});
