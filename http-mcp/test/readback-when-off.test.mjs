// With SDK purchases off, routes and tools get a refusal object in place of the client's purchase service: it keeps
// the service's member names, its passive readers answer not_configured and every purchase action sdk_purchases_off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.mjs';
import { databaseRows } from './helpers/database-rows.mjs';

// The client purchase service's passive readers (named in its createPurchaseService documentation) and its other
// members, every one a purchase action.
const PASSIVE = ['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning'];
const ACTIVE = ['prepare', 'issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane', 'reportWalletResult', 'cancel',
  'agreementIdentity', 'agreementPlan', 'agreementSubmit', 'completionRequest', 'completionCountersign', 'protocolRecheck'];
// Members of the client's protocol object, which the off composition does not hand on at all.
const ABSENT = ['holdChainReadback', 'assertBuyerAccess', 'readIssued', 'readIssuedPayment', 'observeReportedPayment'];
const PURCHASE = { operationId: 'pur_AAAAAAAAAAAAAAAA', token: 'handoff-token', accountId: 'acct_1' };

test('the object the off composition passes to routes and tools has exactly the client\'s passive purchase methods; every active name (cancel, reportWalletResult, protocolRecheck, holdChainReadback and the rest of the inventory) is absent or refuses sdk_purchases_off with zero state change', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const { purchases } = h.app.services;
  assert.ok(Object.isFrozen(purchases));
  assert.deepEqual(Object.keys(purchases).sort(), [...PASSIVE, ...ACTIVE].sort(), 'no member beyond the client service\'s own');
  for (const name of ABSENT) assert.equal(purchases[name], undefined, name);

  const before = databaseRows(h.app.db);
  for (const name of PASSIVE) {
    assert.throws(() => purchases[name](PURCHASE.operationId, PURCHASE.token), (error) => error.code === 'not_configured' && error.message === 'sdk_part_missing: P19', name);
  }
  for (const name of ACTIVE) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(purchases[name](PURCHASE), (error) => error.code === 'sdk_purchases_off', `${name}, call ${attempt + 1}`);
    }
  }
  assert.equal(databaseRows(h.app.db), before, 'no refusal changed the database');
  assert.deepEqual(Object.keys(purchases).sort(), [...PASSIVE, ...ACTIVE].sort(), 'refusing changes nothing on the object');
});
