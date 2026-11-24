// The browser's copy of the SDK's approved TP-1 identity record
// (public/portal/tp1-identity-record.mjs) and the startup check that refuses a
// copy whose canonical bytes or digest differ from the SDK's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_APPROVED_IDENTITY_RECORD_DIGESTS } from '@kynesyslabs/dacs/wire';
import * as recordModule from '../public/portal/tp1-identity-record.mjs';
import { TP1_IDENTITY_RECORD, TP1_IDENTITY_RECORD_DIGEST } from '../public/portal/tp1-identity-record.mjs';
import { Tp1RecordCopyDrift, assertTp1RecordCopy } from '../src/tp1-record-copy.mjs';
import { startHarness } from './helpers/harness.mjs';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const RECORD_FILE = 'public/portal/tp1-identity-record.mjs';
const DATABASE_FILE = 'dacs-chatgpt.sqlite';
const BIN_TIMEOUT_MS = 60_000;

function scratchDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const isDeepFrozen = (value) => Object.isFrozen(value) && Object.values(value).every((member) => typeof member !== 'object' || isDeepFrozen(member));

test('the browser record copy is JCS-equal to the SDK\'s approved record and its digest is the approved digest', async () => {
  assert.equal(canonicalize(TP1_IDENTITY_RECORD), canonicalize(TP1_APPROVED_IDENTITY_RECORD));
  assert.equal(TP1_IDENTITY_RECORD_DIGEST, sha256Hex(canonicalize(TP1_IDENTITY_RECORD)));
  assert.ok(TP1_APPROVED_IDENTITY_RECORD_DIGESTS.includes(TP1_IDENTITY_RECORD_DIGEST));
  assert.deepEqual(Object.keys(recordModule).sort(), ['TP1_IDENTITY_RECORD', 'TP1_IDENTITY_RECORD_DIGEST']);
  assert.ok(isDeepFrozen(TP1_IDENTITY_RECORD));
  assert.equal(assertTp1RecordCopy(), undefined);

  // The browser loads the file on its own: a data: URL module can resolve no import.
  const standalone = await import(`data:text/javascript,${encodeURIComponent(readFileSync(join(PACKAGE_DIR, RECORD_FILE), 'utf8'))}`);
  assert.equal(canonicalize(standalone.TP1_IDENTITY_RECORD), canonicalize(TP1_APPROVED_IDENTITY_RECORD));
  assert.equal(standalone.TP1_IDENTITY_RECORD_DIGEST, TP1_IDENTITY_RECORD_DIGEST);

  // A self-consistent record the SDK does not approve: its own digest matches it, and it is still refused.
  const unapproved = { ...TP1_IDENTITY_RECORD, recordId: 'dacs-demos-testnet-identity/2026-10-15' };
  assert.throws(() => assertTp1RecordCopy(unapproved, sha256Hex(canonicalize(unapproved))), (error) => error instanceof Tp1RecordCopyDrift
    && error.code === 'tp1_record_copy_drift' && error.message.includes('not approved') && !error.message.includes('dacs-demos-testnet-identity'));
});

