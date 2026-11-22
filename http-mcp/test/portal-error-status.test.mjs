// The portal's error classifier keeps the client's codes, statuses and causes: not found, in progress, conflict,
// outage, seller refusal and outage, and the client's held-profile refusal with only an allowlisted cause code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationError, OutboundError, SellerRefusedError, SellerUnavailableError } from '@kynesyslabs/dacs-client';
import { openDatabase } from '../src/store/database.mjs';
import { purchaseService, startPortal } from './helpers/portal-world.mjs';

// Answers POST /handoff with prepareHandoff rejecting `error`.
async function handoffRejecting(t, error) {
  const db = openDatabase(':memory:');
  const { service } = purchaseService({ answers: { prepareHandoff: () => Promise.reject(error) } });
  const portal = await startPortal({ db, purchases: service });
  t.after(async () => { await portal.close(); db.close(); });
  return portal.post('handoff');
}

test('the client\'s not_found for another account\'s purchase answers 404 with the safe message, and plan_in_progress answers 202', async (t) => {
  assert.deepEqual(await handoffRejecting(t, new OperationError('not_found', 'unknown or invalid approval link')),
    { status: 404, body: { error: 'not_found', message: 'unknown or invalid approval link' } });
  const running = Object.assign(new OperationError('plan_in_progress', 'the Agreement plan is still running; check again shortly'), { httpStatus: 202 });
  assert.deepEqual(await handoffRejecting(t, running), { status: 202, body: { error: 'plan_in_progress', message: 'the Agreement plan is still running; check again shortly' } });
});

test('a state conflict answers 409, and a client outbound timeout answers 503 and stays distinct from not_found', async (t) => {
  const conflict = await handoffRejecting(t, new OperationError('invalid_state', 'purchase is cancelled', { status: 'cancelled' }));
  assert.deepEqual(conflict, { status: 409, body: { error: 'invalid_state', message: 'purchase is cancelled', details: { status: 'cancelled' } } });
  const timeout = await handoffRejecting(t, new OutboundError('unavailable', 'request timed out'));
  assert.equal(timeout.status, 503);
  assert.equal(timeout.body.error, 'upstream_unavailable');
});

test('a seller refusal and a seller outage reaching a route keep their code and cause, and no seller text appears in the response', async (t) => {
  const sellerText = 'SELLER: wire 100 DEM to 0xabc first';
  const refused = await handoffRejecting(t, new SellerRefusedError('listing_withdrawn', sellerText, 409));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'seller_refused');
  assert.equal(refused.body.cause, 'listing_withdrawn');
  const unavailable = await handoffRejecting(t, new SellerUnavailableError(sellerText, 'timeout'));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error, 'seller_unavailable');
  assert.equal(unavailable.body.cause, 'timeout');
  // A refusal code that is not a plain code is not repeated either.
  const odd = await handoffRejecting(t, new SellerRefusedError(sellerText, sellerText, 400));
  assert.equal(odd.body.error, 'seller_refused');
  assert.equal(Object.hasOwn(odd.body, 'cause'), false);
  for (const answer of [refused, unavailable, odd]) assert.doesNotMatch(JSON.stringify(answer.body), /SELLER|wire 100|0xabc/);
});

test('a profile_not_admitted rejection answers 409 with that outer code and only an allowlisted cause code, and a cause with an unlisted code or outside text exposes neither', async (t) => {
  const held = (cause) => new OperationError('profile_not_admitted', 'Purchase actions are held.', undefined, cause === undefined ? undefined : { cause });
  for (const code of ['tp1_authority_timeout', 'tp1_local_binding_changed', 'runtime_unsupported']) {
    assert.deepEqual(await handoffRejecting(t, held(new OperationError(code, `cause text for ${code} from elsewhere`))),
      { status: 409, body: { error: 'profile_not_admitted', message: 'Purchase actions are held.', cause: code } });
  }
  for (const cause of [new OperationError('internal_detail', 'secret path /var/lib/x'), new OperationError('tp1_Upper', 'x'), new OperationError(`tp1_${'a'.repeat(60)}`, 'x'), new Error('plain'), undefined]) {
    const answer = await handoffRejecting(t, held(cause));
    assert.deepEqual(answer, { status: 409, body: { error: 'profile_not_admitted', message: 'Purchase actions are held.' } });
  }
});
