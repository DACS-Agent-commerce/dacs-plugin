// The client's coordinate store on the app database's real schema and transaction owner: a payment
// pointer that moved, or a readback that failed, never lets an older observation or a second handoff
// change a purchase. The pointer rules are the store's own conditional UPDATEs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinateStore } from '@kynesyslabs/dacs-client';
import { openDatabase, transaction, isUniqueViolation } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';

const NOW = Date.UTC(2026, 0, 1);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const WALLET = 'wallet-buyer';
const NETWORK = 'testnet';

function tempPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.db');
}

// Opens the file (a restart when called again on the same path) and returns its stores.
function world(t, path) {
  const db = openDatabase(path);
  t.after(() => { if (db.isOpen) db.close(); });
  const ops = createOperationStore({ db, handoffSecret: 'h'.repeat(40), now: () => NOW });
  const coordinates = createCoordinateStore({ db, now: () => NOW });
  db.prepare("INSERT OR IGNORE INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES ('account', 'issuer', 'subject', 'then')").run();
  // One transaction, as the client's handoff does: the purchase and its coordinates exist together or not at all.
  const purchase = (key, expectedNonce) => transaction(db, () => {
    const { operation } = ops.createIdempotent({
      accountId: 'account', kind: 'purchase', idempotencyKey: key, request: { key }, status: 'payment_handoff', terms: {}, termsHash: 'terms-hash',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    coordinates.save({ operationId: operation.id, kind: 'purchase', network: NETWORK, from: WALLET, nonceFence: expectedNonce - 1, expectedNonce, target: 'wallet-seller', amountOs: '5', payload: { nonce: expectedNonce } });
    return operation.id;
  });
  const row = (operationId) => db.prepare('SELECT reported_tx_hash, observation, verified_at, handoffs, payload_hash FROM write_coordinates WHERE operation_id = ?').get(operationId);
  return { db, ops, coordinates, purchase, row };
}

const observationOf = (hash, extra = {}) => ({ txHash: hash, status: 'confirmed', slotConsumed: true, ...extra });

test('a delayed observation of hash A after the pointer moved to B cannot verify B, overwrite B\'s observation, consume B\'s lane or supersede another purchase', (t) => {
  const { db, coordinates, purchase, row } = world(t, tempPath(t));
  const first = purchase('first', 2);
  const other = purchase('other', 3);
  coordinates.reportHash(first, HASH_A);
  coordinates.reportHash(other, HASH_A);
  assert.equal(coordinates.replaceUnobservedHash(first, HASH_B), true, 'the unobserved pointer moves to B');
  assert.equal(coordinates.recordObservation(first, observationOf(HASH_B, { slotConsumed: false }), false, HASH_B), true);
  const before = row(first);
  const otherBefore = row(other);

  assert.equal(coordinates.recordObservation(first, observationOf(HASH_A), true, HASH_A), false, 'the late read of A changes nothing');
  assert.deepEqual(row(first), before);
  assert.equal(row(first).verified_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wallet_nonce_consumptions').get().n, 0, 'no nonce lane was consumed');
  assert.deepEqual(row(other), otherBefore);
  assert.equal(coordinates.verifiedOwnerOf(HASH_A), null);
  assert.deepEqual(coordinates.unresolvedForSender(WALLET, 'none', ['payment_handoff']).map((entry) => entry.operationId).sort(), [first, other].sort());
});

test('the delayed-observation rule holds in the other completion order and across a restart between the two observations', (t) => {
  // A verified first: a pointer move to B is refused and the verified A stays.
  const path = tempPath(t);
  const early = world(t, path);
  const settled = early.purchase('settled-first', 2);
  early.coordinates.reportHash(settled, HASH_A);
  assert.equal(early.coordinates.recordObservation(settled, observationOf(HASH_A), true, HASH_A), true);
  assert.equal(early.coordinates.replaceUnobservedHash(settled, HASH_B), false);
  assert.equal(early.row(settled).reported_tx_hash, HASH_A);
  assert.notEqual(early.row(settled).verified_at, null);

  // B verified, then the process restarts, then the delayed read of A arrives.
  const moved = early.purchase('moved', 3);
  early.coordinates.reportHash(moved, HASH_A);
  early.coordinates.clearRejectedPointer(moved, HASH_A);
  early.coordinates.reportHash(moved, HASH_B);
  assert.equal(early.coordinates.recordObservation(moved, observationOf(HASH_B), true, HASH_B), true);
  const verifiedState = early.row(moved);
  early.db.close();

  const restarted = world(t, path);
  assert.equal(restarted.coordinates.recordObservation(moved, observationOf(HASH_A), true, HASH_A), false);
  assert.deepEqual(restarted.row(moved), verifiedState);
  assert.equal(restarted.coordinates.verifiedOwnerOf(HASH_B), moved);
});

test('a readback failure followed by recovery makes no second handoff and no second broadcast', (t) => {
  const path = tempPath(t);
  const before = world(t, path);
  const operationId = before.purchase('readback', 2);
  before.coordinates.reportHash(operationId, HASH_A);
  const saved = before.row(operationId);
  assert.equal(saved.handoffs, 1);

  // The readback of A fails: nothing is recorded, and nothing may re-save the coordinates.
  assert.throws(() => transaction(before.db, () => {
    before.coordinates.recordObservation(operationId, observationOf(HASH_A), true, HASH_A);
    throw new Error('TEST readback failed after the write');
  }), /TEST readback failed/);
  assert.deepEqual(before.row(operationId), saved);
  before.db.close();

  const recovered = world(t, path);
  assert.throws(() => recovered.coordinates.save({ operationId, kind: 'purchase', network: NETWORK, from: WALLET, nonceFence: 9, expectedNonce: 10, target: 'wallet-seller', payload: { again: true } }), isUniqueViolation);
  assert.equal(recovered.coordinates.recordObservation(operationId, observationOf(HASH_A), true, HASH_A), true);
  const after = recovered.row(operationId);
  assert.equal(after.handoffs, 1, 'recovery counts no second handoff');
  assert.equal(after.payload_hash, saved.payload_hash, 'the broadcast payload is the stored one');
  assert.equal(after.reported_tx_hash, HASH_A);
  assert.equal(recovered.db.prepare('SELECT COUNT(*) AS n FROM write_coordinates').get().n, 1);
});
