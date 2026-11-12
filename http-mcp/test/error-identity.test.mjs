// The plugin's error classes are the client's: its own throw paths raise the client's classes, so the plugin's
// classifiers and the client's recovery branches recognise one another's errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationError as ClientOperationError, OutboundError as ClientOutboundError, WalletFormatError as ClientWalletFormatError } from '@kynesyslabs/dacs-client';
import { OperationError, createOperationStore } from '../src/operations.mjs';
import { OutboundError, fetchBoundedJson } from '../src/util/http.mjs';
import { WalletFormatError, decodeSignature, normalizeDemosAddress } from '../src/wallet/demos-signature.mjs';
import { openDatabase } from '../src/store/database.mjs';

const MAX_BYTES = 64;
const jsonResponse = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const fetchBounded = (fetchImpl) => fetchBoundedJson('https://upstream.example/data', { fetchImpl, timeoutMs: 1_000, maxBytes: MAX_BYTES });

function operationStore(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO accounts (id, auth_issuer, auth_subject, created_at) VALUES ('account', 'issuer', 'subject', 'then')").run();
  return { db, ops: createOperationStore({ db, handoffSecret: 'h'.repeat(40), now: () => Date.UTC(2026, 0, 1) }) };
}

const createPurchase = (ops, request) => ops.createIdempotent({
  accountId: 'account', kind: 'purchase', idempotencyKey: 'same-key', request, status: 'awaiting_approval', terms: {}, termsHash: 'terms-hash',
  expiresAt: new Date(Date.UTC(2026, 0, 1) + 3_600_000).toISOString(),
});

// What the client's own recovery does around a host-store transition: it takes a refusal with this code
// for a concurrent caller having moved the operation and reads the current state instead.
function clientMove(ops, operation, toStatus) {
  try {
    return ops.transition(operation.id, operation.status, toStatus);
  } catch (error) {
    if (error instanceof ClientOperationError && error.code === 'invalid_state') return ops.get(operation.accountId, operation.id);
    throw error;
  }
}

test('the plugin\'s own throw paths raise the client\'s classes with their code or kind: a malformed address and a malformed signature (WalletFormatError), an idempotency conflict (OperationError idempotency_conflict), an outbound timeout, an oversized reply and malformed JSON (OutboundError unavailable and invalid), and instanceof holds across the SDK boundary', async (t) => {
  assert.equal(OperationError, ClientOperationError);
  assert.equal(OutboundError, ClientOutboundError);
  assert.equal(WalletFormatError, ClientWalletFormatError);

  const wallet = (run) => assert.throws(run, (error) => error instanceof ClientWalletFormatError && Object.getPrototypeOf(error) === ClientWalletFormatError.prototype);
  wallet(() => normalizeDemosAddress('0x1234'));
  wallet(() => decodeSignature('not a signature'));

  const { ops } = operationStore(t);
  createPurchase(ops, { listing: 'one' });
  assert.throws(() => createPurchase(ops, { listing: 'two' }), (error) => error instanceof ClientOperationError
    && Object.getPrototypeOf(error) === ClientOperationError.prototype && error.code === 'idempotency_conflict');

  const outbound = (run, kind, message) => assert.rejects(run, (error) => error instanceof ClientOutboundError
    && Object.getPrototypeOf(error) === ClientOutboundError.prototype && error.kind === kind && error.message === message);
  await outbound(() => fetchBounded(async () => { throw new DOMException('too slow', 'TimeoutError'); }), 'unavailable', 'request timed out');
  await outbound(() => fetchBounded(async () => jsonResponse(JSON.stringify({ pad: 'x'.repeat(MAX_BYTES) }))), 'invalid', 'response exceeds byte limit');
  await outbound(() => fetchBounded(async () => jsonResponse('{"truncated":')), 'invalid', 'upstream returned malformed JSON');
});

test('an invalid_state thrown by the plugin operation store inside the client\'s recovery branch is handled there with its code and cause, and is not turned into a 500', (t) => {
  const { ops } = operationStore(t);
  const { operation } = createPurchase(ops, { listing: 'one' });
  ops.transition(operation.id, 'awaiting_approval', 'expired');

  let refusal;
  assert.throws(() => ops.transition(operation.id, 'awaiting_approval', 'approved'), (error) => { refusal = error; return true; });
  assert.ok(refusal instanceof ClientOperationError);
  assert.equal(refusal.code, 'invalid_state');
  assert.deepEqual(refusal.details, { status: 'expired' }, 'the cause (the status that won) is kept');

  const stale = { ...operation, status: 'awaiting_approval' };
  const current = clientMove(ops, stale, 'approved');
  assert.equal(current.status, 'expired', 'the branch returns the state the other caller left');

  assert.throws(() => clientMove(ops, { ...stale, id: 'missing-operation' }, 'approved'), (error) => error instanceof ClientOperationError && error.code === 'not_found', 'other codes are not swallowed');
});
