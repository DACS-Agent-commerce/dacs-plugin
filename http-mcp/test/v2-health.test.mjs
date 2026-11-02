import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { opsHealth, formatOpsHealth } from '../src/ops/health.mjs';

test('v2 health has no import of the demo operator', () => {
  assert.doesNotMatch(readFileSync(new URL('../src/ops/health.mjs', import.meta.url), 'utf8'), /import[^\n]*devnet-demo/);
});

test('v2 health does not read seller approval policy or claim a remote seller budget', t => {
  const root = mkdtempSync(join(tmpdir(), 'v2-health-'));
  const path = join(root, 'app', 'dacs-chatgpt.sqlite');
  const db = openDatabase(path);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'evidence', 'seller-approvals.jsonl'), 'TEST malformed retired seller ledger');
  const report = opsHealth({ databasePath: path, operatorState: root, now: 1000 });
  assert.equal(report.format, 'dacs-ops-health/v2');
  assert.equal(report.healthy, true);
  for (const field of ['budget', 'policyMode', 'limitsSource']) assert.equal(Object.hasOwn(report.seller, field), false, field);
  assert.doesNotMatch(formatOpsHealth(report), /seller budget|rolling-hour|policyMode/);
  assert.deepEqual(report.purchases, []);
  assert.deepEqual(report.stuck, []);
});

for (const status of ['publication_handoff', 'broadcast_reported', 'publication_uncertain']) {
  test(`v2 health alerts after the readback threshold for ${status}, without changing state`, t => {
    const root = mkdtempSync(join(tmpdir(), 'v2-legacy-'));
    const path = join(root, 'app.sqlite'), db = openDatabase(path);
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-owner', 'TEST', 'TEST-owner', new Date(0).toISOString());
    const ops = createOperationStore({ db, handoffSecret: 'TEST-only-health-secret-0000000000000', now: () => 0 });
    const make = (key, status) => ops.createIdempotent({ accountId: 'TEST-owner', kind: 'listing_publication', idempotencyKey: key, request: { key }, status, terms: {}, termsHash: 'ab'.repeat(32), state: {}, expiresAt: new Date(1).toISOString() }).operation;
    const legacy = make('TEST-legacy', status);
    make('TEST-terminal', 'publication_mismatch');
    const before = db.prepare('SELECT * FROM operations ORDER BY id').all();
    const report = opsHealth({ databasePath: path, now: 300001, recentHours: 0.00000001, limit: 1 });
    assert.equal(report.format, 'dacs-ops-health/v2');
    assert.equal(report.healthy, false);
    assert.equal(report.legacyPublications.length, 1);
    assert.equal(report.legacyPublications[0].operationId, legacy.id);
    assert.equal(report.legacyPublications[0].status, status);
    assert.match(report.legacyPublications[0].nextExpected, /operator-led original readback.*never resend/i);
    assert.match(formatOpsHealth(report), new RegExp(`legacy publication ${legacy.id}`));
    assert.match(formatOpsHealth(report), /^STUCK/);
    assert.deepEqual(db.prepare('SELECT * FROM operations ORDER BY id').all(), before);
  });
}

test('health CLI error envelope identifies the v2 contract', async () => {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [new URL('../bin/dacs-ops-health.mjs', import.meta.url).pathname, '--json', '--TEST-invalid-option'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stdout).format, 'dacs-ops-health/v2');
});

function publicationFixture(t, status = 'publication_handoff') {
  const root = mkdtempSync(join(tmpdir(), 'publication-health-')), path = join(root, 'app.sqlite'), db = openDatabase(path);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-owner', 'TEST', 'TEST-owner', new Date(0).toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-health-secret-0000000000000', now: () => 0 });
  const { operation } = ops.createIdempotent({ accountId: 'TEST-owner', kind: 'listing_publication', idempotencyKey: 'TEST-publication', request: {}, status, terms: {}, termsHash: 'ab'.repeat(32), state: {}, expiresAt: new Date(1).toISOString() });
  return { path, db, ops, operation };
}
test('fresh active publication is healthy until its readback threshold', t => {
  const { path } = publicationFixture(t);
  assert.equal(opsHealth({ databasePath: path, now: 1 }).healthy, true);
  const report = opsHealth({ databasePath: path, now: 300001 });
  assert.equal(report.healthy, false);
  assert.match(report.legacyPublications[0].nextExpected, /operator-led original readback.*never resend/);
});
for (const status of ['publication_unknown', 'PUBLICATION_UNCERTAIN', 'publication_handoff ']) {
  test(`health refuses corrupted publication status ${JSON.stringify(status)}`, async t => {
    const { path, db, operation } = publicationFixture(t);
    db.prepare('UPDATE operations SET status=? WHERE id=?').run(status, operation.id);
    assert.throws(() => opsHealth({ databasePath: path, now: 1 }), /valid state/);
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath, [new URL('../bin/dacs-ops-health.mjs', import.meta.url).pathname, '--database', path, '--json'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 2);
  });
}
test('health refuses malformed publication IDs even for a terminal row', t => {
  const { path, db, operation } = publicationFixture(t, 'chain_verified');
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare('UPDATE operations SET id=? WHERE id=?').run('damaged-id', operation.id);
  assert.throws(() => opsHealth({ databasePath: path, now: 1 }), /valid state/);
});

