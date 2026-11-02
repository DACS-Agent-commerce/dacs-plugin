/**
 * The guard must catch every representation of the actual loaded key
 * material (forms derived from the key bytes), with minimum fragments of 12 hex chars or
 * 8 base64 chars, while addresses, public keys, tx hashes and signatures still pass.
 * Randomized: each run uses fresh throwaway keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { SecretGuard } from '../../src/secrets.js';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const ROUNDS = 150;
const DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex'); // PKCS8 ed25519

function fresh() {
  const seed = randomBytes(32);
  const pub = Buffer.from(ed.getPublicKey(seed));
  const g = new SecretGuard();
  g.registerEd25519PrivateKey(new Uint8Array(Buffer.concat([seed, pub]))); // the SDK's 64-byte form
  return { g, seed, pub, address: '0x' + pub.toString('hex') };
}

const sep = (hex: string, s: string, prefix = '') => hex.match(/../g)!.map((p) => prefix + p).join(s);
const frag = (s: string, min: number) => {
  const len = randomInt(min, Math.min(s.length, min + 20) + 1);
  const start = randomInt(0, s.length - len + 1);
  return s.slice(start, start + len);
};

/** Every representation of the key material, plus fragments at the minimum length. */
function leakForms(seed: Buffer, pub: Buffer): Record<string, string> {
  const hex = seed.toString('hex');
  const der = Buffer.concat([DER_PREFIX, seed]);
  const shifted = Buffer.concat([randomBytes(randomInt(1, 3)), seed]);
  const arr = [...seed];
  const s6 = randomInt(0, 32 - 6);
  return {
    hexLower: hex,
    hexUpper: hex.toUpperCase(),
    hex0x: '0x' + hex,
    fullKeyHex: Buffer.concat([seed, pub]).toString('hex'),
    hexFragment12: frag(hex, 12),
    hexFragment12Upper: frag(hex, 12).toUpperCase(),
    hexSpaced: sep(hex, ' '),
    hexColon: sep(hex, ':'),
    hexColonUpper: sep(hex, ':').toUpperCase(),
    hexComma0x: sep(hex, ', ', '0x'),
    hexDash: sep(hex, '-'),
    hexSpacedFragment: sep(hex.slice(10, 24), ' '),
    base64: seed.toString('base64'),
    base64url: seed.toString('base64url'),
    base64Fragment8: frag(seed.toString('base64').replace(/=+$/, ''), 8),
    base64urlFragment8: frag(seed.toString('base64url'), 8),
    fullKeyBase64: Buffer.concat([seed, pub]).toString('base64'),
    derHex: der.toString('hex'),
    derBase64: der.toString('base64'),
    derBase64url: der.toString('base64url'),
    derPem: `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----`,
    base64ShiftedFragment: frag(shifted.toString('base64').slice(4, -4), 12),
    byteArrayJson: JSON.stringify(arr),
    byteArraySpaced: `[${arr.join(', ')}]`,
    byteArrayFragment6: JSON.stringify(arr.slice(s6, s6 + 6)),
    bufferJson: JSON.stringify(seed), // {"type":"Buffer","data":[...]}
    uint8ArrayJson: JSON.stringify({ k: Array.from(new Uint8Array(seed)) }),
    inJsonString: JSON.stringify({ note: `key=${hex}` }),
    escapedInJson: JSON.stringify(JSON.stringify({ k: seed.toString('base64') })),
  };
}

test('guard: every representation of the loaded key is blocked (randomized)', () => {
  const missed: Record<string, number> = {};
  for (let i = 0; i < ROUNDS; i++) {
    const { g, seed, pub } = fresh();
    for (const [form, text] of Object.entries(leakForms(seed, pub))) {
      if (!g.leaks(`prefix ${text} suffix`)) missed[form] = (missed[form] ?? 0) + 1;
    }
  }
  assert.deepEqual(missed, {}, `forms not caught: ${JSON.stringify(missed)}`);
});

