// The app database is the client's transactional PurchaseStore: one transaction owner, created from and
// checked against the client's schema. Restart and concurrency cases run real child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PURCHASE_STATE_SCHEMA, createCoordinateStore } from '@kynesyslabs/dacs-client';
import { openDatabase, transaction, isUniqueViolation } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createAccountService } from '../src/accounts.mjs';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'purchase-store-worker.mjs');
const NOW = Date.UTC(2026, 0, 1);
const HANDOFF_SECRET = 'h'.repeat(40);
const COORDINATES = { kind: 'purchase', network: 'testnet', from: 'wallet-buyer', nonceFence: 1, expectedNonce: 2, target: 'wallet-seller', amountOs: '5', payload: { transfer: 1 } };
const WORKER_ROUNDS = 40;

function tempPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-purchase-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.db');
}

// An app database with the services that write to it, closed when the test ends.
function open(t, path = tempPath(t)) {
  const db = openDatabase(path);
  t.after(() => { if (db.isOpen) db.close(); });
  const accounts = createAccountService({ db, builtinIssuer: 'builtin', now: () => NOW });
  const ops = createOperationStore({ db, handoffSecret: HANDOFF_SECRET, now: () => NOW });
  const coordinates = createCoordinateStore({ db, now: () => NOW });
  const accountId = accounts.resolveFromToken({ issuer: 'external', subject: 'buyer' }).id;
  const createPurchase = (idempotencyKey, request = { key: idempotencyKey }) => ops.createIdempotent({
    accountId, kind: 'purchase', idempotencyKey, request, status: 'awaiting_approval', terms: { listing: 'l' }, termsHash: 'terms-hash',
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
  });
  return { path, db, accounts, ops, coordinates, accountId, createPurchase };
}

function observer(t, path) {
  const connection = new DatabaseSync(path, { readOnly: true });
  t.after(() => connection.close());
  return (sql) => connection.prepare(sql).get();
}

const sha256 = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
const fileState = (path) => [path, `${path}-wal`, `${path}-journal`].map(sha256);
const pragmaValue = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
const schemaObjects = (path) => {
  const connection = new DatabaseSync(path, { readOnly: true });
  try { return connection.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n; } finally { connection.close(); }
};

function startWorker(mode, path, argument) {
  const args = ['--disable-warning=ExperimentalWarning', WORKER, mode, path, ...(argument === undefined ? [] : [String(argument)])];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = [];
  const waiting = [];
  let pending = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      (waiting.shift() ?? ((value) => ready.push(value)))(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr })));
  const nextLine = () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve) => waiting.push(resolve)));
  const line = () => Promise.race([nextLine(), exited.then((result) => { throw new Error(`worker ${mode} exited early: ${result.stderr}`); })]);
  return { child, line, exited, release: () => child.stdin.end() };
}

async function runWorker(mode, path, argument) {
  const worker = startWorker(mode, path, argument);
  worker.release();
  return worker.exited;
}

