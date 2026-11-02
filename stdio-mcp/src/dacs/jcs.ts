/**
 * DACS canonical form (CORE §B.2): RFC 8785 JCS over the document with the
 * hash-excluded fields omitted, after the CF-1 pre-pass:
 *   - every string VALUE is NFC-normalised (member names are left as received);
 *   - unpaired UTF-16 surrogates are rejected (no reproducible UTF-8 form);
 *   - JSON numbers outside the IEEE-754 safe-integer range are rejected.
 * Content hash = lowercase hex sha256 of the canonical UTF-8 bytes.
 */
import canonicalizeMod from 'canonicalize';
import { sha256 } from '@noble/hashes/sha256';

// canonicalize is CJS (module.exports = fn); normalise the default-import shape across loaders
const canonicalize = ((canonicalizeMod as unknown as { default?: unknown }).default ?? canonicalizeMod) as (v: unknown) => string | undefined;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const OMIT = Symbol('omit');

function noSurrogate(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error('JCS: unpaired UTF-16 surrogate has no canonical form');
  return s;
}

function prepare(v: unknown): unknown {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return OMIT;
  if (typeof v === 'bigint') throw new Error('JCS: bigint is not JSON; carry large quantities as decimal strings (CORE §B.2)');
  if (typeof v === 'string') return noSurrogate(v.normalize('NFC'));
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`JCS: number ${v} outside the safe-integer range (CORE §B.2)`);
    }
    return v;
  }
  if (Array.isArray(v)) {
    return Array.from(v, (x) => {
      const p = prepare(x);
      return p === OMIT ? null : p;
    });
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      noSurrogate(k);
      const p = prepare(x);
      if (p !== OMIT) out[k] = p;
    }
    return out;
  }
  return v; // null, boolean
}

export function canonicalBytes(value: unknown): Uint8Array {
  const p = prepare(value);
  const s = canonicalize(p === OMIT ? undefined : p);
  if (s === undefined) throw new Error('JCS: value is not JSON-encodable');
  return new TextEncoder().encode(s);
}

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function sha256Hex(bytes: Uint8Array): string {
  return hex(sha256(bytes));
}

/** sha256 hex of the canonical form of `doc` minus the `omit` top-level fields. */
export function contentHash(doc: Record<string, unknown>, omit: readonly string[]): string {
  // null prototype: an own member named "__proto__" must stay a member, not become a prototype
  const copy: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(doc)) if (!omit.includes(k)) copy[k] = v;
  return sha256Hex(canonicalBytes(copy));
}
