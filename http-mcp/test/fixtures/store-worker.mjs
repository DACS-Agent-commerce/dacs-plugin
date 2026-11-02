// Child-process worker: opens the same SQLite file and races createIdempotent.
import { openDatabase } from '../../src/store/database.mjs';
import { createOperationStore } from '../../src/operations.mjs';

const [dbPath, secret, accountId, key, rounds] = process.argv.slice(2);
const db = openDatabase(dbPath);
const ops = createOperationStore({ db, handoffSecret: secret });
const ids = new Set();
for (let i = 0; i < Number(rounds); i += 1) {
  const { operation } = ops.createIdempotent({
    accountId, kind: 'purchase', idempotencyKey: key, request: { same: true }, status: 'awaiting_approval',
    terms: { x: 1 }, termsHash: 'h', expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  ids.add(operation.id);
}
db.close();
process.stdout.write(JSON.stringify([...ids]));
