import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, readLedgerFile, ADDR_B, type Harness, type LedgerReservation } from '../helpers.js';
import { SpendLedger } from '../../src/spend.js';
import type { BroadcastResult } from '../../src/chain.js';

const DEM = 1_000_000_000n;
const NOW = '2026-10-05T12:00:00Z';

const parts = (priceOs: bigint, networkFeeOs: bigint, storageFeeOs = 0n) => ({ priceOs, networkFeeOs, storageFeeOs });
const ledgerAt = (dir: string, cap: bigint, at = NOW) => new SpendLedger(dir, cap, () => new Date(at));

test("a reservation equal to today's remaining cap is admitted and one OS more is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-exec-'));
  const ledger = ledgerAt(dir, 100n);
  ledger.reserve(parts(30n, 10n), 'first');
  assert.equal(ledger.remainingToday(), 60n);
  assert.throws(() => ledger.reserve(parts(50n, 11n), 'too much'), /cap/);
  assert.equal(ledger.spentToday(), 40n, 'the refusal recorded nothing');
  ledger.reserve(parts(50n, 10n), 'exactly the rest');
  assert.equal(ledger.remainingToday(), 0n);
});

test('a release after a restart and after midnight frees only its own amount and leaves other days alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spend-exec-'));
  const first = ledgerAt(dir, 1_000n);
  const a = first.reserve(parts(300n, 50n), 'a');
  first.reserve(parts(200n, 40n), 'b');
  const nextDay = ledgerAt(dir, 1_000n, '2026-10-06T00:00:01Z');
  nextDay.reserve(parts(100n, 10n), 'c');
  const restarted = ledgerAt(dir, 1_000n, '2026-10-06T08:00:00Z');
  restarted.release(a);
  const f = readLedgerFile(dir);
  assert.equal(f.days['2026-10-05'], '240', "only the other reservation's parts remain on the first day");
  assert.equal(f.days['2026-10-06'], '110', 'the next day is untouched');
  assert.equal(f.reservations?.length, 2);
});

const PAY_ONE_DEM = { to: ADDR_B, amount_dem: '1' }; // 1 DEM + 2 DEM quoted fee = 3 DEM reserved

async function submitPay(h: Harness) {
  const p = await h.call('demos_tx_prepare', PAY_ONE_DEM);
  return h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
}

/** What a fresh process reads from the state dir. */
function afterRestart(h: Harness) {
  const reloaded = ledgerAt(h.config.stateDir, h.config.dailyCapOs);
  return { debitOs: reloaded.spentToday(), reservations: readLedgerFile(h.config.stateDir).reservations ?? [] };
}

function countReleases(h: Harness): () => number {
  let n = 0;
  const release = h.ledger.release.bind(h.ledger);
  h.ledger.release = (...args) => {
    n++;
    release(...args);
  };
  return () => n;
}

/** The wallet reports `state` on broadcast; the returned list holds the open reservation rows seen at that moment. */
function broadcastsAs(h: Harness, state: BroadcastResult['state']): LedgerReservation[][] {
  const openAtBroadcast: LedgerReservation[][] = [];
  h.wallet.broadcast = async (p) => {
    openAtBroadcast.push(readLedgerFile(h.config.stateDir).reservations ?? []);
    return { txHash: p.hash, state, ...(state === 'included' ? { blockNumber: 1001 } : {}) };
  };
  return openAtBroadcast;
}

const RESERVED_ROW = { priceOs: String(1n * DEM), networkFeeOs: String(2n * DEM), storageFeeOs: '0' };
const partsOf = (r: LedgerReservation) => ({ priceOs: r.priceOs, networkFeeOs: r.networkFeeOs, storageFeeOs: r.storageFeeOs });

test('settlement by outcome: completed keeps the fee paid and releases the rest of the quote, once', async () => {
  const h = await harness();
  h.wallet.feeOs = 1n * DEM;
  const openAtBroadcast = broadcastsAs(h, 'included');
  const releases = countReleases(h);
  const r = await submitPay(h);
  assert.equal(r.json.status, 'included');
  assert.deepEqual(openAtBroadcast.map((rows) => rows.map(partsOf)), [[RESERVED_ROW]]);
  assert.equal(releases(), 1);
  assert.deepEqual(afterRestart(h), { debitOs: 2n * DEM, reservations: [] });
});

test('settlement by outcome: completed at the full quote keeps the whole debit and closes the reservation', async () => {
  const h = await harness();
  const r = await submitPay(h);
  assert.equal(r.json.status, 'included');
  assert.deepEqual(afterRestart(h), { debitOs: 3n * DEM, reservations: [] });
});

test('settlement by outcome: failed with a known fee below its quote keeps that fee and releases the unused quote', async () => {
  const h = await harness();
  h.wallet.feeOs = 1n * DEM;
  const openAtBroadcast = broadcastsAs(h, 'failed');
  const releases = countReleases(h);
  const r = await submitPay(h);
  assert.equal(r.json.status, 'failed');
  assert.equal(openAtBroadcast.length, 1);
  assert.equal(releases(), 1);
  assert.deepEqual(afterRestart(h), { debitOs: 2n * DEM, reservations: [] });
});

test('settlement by outcome: failed with an unknown outcome keeps the whole reservation open', async () => {
  const h = await harness();
  h.wallet.nextValid = false; // the node rejects the signed bytes at confirm: sent, outcome unknown
  const releases = countReleases(h);
  const r = await submitPay(h);
  assert.equal(r.json.status, 'unknown');
  assert.equal(releases(), 0);
  const restarted = afterRestart(h);
  assert.equal(restarted.debitOs, 3n * DEM);
  assert.deepEqual(restarted.reservations.map(partsOf), [RESERVED_ROW]);
});

test('settlement by outcome: pending keeps the whole reservation open even when the fee is known', async () => {
  const h = await harness();
  h.wallet.feeOs = 1n * DEM;
  broadcastsAs(h, 'pending');
  const releases = countReleases(h);
  const r = await submitPay(h);
  assert.equal(r.json.status, 'pending');
  assert.equal(releases(), 0);
  const restarted = afterRestart(h);
  assert.equal(restarted.debitOs, 3n * DEM);
  assert.equal(restarted.reservations.length, 1);
});