test('guard: every 12-hex-char and 8-base64-char window of the seed is caught (exhaustive)', () => {
  for (let r = 0; r < 20; r++) {
    const { g, seed } = fresh();
    const hex = seed.toString('hex');
    for (let i = 0; i + 12 <= hex.length; i++) {
      assert.ok(g.leaks(hex.slice(i, i + 12)), `hex window @${i}`);
      assert.ok(g.leaks(hex.slice(i, i + 12).toUpperCase()), `HEX window @${i}`);
    }
    for (const enc of [seed.toString('base64').replace(/=+$/, ''), seed.toString('base64url')]) {
      for (let i = 0; i + 8 <= enc.length; i++) assert.ok(g.leaks(enc.slice(i, i + 8)), `b64 window @${i}`);
    }
    // DER-wrapped base64: every 8-char window lying fully over the seed bits
    const der = Buffer.concat([DER_PREFIX, seed]).toString('base64').replace(/=+$/, '');
    const startChar = Math.ceil((DER_PREFIX.length * 8) / 6);
    for (let i = startChar; i + 8 <= der.length; i++) assert.ok(g.leaks(der.slice(i, i + 8)), `DER b64 window @${i}`);
  }
});

test('guard: mnemonic words in order are caught however they are separated', () => {
  const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
  const g = new SecretGuard();
  g.register(words.join(' '));
  const forms = [
    words.slice(2, 6).join(' '),
    words.slice(3, 7).join(', '),
    words.slice(1, 5).map((w, i) => `${i + 2}. ${w}`).join('\n'),
    words.slice(4, 8).join(''),
    words.slice(0, 4).join('-').toUpperCase(),
    JSON.stringify(words.slice(5, 9)),
  ];
  for (const f of forms) assert.ok(g.leaks(f), f);
  // the same words out of order, or fewer than four, are ordinary text
  assert.ok(!g.leaks('thank you for the useful wave; legal year'));
  assert.ok(!g.leaks(words.slice(0, 3).join(' ')));
});

test('guard: addresses, public keys, tx hashes and signatures still pass (false-positive fuzz)', () => {
  let falsePositives = 0;
  const samples: string[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const { g, pub, address } = fresh();
    const txHash = randomBytes(32).toString('hex');
    const sig = randomBytes(64).toString('base64url');
    const other = [...randomBytes(32)];
    const texts = [
      address,
      address.toUpperCase().replace('0X', '0x'),
      pub.toString('hex'),
      pub.toString('base64'),
      pub.toString('base64url'),
      `key:${pub.toString('hex')}`,
      sep(pub.toString('hex'), ':'),
      JSON.stringify([...pub]),
      txHash,
      sig,
      JSON.stringify(other),
      JSON.stringify({ address, balance_os: '162426900000000', nonce: 636, tx_hash: txHash, from: address, to: '0x' + randomBytes(32).toString('hex'), signature: { value: sig } }, null, 2),
      'stor-' + randomBytes(20).toString('hex'),
      'The quick brown fox pays 12 DEM to github:acme at block 456844; fee 2 DEM, cap 8 DEM.',
    ];
    for (const t of texts) {
      if (g.leaks(t)) {
        falsePositives++;
        samples.push(t.slice(0, 40));
      }
    }
  }
  assert.equal(falsePositives, 0, `false positives: ${samples.join(' | ')}`);
});

test('guard: a full tool result naming the own address passes; the same result plus a seed fragment is blocked', () => {
  const { g, seed, address } = fresh();
  const result = JSON.stringify({ prepared_id: 'ab'.repeat(12), unsigned_tx: { from: address, to: '0x' + randomBytes(32).toString('hex'), amount_os: '1000000000' }, card: { headline: 'PAY 1 DEM' } }, null, 2);
  assert.ok(!g.leaks(result));
  assert.ok(g.valueLeaks({ ...JSON.parse(result), memo: seed.toString('hex').slice(20, 32) }));
  assert.ok(g.valueLeaks({ ...JSON.parse(result), memo: [...seed.subarray(3, 9)] .join(',') }));
});
