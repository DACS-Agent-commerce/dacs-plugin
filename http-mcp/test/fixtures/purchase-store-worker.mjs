// Child-process worker for purchase-store.test.mjs: one run of "our program" against an app database
// file. Each mode reports on stdout and either exits, waits for the parent, or kills itself.
// Usage: purchase-store-worker.mjs <mode> <database path> [argument]
import { readSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [mode, path, argument] = process.argv.slice(2);
const say = (value) => writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
// Blocks until the parent writes a byte or closes this worker's stdin.
const waitForParent = () => readSync(0, Buffer.alloc(1));
const killSelf = () => process.kill(process.pid, 'SIGKILL');

const sqlLog = [];
let onSql = () => {};
for (const method of ['exec', 'prepare']) {
  const original = DatabaseSync.prototype[method];
  DatabaseSync.prototype[method] = function recorded(sql, ...rest) {
    sqlLog.push(String(sql));
    onSql(String(sql));
    return original.call(this, sql, ...rest);
  };
}
const recordedPrepare = DatabaseSync.prototype.prepare;
const duringVersionRow = (action) => (sql) => { if (/INSERT INTO meta/.test(sql)) action(); };

if (mode === 'create-hold') onSql = duringVersionRow(() => { say('inside'); waitForParent(); });
if (mode === 'create-die') onSql = duringVersionRow(() => { say('inside'); killSelf(); });
if (mode === 'open-announce') onSql = (sql) => { if (sql === 'BEGIN IMMEDIATE') say('begin'); };

const { openDatabase, transaction } = await import('../../src/store/database.mjs');
const importedStatements = sqlLog.splice(0);

if (mode === 'order-probe') {
  // The client's statement guard replaces the prototype's prepare when the store is created.
  say({ guardInstalledByImport: DatabaseSync.prototype.prepare !== recordedPrepare, importedStatements });
} else if (mode === 'counter') {
  const db = openDatabase(path);
  const read = db.prepare("SELECT value FROM meta WHERE key = 'counter'");
  const write = db.prepare("UPDATE meta SET value = ? WHERE key = 'counter'");
  for (let round = 0; round < Number(argument); round += 1) {
    transaction(db, () => write.run(String(Number(read.get().value) + 1)));
  }
  db.close();
  say('done');
} else if (mode === 'mismatch-then-kill') {
  const db = openDatabase(path);
  db.exec('DROP INDEX operations_by_subject');
  say('mutated');
  killSelf();
} else if (['commit-then-kill', 'hold-in-transaction'].includes(mode)) {
  const { createAccountService } = await import('../../src/accounts.mjs');
  const { createOperationStore } = await import('../../src/operations.mjs');
  const db = openDatabase(path);
  const account = createAccountService({ db, builtinIssuer: 'builtin' }).resolveFromToken({ issuer: 'external', subject: 'buyer' });
  const ops = createOperationStore({ db, handoffSecret: 'worker-handoff-secret'.repeat(2) });
  const create = (idempotencyKey) => ops.createIdempotent({
    accountId: account.id, kind: 'purchase', idempotencyKey, request: { key: idempotencyKey }, status: 'awaiting_approval',
    terms: { listing: 'worker' }, termsHash: 'worker-terms-hash', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  if (mode === 'commit-then-kill') {
    create('committed-key');
    say('committed');
    killSelf();
  } else {
    transaction(db, () => { create('uncommitted-key'); say('inside'); waitForParent(); });
  }
} else {
  const db = openDatabase(path);
  say({ log: sqlLog, versionRows: db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'schema_version'").get().n });
  db.close();
}
