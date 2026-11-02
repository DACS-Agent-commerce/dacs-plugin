import { test } from 'node:test';
import assert from 'node:assert/strict';
// The payment-path assertion shapes of devnet-operator-seller-disposition-prefixed.
// CI_RUNNER_EFFECTS: "creates,payments" after the first purchase; CI_RUNNER_ATTEMPT:
// the name of an error thrown in the interrupt phase, or none.
const [creates, payments] = (process.env.CI_RUNNER_EFFECTS ?? '5,1').split(',').map(Number);
test('effects after the first purchase', () => {
  assert.deepEqual({ creates, payments }, { creates: 5, payments: 1 });
});
test('no error in any phase', () => {
  const name = process.env.CI_RUNNER_ATTEMPT;
  assert.equal(name ? { name, code: null, phase: 'interrupt' } : null, null);
});
