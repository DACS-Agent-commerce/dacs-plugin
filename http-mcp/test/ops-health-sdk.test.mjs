import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize } from '@kynesyslabs/dacs';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import * as store from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { formatOpsHealth, opsHealth } from '../src/ops/health.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { ACTIVE, INACTIVE, exitWith, health, sha, stateWith, withTransfer } from './helpers/health-signature-world.mjs';

const UNREADABLE = /could not read valid state/;
const at = Date.parse('2026-11-01T12:00:00Z');
const isoAt = (ms) => new Date(ms).toISOString();

function databaseFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-health-sdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'app.sqlite');
}

test('ops health reads a client-created purchase database read-only and reports its stages', (t) => {
  const path = databaseFile(t), db = store.openDatabase(path);
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', isoAt(at));
  const ops = createOperationStore({ db, handoffSecret: 'TEST-health-only'.repeat(4), now: () => at });
  const terms = { buyer: { accountId: 'TEST-buyer', wallet: `0x${'1'.repeat(64)}` }, seller: { payee: `0x${'2'.repeat(64)}` }, protocol: { jobId: 'TEST-job' } };
  const { operation } = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'agreement_pending',
    terms, termsHash: sha(canonicalize(terms)), expiresAt: isoAt(at + 3_600_000), state: { protocol: { stage: 'identity', attempts: [] } } });
  ops.transition(operation.id, 'agreement_pending', 'agreement_pending', { state: { protocol: { stage: 'agreement-signing', attempts: [] } }, event: 'protocol_step', data: { stage: 'agreement-signing' } });
  db.close();
  const before = readFileSync(path);
  const report = opsHealth({ databasePath: path, now: at + 60_000 });
  assert.deepEqual(readFileSync(path), before, 'the database is read, never written');
  assert.equal(report.purchases.length, 1);
  assert.equal(report.purchases[0].purchaseId, operation.id);
  assert.equal(report.purchases[0].stage, 'agreement-signing');
  assert.deepEqual(report.purchases[0].timeline.map(({ lane, stage }) => `${lane}:${stage}`), ['purchase:agreement_pending', 'protocol:identity', 'protocol:agreement-signing']);
});

test('ops health refuses a durable wallet journal whose format or version differs from the client\'s', (t) => {
  const s = stateWith(t, createEphemeralWallet(), []);
  rmSync(s.journalPath);
  openDurableWalletJournal({ path: s.journalPath, mode: 'create' }).close();
  assert.deepEqual(health(s).seller, { journals: ['node2-transport.sqlite'], unconfirmed: [] }, 'a journal the client created is read');
  for (const [key, value] of [['format', 'TEST-other-journal/v1'], ['version', '999']]) {
    const journal = new DatabaseSync(s.journalPath), original = journal.prepare('SELECT value FROM meta WHERE key=?').get(key).value;
    journal.prepare('UPDATE meta SET value=? WHERE key=?').run(value, key); journal.close();
    assert.throws(() => health(s), UNREADABLE, key);
    const restore = new DatabaseSync(s.journalPath); restore.prepare('UPDATE meta SET value=? WHERE key=?').run(original, key); restore.close();
  }
});

test('a database created fresh through the store passes the health purchase read: health takes the schema version from the store\'s shared export, not a literal', (t) => {
  assert.ok(Number.isSafeInteger(store.SCHEMA_VERSION), 'the store exports its schema version');
  const path = databaseFile(t);
  store.openDatabase(path).close();
  assert.deepEqual(opsHealth({ databasePath: path }).purchases, []);
  const setVersion = (value) => { const db = new DatabaseSync(path); db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(value); db.close(); };
  for (const other of [String(store.SCHEMA_VERSION - 1), String(store.SCHEMA_VERSION + 1), `${store.SCHEMA_VERSION}.0`]) {
    setVersion(other);
    assert.throws(() => opsHealth({ databasePath: path }), UNREADABLE, other);
  }
  setVersion(String(store.SCHEMA_VERSION));
  assert.deepEqual(opsHealth({ databasePath: path }).purchases, []);
});

const MISSING_MEMBER = { chainId: 7, forks: {} }, NON_BOOLEAN = { chainId: 7, forks: { signatureDomain: { activated: 'true' } } };
const expectValid = (report, label) => {
  assert.equal(report.healthy, true, label);
  assert.deepEqual(report.signatureAuthorityUnavailable, [], label);
  assert.deepEqual(report.signatureFormMismatch, [], label);
};
const expectUnavailable = (report, label) => {
  assert.equal(report.signatureAuthorityUnavailable.length, 2, label);
  assert.deepEqual(report.signatureFormMismatch, [], label);
  assert.equal(report.healthy, false, label);
};

