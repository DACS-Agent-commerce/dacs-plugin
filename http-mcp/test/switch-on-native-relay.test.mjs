// SDK purchases on: the native wallet relay is not mounted. It needs the client's registered transport, which today
// only a node wallet session holding a buyer key provides; the server holds no buyer key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVNET_NATIVE_RPC_PATH } from '@kynesyslabs/dacs-client';
import { requireNativeRelayParts } from '../src/sdk/switch-on.mjs';
import { switchOnHarness } from './helpers/switch-on-world.mjs';

test('with the switch on the native wallet relay stays unmounted, and its parts guard refuses sdk_part_missing naming P19 stopped and P19f feeCeilingOs', async (t) => {
  assert.throws(() => requireNativeRelayParts(), (error) => error.code === 'sdk_part_missing' && error.message === 'sdk_part_missing: P19 stopped; P19f feeCeilingOs');
  const { h } = await switchOnHarness(t);
  assert.equal((await fetch(`${h.origin}${DEVNET_NATIVE_RPC_PATH}`)).status, 404);
});
