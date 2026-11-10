/**
 * The real DemosChain.openWallet runs the caller's recheck after the node connection and before
 * the SDK loads the key. Only the SDK's connect and connectWallet are replaced, by recording doubles.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Demos } from '@kynesyslabs/demosdk/websdk';
import { DemosChain } from '../../src/chain.js';
import { loadConfig } from '../../src/config.js';
import { SecretGuard } from '../../src/secrets.js';
import { createLegacyWalletOpener } from '../../src/wallet-policy.js';
import { MNEMONIC } from '../helpers.js';

const KEY_LOAD_REACHED = 'the SDK key load was reached';
const RECHECK_REFUSED = 'recheck refused';

/** Replaces the SDK's connect and connectWallet; `connect` resolves when `releaseConnect` is called. */
function sdkDoubles(t: TestContext) {
  const order: string[] = [];
  let releaseConnect: () => void = () => {};
  t.mock.method(Demos.prototype, 'connect', async () => {
    order.push('connect');
    await new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    return true;
  });
  t.mock.method(Demos.prototype, 'connectWallet', async () => {
    order.push('connectWallet');
    throw new Error(KEY_LOAD_REACHED);
  });
  return { order, releaseConnect: () => releaseConnect() };
}

function newChain() {
  return new DemosChain('http://127.0.0.1:1', new SecretGuard());
}

test('the real openWallet runs the recheck after connecting and before the key loads', async (t) => {
  const sdk = sdkDoubles(t);
  const opening = newChain().openWallet(MNEMONIC, () => sdk.order.push('recheck'));
  sdk.releaseConnect();
  await assert.rejects(opening, new RegExp(KEY_LOAD_REACHED));
  assert.deepEqual(sdk.order, ['connect', 'recheck', 'connectWallet']);
});

test('a recheck that throws stops the real openWallet before connectWallet runs', async (t) => {
  const sdk = sdkDoubles(t);
  const opening = newChain().openWallet(MNEMONIC, () => {
    throw new Error(RECHECK_REFUSED);
  });
  sdk.releaseConnect();
  await assert.rejects(opening, new RegExp(RECHECK_REFUSED));
  assert.deepEqual(sdk.order, ['connect']);
});

function openerWithWrites() {
  const dir = mkdtempSync(join(tmpdir(), 'open-wallet-recheck-'));
  writeFileSync(join(dir, 'mnemonic'), MNEMONIC, { mode: 0o600 });
  const config = loadConfig({ DEMOS_MCP_ENABLE_WRITES: '1', DEMOS_STATE_DIR: dir, DEMOS_MNEMONIC_FILE: join(dir, 'mnemonic') });
  config.rpcIsKnownTestnet = true;
  const open = createLegacyWalletOpener(config, new SecretGuard(), newChain());
  return { dir, config, open };
}

const MARKERS: Record<string, (dir: string, config: ReturnType<typeof loadConfig>) => void> = {
  STOP: (dir) => writeFileSync(join(dir, 'STOP'), ''),
  KILL: (dir) => writeFileSync(join(dir, 'KILL'), ''),
  'purchase-only': (dir, config) => {
    config.keystorePath = join(dir, 'wallet.keystore.json');
    writeFileSync(`${config.keystorePath}.purchase-only`, '');
  },
};

for (const [name, addMarker] of Object.entries(MARKERS)) {
  test(`a ${name} marker added while the node connection is pending means the key load is never reached`, async (t) => {
    const sdk = sdkDoubles(t);
    const { dir, config, open } = openerWithWrites();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const opening = open();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sdk.order, ['connect'], 'control: the connection is pending');
    addMarker(dir, config);
    sdk.releaseConnect();
    await assert.rejects(opening, (e: Error) => e.message !== KEY_LOAD_REACHED && /Writes are stopped|purchase-only wallet/.test(e.message));
    assert.deepEqual(sdk.order, ['connect']);
  });
}

test('without a marker the real opener goes on to the key load after the connection', async (t) => {
  const sdk = sdkDoubles(t);
  const { dir, open } = openerWithWrites();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opening = open();
  await new Promise<void>((resolve) => setImmediate(resolve));
  sdk.releaseConnect();
  await assert.rejects(opening, new RegExp(KEY_LOAD_REACHED));
  assert.deepEqual(sdk.order, ['connect', 'connectWallet']);
});