test('ops health verifies a retained failed native transfer with the node-derived verifier for each transaction-signature form (active, inactive, missing member, non-boolean, downgrade after active, unreadable), reports unavailable signature authority apart from a malformed record, and runs through the real health module and bin with no resolve hook', async (t) => {
  const domain = withTransfer(t, ACTIVE), bare = withTransfer(t, INACTIVE);
  expectValid(health(domain, ACTIVE), 'active: the domain form');
  expectValid(health(bare, INACTIVE), 'inactive: the bare hash');
  expectValid(health(bare, MISSING_MEMBER), 'missing member: the bare hash');
  expectUnavailable(health(domain, NON_BOOLEAN), 'non-boolean');
  expectUnavailable(health(domain, null), 'unreadable');
  // Each run starts with an empty record of activated chains, so a later answer
  // with the member missing selects the bare hash: a domain-form record is then a
  // mismatch, listed and never accepted.
  expectValid(health(domain, ACTIVE), 'downgrade: first the active answer');
  const downgraded = health(domain, MISSING_MEMBER);
  assert.deepEqual(downgraded.signatureFormMismatch, [{ hash: domain.record.hash, purchaseIds: ['pur_AAAAAAAAAAAAAAAA'] }]);
  assert.equal(downgraded.healthy, false);
  const malformed = withTransfer(t, ACTIVE, (r) => { r.failure.nonceFence += 1; return r; });
  assert.throws(() => health(malformed, null), UNREADABLE, 'a malformed record is corrupt even when the authority is unavailable');
  const bin = 'bin/dacs-ops-health.mjs';
  for (const [s, answer, status] of [[domain, ACTIVE, 0], [bare, INACTIVE, 0], [bare, MISSING_MEMBER, 0], [domain, NON_BOOLEAN, 3], [domain, 'down', 3], [domain, MISSING_MEMBER, 3], [malformed, 'down', 2]]) {
    const out = await exitWith(s, answer, bin);
    assert.equal(out.status, status, `${JSON.stringify(answer)}: ${out.stderr}${out.stdout}`);
  }
});

// Appends the purchase's CREATE delivery and the given retirement event bodies (raw text) to the app database.
function withRetirement(t, bodies) {
  const s = stateWith(t, createEphemeralWallet(), []), db = new DatabaseSync(s.databasePath);
  db.prepare(`INSERT INTO agreement_create_deliveries (delivery_id, operation_id, account_id, wallet, terms_hash, kind, request_bytes, request_hash, state, created_at)
    VALUES ('TEST-delivery', 'pur_AAAAAAAAAAAAAAAA', 'TEST-buyer', ?, ?, 'TEST-kind', ?, ?, 'claimed', ?)`).run(`0x${'1'.repeat(64)}`, 'a'.repeat(64), Buffer.from('{}'), 'b'.repeat(64), isoAt(at));
  bodies.forEach((body, index) => db.prepare("INSERT INTO agreement_create_events VALUES ('TEST-delivery', ?, 'retirement', ?, ?)").run(index + 1, body, isoAt(at)));
  db.close();
  return s;
}
const PENDING = { state: 'pending', hash: 'c'.repeat(64), lane: JSON.stringify(['demos-devnet', 'd'.repeat(64), `0x${'1'.repeat(64)}`]), nonce: 4, historyDigest: 'e'.repeat(64) };
const RETIRED = { state: 'retired', hash: 'c'.repeat(64), proofs: { lane: 'no browser stage', absence: 'TEST-absence', nonce: 5 } };

test('ops health and diagnostics report a retired CREATE, a pending retirement and a malformed retirement record as three different states', (t) => {
  const stateOf = (bodies) => {
    const report = health(withRetirement(t, bodies));
    return { value: report.purchases[0].createRetirement, line: formatOpsHealth(report).split('\n').find((line) => line.startsWith('purchase ')) };
  };
  assert.equal(health(stateWith(t, createEphemeralWallet(), [])).purchases[0].createRetirement, 'none');
  const cases = {
    'pending-retirement': [[canonicalize(PENDING)], [canonicalize({ ...PENDING, hash: null })]],
    retired: [[canonicalize(PENDING), canonicalize(RETIRED)], [canonicalize({ ...RETIRED, hash: null, proofs: { ...RETIRED.proofs, absence: null } })]],
    malformed: [['not json'], [canonicalize({ state: 'retired' })], [canonicalize({ ...PENDING, extra: 1 })], [canonicalize({ ...PENDING, state: 'released' })],
      [canonicalize({ ...PENDING, nonce: -1 })], [canonicalize({ ...RETIRED, proofs: { lane: 'x' } })], [canonicalize(RETIRED), canonicalize({ ...PENDING, historyDigest: 'short' })]],
  };
  for (const [expected, rows] of Object.entries(cases)) {
    for (const bodies of rows) {
      const shown = stateOf(bodies);
      assert.equal(shown.value, expected, bodies.join(' | '));
      assert.match(shown.line, new RegExp(` create-retirement=${expected}$`), bodies.join(' | '));
    }
  }
});
