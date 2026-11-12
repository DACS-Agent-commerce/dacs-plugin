// src/purchase-guidance.mjs presents the client's public status guidance and ports none of its text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PURCHASE_STATUS_HELP, networkIdentityLabel, purchaseNext } from '@kynesyslabs/dacs-client';
import * as guidance from '../src/purchase-guidance.mjs';

// Every status the client's purchase store can hold.
const STATUSES = ['agreement_pending', 'agreement_rejected', 'awaiting_approval', 'approved', 'payment_handoff', 'broadcast_reported',
  'payment_uncertain', 'settled_verified', 'payment_failed', 'payment_mismatch', 'expired', 'terms_changed', 'superseded', 'cancelled'];

test('every purchase status the client can return has the carried guidance text', () => {
  assert.deepEqual(Object.keys(PURCHASE_STATUS_HELP).sort(), [...STATUSES].sort());
  for (const status of STATUSES) {
    const text = guidance.statusGuidance(status);
    assert.equal(text, PURCHASE_STATUS_HELP[status], status);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, status);
    assert.notEqual(text, guidance.STATUS_UNKNOWN_GUIDANCE, `${status} is known`);
    assert.equal(guidance.nextStepGuidance({ status }), purchaseNext({ status }), status);
  }
  assert.equal(guidance.networkIdentityLabel, networkIdentityLabel);
  assert.equal(guidance.networkIdentityLabel({ chainIdentity: 'abc' }), 'genesis abc');
  assert.equal(guidance.networkIdentityLabel(null), 'unbound');
});

test('an unknown status gets the fixed status-unknown guidance and never reads as approved, paid or settled', () => {
  for (const status of ['settled', 'paid', 'toString', 'constructor', '__proto__', '', 'APPROVED', undefined, null, 42, {}]) {
    assert.equal(guidance.statusGuidance(status), guidance.STATUS_UNKNOWN_GUIDANCE, String(status));
  }
  assert.equal(guidance.nextStepGuidance({ status: 'settled' }), guidance.STATUS_UNKNOWN_GUIDANCE);
  assert.equal(guidance.nextStepGuidance({ status: 'toString' }), guidance.STATUS_UNKNOWN_GUIDANCE);
  assert.doesNotMatch(guidance.STATUS_UNKNOWN_GUIDANCE, /approved|paid|settled|delivered|success/i);
});
