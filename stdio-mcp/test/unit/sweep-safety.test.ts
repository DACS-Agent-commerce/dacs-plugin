import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, readLedgerFile, ADDR_B } from '../helpers.js';
import { SpendCapError, SpendLedger } from '../../src/spend.js';

const CAP_OS = 1_000_000n;
const TODAY = '2026-10-05';
const LOCK_AGE_MS = 120_000;

type Row = Record<string, unknown>;

const stateDir = () => mkdtempSync(join(tmpdir(), 'spend-sweep-'));
const ledgerPath = (dir: string) => join(dir, 'spend-ledger.json');
const ledgerAt = (dir: string, day = TODAY) => new SpendLedger(dir, CAP_OS, () => new Date(`${day}T12:00:00Z`));
const writeLedger = (dir: string, file: unknown) => writeFileSync(ledgerPath(dir), JSON.stringify(file, null, 2));
const parts = (priceOs: bigint, networkFeeOs: bigint, storageFeeOs = 0n) => ({ priceOs, networkFeeOs, storageFeeOs });
const row = (id: string, day: string, priceOs: string, networkFeeOs: string, storageFeeOs = '0'): Row => ({ id, day, priceOs, networkFeeOs, storageFeeOs });

/** Independent of the ledger code: every day's open reservations sum to no more than its total. */
function assertDayTotalsHold(dir: string): void {
  const f = readLedgerFile(dir);
  const sums = new Map<string, bigint>();
  for (const r of f.reservations ?? []) {
    sums.set(r.day, (sums.get(r.day) ?? 0n) + BigInt(r.priceOs) + BigInt(r.networkFeeOs) + BigInt(r.storageFeeOs));
  }
  for (const [day, sum] of sums) assert.ok(sum <= BigInt(f.days[day] ?? '0'), `reservations of ${day} exceed its total`);
}

test('a live lock older than 30 seconds is refused, not removed', () => {
  const dir = stateDir();
  const lock = `${ledgerPath(dir)}.lock`;
  writeFileSync(lock, '');
  const old = new Date(Date.now() - LOCK_AGE_MS);
  utimesSync(lock, old, old);
  assert.throws(() => ledgerAt(dir).reserve(parts(10n, 5n), 'x'), (err: unknown) => {
    assert.ok(err instanceof SpendCapError);
    assert.match(err.message, /locked by another process/);
    assert.ok(err.message.includes(lock), 'the message names the lock file');
    assert.match(err.message, /remove it if no other process is running/);
    return true;
  });
  assert.ok(existsSync(lock), 'the lock of a live process stays');
  assert.equal(existsSync(ledgerPath(dir)), false, 'nothing was recorded');
});

test('a reservation records price, network fee and storage fee and releases only its own parts', () => {
  const dir = stateDir();
  const ledger = ledgerAt(dir);
  const a = ledger.reserve(parts(1000n, 200n, 30n), 'a');
  const b = ledger.reserve(parts(500n, 100n), 'b');
  const before = readLedgerFile(dir);
  assert.equal(before.days[TODAY], '1830');
  assert.deepEqual(before.reservations, [row(a, TODAY, '1000', '200', '30'), row(b, TODAY, '500', '100', '0')]);
  ledger.release(a);
  const after = readLedgerFile(dir);
  assert.equal(after.days[TODAY], '600');
  assert.deepEqual(after.reservations, [row(b, TODAY, '500', '100', '0')]);
  ledger.release(a);
  assert.equal(readLedgerFile(dir).days[TODAY], '600', 'a second release frees nothing');
});

test('a release keeps the parts it is given, never more than the reservation holds', () => {
  const dir = stateDir();
  const ledger = ledgerAt(dir);
  const id = ledger.reserve(parts(500n, 100n, 20n), 'x');
  ledger.release(id, { priceOs: 900n, networkFeeOs: 40n });
  assert.equal(readLedgerFile(dir).days[TODAY], '540');
  assert.deepEqual(readLedgerFile(dir).reservations, []);
});

test('a version 1 ledger without reservations loads and keeps its debit', () => {
  const dir = stateDir();
  writeLedger(dir, { version: 1, days: { [TODAY]: '7' } });
  const ledger = ledgerAt(dir);
  assert.equal(ledger.spentToday(), 7n);
  ledger.reserve(parts(2n, 1n), 'x');
  assert.equal(ledger.spentToday(), 10n);
  assert.equal(readLedgerFile(dir).reservations?.length, 1);
});

test('old settled days are pruned on write; today and days with open reservations stay; the cap is unchanged', () => {
  const dir = stateDir();
  writeLedger(dir, {
    version: 1,
    days: { '2026-09-01': '5', '2026-09-20': '7', '2026-10-01': '3', [TODAY]: '2' },
    reservations: [row('open-1', '2026-10-01', '2', '1')],
  });
  const ledger = ledgerAt(dir);
  const id = ledger.reserve(parts(10n, 5n), 'x');
  assert.deepEqual(Object.keys(readLedgerFile(dir).days), ['2026-10-01', TODAY]);
  assert.equal(ledger.capOs, CAP_OS);
  assert.equal(ledger.remainingToday(), CAP_OS - 17n);
  ledger.release('open-1');
  assert.deepEqual(Object.keys(readLedgerFile(dir).days), [TODAY], 'the day is pruned once its reservation is closed');
  ledger.release(id);
  assert.equal(ledger.capOs, CAP_OS);
});