// A valid file converted to the given journal mode and then altered, leaving a -wal with frames when WAL.
function alteredFile(t, journalMode, statements) {
  const path = tempPath(t);
  openDatabase(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA journal_mode = ${journalMode === 'wal' ? 'WAL' : 'DELETE'}`);
  for (const statement of statements) raw.exec(statement);
  if (journalMode === 'wal') t.after(() => raw.close());
  else raw.close();
  return path;
}

test('client purchase prepare commits the operation, its event and its coordinates in one app-database transaction', (t) => {
  const { path, db, ops, coordinates, createPurchase } = open(t);
  const count = observer(t, path);
  const rows = () => ['operations', 'operation_events', 'write_coordinates'].map((table) => count(`SELECT COUNT(*) AS n FROM ${table}`).n);
  let midway;
  const { operation } = transaction(db, () => {
    const created = createPurchase('prepare-key');
    coordinates.save({ operationId: created.operation.id, ...COORDINATES });
    midway = rows();
    return created;
  });
  assert.deepEqual(midway, [0, 0, 0]);
  assert.deepEqual(rows(), [1, 1, 1]);
  assert.deepEqual(ops.history(operation.id).map((event) => event.type), ['created']);
});

test('a throw after ops.transition inside the client transaction leaves the operation and its events unchanged', (t) => {
  const { db, ops, accountId, createPurchase } = open(t);
  const { operation } = createPurchase('transition-key');
  assert.throws(() => transaction(db, () => {
    ops.transition(operation.id, 'awaiting_approval', 'cancelled');
    throw new Error('TEST after transition');
  }), /TEST after transition/);
  assert.equal(ops.get(accountId, operation.id).status, 'awaiting_approval');
  assert.deepEqual(ops.history(operation.id).map((event) => event.type), ['created']);
});

test('a plugin transaction called inside the client transaction joins it as a savepoint and rolls back with it', (t) => {
  const { db, ops, accountId, createPurchase } = open(t);
  assert.throws(() => transaction(db, () => {
    createPurchase('outer-only');
    throw new Error('TEST outer');
  }), /TEST outer/);
  assert.equal(ops.findByKey(accountId, 'purchase', 'outer-only'), null);

  transaction(db, () => {
    createPurchase('kept');
    assert.throws(() => transaction(db, () => {
      createPurchase('dropped');
      throw new Error('TEST inner');
    }), /TEST inner/);
  });
  assert.notEqual(ops.findByKey(accountId, 'purchase', 'kept'), null);
  assert.equal(ops.findByKey(accountId, 'purchase', 'dropped'), null);
});

test('an async or generator transaction callback is refused purchase_store_async_callback before it runs, with zero writes, and the connection stays usable', (t) => {
  const { db, ops, accountId, createPurchase } = open(t);
  let ran = false;
  const callbacks = [async () => { ran = true; createPurchase('async-key'); }, function* generator() { ran = true; }, async function* asyncGenerator() { ran = true; }];
  for (const callback of callbacks) {
    assert.throws(() => transaction(db, callback), (error) => error.code === 'purchase_store_async_callback');
  }
  assert.equal(ran, false);
  assert.equal(db.isTransaction, false);
  assert.equal(ops.list(accountId).length, 0);
  assert.equal(transaction(db, () => createPurchase('after-refusal').created), true);
});

test('a synchronous callback that writes and then returns a Promise or thenable rolls back, retires the connection, and no late continuation writes through retained statements', async (t) => {
  const deferredResults = {
    promise: (lateWrite) => Promise.resolve().then(lateWrite),
    thenable: (lateWrite) => ({ then: (resolve) => { lateWrite(); resolve(); } }),
  };
  for (const [kind, defer] of Object.entries(deferredResults)) {
    const { path, db } = open(t);
    const count = observer(t, path);
    const insert = db.prepare('INSERT INTO secrets (name, value, created_at) VALUES (?, ?, ?)');
    const lateErrors = [];
    const lateWrite = () => { try { insert.run(`late-${kind}`, 'v', 'now'); } catch (error) { lateErrors.push(error); } };
    assert.throws(() => transaction(db, () => {
      insert.run(`sync-${kind}`, 'v', 'now');
      return defer(lateWrite);
    }), (error) => error.code === 'purchase_store_async_result');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count('SELECT COUNT(*) AS n FROM secrets').n, 0, kind);
    assert.throws(() => transaction(db, () => 1), (error) => error.code === 'purchase_store_retired_handle', kind);
    if (kind === 'promise') assert.equal(lateErrors.length, 1);
  }
});

test('two app handles on one database file serialize purchase writes with no lost update', async (t) => {
  const { path, db } = open(t);
  transaction(db, () => db.prepare("INSERT INTO meta (key, value) VALUES ('counter', '0')").run());
  const workers = [startWorker('counter', path, WORKER_ROUNDS), startWorker('counter', path, WORKER_ROUNDS)];
  for (const worker of workers) worker.release();
  for (const result of await Promise.all(workers.map((worker) => worker.exited))) assert.equal(result.code, 0, result.stderr);
  assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key = 'counter'").get().value), 2 * WORKER_ROUNDS);
});

test('a purchase committed before a process kill is readable after reopen and an uncommitted one leaves no row', async (t) => {
  const path = tempPath(t);
  const committing = await runWorker('commit-then-kill', path);
  assert.equal(committing.signal, 'SIGKILL');

  const holding = startWorker('hold-in-transaction', path);
  assert.equal(await holding.line(), 'inside');
  holding.child.kill('SIGKILL');
  assert.equal((await holding.exited).signal, 'SIGKILL');

  const { ops, accountId } = open(t, path);
  const committed = ops.findByKey(accountId, 'purchase', 'committed-key');
  assert.notEqual(committed, null);
  assert.deepEqual(ops.history(committed.id).map((event) => event.type), ['created']);
  assert.equal(ops.findByKey(accountId, 'purchase', 'uncommitted-key'), null);
  assert.equal(ops.list(accountId).length, 1);
});

test('a duplicate idempotency key maps to idempotency_conflict and a re-linked wallet to wallet_linked_elsewhere through the client\'s classifier', (t) => {
  const { db, accounts, accountId, createPurchase } = open(t);
  createPurchase('same-key', { listing: 'first' });
  assert.throws(() => createPurchase('same-key', { listing: 'second' }), (error) => error.code === 'idempotency_conflict');

  const duplicate = () => db.prepare(`INSERT INTO operations (id, account_id, kind, idempotency_key, request_hash, status, terms, terms_hash, handoff_token_hash, expires_at, created_at, updated_at)
    VALUES ('other-id', ?, 'purchase', 'same-key', 'r', 's', '{}', 't', 'other-token-hash', 'e', 'c', 'u')`).run(accountId);
  let violation;
  try { duplicate(); } catch (error) { violation = error; }
  assert.equal(isUniqueViolation(violation), true);
  assert.equal(isUniqueViolation(new Error('UNIQUE constraint failed: operations.id')), false);

  const other = accounts.resolveFromToken({ issuer: 'external', subject: 'other' }).id;
  accounts.linkWallet({ accountId, address: 'wallet-one', challengeId: 'challenge-one' });
  assert.throws(() => accounts.linkWallet({ accountId: other, address: 'wallet-one', challengeId: 'challenge-two' }), (error) => error.code === 'wallet_linked_elsewhere');
  // A new address reusing a consumed challenge id reaches the insert and fails on the unique column.
  assert.throws(() => accounts.linkWallet({ accountId: other, address: 'wallet-two', challengeId: 'challenge-one' }), (error) => error.code === 'wallet_linked_elsewhere');
});

test('the purchase store exists before the plugin prepares any statement on the app database', async (t) => {
  const worker = startWorker('order-probe', tempPath(t));
  worker.release();
  const report = JSON.parse(await worker.line());
  assert.equal((await worker.exited).code, 0);
  assert.equal(report.guardInstalledByImport, true);
  // Importing prepares only the client's own guard probes, never a statement on the app database.
  assert.deepEqual(report.importedStatements.filter((sql) => !/^(PRAGMA |SELECT 1$)/.test(sql)), []);
});

function versionTwoFile(t, journalMode) {
  const path = tempPath(t);
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA journal_mode = ${journalMode === 'wal' ? 'WAL' : 'DELETE'}`);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '2');
    CREATE TABLE accounts (id TEXT PRIMARY KEY, auth_issuer TEXT NOT NULL, auth_subject TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL);
    INSERT INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES ('old-account', 'issuer', 'subject', 'then')`);
  if (journalMode === 'wal') t.after(() => raw.close());
  else raw.close();
  return path;
}

test('a schema-version-2 database file in rollback-journal mode and in WAL mode is refused with unsupported state schema version 2, is not migrated, and its database and journal or -wal bytes are unchanged', (t) => {
  for (const journalMode of ['rollback-journal', 'wal']) {
    const path = versionTwoFile(t, journalMode);
    const before = fileState(path);
    if (journalMode === 'wal') assert.notEqual(before[1], null, 'the WAL case has frames in its -wal');
    assert.throws(() => openDatabase(path), /unsupported state schema version 2/);
    assert.deepEqual(fileState(path), before, journalMode);
    const connection = new DatabaseSync(path, { readOnly: true });
    assert.equal(connection.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
    assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'operations'").get().n, 0);
    connection.close();
  }
});

test('a new database file is created from PURCHASE_STATE_SCHEMA and the plugin tables in one transaction, and a crash during creation leaves an empty file that the next open creates', async (t) => {
  const executed = [];
  const originals = ['exec', 'prepare'].map((method) => [method, DatabaseSync.prototype[method]]);
  for (const [method, original] of originals) {
    DatabaseSync.prototype[method] = function recorded(sql, ...rest) { executed.push(String(sql)); return original.call(this, sql, ...rest); };
  }
  try { openDatabase(tempPath(t)).close(); } finally { for (const [method, original] of originals) DatabaseSync.prototype[method] = original; }
  const at = (matcher) => executed.findIndex((sql) => matcher.test(sql));
  const begin = executed.indexOf('BEGIN IMMEDIATE');
  assert.equal(executed.filter((sql) => /^(BEGIN|COMMIT)/.test(sql)).length, 2, 'exactly one BEGIN and one COMMIT');
  assert.ok(begin >= 0 && executed.lastIndexOf(PURCHASE_STATE_SCHEMA) > begin, 'the client schema runs inside the transaction');
  assert.ok(at(/CREATE TABLE IF NOT EXISTS wallets/) > begin, 'the plugin tables run inside the transaction');
  assert.ok(at(/INSERT INTO meta/) > at(/CREATE TABLE IF NOT EXISTS secrets/), 'the version row follows the schema');
  assert.ok(at(/^COMMIT$/) > at(/INSERT INTO meta/), 'the commit follows the version row');

  const path = tempPath(t);
  const dying = startWorker('create-die', path);
  dying.release();
  assert.equal(await dying.line(), 'inside');
  assert.equal((await dying.exited).signal, 'SIGKILL');
  assert.equal(schemaObjects(path), 0, 'the crash left no schema object');
  const { db } = open(t, path);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'schema_version'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'operations'").get().n, 1);
});

const SCHEMA_ALTERATIONS = {
  'a reversed partial-index predicate': ['DROP INDEX write_coordinates_verified_tx',
    'CREATE UNIQUE INDEX write_coordinates_verified_tx ON write_coordinates(reported_tx_hash) WHERE verified_at IS NULL'],
  'different index columns': ['DROP INDEX operations_by_account', 'CREATE INDEX operations_by_account ON operations(account_id, updated_at)'],
  'a missing foreign key': ['DROP TABLE approvals', `CREATE TABLE approvals (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
    challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id), signer_address TEXT NOT NULL, terms_hash TEXT NOT NULL, signature TEXT NOT NULL, approved_at TEXT NOT NULL)`],
  'a missing index': ['DROP INDEX operations_by_subject'],
  'an extra table': ['CREATE TABLE stray (id TEXT)'],
  'schema objects without a version row': ["DELETE FROM meta WHERE key = 'schema_version'"],
};

test('an existing v3 file with a reversed partial-index predicate, different index columns, a missing foreign key or a missing index, in rollback-journal and in WAL mode, is refused purchase_state_schema_mismatch with its database and journal or -wal bytes unchanged', (t) => {
  for (const journalMode of ['rollback-journal', 'wal']) {
    for (const [alteration, statements] of Object.entries(SCHEMA_ALTERATIONS)) {
      const path = alteredFile(t, journalMode, statements);
      const before = fileState(path);
      if (journalMode === 'wal') assert.notEqual(before[1], null, 'the WAL case has frames in its -wal');
      assert.throws(() => openDatabase(path), (error) => error.code === 'purchase_state_schema_mismatch', `${journalMode}: ${alteration}`);
      assert.deepEqual(fileState(path), before, `${journalMode}: ${alteration}`);
    }
  }
});

test('a file that is not a database is refused with its cause and left unchanged', (t) => {
  const path = tempPath(t);
  writeFileSync(path, 'this is not a database file, it is only text'.repeat(100));
  const before = fileState(path);
  assert.throws(() => openDatabase(path), (error) => error.cause instanceof Error && /not a database/.test(error.cause.message));
  assert.deepEqual(fileState(path), before);
});

test('on the valid schema a second verified pointer to the same transaction hash is refused, and two purchases may hold the same unverified hash', (t) => {
  const { coordinates, createPurchase } = open(t);
  const first = createPurchase('first').operation.id;
  const second = createPurchase('second').operation.id;
  for (const operationId of [first, second]) coordinates.save({ operationId, ...COORDINATES, expectedNonce: operationId === first ? 2 : 3 });
  const hash = 'a'.repeat(64);
  assert.equal(coordinates.reportHash(first, hash), true);
  assert.equal(coordinates.reportHash(second, hash), true);
  assert.equal(coordinates.recordObservation(first, { txHash: hash }, true), true);
  assert.throws(() => coordinates.recordObservation(second, { txHash: hash }, true), isUniqueViolation);
});

test('the opened app database passes the client\'s purchase-database admission (WAL, synchronous FULL, no attachments), and a new file and an existing validated file, reopened read-write, both report journal_mode wal, synchronous 2 (FULL) and foreign_keys 1 when read back from the connection', (t) => {
  const reopenedWal = tempPath(t);
  openDatabase(reopenedWal).close();
  const reopenedRollback = tempPath(t);
  openDatabase(reopenedRollback).close();
  const raw = new DatabaseSync(reopenedRollback);
  raw.exec('PRAGMA journal_mode = DELETE');
  raw.close();
  for (const [label, path] of [['new file', tempPath(t)], ['reopened WAL file', reopenedWal], ['reopened rollback-journal file', reopenedRollback]]) {
    const { db } = open(t, path);
    assert.equal(transaction(db, () => 'admitted'), 'admitted', label);
    assert.equal(pragmaValue(db, 'journal_mode'), 'wal', label);
    assert.equal(pragmaValue(db, 'synchronous'), 2, label);
    assert.equal(pragmaValue(db, 'foreign_keys'), 1, label);
    assert.deepEqual(db.prepare('PRAGMA database_list').all().filter(({ name }) => name !== 'main' && name !== 'temp'), [], label);
  }
});

test('two concurrent first opens of an empty database file create the schema once, and neither sees a half-created schema or writes a second version row', async (t) => {
  const path = tempPath(t);
  const creator = startWorker('create-hold', path);
  assert.equal(await creator.line(), 'inside');
  assert.equal(schemaObjects(path), 0, 'the held creation is not visible');

  const latecomer = startWorker('open-announce', path);
  latecomer.release();
  assert.equal(await latecomer.line(), 'begin');
  creator.release();
  const [created, second] = await Promise.all([creator.exited, latecomer.exited]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(second.code, 0, second.stderr);

  const { db } = open(t, path);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'schema_version'").get().n, 1);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'operations'").get().n, 1);
});

test('a WAL-mode file left with committed frames in its -wal is validated through a read-only connection, so a refusal leaves the database and -wal bytes unchanged and a valid file opens with its frames intact', async (t) => {
  const valid = tempPath(t);
  assert.equal((await runWorker('commit-then-kill', valid)).signal, 'SIGKILL');
  assert.ok(existsSync(`${valid}-wal`) && readFileSync(`${valid}-wal`).length > 0, 'the kill left committed frames in the -wal');
  const { ops, accountId } = open(t, valid);
  assert.notEqual(ops.findByKey(accountId, 'purchase', 'committed-key'), null);

  const altered = tempPath(t);
  assert.equal((await runWorker('mismatch-then-kill', altered)).signal, 'SIGKILL');
  const before = fileState(altered);
  assert.notEqual(before[1], null);
  assert.throws(() => openDatabase(altered), (error) => error.code === 'purchase_state_schema_mismatch');
  assert.deepEqual(fileState(altered), before);
});

test('purchase_commit_lost_response_reuses_handoff', (t) => {
  const path = tempPath(t);
  const first = open(t, path);
  const lost = first.createPurchase('lost-response-key');
  first.coordinates.save({ operationId: lost.operation.id, ...COORDINATES });
  first.db.close();

  const restarted = open(t, path);
  const retried = restarted.createPurchase('lost-response-key');
  assert.equal(retried.created, false);
  assert.equal(retried.operation.id, lost.operation.id);
  assert.equal(retried.handoffToken, lost.handoffToken);
  assert.equal(restarted.ops.list(restarted.accountId).length, 1);
  assert.throws(() => restarted.coordinates.save({ operationId: lost.operation.id, ...COORDINATES }), isUniqueViolation);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM write_coordinates').get().n, 1);
});
