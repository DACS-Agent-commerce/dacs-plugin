/**
 * CORE §B.7 domain-separated signatures.
 *   signed_bytes := UTF8(domain_separator) || UTF8(lowercase-hex artifact_hash)
 *   value        := unpadded Base64URL of the raw signature bytes (SIG-6)
 * Key resolution: only the `key:<hex-pubkey>` scheme (DACS-1 §6.3.1; lowercase,
 * no 0x) resolves to an ed25519 key offline. A Demos wallet address is its
 * ed25519 public key, so a Demos wallet's claim is `key:<address without 0x>`.
 * Other schemes need DACS-2 resolution and verify as `indeterminate` here.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export const SEP = {
  AGREEMENT: 'dacs-agreement:v1:',
  PAYEE_BOUND_AGREEMENT: 'dacs-payee-bound-agreement:v1:',
  EVIDENCE: 'dacs-evidence:v1:',
  BUNDLE: 'dacs-bundle:v1:',
  FAULT_BUNDLE: 'dacs-fault-bundle:v1:',
  BUNDLE_BINDING: 'dacs-bundle-binding:v1:',
  LISTING: 'dacs-listing:v1:',
  BUNDLE_PRESENTATION: 'dacs-bundle-presentation:v1:',
} as const;

export function signedBytes(separator: string, artifactHashHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(artifactHashHex)) throw new Error('artifact hash must be lowercase 64-hex');
  return separator + artifactHashHex;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/** SIG-6 strict decode: rejects padding, std-base64 chars, whitespace, non-canonical spellings. */
export function decodeSig6(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || !B64URL.test(value)) return null;
  if (value.length % 4 === 1) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null; // residual bits / non-canonical
  return new Uint8Array(bytes);
}

export function encodeSig6(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

const KEY_CLAIM = /^key:([0-9a-f]{64})$/;

/** ed25519 public key for a `key:` claim, else null (unresolvable offline). */
export function keyForClaim(claim: unknown): Uint8Array | null {
  if (typeof claim !== 'string') return null;
  const m = KEY_CLAIM.exec(claim);
  return m ? Uint8Array.from(Buffer.from(m[1]!, 'hex')) : null;
}

export function claimForAddress(address: string): string {
  return `key:${address.toLowerCase().replace(/^0x/, '')}`;
}

export function addressForClaim(claim: string): string | null {
  const m = KEY_CLAIM.exec(claim);
  return m ? `0x${m[1]}` : null;
}

export type SigDecision = 'pass' | 'fail' | 'indeterminate';

export function verifyDomainSig(
  separator: string,
  artifactHashHex: string,
  claim: unknown,
  algorithm: unknown,
  value: unknown,
): { decision: SigDecision; reason?: string } {
  if (algorithm !== 'ed25519') {
    return algorithm === 'ecdsa-secp256k1' || algorithm === 'sr1-aggregate'
      ? { decision: 'indeterminate', reason: `algorithm ${String(algorithm)} not supported by this verifier` }
      : { decision: 'fail', reason: `unknown algorithm ${String(algorithm)}` };
  }
  const sig = decodeSig6(value);
  if (!sig) return { decision: 'fail', reason: 'signature value is not canonical unpadded Base64URL (SIG-6)' };
  if (sig.length !== 64) return { decision: 'fail', reason: `ed25519 signature must be 64 bytes, got ${sig.length}` };
  const key = keyForClaim(claim);
  if (!key) return { decision: 'indeterminate', reason: `cannot resolve a key for claim ${String(claim)} offline (only key:<hex> resolves)` };
  try {
    const ok = ed.verify(sig, new TextEncoder().encode(signedBytes(separator, artifactHashHex)), key);
    return ok ? { decision: 'pass' } : { decision: 'fail', reason: 'signature does not verify' };
  } catch {
    return { decision: 'fail', reason: 'malformed signature or key' };
  }
}
