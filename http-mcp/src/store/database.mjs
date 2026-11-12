// Durable state for accounts, wallets, agents, operations, challenges and the OAuth provider, on
// node:sqlite (WAL, synchronous=FULL), so idempotency keys, one-use challenges and approvals are
// enforced by UNIQUE constraints and survive process restarts. The client's PurchaseStore owns every
// transaction, and the client's PURCHASE_STATE_SCHEMA is the only DDL for the purchase tables: a new
// file is created from it, and an existing file must match it exactly before anything is written.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { PURCHASE_STATE_SCHEMA, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';

// Created at import, before this module prepares any statement: the client's statement guard only
// tracks statements prepared after the store exists.
const purchaseStore = createSqlitePurchaseStore();

/** Runs a synchronous callback in the client's BEGIN IMMEDIATE transaction; a nested call is a savepoint. Rolls back and rethrows on any error. */
export const { transaction } = purchaseStore;

/** Whether a SQLite error is a UNIQUE or PRIMARY KEY violation. */
export const { isUniqueViolation } = purchaseStore;

// v3: the purchase tables are the client's schema (operations gains handoff_expires_at and job_id).
// Pre-release: older files are refused rather than migrated.
const SCHEMA_VERSION = 3;
const BUSY_TIMEOUT_MS = 5000;
const IN_MEMORY = ':memory:';
// Persistent settings come after busy_timeout so a concurrent first open waits instead of failing.
const CONNECTION_PRAGMAS = [`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`, 'PRAGMA journal_mode = WAL', 'PRAGMA synchronous = FULL', 'PRAGMA foreign_keys = ON'];

