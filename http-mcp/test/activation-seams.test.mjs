// The SDK purchase parts read from the client namespace, and the refusal object handed on in place of a purchase reader or service.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as installedClient from '@kynesyslabs/dacs-client';
import { createRefusalObject, readActivationSeams } from '../src/sdk/activation-seams.mjs';
import { OperationError } from '../src/operations.mjs';

const RECORDER = { part: 'P19r', name: 'createPurchaseEvidenceRecorder' };

test('the activation seams read the evidence recorder only from its subpath namespace and name it as missing when that is absent', () => {
  const installed = readActivationSeams();
  assert.equal(installed.evidenceRecorderFactory, null);
  assert.deepEqual(installed.missing, [RECORDER]);
  const recorderFactory = () => ({});
  const rootOnly = readActivationSeams({ ...installedClient, createPurchaseEvidenceRecorder: recorderFactory });
  assert.equal(rootOnly.evidenceRecorderFactory, null, 'a root export is not the recorder subpath');
  assert.deepEqual(rootOnly.missing, [RECORDER]);
  const subpath = readActivationSeams(installedClient, { recorderNamespace: { createPurchaseEvidenceRecorder: recorderFactory } });
  assert.equal(subpath.evidenceRecorderFactory, recorderFactory);
  assert.deepEqual(subpath.missing, []);
  assert.deepEqual(readActivationSeams(installedClient, { recorderNamespace: null }).missing, [RECORDER], 'an absent subpath');
  assert.deepEqual(readActivationSeams(installedClient, { recorderNamespace: { createPurchaseEvidenceRecorder: 'not a function' } }).missing, [RECORDER],
    'a non-function under the name is absent');
});

test('the refusal object has exactly the listed names; passive names refuse not_configured naming the missing part and active names refuse sdk_purchases_off, with no state kept', async () => {
  const passive = ['status', 'portalOperation'];
  const active = ['prepare', 'cancel', 'reportWalletResult'];
  const refusal = createRefusalObject({ passive, active, missing: RECORDER });
  assert.deepEqual(Object.keys(refusal).sort(), [...passive, ...active].sort());
  assert.ok(Object.isFrozen(refusal));
  for (const name of passive) {
    // A passive reader answers synchronously, so its refusal is thrown at the call, which also rejects an awaiting caller.
    assert.throws(() => refusal[name]({ operationId: 'op_1' }), (error) => error instanceof OperationError && error.code === 'not_configured' && error.message === 'sdk_part_missing: P19r createPurchaseEvidenceRecorder', name);
  }
  const partOnly = createRefusalObject({ passive: ['status'], active: [], missing: { part: 'P19' } });
  assert.throws(() => partOnly.status(), (error) => error.code === 'not_configured' && error.message === 'sdk_part_missing: P19' && error.details.name === undefined, 'a part with no public name is named by its part alone');
  for (const name of active) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(refusal[name]({ operationId: 'op_1' }), (error) => error instanceof OperationError && error.code === 'sdk_purchases_off', name);
    }
  }
  assert.deepEqual(Object.keys(refusal).sort(), [...passive, ...active].sort(), 'refusing changes nothing on the object');
});

test('a name listed as both passive and active is refused when the refusal object is built', () => {
  assert.throws(() => createRefusalObject({ passive: ['status'], active: ['status'], missing: RECORDER }), TypeError);
});
