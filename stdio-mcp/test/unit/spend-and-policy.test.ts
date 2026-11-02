import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, ADDR_B, ADDR_C } from '../helpers.js';
import { loadConfig, writeBlocker } from '../../src/config.js';

test('spend cap is enforced before signing (wallet never asked to prepare)', async () => {
  const h = await harness({ DEMOS_DAILY_CAP_DEM: '5' });
  const r = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '4' }); // 4 + ~2 fee > 5
  assert.equal(r.isError, true);
  assert.match(r.text, /cap/);
  assert.equal(h.wallet.prepares, 0, 'cap must be checked before the wallet signs anything');
});

test('spend cap accumulates across confirmed writes and persists in the ledger', async () => {
  const h = await harness({ DEMOS_DAILY_CAP_DEM: '7' });
  const a = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '2' }); // 2 + 2 fee = 4
  await h.call('demos_tx_submit', { prepared_id: a.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(h.ledger.spentToday(), 4_000_000_000n);
  const b = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '2' }); // would be 8 > 7
  assert.equal(b.isError, true);
  assert.match(b.text, /3 DEM of today's 7 DEM cap remains/);
  // next UTC day resets
  h.setNow(Date.parse('2026-10-06T00:00:01Z'));
  const c = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '2' });
  assert.equal(c.isError, false, c.text);
});

test('cap is re-checked at submit (another write may have spent in between)', async () => {
  const h = await harness({ DEMOS_DAILY_CAP_DEM: '6' });
  const a = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '3' }); // 5
  const code = h.channel.last().code;
  h.ledger.reserve(2_000_000_000n, 'external'); // simulate spend recorded meanwhile
  const r = await h.call('demos_tx_submit', { prepared_id: a.json.prepared_id, confirmation_code: code });
  assert.equal(r.isError, true);
  assert.match(r.text, /cap/);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('a corrupted ledger blocks writes (fail closed)', async () => {
  const h = await harness();
  writeFileSync(join(h.config.stateDir, 'spend-ledger.json'), '{not json');
  const r = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /ledger/);
});

test('recipient allow-list', async () => {
  const h = await harness({ DEMOS_RECIPIENT_ALLOWLIST: ADDR_B });
  const bad = await h.call('demos_tx_prepare', { to: ADDR_C, amount_dem: '1' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /allow-list/);
  const good = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(good.isError, false, good.text);
});

test('amount validation: exactly one unit, positive, strict decimals', async () => {
  const h = await harness();
  for (const args of [
    { to: ADDR_B },
    { to: ADDR_B, amount_dem: '1', amount_os: '1' },
    { to: ADDR_B, amount_dem: '-1' },
    { to: ADDR_B, amount_dem: '1e3' },
    { to: ADDR_B, amount_dem: '0.0000000001' },
    { to: ADDR_B, amount_dem: '0' },
    { to: 'not-an-address', amount_dem: '1' },
  ]) {
    const r = await h.call('demos_tx_prepare', args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(h.wallet.prepares, 0);
});

test('node rejection at confirm (signed bytes already sent) broadcasts nothing but keeps the reservation', async () => {
  const h = await harness();
  h.wallet.nextValid = false;
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(p.isError, false);
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r.json.status, 'unknown');
  assert.match(r.json.warning, /Outcome unknown/);
  assert.equal(h.wallet.broadcasts.length, 0);
  assert.equal(h.ledger.spentToday(), 3_000_000_000n);
});

test('a confirmed fee above the approved quote is not broadcast', async () => {
  const h = await harness();
  h.wallet.feeOs = 5_000_000_000n; // node now charges 5 DEM; the human approved a 2 DEM quote
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r.isError, true);
  assert.match(r.text, /not transmitted/);
  assert.equal(h.wallet.broadcasts.length, 0);
  assert.equal(h.ledger.spentToday(), 0n);
});

test('a lower actual fee releases the unused part of the reservation', async () => {
  const h = await harness();
  h.wallet.feeOs = 1_000_000_000n;
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(h.ledger.spentToday(), 2_000_000_000n);
});

test('kill file refuses prepare and submit', async () => {
  const h = await harness();
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  const code = h.channel.last().code;
  writeFileSync(join(h.config.stateDir, 'KILL'), '');
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: code });
  assert.match(r.text, /kill switch|alignment stop/);
  const r2 = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.match(r2.text, /kill switch|alignment stop/);
  assert.equal(h.wallet.prepares, 0);
});

test('config: mainnet needs explicit opt-in and an explicit RPC; testnet is the default', () => {
  assert.equal(loadConfig({}).network, 'testnet');
  assert.equal(loadConfig({}).writesEnabled, false);
  assert.throws(() => loadConfig({ DEMOS_NETWORK: 'mainnet' }), /DEMOS_ALLOW_MAINNET/);
  assert.throws(() => loadConfig({ DEMOS_NETWORK: 'mainnet', DEMOS_ALLOW_MAINNET: '1' }), /DEMOS_RPC_URL/);
  assert.throws(() => loadConfig({ DEMOS_RPC_URL: 'http://testnet-rpc.invalid' }), /https/);
  assert.equal(loadConfig({ DEMOS_MCP_ENABLE_WRITES: '${user_config.enable_writes}' }).writesEnabled, false);
  assert.throws(() => loadConfig({ DEMOS_CONFIRM_CHANNELS: 'webhook' }), /https DEMOS_CONFIRM_WEBHOOK_URL/);
});

test('sanitized defaults: no built-in RPC takes writes, and the refusal names no opt-in', () => {
  const base = { DEMOS_MCP_ENABLE_WRITES: '1', DEMOS_MNEMONIC_FILE: '/nonexistent/mock', DEMOS_CONFIRM_CHANNELS: 'stderr' };
  const unset = loadConfig(base);
  assert.equal(unset.rpcIsKnownTestnet, false);
  const refusal = writeBlocker(unset);
  assert.match(refusal ?? '', /not a known testnet host; testnet writes are refused/);
  assert.doesNotMatch(refusal ?? '', /DEMOS_ALLOW_MAINNET/);
  const configured = loadConfig({ ...base, DEMOS_RPC_URL: 'https://rpc.example' });
  assert.equal(configured.rpcIsKnownTestnet, false);
  assert.match(writeBlocker(configured) ?? '', /testnet writes are refused/);
  // The mainnet opt-in does not open testnet writes.
  const optedIn = loadConfig({ ...base, DEMOS_RPC_URL: 'https://rpc.example', DEMOS_ALLOW_MAINNET: '1' });
  assert.equal(optedIn.network, 'testnet');
  assert.match(writeBlocker(optedIn) ?? '', /testnet writes are refused/);
});
