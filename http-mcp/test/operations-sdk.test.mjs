// operations.mjs takes canonicalize from the core package and the seller-session transition from the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationStore, requestHashOf } from '../src/operations.mjs';
import { openDatabase } from '../src/store/database.mjs';

// sha256 of the request's RFC 8785 text, computed outside the repository for each request.
const REQUEST_HASH_VECTORS = [
  [{ listingId: 'listing-1', version: 1, seller: 'seller.example', wallet: 'wallet-buyer' }, '070816b317ecf5b8a30e22475bdfe5992280e139053d529a4750c85a93f6bb0c'],
  [{ wallet: 'wallet-buyer', listingId: 'listing-1', version: 1, seller: 'seller.example', protocol: 'offline-agreement' }, 'e99a5cabacd676452e1bdef96d6109291f68ee9f72216c89d9df58ad1e864ba1'],
  [{ identity: { b: [3, 2, 1], a: 'été', z: null }, count: 10 }, 'a7dd1c68226a3a3207db452e38cbf5ca1961bca72d5204d658be2cc62911434e'],
];

test('operation request hashes are unchanged after canonicalize moves to core', () => {
  for (const [request, expected] of REQUEST_HASH_VECTORS) assert.equal(requestHashOf(request), expected);
});

test('the client\'s seller-session transition keeps the session lifetime markers', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let clock = Date.UTC(2026, 0, 1);
  const ops = createOperationStore({ db, handoffSecret: 'h'.repeat(40), now: () => clock });
  db.prepare("INSERT INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES ('account', 'issuer', 'subject', 'then')").run();
  const { operation } = ops.createIdempotent({
    accountId: 'account', kind: 'purchase', idempotencyKey: 'session-key', request: { session: 1 }, status: 'awaiting_approval', terms: {}, termsHash: 'terms-hash',
    expiresAt: new Date(clock + 3_600_000).toISOString(),
    state: { protocol: { sessionDelegation: { payload: { expiresAt: clock + 7_200_000 } } } },
  });

  clock += 1_000;
  const ended = ops.transition(operation.id, 'awaiting_approval', 'expired');
  assert.equal(ended.state.protocol.sellerSessionFinalAt, clock);

  const endedAt = clock;
  clock += 5_000;
  const stillEnded = ops.transition(operation.id, 'expired', 'superseded');
  assert.equal(stillEnded.state.protocol.sellerSessionFinalAt, endedAt, 'the first end time stays');
  assert.deepEqual(stillEnded.state.protocol.sessionDelegation, ended.state.protocol.sessionDelegation);

  clock += 5_000;
  const reopened = ops.transition(operation.id, 'superseded', 'awaiting_approval');
  assert.equal(reopened.state.protocol.sellerSessionFinalAt, undefined, 'a return to unresolved work clears the marker');
});
