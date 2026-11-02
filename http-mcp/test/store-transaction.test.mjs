// transaction(): a BEGIN IMMEDIATE that fails (another connection holds the
// write lock past the busy timeout) must leave the connection able to run
// real transactions afterwards. Two connections to one file stand in for two
// server processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../src/store/database.mjs';

function twoConnections(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-transaction-'));
  const a = openDatabase(join(dir, 'state.db'));
  const b = openDatabase(join(dir, 'state.db'));
  // Fail at once on a held lock instead of waiting the configured 5 s.
  a.exec('PRAGMA busy_timeout = 0');
  b.exec('PRAGMA busy_timeout = 0');
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
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
  assert.throws(() => transaction(b, () => Promise.resolve()), /transaction bodies must be synchronous/);
  assert.equal(b.isTransaction, false);
});

// wallet_nonce_consumptions was added without a schema bump: a state file
// written before it (the same schema without that one table) opens unchanged,
// keeps its schema_version and rows, and gains the empty table.
test('a state file without wallet_nonce_consumptions keeps its schema_version and gains the table', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-store-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.db');
  const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallet_nonce_consumptions'").all().length;
  const version = (db) => db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
  const older = openDatabase(path);
  older.exec('DROP TABLE wallet_nonce_consumptions');
  insert(older, 'TEST-kept');
  const before = version(older);
  assert.equal(tables(older), 0);
  older.close();
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(version(db), before);
  assert.equal(tables(db), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wallet_nonce_consumptions').get().n, 0);
  assert.equal(count(db), 1);
});