// The plugin's own tables; the purchase tables come from PURCHASE_STATE_SCHEMA.
const PLUGIN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS wallets (
     address TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     scheme TEXT NOT NULL,
     linked_at TEXT NOT NULL,
     link_challenge_id TEXT NOT NULL UNIQUE
   )`,
  `CREATE INDEX IF NOT EXISTS wallets_by_account ON wallets(account_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id),
     wallet_address TEXT NOT NULL REFERENCES wallets(address),
     listing_id TEXT NOT NULL,
     profile TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (account_id, listing_id),
     UNIQUE (wallet_address, listing_id)
   )`,
  `CREATE TABLE IF NOT EXISTS oidc_models (
     model TEXT NOT NULL,
     id TEXT NOT NULL,
     payload TEXT NOT NULL,
     grant_id TEXT,
     user_code TEXT,
     uid TEXT,
     expires_at INTEGER,
     consumed_at INTEGER,
     PRIMARY KEY (model, id)
   )`,
  `CREATE INDEX IF NOT EXISTS oidc_by_grant ON oidc_models(grant_id)`,
  `CREATE INDEX IF NOT EXISTS oidc_by_uid ON oidc_models(model, uid)`,
  `CREATE INDEX IF NOT EXISTS oidc_by_user_code ON oidc_models(model, user_code)`,
  // One-use wallet-link capabilities (start_wallet_link).
  `CREATE TABLE IF NOT EXISTS used_link_nonces (
     nonce TEXT PRIMARY KEY,
     account_id TEXT NOT NULL,
     used_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS secrets (
     name TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

// Thrown when an existing app database does not hold exactly the schema this build creates.
class PurchaseStateSchemaError extends Error {
  constructor(detail) {
    super(`purchase state schema mismatch: ${detail}`);
    this.code = 'purchase_state_schema_mismatch';
  }
}

function connect(path) {
  const db = new DatabaseSync(path);
  try {
    for (const pragma of CONNECTION_PRAGMAS) db.exec(pragma);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

// One entry per schema object: its type, table and normalized SQL, plus the columns, foreign keys and
// indexes SQLite reports for it. The SQL comparison is needed because a reversed partial-index
// predicate leaves the index's columns unchanged.
function describeSchema(db) {
  const columns = db.prepare('SELECT * FROM pragma_table_xinfo(?)');
  const foreignKeys = db.prepare('SELECT * FROM pragma_foreign_key_list(?)');
  const indexes = db.prepare('SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name');
  const indexColumns = db.prepare('SELECT * FROM pragma_index_xinfo(?)');
  const described = new Map();
  for (const { type, name, tbl_name: table, sql } of db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all()) {
    const entry = { type, table, sql: sql?.replace(/\s+/g, ' ').trim() ?? null };
    if (type === 'table') Object.assign(entry, { columns: columns.all(name), foreignKeys: foreignKeys.all(name), indexes: indexes.all(name) });
    if (type === 'index') entry.indexColumns = indexColumns.all(name);
    described.set(name, JSON.stringify(entry));
  }
  return described;
}

function referenceSchema() {
  const reference = new DatabaseSync(IN_MEMORY);
  try {
    reference.exec(PURCHASE_STATE_SCHEMA);
    for (const statement of PLUGIN_SCHEMA) reference.exec(statement);
    return describeSchema(reference);
  } finally {
    reference.close();
  }
}

// The first object that differs from the reference, or null when the two schemas are equal.
function schemaDifference(actual, expected) {
  for (const [name, description] of expected) {
    if (actual.get(name) !== description) return actual.has(name) ? `${name} differs` : `${name} is missing`;
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) return `${name} is not part of the schema`;
  }
  return null;
}

// Reads an existing file through a read-only connection: closing a read-write one checkpoints a crashed
// WAL file into the database, so a refused file's bytes must never meet one. Returns the number of schema
// objects, the stored version (null when there is no version row) and, for a stored current version,
// the first schema difference. Throws an error carrying the cause when the file cannot be read.
function readState(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const objects = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n;
    const hasMeta = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const versionRow = hasMeta ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() : undefined;
    const version = versionRow?.value ?? null;
    const difference = version !== null && Number(version) === SCHEMA_VERSION ? schemaDifference(describeSchema(db), referenceSchema()) : null;
    return { objects, version, difference };
  } catch (error) {
    throw new Error(`cannot read the state database ${path}: ${error.message}`, { cause: error });
  } finally {
    if (db?.isOpen) db.close();
  }
}

// Creates the whole schema in one BEGIN IMMEDIATE, after re-checking under that lock that no other run
// created it first. A crash before COMMIT leaves no schema object, so the next open creates it again.
// Returns the open database, or null when another run's schema was already there.
function createDatabase(path) {
  const db = connect(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    if (db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n > 0) {
      db.exec('ROLLBACK');
      db.close();
      return null;
    }
    db.exec(PURCHASE_STATE_SCHEMA);
    for (const statement of PLUGIN_SCHEMA) db.exec(statement);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    db.exec('COMMIT');
    return db;
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

const isAbsentOrEmpty = (path) => !existsSync(path) || statSync(path).size === 0;

/**
 * Opens the app database at `path` (or ':memory:') for read and write: WAL, synchronous FULL, foreign keys on.
 * An absent, empty or schema-less file is created from the client's schema and the plugin's tables. Any other
 * file is read through a read-only connection first and opened only if its version is 3 and its schema equals
 * the one a new file gets; nothing is written, repaired or checkpointed before that.
 * Throws `unsupported state schema version <v>` for another version (no migration), an error with code
 * `purchase_state_schema_mismatch` for a schema that differs, and an error carrying the cause when the
 * file cannot be read.
 */
export function openDatabase(path) {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let state = path === IN_MEMORY || isAbsentOrEmpty(path) ? null : readState(path);
  if (!state || state.objects === 0) {
    const created = createDatabase(path);
    if (created) return created;
    state = readState(path);
  }
  if (state.version === null) throw new PurchaseStateSchemaError('the schema has no version row');
  if (Number(state.version) !== SCHEMA_VERSION) throw new Error(`unsupported state schema version ${state.version}; expected ${SCHEMA_VERSION}`);
  if (state.difference) throw new PurchaseStateSchemaError(state.difference);
  return connect(path);
}