test('the server serves the browser record copy at /portal/assets/tp1-identity-record.mjs as JavaScript', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const response = await fetch(`${h.origin}/portal/assets/tp1-identity-record.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(await response.text(), readFileSync(join(PACKAGE_DIR, RECORD_FILE), 'utf8'));
});

/** One-byte (or one-member) edits of the copy, each as an object for the in-process check and as a source edit for the bin. */
const replaceOnce = (source, from, to) => {
  assert.equal(source.split(from).length, 2, `${from} occurs once in ${RECORD_FILE}`);
  return source.replace(from, to);
};
const flipHex = (hex) => `${hex[0] === 'f' ? '0' : 'f'}${hex.slice(1)}`;
const DRIFTS = [
  { name: 'one hex digit of chainIdentity',
    copy: () => ({ ...TP1_IDENTITY_RECORD, chainIdentity: flipHex(TP1_IDENTITY_RECORD.chainIdentity) }), digest: TP1_IDENTITY_RECORD_DIGEST,
    edit: (source) => replaceOnce(source, TP1_IDENTITY_RECORD.chainIdentity, flipHex(TP1_IDENTITY_RECORD.chainIdentity)), reason: 'differs from the SDK' },
  { name: 'one character of provenance.documentation',
    copy: () => ({ ...TP1_IDENTITY_RECORD, provenance: { ...TP1_IDENTITY_RECORD.provenance, documentation: `${TP1_IDENTITY_RECORD.provenance.documentation.slice(0, -1)}!` } }),
    digest: TP1_IDENTITY_RECORD_DIGEST, edit: (source) => replaceOnce(source, '2026-10-21`.', '2026-10-21`!'), reason: 'differs from the SDK' },
  { name: 'an added member',
    copy: () => ({ ...TP1_IDENTITY_RECORD, network2: 'demos-testnet' }), digest: TP1_IDENTITY_RECORD_DIGEST,
    edit: (source) => replaceOnce(source, "  network: 'demos-testnet',\n", "  network: 'demos-testnet',\n  network2: 'demos-testnet',\n"), reason: 'differs from the SDK' },
  { name: 'one hex digit of the digest constant',
    copy: () => TP1_IDENTITY_RECORD, digest: flipHex(TP1_IDENTITY_RECORD_DIGEST),
    edit: (source) => replaceOnce(source, TP1_IDENTITY_RECORD_DIGEST, flipHex(TP1_IDENTITY_RECORD_DIGEST)), reason: 'is not the SHA-256' },
];

/** Copies the package's shipped files to a scratch directory, with `edit` applied to the record copy's source. */
function packageTree(t, edit) {
  const tree = scratchDir(t, 'tp1-record-tree-');
  const { files } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
  for (const entry of [...files, 'package.json'].filter((name) => existsSync(join(PACKAGE_DIR, name)))) {
    cpSync(join(PACKAGE_DIR, entry), join(tree, entry), { recursive: true });
  }
  symlinkSync(realpathSync(join(PACKAGE_DIR, 'node_modules')), join(tree, 'node_modules'), 'dir');
  writeFileSync(join(tree, RECORD_FILE), edit(readFileSync(join(PACKAGE_DIR, RECORD_FILE), 'utf8')));
  return tree;
}

function isolatedDataDir(t) {
  const dataDir = join(scratchDir(t, 'tp1-record-data-'), 'data');
  mkdirSync(dataDir);
  return dataDir;
}

// A bin run sees only PATH and these settings, with every switch off.
const binEnv = (dataDir) => ({ PATH: process.env.PATH, DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64),
  DACS_DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0' });
const binPath = (tree) => join(tree, 'bin', 'dacs-chatgpt-plugin.mjs');

/** Runs the tree's server bin to its exit with every switch off. */
function runBin(t, tree) {
  const dataDir = isolatedDataDir(t);
  const run = spawnSync(process.execPath, [binPath(tree)], { env: binEnv(dataDir), encoding: 'utf8', timeout: BIN_TIMEOUT_MS });
  return { status: run.status, signal: run.signal, stderr: run.stderr, dataFiles: readdirSync(dataDir) };
}

// Builds the switch-on composition directly, past the bin's held loadConfig(on), and prints the refusal's code.
const CONSTRUCTION_SCRIPT = `
import { join } from 'node:path';
import { loadConfig } from './src/config.mjs';
import { createApp } from './src/app.mjs';
import { createLogger } from './src/util/log.mjs';
const dataDir = process.argv[2];
const off = loadConfig({ DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir,
  DACS_CHAIN_RPC_URL: 'https://node.chain.invalid' });
const config = { ...off, sdkPurchases: 'on', tp1TransportAuthority: 'tp1-node', databasePath: join(dataDir, '${DATABASE_FILE}') };
const fetchImpl = async () => { throw new TypeError('fetch failed: no network in this run'); };
try {
  const { close } = await createApp({ config, fetchImpl, logger: createLogger({ level: 'error', sink: () => {} }) });
  await close();
  process.stdout.write(JSON.stringify({ started: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ name: error.name, code: error.code ?? null }));
}
`;

test('a one-byte change in the browser copy makes the server refuse to start with tp1_record_copy_drift', async (t) => {
  for (const drift of DRIFTS) {
    await t.test(`in process: ${drift.name}`, () => {
      assert.throws(() => assertTp1RecordCopy(drift.copy(), drift.digest), (error) => error instanceof Tp1RecordCopyDrift
        && error.code === 'tp1_record_copy_drift' && error.message.includes(drift.reason) && !error.message.includes(TP1_IDENTITY_RECORD.chainIdentity));
    });
    await t.test(`server bin, purchases off: ${drift.name}`, (t) => {
      const run = runBin(t, packageTree(t, drift.edit));
      assert.notEqual(run.status, 0, run.stderr);
      assert.equal(run.signal, null);
      assert.match(run.stderr, /tp1_record_copy_drift/);
      assert.doesNotMatch(run.stderr, /"event":"listening"/);
      assert.deepEqual(run.dataFiles, [], 'no database file is created');
    });
  }

  await t.test('direct switch-on construction from a drifted tree refuses before opening the database', (t) => {
    const tree = packageTree(t, DRIFTS[0].edit);
    writeFileSync(join(tree, 'construct-on.mjs'), CONSTRUCTION_SCRIPT);
    const dataDir = isolatedDataDir(t);
    const run = spawnSync(process.execPath, [join(tree, 'construct-on.mjs'), dataDir], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: BIN_TIMEOUT_MS });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { name: 'Tp1RecordCopyDrift', code: 'tp1_record_copy_drift' });
    assert.deepEqual(readdirSync(dataDir), [], 'no database file is created');
  });

  await t.test('a comment-only change is not drift: the bin listens, opens its database and stops cleanly', async (t) => {
    const tree = packageTree(t, (source) => `// a comment the canonical bytes do not see\n${source}\n\n`);
    const dataDir = isolatedDataDir(t);
    const child = spawn(process.execPath, [binPath(tree)], { env: binEnv(dataDir), stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    });
    let listening = false;
    for await (const line of createInterface({ input: child.stderr })) {
      if (line.includes('"event":"listening"')) {
        listening = true;
        break;
      }
    }
    assert.ok(listening, 'the bin logs that it is listening');
    assert.ok(readdirSync(dataDir).includes(DATABASE_FILE), 'the isolated database is opened');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], 'SIGTERM stops the bin cleanly');
  });
});
