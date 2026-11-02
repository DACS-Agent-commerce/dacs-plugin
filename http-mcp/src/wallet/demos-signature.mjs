// Demos wallet address and Ed25519 signature handling.
//
// Provenance: adapted from the Community DACS Directory wallet contract
// (community@074f040, reference-implementations/dacs-directory/src/components/useDemosWallet.ts,
// src/catalog/claimRef.ts, src/catalog/listingVerification.ts decodeSignature):
//  - a Demos address is "0x" + 64 lowercase hex, and those hex digits are the raw
//    Ed25519 public key; the DACS claim is "did:demos:agent:<64 hex>";
//  - provider.request({method:"sign", params:[{message, publicKey}]}) signs the raw
//    UTF-8 bytes of message (no prefix, no pre-hash) and returns hex (optionally
//    0x-prefixed, sometimes doubled "0x0x") or base64url of the 64-byte signature.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HEX64 = /^[0-9a-f]{64}$/;

export class WalletFormatError extends Error {}

export function normalizeDemosAddress(value) {
  if (typeof value !== 'string') throw new WalletFormatError('wallet address must be a string');
  const trimmed = value.trim();
  const hex = trimmed.replace(/^0x/i, '');
  if (!HEX64.test(hex.toLowerCase()) || hex.length !== 64) {
    throw new WalletFormatError('wallet address must be 0x followed by 64 hex characters (an Ed25519 public key)');
  }
  return `0x${hex.toLowerCase()}`;
}

export function claimForAddress(address) {
  return `did:demos:agent:${normalizeDemosAddress(address).slice(2)}`;
}

export function addressForClaim(claim) {
  const match = /^did:demos:agent:([0-9a-f]{64})$/i.exec(String(claim));
  if (!match || match[1] !== match[1].toLowerCase()) throw new WalletFormatError('claim must be did:demos:agent:<64 lowercase hex>');
  return `0x${match[1]}`;
}

export function decodeSignature(value) {
  if (typeof value !== 'string') throw new WalletFormatError('signature must be a string');
  const trimmed = value.trim();
  // Canonical base64url first: "0x"/"0X" are valid base64url characters, so a
  // genuine 86-character signature can start with them.
  if (/^[A-Za-z0-9_-]{86}$/.test(trimmed)) {
    const bytes = Buffer.from(trimmed, 'base64url');
    if (bytes.length === 64 && bytes.toString('base64url') === trimmed) return bytes;
  }
  const stripped = trimmed.replace(/^(0x)+/i, '');
  if (/^[0-9a-fA-F]{128}$/.test(stripped)) return Buffer.from(stripped, 'hex');
  if (/^[A-Za-z0-9_-]{86}$/.test(stripped)) {
    const bytes = Buffer.from(stripped, 'base64url');
    if (bytes.length === 64) return bytes;
  }
  throw new WalletFormatError('signature must be 64 bytes encoded as hex or base64url');
}

// Ed25519 point arithmetic (RFC 8032 section 5.1) on BigInt, used only to decide
// whether a public key may be used. node:crypto accepts every on-curve encoding,
// so the check is made here, from the key's group order rather than from a list.
const P = 2n ** 255n - 19n;
const modPow = (base, exponent) => {
  let result = 1n, b = base % P;
  for (let e = exponent; e > 0n; e >>= 1n, b = b * b % P) if (e & 1n) result = result * b % P;
  return result;
};
const D = (P - 121665n * modPow(121666n, P - 2n) % P) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

// Extended coordinates [X, Y, Z, T]. The unified formula is complete on this
// curve, so it also doubles.
function addPoints([x1, y1, z1, t1], [x2, y2, z2, t2]) {
  const a = (y1 - x1) * (y2 - x2) % P, b = (y1 + x1) * (y2 + x2) % P;
  const c = 2n * D * t1 % P * t2 % P, d = 2n * z1 * z2 % P;
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return [(e * f % P + P) % P, (g * h % P + P) % P, (f * g % P + P) % P, (e * h % P + P) % P];
}

// Decodes 32 bytes to a point. Returns null unless the encoding is canonical
// (y < p, and a set sign bit only when x != 0) and the point is on the curve.
function decodePoint(raw) {
  const bytes = Buffer.from(raw);
  if (bytes.length !== 32) return null;
  const sign = bytes[31] >> 7;
  bytes[31] &= 0x7f;
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`);
  if (y >= P) return null;
  const y2 = y * y % P, x2 = (y2 - 1n + P) % P * modPow((D * y2 + 1n) % P, P - 2n) % P;
  let x = modPow(x2, (P + 3n) / 8n);
  if (x * x % P !== x2) x = x * SQRT_M1 % P;
  if (x * x % P !== x2) return null;
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = (P - x) % P;
  return [x, y, 1n, x * y % P];
}

// True for a canonical, on-curve key whose order is not 1, 2, 4 or 8, that is,
// where [8]A is not the identity. Every other input is refused.
export function isUsableEd25519PublicKey(raw) {
  try {
    let point = decodePoint(raw);
    if (!point) return false;
    for (let i = 0; i < 3; i++) point = addPoints(point, point);
    return !(point[0] === 0n && point[1] === point[2]);
  } catch {
    return false;
  }
}

function publicKeyObject(address) {
  const raw = Buffer.from(normalizeDemosAddress(address).slice(2), 'hex');
  if (!isUsableEd25519PublicKey(raw)) throw new WalletFormatError('wallet address is not a usable Ed25519 public key');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

// Returns true only for a valid Ed25519 signature by `address` over the exact
// UTF-8 bytes of `message`. Small-order and non-canonical public keys are
// refused. Malformed input returns false, never throws.
export function verifyDemosSignature({ address, message, signature }) {
  try {
    const sig = decodeSignature(signature);
    return cryptoVerify(null, Buffer.from(message, 'utf8'), publicKeyObject(address), sig);
  } catch {
    return false;
  }
}
