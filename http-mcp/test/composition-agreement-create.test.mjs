// With SDK purchases on, the client's Agreement CREATE has one way out: the CREATE delivery and its challenge, claim
// and pass routes. createApp refuses every option of the in-process brokers it no longer composes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';
import { NODE_ORIGIN, switchOnHarness, switchedOn } from './helpers/switch-on-world.mjs';

const REMOVED_OPTIONS = ['dacsProtocol', 'nativeWalletTransport', 'devnetAgreementTransport', 'offlineAgreementBroker'];

test('with the switch on, the client\'s Agreement CREATE goes only to the delivery adapter, and composing any old broker option is refused', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'create-only-delivery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir };
  const config = switchedOn({ chain: { rpcUrl: NODE_ORIGIN, network: 'demos-testnet', timeoutMs: 1000 } })(loadConfig(env));
  for (const name of REMOVED_OPTIONS) {
    await assert.rejects(createApp({ config, logger: createLogger({ level: 'error', sink: () => {} }), [name]: {} }),
      (error) => error instanceof TypeError && error.message.includes(name), name);
  }
  assert.deepEqual(readdirSync(dataDir), [], 'refused before the database was opened');

  const { h } = await switchOnHarness(t, { env: { DACS_INTENT_APPROVAL: 'on' } });
  // The CREATE delivery's own routes answer: a body that is not its exact canonical JSON is refused invalid_request.
  for (const route of ['challenge', 'claim', 'pass']) {
    const response = await fetch(`${h.origin}/portal/api/purchase/pur_AAAAAAAAAAAAAAAA/agreement-create/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([response.status, (await response.json()).error], [400, 'invalid_request'], route);
  }
});
