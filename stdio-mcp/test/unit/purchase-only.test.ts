/**
 * Purchase-only wallet mode: the legacy tools can read, but cannot load the key
 * or sign. The fence is rechecked at each use, not only at startup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, ADDR_B } from '../helpers.js';
import { loadConfig, writeBlocker } from '../../src/config.js';
import { createLegacyWalletOpener } from '../../src/wallet-policy.js';
import { SecretGuard } from '../../src/secrets.js';

const FENCED = /purchase-only wallet: legacy signing is disabled/;

function countingChain() {
  const calls: string[] = [];
  return { calls, chain: { openWallet: async (m: string) => (calls.push(m), {} as any) } };
}

test('purchase-only mode leaves read tools available but refuses legacy key loading', async () => {
  const h = await harness({ DEMOS_WALLET_MODE: 'purchase-only' });
  assert.equal(h.config.purchaseOnly, true);
  assert.equal((await h.call('demos_network_info')).isError, false);
  assert.equal((await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' })).isError, true);
  assert.equal(h.wallet.prepares, 0);
  const { calls, chain } = countingChain();
  await assert.rejects(createLegacyWalletOpener(h.config, new SecretGuard(), chain)(), FENCED);
  assert.deepEqual(calls, []);
});

test('a keystore fenced after a legacy transfer was prepared blocks that transfer before signing', async () => {
  const h = await harness();
  const key = join(h.config.stateDir, 'wallet.keystore.json');
  writeFileSync(key, 'synthetic placeholder');
  h.config.keystorePath = key;
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(p.isError, false, p.text);
  const code = h.channel.last().code;
  writeFileSync(`${key}.purchase-only`, '');
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: code });
  assert.equal(r.isError, true);
  assert.match(r.text, FENCED);
  assert.equal(h.wallet.prepares, 0);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('the policy recheck blocks an already-open wallet before the SDK prepares anything', async () => {
  let opens = 0;
  const h = await harness({}, { openWallet: async () => (opens++, h.wallet) });
  assert.equal((await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' })).isError, false);
  assert.equal(opens, 1, 'control: prepare opened the wallet');
  h.config.keystorePath = join(h.config.stateDir, 'wallet.keystore.json');
  writeFileSync(`${h.config.keystorePath}.purchase-only`, '');
  const r = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(r.isError, true);
  assert.match(r.text, FENCED);
  assert.equal(opens, 1);
  assert.equal(h.wallet.prepares, 0);
});

test('the production opener rechecks stop markers and policy each time, before loading a key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'purchase-only-'));
  const config = loadConfig({ DEMOS_MCP_ENABLE_WRITES: '1', DEMOS_STATE_DIR: dir, DEMOS_MNEMONIC_FILE: join(dir, 'missing') });
  config.rpcIsKnownTestnet = true;
  const { calls, chain } = countingChain();
  const open = createLegacyWalletOpener(config, new SecretGuard(), chain);
  // control: with no fence the opener goes on to key loading (here: a missing file)
  await assert.rejects(open(), (e: Error) => !FENCED.test(e.message) && e.message !== 'Writes are stopped');
  writeFileSync(join(dir, 'STOP'), '');
  await assert.rejects(open(), /^Error: Writes are stopped$/);
  rmSync(join(dir, 'STOP'));
  config.purchaseOnly = true;
  await assert.rejects(open(), FENCED);
  assert.deepEqual(calls, []);
});

test('every registered legacy write tool refuses before key loading', async () => {
  let opens = 0;
  const h = await harness({}, { openWallet: async () => (opens++, h.wallet) });
  const { tools } = await h.client.listTools();
  const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
  assert.ok(writes.includes('demos_tx_prepare') && writes.includes('demos_tx_submit'), 'control: the write tools are registered');
  h.config.keystorePath = join(h.config.stateDir, 'wallet.keystore.json');
  writeFileSync(`${h.config.keystorePath}.purchase-only`, '');
  for (const name of writes) await h.call(name, {});
  const r = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(r.isError, true);
  assert.match(r.text, FENCED);
  assert.equal(opens, 0);
  assert.equal(h.wallet.prepares, 0);
});

test('a marker beside a symlinked keystore path, or beside its target, fences the wallet', () => {
  for (const besideLink of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'purchase-only-'));
    const config = loadConfig({ DEMOS_MCP_ENABLE_WRITES: '1', DEMOS_STATE_DIR: dir, DEMOS_CONFIRM_CHANNELS: 'stderr' });
    config.rpcIsKnownTestnet = true;
    mkdirSync(join(dir, 'secrets'));
    const target = join(dir, 'secrets', 'wallet.keystore.json'), link = join(dir, 'wallet.keystore.json');
    writeFileSync(target, 'synthetic placeholder');
    symlinkSync(target, link);
    config.keystorePath = link;
    assert.equal(writeBlocker(config), null);
    writeFileSync(`${besideLink ? link : target}.purchase-only`, '');
    assert.match(writeBlocker(config)!, FENCED);
  }
});

test('a marker that is a symlink to a missing target still blocks a prepared transfer before signing', async () => {
  const h = await harness();
  const key = join(h.config.stateDir, 'wallet.keystore.json');
  writeFileSync(key, 'synthetic placeholder');
  h.config.keystorePath = key;
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(p.isError, false, p.text);
  const code = h.channel.last().code;
  symlinkSync(join(h.config.stateDir, 'missing-target'), `${key}.purchase-only`);
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: code });
  assert.equal(r.isError, true);
  assert.match(r.text, FENCED);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('DEMOS_WALLET_MODE accepts only unset or purchase-only, and never echoes the value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'purchase-only-'));
  assert.equal(loadConfig({ DEMOS_STATE_DIR: dir }).purchaseOnly, false);
  assert.equal(loadConfig({ DEMOS_STATE_DIR: dir, DEMOS_WALLET_MODE: '' }).purchaseOnly, false);
  assert.equal(loadConfig({ DEMOS_STATE_DIR: dir, DEMOS_WALLET_MODE: 'purchase-only' }).purchaseOnly, true);
  for (const value of ['PURCHASE-ONLY', 'purchase-onlly', '${purchase-only}', '${DEMOS_WALLET_MODE}', 'x'.repeat(100_000)]) {
    assert.throws(
      () => loadConfig({ DEMOS_STATE_DIR: dir, DEMOS_MCP_ENABLE_WRITES: '1', DEMOS_WALLET_MODE: value }),
      (e: Error) => e.message === 'DEMOS_WALLET_MODE must be unset or purchase-only' && !e.message.includes(value),
    );
  }
});
