// transaction(): a BEGIN IMMEDIATE that fails (another connection holds the
// write lock past the busy timeout) must leave the connection able to run
// real transactions afterwards. Two connections to one file stand in for two
// server processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../src/store/database.mjs';

function twoConnections(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-transaction-'));
  const a = openDatabase(join(dir, 'state.db'));
  const b = openDatabase(join(dir, 'state.db'));
  // Fail at once on a held lock instead of waiting the configured 5 s.
  a.exec('PRAGMA busy_timeout = 0');
  b.exec('PRAGMA busy_timeout = 0');
  t.after(() => { for (const db of [a, b]) if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { a, b };
}

const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM secrets WHERE name LIKE 'TEST-%'").get().n;
const insert = (db, name) => db.prepare('INSERT INTO secrets (name, value, created_at) VALUES (?, ?, ?)').run(name, 'TEST', new Date(0).toISOString());

test('a failed BEGIN IMMEDIATE leaves later transactions real: they roll back and exclude other writers', (t) => {
  const { a, b } = twoConnections(t);
  a.exec('BEGIN IMMEDIATE');
  assert.throws(() => transaction(b, () => insert(b, 'TEST-never')), /database is locked/);
  a.exec('ROLLBACK');

  // A throwing transaction after the failed BEGIN rolls its write back.
  assert.throws(() => transaction(b, () => { insert(b, 'TEST-rolled-back'); throw new Error('TEST rollback'); }), /TEST rollback/);
  assert.equal(count(a), 0);
  assert.equal(b.isTransaction, false);

  // A later transaction holds the write lock: the other connection cannot
  // write between its read and its write, and nested calls join it.
  transaction(b, () => {
    assert.equal(b.isTransaction, true);
    assert.throws(() => insert(a, 'TEST-other'), /database is locked/);
    transaction(b, () => insert(b, 'TEST-nested'));
    insert(b, 'TEST-outer');
  });
  assert.equal(count(a), 2);
  assert.equal(b.isTransaction, false);
});

test('a transaction that throws after BEGIN rolls back and the next one starts fresh', (t) => {
  const { a, b } = twoConnections(t);
  assert.throws(() => transaction(b, () => { insert(b, 'TEST-first'); throw new Error('TEST first'); }), /TEST first/);
  assert.equal(count(a), 0);
  transaction(b, () => insert(b, 'TEST-second'));
  assert.equal(count(a), 1);
  // A deferred result retires the connection (it is closed); the other connection can write again.
  assert.throws(() => transaction(b, () => Promise.resolve()), (error) => error.code === 'purchase_store_async_result');
  assert.equal(b.isOpen, false);
  transaction(a, () => insert(a, 'TEST-after-retired'));
  assert.equal(count(a), 2);
});

// A state file is never repaired on open: a missing table is a refusal, and the table stays missing.
test('a state file without wallet_nonce_consumptions is refused and not repaired', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.db');
  const older = openDatabase(path);
  older.exec('DROP TABLE wallet_nonce_consumptions');
  insert(older, 'TEST-kept');
  older.close();
  assert.throws(() => openDatabase(path), (error) => error.code === 'purchase_state_schema_mismatch');
  const inspected = new DatabaseSync(path, { readOnly: true });
  t.after(() => inspected.close());
  assert.equal(inspected.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'wallet_nonce_consumptions'").get().n, 0);
  assert.equal(count(inspected), 1);
});
