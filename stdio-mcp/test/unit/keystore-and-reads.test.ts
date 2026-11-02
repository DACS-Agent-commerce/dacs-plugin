import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptMnemonic, decryptKeystore, loadMnemonic, writeKeystore } from '../../src/keystore.js';
import { loadConfig } from '../../src/config.js';
import { SecretGuard } from '../../src/secrets.js';
import { demToOs, osToDem, isCanonicalDecimal } from '../../src/amount.js';
import { harness, MNEMONIC, PASSPHRASE, ADDR_B } from '../helpers.js';

test('keystore round-trip; wrong passphrase fails without echoing anything', () => {
  const ks = encryptMnemonic(MNEMONIC, PASSPHRASE, { N: 2 ** 14 });
  assert.ok(!JSON.stringify(ks).includes('legal'));
  assert.equal(decryptKeystore(ks, PASSPHRASE), MNEMONIC);
  assert.throws(() => decryptKeystore(ks, 'wrong passphrase!'), (e: Error) => e.message === 'keystore decryption failed (wrong passphrase or corrupted file)');
});

test('key files must be private (chmod 600) and registered with the guard on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demos-ks-'));
  const ksPath = join(dir, 'w.keystore.json');
  writeKeystore(ksPath, encryptMnemonic(MNEMONIC, PASSPHRASE, { N: 2 ** 14 }));
  const g = new SecretGuard();
  const cfg = loadConfig({ DEMOS_KEYSTORE: ksPath, DEMOS_KEYSTORE_PASSPHRASE: PASSPHRASE });
  assert.equal(loadMnemonic(cfg, g), MNEMONIC);
  assert.ok(g.leaks(MNEMONIC) && g.leaks(PASSPHRASE));
  chmodSync(ksPath, 0o644);
  assert.throws(() => loadMnemonic(cfg, new SecretGuard()), /chmod 600/);
  const mf = join(dir, 'm.txt');
  writeFileSync(mf, MNEMONIC);
  chmodSync(mf, 0o640); // writeFileSync's mode is narrowed by the umask, to 0600 under 077
  assert.throws(() => loadMnemonic(loadConfig({ DEMOS_MNEMONIC_FILE: mf }), new SecretGuard()), /chmod 600/);
  chmodSync(mf, 0o600);
  assert.equal(loadMnemonic(loadConfig({ DEMOS_MNEMONIC_FILE: mf }), new SecretGuard()), MNEMONIC);
});

test('amounts: DEM <-> OS, CD-1', () => {
  assert.equal(demToOs('1.5'), 1_500_000_000n);
  assert.equal(demToOs('0.000000001'), 1n);
  assert.equal(osToDem(1_500_000_000n), '1.5');
  assert.equal(osToDem(2_000_000_000n), '2');
  assert.throws(() => demToOs('1.0000000001'));
  assert.ok(isCanonicalDecimal('1.5') && !isCanonicalDecimal('1.50') && !isCanonicalDecimal('01') && !isCanonicalDecimal('0'));
});

test('read tools: balance, tx, identities, storage with key path', async () => {
  const h = await harness({ DEMOS_MCP_ENABLE_WRITES: '0' });
  h.chain.balances.set(ADDR_B, 12_340_000_000n);
  const b = await h.call('demos_balance', { address: ADDR_B.toUpperCase().replace('0X', '0x') });
  assert.equal(b.json.balance_dem, '12.34');
  assert.equal(b.json.balance_os, '12340000000');
  const t = await h.call('demos_tx_get', { hash: 'ab'.repeat(32) });
  assert.equal(t.json.state, 'not_found');
  const i = await h.call('demos_identity_lookup', { address: ADDR_B });
  assert.equal(i.json.dacs_key_claim, 'key:' + ADDR_B.slice(2));
  h.chain.storage.set('stor-' + 'a'.repeat(40), { storageAddress: 'stor-' + 'a'.repeat(40), owner: ADDR_B, data: { receipts: [{ n: 0 }, { n: 1 }] } });
  const s = await h.call('demos_storage_read', { address: 'stor-' + 'a'.repeat(40), key: 'receipts.1' });
  assert.deepEqual(s.json.untrusted_content, { n: 1 });
  assert.match(s.json.content_hash_jcs_sha256, /^[0-9a-f]{64}$/);
  const n = await h.call('demos_network_info');
  assert.equal(n.json.network, 'testnet');
  assert.match(n.json.safety.writes, /disabled/);
});
