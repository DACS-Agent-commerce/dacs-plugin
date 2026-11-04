/**
 * Purchase-only wallet mode: the legacy tools can read, but cannot load the key
 * or sign. The fence is rechecked at each use, not only at startup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
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

test('a marker that appears while the transfer is being signed stops it before broadcast', async () => {
  const h = await harness();
  const key = join(h.config.stateDir, 'wallet.keystore.json');
  writeFileSync(key, 'synthetic placeholder');
  h.config.keystorePath = key;
  const p = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  assert.equal(p.isError, false, p.text);
  const code = h.channel.last().code;
  const preparePay = h.wallet.preparePay.bind(h.wallet);
  h.wallet.preparePay = async (...args) => {
    const tx = await preparePay(...args);
    writeFileSync(`${key}.purchase-only`, '');
    return tx;
  };
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: code });
  // signed bytes reached the RPC at confirm, so the outcome stays unknown, but nothing is broadcast
  assert.equal(r.json.status, 'unknown');
  assert.match(r.text, FENCED);
  assert.equal(h.wallet.prepares, 1);
  assert.equal(h.wallet.broadcasts.length, 0);
});

test('a stop marker that is a symlink to a missing target stops the opener before key loading', async () => {
  for (const marker of ['STOP', 'KILL']) {
    const dir = mkdtempSync(join(tmpdir(), 'purchase-only-'));
    const config = loadConfig({ DEMOS_MCP_ENABLE_WRITES: '1', DEMOS_STATE_DIR: dir, DEMOS_MNEMONIC_FILE: join(dir, 'missing') });
    config.rpcIsKnownTestnet = true;
    const { calls, chain } = countingChain();
    symlinkSync(join(dir, 'missing-target'), join(dir, marker));
    await assert.rejects(createLegacyWalletOpener(config, new SecretGuard(), chain)(), /^Error: Writes are stopped$/);
    assert.deepEqual(calls, []);
  }
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

test('a marker that appears after start-up is reported by the network info and stops the backup reveal', async (t) => {
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'abandon ability able about above absent absorb abstract absurd abuse access accident'; this.made.push(m); return m; },
    async addressOf(m: string) { return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  const url = h.channel.last().approveUrl!;
  await post(url + '/approve', { passphrase: pass, confirm: pass, remember: 'on' });
  // the backup is left unacknowledged (the page is not acknowledged), then the wallet is fenced
  const keystore = join(h.config.stateDir, 'wallet.keystore.json');
  const control = await h.call('demos_network_info');
  assert.match(control.json.safety.writes, /^enabled/, 'control: before the marker writes are enabled');
  writeFileSync(`${keystore}.purchase-only`, '');
  const info = await h.call('demos_network_info');
  assert.match(info.json.safety.writes, FENCED);
  const status = await h.call('demos_onboard_status');
  assert.equal(status.json.steps.writes_enabled, false);
  assert.equal(status.json.next.step, 'wallet fenced');
  assert.match(status.json.next.say, /enabling wallet writes does not lift that/);
  const r = await h.call('demos_onboard_create_wallet');
  assert.equal(r.isError, true);
  assert.match(r.text, FENCED);
  assert.equal(wf.made.length, 1, 'no second wallet');
});

test('a marker that appears while the reveal page is open refuses the phrase after the passphrase', async (t) => {
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'zoo wrong yellow wolf wise wing winner window wide wet wedding weapon'; this.made.push(m); return m; },
    async addressOf(m: string) { return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  const url = h.channel.last().approveUrl!;
  await post(url + '/approve', { passphrase: pass, confirm: pass, remember: 'on' });
  const r = await h.call('demos_onboard_create_wallet');
  assert.match(r.json.step, /finish backup/, 'control: the reveal path is offered before the marker');
  const reveal = h.channel.last().approveUrl!;
  writeFileSync(`${join(h.config.stateDir, 'wallet.keystore.json')}.purchase-only`, '');
  const shown = await post(reveal + '/approve', { passphrase: pass });
  assert.match(shown, /fenced for purchase-only use/);
  for (const w of wf.made[0]!.split(' ')) assert.ok(!shown.includes(`<li>${w}</li>`));
});

test('a marker that appears while the create-wallet page is open stops the wallet from being created', async (t) => {
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'legal winner thank year wave sausage worth useful legal winner thank yellow'; this.made.push(m); return m; },
    async addressOf(m: string) { return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const pass = 'correct horse battery staple';
  const r = await h.call('demos_onboard_create_wallet');
  assert.equal(r.isError, false, 'control: the create page is offered before the marker');
  const url = h.channel.last().approveUrl!;
  const keystore = join(h.config.stateDir, 'wallet.keystore.json');
  writeFileSync(`${keystore}.purchase-only`, '');
  const shown = await post(url + '/approve', { passphrase: pass, confirm: pass });
  assert.match(shown, /fenced for purchase-only use/);
  assert.equal(wf.made.length, 0, 'no phrase was generated');
  assert.equal(existsSync(keystore), false, 'no keystore was written');
});

test('a marker that appears during the address lookup stops the create form before it writes or shows anything', async (t) => {
  let marker = '';
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'; this.made.push(m); return m; },
    async addressOf(m: string) { writeFileSync(marker, ''); return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const keystore = join(h.config.stateDir, 'wallet.keystore.json');
  marker = `${keystore}.purchase-only`;
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  const url = h.channel.last().approveUrl!;
  const shown = await post(url + '/approve', { passphrase: pass, confirm: pass });
  assert.match(shown, /fenced for purchase-only use/);
  for (const w of wf.made[0]!.split(' ')) assert.ok(!shown.includes(`<li>${w}</li>`));
  assert.equal(existsSync(keystore), false, 'no keystore was written');
});

test('a marker that appears during the file work leaves no keystore and shows no phrase', async (t) => {
  let marker = '';
  let lookedUp = false;
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'rapid olive tail sword ahead clay frost skill cruise bonus quick merry'; this.made.push(m); return m; },
    async addressOf(m: string) { lookedUp = true; return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const keystore = join(h.config.stateDir, 'wallet.keystore.json');
  marker = `${keystore}.purchase-only`;
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  const url = h.channel.last().approveUrl!;
  // the marker appears while the file work runs: the passphrase file path is read after the address check
  let armed = true;
  const passFile = h.config.keystorePassphraseFile;
  Object.defineProperty(h.config, 'keystorePassphraseFile', {
    get() {
      if (armed && lookedUp) {
        armed = false;
        writeFileSync(marker, '');
      }
      return passFile;
    },
  });
  const shown = await post(url + '/approve', { passphrase: pass, confirm: pass, remember: 'on' });
  assert.equal(armed, false, 'control: the hook ran during the file work');
  assert.match(shown, /fenced for purchase-only use/);
  for (const w of wf.made[0]!.split(' ')) assert.ok(!shown.includes(`<li>${w}</li>`));
  assert.equal(existsSync(keystore), false, 'no keystore remains');
  assert.equal(existsSync(passFile!), false, 'no passphrase file remains');
});

test('a marker that appears after publication takes back the wallet, the passphrase file and the state', async (t) => {
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'timber wall damp cream orange idle pelican noodle swift truth olive hurry'; this.made.push(m); return m; },
    async addressOf(m: string) { return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const keystore = join(h.config.stateDir, 'wallet.keystore.json');
  const marker = `${keystore}.purchase-only`;
  const passFile = h.config.keystorePassphraseFile!;
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  const url = h.channel.last().approveUrl!;
  // the marker appears at the first Date construction after the keystore is published (the state write), after the first post-publication check
  let fired = false;
  const restore = onFirstDateAfterPublish(keystore, () => {
    fired = true;
    writeFileSync(marker, '');
  });
  t.after(restore);
  const shown = await post(url + '/approve', { passphrase: pass, confirm: pass, remember: 'on' });
  assert.equal(fired, true, 'control: the hook ran after publication');
  assert.match(shown, /fenced for purchase-only use/);
  for (const w of wf.made[0]!.split(' ')) assert.ok(!shown.includes(`<li>${w}</li>`));
  assert.equal(existsSync(keystore), false, 'the wallet was taken back');
  assert.equal(existsSync(passFile), false, 'the passphrase file was taken back');
  assert.equal((await h.call('demos_onboard_status')).json.steps.wallet, null, 'the onboarding state was restored');
});

test('a late take-back leaves a different file at the keystore path alone', async (t) => {
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'cargo easy gas pencil robot slim tent tomato urban vague wheel yard'; this.made.push(m); return m; },
    async addressOf(m: string) { return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const dir = h.config.stateDir;
  const keystore = join(dir, 'wallet.keystore.json');
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  const url = h.channel.last().approveUrl!;
  t.after(onFirstDateAfterPublish(keystore, () => {
    // replace the published file by someone else's, then fence
    rmSync(keystore);
    writeFileSync(keystore, 'someone else wallet');
    writeFileSync(`${keystore}.purchase-only`, '');
  }));
  await post(url + '/approve', { passphrase: pass, confirm: pass });
  assert.equal(existsSync(keystore), true, 'the other file survived');
});

test('a marker that appears during the status lookups is reported by the same status call', async (t) => {
  const wf = {
    made: [] as string[],
    newMnemonic() { const m = 'bitter ladder shop wagon actor cabin donor above lock cargo table brisk'; this.made.push(m); return m; },
    async addressOf(m: string) { return '0x' + createHash('sha256').update(m).digest('hex'); },
  };
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, { approval: true, walletFactory: wf });
  t.after(async () => {
    await h.approval!.stop();
    rmSync(h.config.stateDir, { recursive: true, force: true });
  });
  const pass = 'correct horse battery staple';
  await h.call('demos_onboard_create_wallet');
  await post(h.channel.last().approveUrl! + '/approve', { passphrase: pass, confirm: pass, remember: 'on' });
  const marker = `${join(h.config.stateDir, 'wallet.keystore.json')}.purchase-only`;
  const original = h.chain.addressInfo.bind(h.chain);
  h.chain.addressInfo = async (a: string) => {
    writeFileSync(marker, '');
    return original(a);
  };
  const status = await h.call('demos_onboard_status');
  assert.equal(status.json.steps.writes_enabled, false);
  assert.match(status.json.writes, FENCED);
});

test('a marker present at start-up keeps both reports disabled after it is removed', async (t) => {
  const h = await harness({ DEMOS_MNEMONIC_FILE: '' }, {
    beforeServer: (dir) => writeFileSync(join(dir, 'wallet.keystore.json.purchase-only'), ''),
  });
  t.after(() => rmSync(h.config.stateDir, { recursive: true, force: true }));
  const marker = join(h.config.stateDir, 'wallet.keystore.json.purchase-only');
  assert.match((await h.call('demos_network_info')).json.safety.writes, FENCED);
  rmSync(marker);
  // the write and create tools were not registered at start-up, so the reports must not say enabled
  assert.match((await h.call('demos_network_info')).json.safety.writes, FENCED);
  const status = await h.call('demos_onboard_status');
  assert.equal(status.json.steps.writes_enabled, false);
});

/** Runs `fn` once, at the first `new Date()` after `file` exists; returns the function that puts the real Date back. */
function onFirstDateAfterPublish(file: string, fn: () => void): () => void {
  const RealDate = Date;
  let done = false;
  (globalThis as any).Date = class extends RealDate {
    constructor(...a: any[]) {
      if (!done && existsSync(file)) {
        done = true;
        fn();
      }
      super(...(a as []));
    }
  };
  return () => {
    (globalThis as any).Date = RealDate;
  };
}

function post(url: string, form: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.end(body);
  });
}
