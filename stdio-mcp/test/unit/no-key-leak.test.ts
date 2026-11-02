/**
 * No key material in any tool output. We register a mnemonic, a passphrase and a
 * private key, then drive every tool with randomized inputs — including a wallet
 * that actively tries to smuggle the mnemonic out through node messages and
 * error strings — and scan every output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, keypair, MNEMONIC, PASSPHRASE, ADDR_B, MockWallet } from '../helpers.js';
import { SecretGuard } from '../../src/secrets.js';

const PRIV_HEX = Buffer.from(keypair(7).priv).toString('hex');

function scan(outputs: string[], codes: string[]): void {
  const words = MNEMONIC.split(' ');
  for (const out of outputs) {
    const lower = out.toLowerCase();
    assert.ok(!lower.includes(MNEMONIC), 'mnemonic leaked');
    for (let i = 0; i + 4 <= words.length; i++) assert.ok(!lower.includes(words.slice(i, i + 4).join(' ')), 'mnemonic fragment leaked');
    assert.ok(!out.includes(PASSPHRASE), 'passphrase leaked');
    for (let i = 0; i + 24 <= PRIV_HEX.length; i += 8) assert.ok(!lower.includes(PRIV_HEX.slice(i, i + 24)), 'private key fragment leaked');
    for (const c of codes) assert.ok(!out.toUpperCase().includes(c) && !out.toUpperCase().includes(c.replace('-', '')), 'confirmation code leaked');
  }
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;
const junk = () =>
  pick([
    '',
    'x'.repeat(rnd(300)),
    MNEMONIC,
    PRIV_HEX,
    PASSPHRASE,
    '0x' + 'ab'.repeat(32),
    ADDR_B,
    '1',
    '0.5',
    '-3',
    '{"agreementVersion":"1"}',
    'https://gist.github.com/a/b',
    '\u0000\uD800',
  ]);

test('fuzz: 400 random tool calls never emit key material or codes', async () => {
  const wallet = new MockWallet();
  const h = await harness({}, { wallet });
  const tools = (await h.client.listTools()).tools.map((t) => t.name);
  for (let i = 0; i < 400; i++) {
    wallet.leak = pick([null, null, MNEMONIC, PRIV_HEX, PASSPHRASE, 'throw']);
    const name = pick(tools);
    const args: Record<string, unknown> = {};
    for (const k of ['address', 'hash', 'to', 'amount_dem', 'amount_os', 'memo', 'kind', 'proof', 'context', 'subject', 'receipt', 'offer', 'prepared_id', 'confirmation_code', 'key']) {
      if (Math.random() < 0.4) args[k] = junk();
    }
    if (name === 'demos_tx_prepare' && Math.random() < 0.5) Object.assign(args, { to: ADDR_B, amount_dem: '1', amount_os: undefined });
    if (name === 'demos_tx_submit' && h.channel.messages.length && Math.random() < 0.3) {
      args.prepared_id = h.channel.last().preparedId;
      args.confirmation_code = h.channel.last().code;
    }
    try {
      await h.call(name, args);
    } catch {
      /* protocol-level validation errors are fine */
    }
  }
  assert.ok(h.outputs.length > 300);
  scan(h.outputs, h.channel.messages.map((m) => m.code));
  // the receipts log on disk holds no secrets either
  let log = '';
  try {
    log = readFileSync(join(h.config.stateDir, 'receipts.jsonl'), 'utf8');
  } catch {
    log = '';
  }
  scan([log], h.channel.messages.map((m) => m.code));
});

test('a node message carrying the mnemonic is blocked, not passed through', async () => {
  const wallet = new MockWallet();
  wallet.leak = MNEMONIC;
  const h = await harness({}, { wallet });
  const r = await h.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  scan([r.text], []);
  const w2 = new MockWallet();
  w2.leak = 'throw';
  const h2 = await harness({}, { wallet: w2 });
  const p2 = await h2.call('demos_tx_prepare', { to: ADDR_B, amount_dem: '1' });
  const r2 = await h2.call('demos_tx_submit', { prepared_id: p2.json.prepared_id, confirmation_code: h2.channel.last().code });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /withheld|blocked/);
  scan([r2.text], []);
});

test('SecretGuard catches registered secrets, fragments, and unregistered key-named fields', () => {
  const g = new SecretGuard();
  g.register(MNEMONIC);
  g.registerBytes(keypair(7).priv);
  assert.ok(g.leaks(`words: ${MNEMONIC.split(' ').slice(3, 8).join(' ')}`));
  assert.ok(g.leaks(PRIV_HEX.slice(10, 40)));
  assert.ok(g.leaks(Buffer.from(keypair(7).priv).toString('base64')));
  assert.ok(g.leaks('{"privateKey": "deadbeefdeadbeefdeadbeef"}'));
  assert.ok(!g.leaks('{"address":"' + ADDR_B + '","balance":"1"}'));
  assert.equal(g.redact(`x ${MNEMONIC} y`).includes('legal winner'), false);
});


test('live-testnet fix: a 64-byte SDK key (seed || pubkey) does not block the wallet address, and still catches the key', () => {
  const kp = keypair(9);
  const sdkForm = new Uint8Array([...kp.priv, ...kp.pub]); // what the Demos SDK returns
  const g = new SecretGuard();
  g.registerEd25519PrivateKey(sdkForm);
  assert.ok(!g.leaks(JSON.stringify({ from: kp.address, unsigned_tx: { from: kp.address } })), 'own address must not count as a leak');
  assert.ok(g.leaks(Buffer.from(sdkForm).toString('hex')));
  assert.ok(g.leaks(Buffer.from(sdkForm).toString('base64')));
  assert.ok(g.leaks(Buffer.from(sdkForm).toString('base64url')));
  assert.ok(g.leaks(Buffer.from(kp.priv).toString('hex').slice(16, 48)));
  assert.throws(() => g.registerEd25519PrivateKey(new Uint8Array(16)));
});

test('JSON escaping cannot smuggle a secret (quote-bearing passphrase)', async () => {
  const h = await harness({ DEMOS_MCP_ENABLE_WRITES: '0' });
  const tricky = 'pa"ss\\word with "quotes" 99';
  h.guard.register(tricky);
  h.chain.storage.set('stor-' + 'b'.repeat(40), { storageAddress: 'stor-' + 'b'.repeat(40), data: { note: tricky } });
  const r = await h.call('demos_storage_read', { address: 'stor-' + 'b'.repeat(40) });
  assert.equal(r.isError, true);
  assert.ok(!r.text.includes('quotes'));
  assert.ok(h.guard.leaks(JSON.stringify({ x: tricky })));
});
