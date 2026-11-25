import test from 'node:test';
import assert from 'node:assert/strict';
import { NotConfiguredError } from '@kynesyslabs/dacs-client';
import { createIdentityActions, createIdentityService } from '../src/identities.mjs';

test('identity reads without a chain refuse not_configured through the client\'s NotConfiguredError', async () => {
  const service = createIdentityService({ chain: null, accounts: { listWallets: () => [] } });
  assert.equal(service.capability(), 'not_configured');
  const read = await service.observe({ accountId: 'TEST-account' }).then(() => null, (error) => error);
  assert.ok(read instanceof NotConfiguredError, 'the client\'s error class');
  assert.equal(read.code, 'not_configured');
  const actions = createIdentityActions({ config: { identityWrites: 'simulated-fixture-only' }, ops: {}, accounts: {}, coordinates: {}, chain: null });
  const start = await actions.start({ accountId: 'TEST-account', kind: 'github' }).then(() => null, (error) => error);
  assert.ok(start instanceof NotConfiguredError);
  assert.equal(start.code, 'not_configured');
});