function saveHandoff(db, operationId, verifiedAt = null) {
  db.prepare("INSERT INTO write_coordinates (operation_id,kind,network,from_address,nonce_fence,expected_nonce,target,payload,payload_hash,saved_at,verified_at) VALUES (?,'storage-program-create','TEST-network','0xTEST',1,2,'stor-TEST','{}','TEST-hash',?,?)")
    .run(operationId, new Date(0).toISOString(), verifiedAt);
}
test('health keeps cancelled unread handoffs visible as informational history across repeated reports and the CLI', async t => {
  const { path, db, operation } = publicationFixture(t, 'cancelled');
  saveHandoff(db, operation.id);
  const before = {
    operations: db.prepare('SELECT * FROM operations').all(),
    coordinates: db.prepare('SELECT * FROM write_coordinates').all(),
  };
  assert.equal(opsHealth({ databasePath: path, now: 1 }).healthy, true);
  for (const now of [300001, 600000, 30 * 24 * 60 * 60 * 1000]) {
    const report = opsHealth({ databasePath: path, now });
    assert.equal(report.healthy, true);
    assert.deepEqual(report.legacyPublications.map(row => [row.operationId, row.status]), [[operation.id, 'cancelled']]);
    assert.match(report.legacyPublications[0].nextExpected, /operator-led original readback.*never resend/);
    assert.match(formatOpsHealth(report), /^HEALTHY/);
    assert.match(formatOpsHealth(report), new RegExp(`legacy publication ${operation.id}`));
  }
  const { spawnSync } = await import('node:child_process');
  const cli = new URL('../bin/dacs-ops-health.mjs', import.meta.url).pathname;
  const child = spawnSync(process.execPath, [cli, '--database', path, '--json'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.healthy, true);
  assert.deepEqual(report.legacyPublications.map(row => [row.operationId, row.status]), [[operation.id, 'cancelled']]);
  assert.deepEqual({
    operations: db.prepare('SELECT * FROM operations').all(),
    coordinates: db.prepare('SELECT * FROM write_coordinates').all(),
  }, before);
});
test('cancelling an overdue publication restores health without hiding its unread handoff', t => {
  const { path, db, operation } = publicationFixture(t);
  saveHandoff(db, operation.id);
  const now = 3_600_001;
  assert.equal(opsHealth({ databasePath: path, now }).healthy, false);
  db.prepare('UPDATE operations SET status=?, updated_at=? WHERE id=?').run('cancelled', new Date(now).toISOString(), operation.id);
  const report = opsHealth({ databasePath: path, now: now + 1 });
  assert.equal(report.healthy, true);
  assert.deepEqual(report.legacyPublications.map(row => [row.operationId, row.status]), [[operation.id, 'cancelled']]);
});
for (const kind of ['listing_publication', 'purchase']) {
  test(`cancelled publication history does not suppress an overdue ${kind} alert`, async t => {
    const { path, db, ops, operation } = publicationFixture(t, 'cancelled');
    saveHandoff(db, operation.id);
    const status = kind === 'purchase' ? 'payment_uncertain' : 'publication_handoff';
    const pending = ops.createIdempotent({ accountId: 'TEST-owner', kind, idempotencyKey: 'TEST-overdue', request: {}, status, terms: {}, termsHash: 'ab'.repeat(32), state: {}, expiresAt: new Date(1).toISOString() }).operation;
    const report = opsHealth({ databasePath: path, now: 300001 });
    assert.equal(report.healthy, false);
    assert.ok(report.legacyPublications.some(row => row.operationId === operation.id));
    if (kind === 'purchase') assert.equal(report.stuck[0].purchaseId, pending.id);
    else assert.ok(report.legacyPublications.some(row => row.operationId === pending.id));
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath, [new URL('../bin/dacs-ops-health.mjs', import.meta.url).pathname, '--database', path, '--json'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout).healthy, false);
  });
}
test('health clears a cancelled publication once its late write is verified, and ignores one that never had a handoff', t => {
  const verified = publicationFixture(t, 'cancelled');
  saveHandoff(verified.db, verified.operation.id, new Date(0).toISOString());
  assert.equal(opsHealth({ databasePath: verified.path, now: 300001 }).healthy, true);
  assert.equal(opsHealth({ databasePath: publicationFixture(t, 'cancelled').path, now: 300001 }).healthy, true);
});
for (const later of ['broadcast_reported', 'publication_uncertain']) {
  test(`a delayed move to ${later} does not restart an overdue handoff's alert window`, t => {
    const { path, db, operation } = publicationFixture(t);
    saveHandoff(db, operation.id);
    const now = 3_600_001;
    assert.equal(opsHealth({ databasePath: path, now }).healthy, false);
    db.prepare('UPDATE operations SET status=?, updated_at=? WHERE id=?').run(later, new Date(now).toISOString(), operation.id);
    const report = opsHealth({ databasePath: path, now: now + 1 });
    assert.equal(report.healthy, false);
    assert.deepEqual(report.legacyPublications.map(row => [row.operationId, row.status]), [[operation.id, later]]);
  });
}