const CORRUPT_LEDGERS: Array<[string, unknown]> = [
  ['reservations is not a list', { version: 1, days: { [TODAY]: '9' }, reservations: 'x' }],
  ['a reservation is null', { version: 1, days: { [TODAY]: '9' }, reservations: [null] }],
  ['a reservation has no id', { version: 1, days: { [TODAY]: '9' }, reservations: [{ ...row('a', TODAY, '1', '1'), id: undefined }] }],
  ['a reservation id is a number', { version: 1, days: { [TODAY]: '9' }, reservations: [{ ...row('a', TODAY, '1', '1'), id: 5 }] }],
  ['a reservation day is not a date', { version: 1, days: { [TODAY]: '9' }, reservations: [row('a', 'yesterday', '1', '1')] }],
  ['a price is negative', { version: 1, days: { [TODAY]: '9' }, reservations: [row('a', TODAY, '-1', '1')] }],
  ['a network fee is a number', { version: 1, days: { [TODAY]: '9' }, reservations: [{ ...row('a', TODAY, '1', '1'), networkFeeOs: 1 }] }],
  ['a storage fee is missing', { version: 1, days: { [TODAY]: '9' }, reservations: [{ ...row('a', TODAY, '1', '1'), storageFeeOs: undefined }] }],
  ['two reservations share an id', { version: 1, days: { [TODAY]: '9' }, reservations: [row('a', TODAY, '1', '1'), row('a', TODAY, '1', '1')] }],
  ['a day total is not a number', { version: 1, days: { [TODAY]: 'x' } }],
];

test('corrupt ledger or reservation fields refuse before signing and keep the recorded debit', async () => {
  const h = await harness();
  for (const [what, file] of CORRUPT_LEDGERS) {
    writeLedger(h.config.stateDir, file);
    const bytes = readFileSync(ledgerPath(h.config.stateDir), 'utf8');
    const prepared = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
    assert.equal(prepared.isError, true, what);
    assert.match(prepared.text, /spend ledger/, what);
    assert.throws(() => h.ledger.reserve(parts(1n, 1n), 'x'), SpendCapError, what);
    assert.throws(() => h.ledger.release('a'), SpendCapError, what);
    assert.equal(readFileSync(ledgerPath(h.config.stateDir), 'utf8'), bytes, `${what}: the record is kept`);
  }
  assert.equal(h.wallet.prepares, 0, 'nothing was signed');
});

test('two reservations that each fit the day total but exceed it together refuse in both orders and after a reload, keeping every record', async () => {
  const a = row('a', TODAY, '2', '1');
  const b = row('b', TODAY, '2', '1');
  for (const reservations of [[a, b], [b, a]]) {
    const h = await harness();
    writeLedger(h.config.stateDir, { version: 1, days: { [TODAY]: '5' }, reservations });
    const bytes = readFileSync(ledgerPath(h.config.stateDir), 'utf8');
    const prepared = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
    assert.equal(prepared.isError, true);
    assert.equal(h.wallet.prepares, 0, 'refused before any authority');
    for (const ledger of [h.ledger, ledgerAt(h.config.stateDir)]) {
      assert.throws(() => ledger.reserve(parts(1n, 1n), 'x'), new RegExp(`${TODAY} needs reconciliation`));
      assert.throws(() => ledger.release('a'), /needs reconciliation/);
      assert.throws(() => ledger.spentToday(), /needs reconciliation/);
    }
    assert.equal(readFileSync(ledgerPath(h.config.stateDir), 'utf8'), bytes, 'every record is kept');
  }
});

test("a day total equal to the reservations' sum and one above it both load; after a release the older debit is still charged", () => {
  const equalDir = stateDir();
  writeLedger(equalDir, { version: 1, days: { [TODAY]: '6' }, reservations: [row('a', TODAY, '3', '1'), row('b', TODAY, '2', '0')] });
  assert.equal(ledgerAt(equalDir).spentToday(), 6n);

  const olderDir = stateDir();
  writeLedger(olderDir, { version: 1, days: { [TODAY]: '10' }, reservations: [row('a', TODAY, '3', '1'), row('b', TODAY, '2', '0')] });
  const ledger = ledgerAt(olderDir);
  assert.equal(ledger.spentToday(), 10n);
  ledger.release('a');
  assert.equal(ledger.spentToday(), 6n);
  ledger.release('b');
  assert.equal(ledger.spentToday(), 4n, 'the debit recorded outside the reservations stays charged');
  assert.equal(readLedgerFile(olderDir).days[TODAY], '4');
});

test('after each reserve, release and prune the reloaded ledger satisfies the day total check', () => {
  const dir = stateDir();
  const reloadsCleanly = (day: string) => {
    assertDayTotalsHold(dir);
    ledgerAt(dir, day).spentToday();
  };
  const day1 = ledgerAt(dir, '2026-10-05');
  const a = day1.reserve(parts(100n, 20n), 'a');
  reloadsCleanly('2026-10-05');
  const b = day1.reserve(parts(50n, 10n, 5n), 'b');
  reloadsCleanly('2026-10-05');
  day1.release(a, { priceOs: 100n, networkFeeOs: 7n });
  reloadsCleanly('2026-10-05');
  const day2 = ledgerAt(dir, '2026-10-06');
  const c = day2.reserve(parts(30n, 5n), 'c');
  reloadsCleanly('2026-10-06');
  assert.deepEqual(Object.keys(readLedgerFile(dir).days), ['2026-10-05', '2026-10-06'], 'the open reservation keeps its day through the prune');
  day2.release(b);
  reloadsCleanly('2026-10-06');
  assert.deepEqual(Object.keys(readLedgerFile(dir).days), ['2026-10-06'], 'the settled day is pruned');
  day2.release(c);
  reloadsCleanly('2026-10-06');
});
