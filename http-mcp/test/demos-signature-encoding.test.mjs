// Wallet signature decoding: canonical base64url is decided before any hex
// "0x" prefix is stripped. "0x"/"0X" are also valid base64url characters, so a
// genuine 86-character signature can start with them (about 1 in 2,000).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { decodeSignature, verifyDemosSignature } from '../src/wallet/demos-signature.mjs';

function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return { publicKey, privateKey, address: `0x${raw.toString('hex')}` };
}

// A real signature whose canonical base64url begins with `prefix`, found by
// varying the signed message under a key generated at runtime.
function prefixedSignature(prefix) {
  const key = freshKey();
  for (let i = 0; i < 1_000_000; i++) {
    const message = `demos-signature-encoding:${prefix}:${i}`;
    const bytes = sign(null, Buffer.from(message, 'utf8'), key.privateKey);
    if (bytes.toString('base64url').startsWith(prefix)) return { ...key, message, bytes, b64: bytes.toString('base64url') };
  }
  throw new Error(`no ${prefix} signature found`);
}

const encodings = (bytes) => {
  const hex = bytes.toString('hex');
  return { base64url: bytes.toString('base64url'), hex, '0x hex': `0x${hex}`, '0X hex': `0X${hex}`, '0x0x hex': `0x0x${hex}`, 'upper hex': hex.toUpperCase() };
};
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Same 64 bytes, but the final character's four unused low bits are set.
const nonCanonical = (b64) => `${b64.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(b64.at(-1)) | 1]}`;

for (const prefix of ['0x', '0X']) {
  test(`genuine Ed25519 signature whose base64url starts with ${prefix} decodes to its exact bytes and verifies`, () => {
    const s = prefixedSignature(prefix);
    assert.equal(s.b64.length, 86);
    assert.ok(s.b64.startsWith(prefix));
    assert.equal(verify(null, Buffer.from(s.message, 'utf8'), s.publicKey, s.bytes), true, 'independent oracle: the raw bytes are a valid signature');
    assert.deepEqual(decodeSignature(s.b64), s.bytes);
    assert.deepEqual(decodeSignature(` ${s.b64}\n`), s.bytes, 'surrounding whitespace is still trimmed');
    assert.equal(verifyDemosSignature({ address: s.address, message: s.message, signature: s.b64 }), true);
  });

  test(`${prefix} base64url, raw hex and prefixed hex of the same bytes give the same verdict`, () => {
    const s = prefixedSignature(prefix);
    const other = freshKey();
    const tampered = Buffer.from(s.bytes);
    tampered[40] ^= 1;
    for (const [name, signature] of Object.entries(encodings(s.bytes))) {
      assert.deepEqual(decodeSignature(signature), s.bytes, name);
      assert.equal(verifyDemosSignature({ address: s.address, message: s.message, signature }), true, name);
      assert.equal(verifyDemosSignature({ address: s.address, message: `${s.message}!`, signature }), false, `${name}: other message`);
      assert.equal(verifyDemosSignature({ address: other.address, message: s.message, signature }), false, `${name}: other key`);
    }
    for (const [name, signature] of Object.entries(encodings(tampered))) {
      assert.equal(verifyDemosSignature({ address: s.address, message: s.message, signature }), false, `${name}: tampered bytes`);
    }
  });

  test(`${prefix} base64url: wrong-length and non-canonical encodings are still rejected`, () => {
    const s = prefixedSignature(prefix);
    const hex = s.bytes.toString('hex');
    const rejected = {
      'prefix stripped (84 chars)': s.b64.slice(2),
      'one char short (85)': s.b64.slice(0, -1),
      'one char long (87)': `${s.b64}A`,
      'padded': `${s.b64}==`,
      'standard base64 alphabet': `${s.b64.slice(0, 10)}+${s.b64.slice(11)}`,
      'non-canonical trailing bits': nonCanonical(s.b64),
      '63 bytes': s.bytes.subarray(0, 63).toString('base64url'),
      '65 bytes': Buffer.concat([s.bytes, Buffer.alloc(1)]).toString('base64url'),
      '126 hex': hex.slice(2),
      '130 hex': `${hex}00`,
      '0x 126 hex': `0x${hex.slice(2)}`,
      '0x 130 hex': `0x${hex}00`,
      'non-hex 128': `${hex.slice(0, -1)}g`,
      'empty': '',
      '0x only': '0x',
    };
    assert.notEqual(nonCanonical(s.b64), s.b64);
    assert.deepEqual(Buffer.from(nonCanonical(s.b64), 'base64url'), s.bytes, 'the non-canonical form carries the same bytes');
    for (const [name, signature] of Object.entries(rejected)) {
      assert.throws(() => decodeSignature(signature), /64 bytes encoded as hex or base64url/, name);
      assert.equal(verifyDemosSignature({ address: s.address, message: s.message, signature }), false, name);
    }
    for (const value of [undefined, null, 42, s.bytes]) assert.throws(() => decodeSignature(value), /must be a string/);
  });
}

test('verifyDemosSignature with no argument or null returns false instead of throwing', () => {
  assert.equal(verifyDemosSignature(), false);
  assert.equal(verifyDemosSignature(null), false);
});
