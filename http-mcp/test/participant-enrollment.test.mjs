// The operator's participant enrollment file, <dataDir>/participant-enrollment.json, read once per load on real files.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, WireError } from '@kynesyslabs/dacs/wire';
import { loadParticipantEnrollment } from '../src/sdk/participant-enrollment.mjs';
import { startHarness } from './helpers/harness.mjs';

const FILE_NAME = 'participant-enrollment.json';
const FORMAT = 'dacs-participant-enrollment/v1';
const SELLER = `did:demos:agent:${'1'.repeat(64)}`;
const OTHER_SELLER = `did:demos:agent:${'2'.repeat(64)}`;
const PROFILE = Object.freeze({
  id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion,
});

const entry = (claim, patch = {}) => ({
  claim, profile: { ...PROFILE }, modules: { ...TESTNET_PROFILE_TP1.tuple }, evidence: 'operator review of the seller build', revoked: false, ...patch,
});
const enrollment = (entries) => ({ format: FORMAT, entries });

function dataDirectory(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-enrollment-'));
  t.after(() => {
    chmodSync(dataDir, 0o700);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

function writeEnrollment(dataDir, document) {
  writeFileSync(join(dataDir, FILE_NAME), typeof document === 'string' ? document : JSON.stringify(document));
}

const refusedWith = (code, detail) => (error) => {
  assert.ok(error instanceof WireError, `a WireError, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  if (detail !== undefined) assert.equal(error.detail, detail);
  return true;
};

test('a valid file with one entry answers that entry for its claim and nothing for any other claim', async (t) => {
  const dataDir = dataDirectory(t);
  writeEnrollment(dataDir, enrollment([entry(SELLER)]));
  const source = await loadParticipantEnrollment({ dataDir });
  assert.deepEqual(await source.entriesFor(SELLER), [entry(SELLER)]);
  assert.deepEqual(await source.entriesFor(OTHER_SELLER), []);
  assert.deepEqual(await source.entriesFor(SELLER.toUpperCase()), [], 'a claim is matched exactly');
  assert.deepEqual(await source.entriesFor(undefined), []);
  assert.deepEqual(Object.keys(source), ['entriesFor'], 'the source has no write or reload member');
});

test('a missing file gives a source that answers no entries', async (t) => {
  const dataDir = dataDirectory(t);
  const source = await loadParticipantEnrollment({ dataDir });
  assert.deepEqual(await source.entriesFor(SELLER), []);
});

test('an unknown field at the top level, in an entry, in its profile or in its modules refuses the whole file', async (t) => {
  const rows = [
    ['top level', { ...enrollment([entry(SELLER)]), comment: 'x' }],
    ['entry', enrollment([entry(OTHER_SELLER), { ...entry(SELLER), note: 'x' }])],
    ['profile', enrollment([entry(SELLER, { profile: { ...PROFILE, endpoint: 'https://seller.example' } })])],
    ['modules', enrollment([entry(SELLER, { modules: { ...TESTNET_PROFILE_TP1.tuple, 'DACS-6': '0.1' } })])],
  ];
  for (const [where, document] of rows) {
    await t.test(where, async (t) => {
      const dataDir = dataDirectory(t);
      writeEnrollment(dataDir, document);
      await assert.rejects(loadParticipantEnrollment({ dataDir }), refusedWith('tp1_enrollment_invalid'));
    });
  }
});

test('a duplicate claim refuses the whole file', async (t) => {
  const dataDir = dataDirectory(t);
  writeEnrollment(dataDir, enrollment([entry(SELLER), entry(OTHER_SELLER), entry(SELLER, { evidence: 'second review' })]));
  await assert.rejects(loadParticipantEnrollment({ dataDir }), refusedWith('tp1_enrollment_invalid', 'duplicate_claim'));
});

test('an entry with a claim, profile, modules, evidence or revoked of the wrong shape refuses the whole file', async (t) => {
  const modulesWithoutCore = Object.fromEntries(Object.entries(TESTNET_PROFILE_TP1.tuple).filter(([name]) => name !== 'CORE'));
  const rows = [
    ['a claim that is not a Demos agent claim', entry('did:demos:agent:short')],
    ['a claim with an uppercase key', entry(`did:demos:agent:${'A'.repeat(64)}`)],
    ['a profile missing its pin version', entry(SELLER, { profile: { ...PROFILE, pinVersion: undefined } })],
    ['a profile with a short base', entry(SELLER, { profile: { ...PROFILE, base: 'd45c0a2' } })],
    ['modules missing CORE', entry(SELLER, { modules: modulesWithoutCore })],
    ['a module version that is not a string', entry(SELLER, { modules: { ...TESTNET_PROFILE_TP1.tuple, CORE: 0.3 } })],
    ['empty evidence', entry(SELLER, { evidence: '' })],
    ['evidence that is not a string', entry(SELLER, { evidence: { review: 'done' } })],
    ['revoked written as a string', entry(SELLER, { revoked: 'false' })],
    ['an entry that is not an object', [entry(SELLER)]],
  ];
  for (const [shape, wrong] of rows) {
    await t.test(shape, async (t) => {
      const dataDir = dataDirectory(t);
      writeEnrollment(dataDir, enrollment([entry(OTHER_SELLER), wrong]));
      await assert.rejects(loadParticipantEnrollment({ dataDir }), refusedWith('tp1_enrollment_invalid'));
    });
  }
});

test('a malformed, truncated or oversized file refuses with tp1_enrollment_invalid and gives no reader', async (t) => {
  const valid = JSON.stringify(enrollment([entry(SELLER), entry(OTHER_SELLER)]));
  const rows = [
    ['truncated after its first entry', valid.slice(0, valid.indexOf(OTHER_SELLER))],
    ['empty', ''],
    ['not JSON', 'format = v1\n'],
    ['a JSON array', JSON.stringify([entry(SELLER)])],
    ['another format version', JSON.stringify({ format: 'dacs-participant-enrollment/v2', entries: [entry(SELLER)] })],
    ['entries that are not a list', JSON.stringify({ format: FORMAT, entries: entry(SELLER) })],
    ['a member name written twice', `{"format":"${FORMAT}","entries":[],"entries":${JSON.stringify([entry(SELLER)])}}`],
    ['a byte order mark', String.fromCharCode(0xfeff) + valid],
    ['over one mebibyte', JSON.stringify(enrollment([entry(SELLER, { evidence: 'x'.repeat(1024 * 1024) })]))],
  ];
  for (const [state, text] of rows) {
    await t.test(state, async (t) => {
      const dataDir = dataDirectory(t);
      writeEnrollment(dataDir, text);
      await assert.rejects(loadParticipantEnrollment({ dataDir }), refusedWith('tp1_enrollment_invalid'));
    });
  }
});

test('a file with more entries than the limit refuses with tp1_enrollment_invalid', async (t) => {
  const dataDir = dataDirectory(t);
  const entries = Array.from({ length: 1025 }, (_, index) => entry(`did:demos:agent:${index.toString(16).padStart(64, '0')}`));
  writeEnrollment(dataDir, enrollment(entries));
  await assert.rejects(loadParticipantEnrollment({ dataDir }), refusedWith('tp1_enrollment_invalid', 'too_many_entries'));
});

test('an unreadable file, a symlink or a directory at the file path refuses with tp1_enrollment_unreadable and keeps the cause', async (t) => {
  const rows = [
    ['a file with mode 000', 'EACCES', (dataDir) => { writeEnrollment(dataDir, enrollment([entry(SELLER)])); chmodSync(join(dataDir, FILE_NAME), 0o000); }],
    ['a symlink to a valid file', 'ELOOP', (dataDir) => {
      writeFileSync(join(dataDir, 'elsewhere.json'), JSON.stringify(enrollment([entry(SELLER)])));
      symlinkSync(join(dataDir, 'elsewhere.json'), join(dataDir, FILE_NAME));
    }],
    ['a directory', 'not_a_regular_file', (dataDir) => mkdirSync(join(dataDir, FILE_NAME))],
    ['a data directory that is a file', 'ENOTDIR', (dataDir) => writeFileSync(join(dataDir, 'state'), '')],
  ];
  for (const [state, cause, build] of rows) {
    await t.test(state, async (t) => {
      const root = dataDirectory(t);
      build(root);
      const dataDir = cause === 'ENOTDIR' ? join(root, 'state') : root;
      await assert.rejects(loadParticipantEnrollment({ dataDir }), (error) => {
        refusedWith('tp1_enrollment_unreadable')(error);
        assert.equal(error.cause?.code ?? error.detail, cause);
        return true;
      });
    });
  }
});

test('editing or removing the file while running changes nothing until the next load', async (t) => {
  const dataDir = dataDirectory(t);
  writeEnrollment(dataDir, enrollment([entry(SELLER)]));
  const running = await loadParticipantEnrollment({ dataDir });
  writeEnrollment(dataDir, enrollment([entry(OTHER_SELLER)]));
  assert.deepEqual(await running.entriesFor(SELLER), [entry(SELLER)]);
  assert.deepEqual(await running.entriesFor(OTHER_SELLER), []);
  writeEnrollment(dataDir, '{"format":');
  assert.deepEqual(await running.entriesFor(SELLER), [entry(SELLER)], 'a malformed edit does not reach the running source');
  rmSync(join(dataDir, FILE_NAME));
  assert.deepEqual(await running.entriesFor(SELLER), [entry(SELLER)]);
  writeEnrollment(dataDir, enrollment([entry(OTHER_SELLER)]));
  const restarted = await loadParticipantEnrollment({ dataDir });
  assert.deepEqual(await restarted.entriesFor(SELLER), []);
  assert.deepEqual(await restarted.entriesFor(OTHER_SELLER), [entry(OTHER_SELLER)]);
});

test('an answered entry cannot be changed through the answer', async (t) => {
  const dataDir = dataDirectory(t);
  writeEnrollment(dataDir, enrollment([entry(SELLER)]));
  const source = await loadParticipantEnrollment({ dataDir });
  const [answered] = await source.entriesFor(SELLER);
  assert.throws(() => { answered.revoked = true; }, TypeError);
  assert.throws(() => { answered.profile.pinVersion = 'other'; }, TypeError);
  (await source.entriesFor(SELLER)).push(entry(OTHER_SELLER));
  assert.deepEqual(await source.entriesFor(SELLER), [entry(SELLER)]);
});

test('a revoked entry is answered with revoked true, and removing it takes effect at the next load', async (t) => {
  const dataDir = dataDirectory(t);
  writeEnrollment(dataDir, enrollment([entry(SELLER, { revoked: true }), entry(OTHER_SELLER)]));
  const source = await loadParticipantEnrollment({ dataDir });
  assert.deepEqual(await source.entriesFor(SELLER), [entry(SELLER, { revoked: true })]);
  writeEnrollment(dataDir, enrollment([entry(SELLER, { revoked: true })]));
  assert.deepEqual(await (await loadParticipantEnrollment({ dataDir })).entriesFor(OTHER_SELLER), []);
});

// Sends `path` exactly as written, so the client does not resolve its dot segments first, on its own connection:
// the server may close a connection after a refused request without reading its body.
function rawRequest(origin, method, path) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, method, path, agent: false, headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', (error) => reject(new Error(`${method} ${path}: ${error.message}`, { cause: error })));
    request.end(method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(enrollment([entry(OTHER_SELLER)])));
  });
}

test('no request route reads, writes or serves the enrollment file, by name or by a path outside the asset folders', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const marker = 'enrollment-marker-evidence';
  const filePath = join(harness.dataDir, FILE_NAME);
  writeEnrollment(harness.dataDir, enrollment([entry(SELLER, { evidence: marker })]));
  const before = { bytes: readFileSync(filePath), mtimeMs: statSync(filePath).mtimeMs };
  const assetsDir = fileURLToPath(new URL('../public/portal/', import.meta.url));
  const traversal = relative(assetsDir, filePath).split('/').join('%2f');
  const paths = [`/${FILE_NAME}`, `/portal/${FILE_NAME}`, `/portal/assets/${FILE_NAME}`, `/portal/assets/${traversal}`,
    `/portal/assets/${relative(assetsDir, filePath)}`, `/.data/${FILE_NAME}`, `/oauth/${FILE_NAME}`, `/mcp/${FILE_NAME}`];
  for (const path of paths) {
    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
      const { status, body } = await rawRequest(harness.origin, method, path);
      assert.ok(status >= 400, `${method} ${path} answers an error, got ${status}`);
      assert.ok(!body.includes(marker), `${method} ${path} does not serve the file`);
    }
  }
  assert.deepEqual(readFileSync(filePath), before.bytes, 'no request changed the file');
  assert.equal(statSync(filePath).mtimeMs, before.mtimeMs);
});
