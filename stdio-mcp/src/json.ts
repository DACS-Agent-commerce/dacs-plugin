/**
 * JSON helpers. Chain data carries bigints (balances, fees in OS), so every
 * value that leaves the server goes through `toJsonSafe` first: bigints become
 * decimal strings, functions/symbols are dropped, cycles are cut, and very long
 * strings / arrays are truncated so one tool call cannot flood the model.
 */

const MAX_STRING = 4_000;
const MAX_ARRAY = 200;
const MAX_DEPTH = 12;

export function toJsonSafe(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…[truncated ${value.length - MAX_STRING} chars]` : value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`.slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (typeof value === 'object') {
    // `seen` holds the current ancestors only: a true cycle is cut, a shared reference is not
    if (seen.has(value as object)) return '[cycle]';
    seen.add(value as object);
    try {
      if (Array.isArray(value)) {
        const out = value.slice(0, MAX_ARRAY).map((v) => toJsonSafe(v, depth + 1, seen));
        if (value.length > MAX_ARRAY) out.push(`…[${value.length - MAX_ARRAY} more items]`);
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const s = toJsonSafe(v, depth + 1, seen);
        if (s !== undefined) out[k] = s;
      }
      return out;
    } finally {
      seen.delete(value as object);
    }
  }
  return String(value);
}

export function stringify(value: unknown): string {
  return JSON.stringify(toJsonSafe(value), null, 2);
}

/** Parse a JSON string if it looks like one; otherwise return the input unchanged. */
export function maybeParseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}
