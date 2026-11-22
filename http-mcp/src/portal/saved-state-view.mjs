// One projection for every portal answer built from the client's saved state; it never throws on saved data.

/** The longest saved string an answer repeats; a longer one is cut and marked. */
export const SAVED_STRING_LIMIT = 4096;
const TRUNCATED = '…[truncated]';
const MAX_DEPTH = 8;
const DROPPED = new Set(['signature', 'signedTransaction', 'signedBytes', 'privateKey', 'seed', 'mnemonic', 'capability', 'token', 'replay']);

function bounded(value, depth) {
  if (typeof value === 'string') return value.length > SAVED_STRING_LIMIT ? value.slice(0, SAVED_STRING_LIMIT) + TRUNCATED : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => bounded(item, depth + 1));
  const copy = {};
  for (const [name, member] of Object.entries(value)) {
    if (!DROPPED.has(name)) copy[name] = bounded(member, depth + 1);
  }
  return copy;
}

/**
 * Returns a new plain object holding only `members` of `value` (dotted paths name nested members), each bounded:
 * members named as signing or replay material are dropped at any depth, strings over SAVED_STRING_LIMIT are cut,
 * and anything nested deeper than eight levels is left out. A missing member is left out.
 */
export function savedStateView(value, members) {
  const view = {};
  for (const path of members) {
    const names = path.split('.');
    let source = value;
    for (const name of names) source = source !== null && typeof source === 'object' && !DROPPED.has(name) ? source[name] : undefined;
    if (source === undefined) continue;
    let target = view;
    for (const name of names.slice(0, -1)) target = target[name] ??= {};
    target[names.at(-1)] = bounded(source, names.length);
  }
  return view;
}
