import { assertProbeTransaction } from './vectors.mjs';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const hasKeys = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export function addressOf(value) {
  if (typeof value !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(value)) throw new Error('invalid_address');
  return `0x${value.replace(/^0x/i, '').toLowerCase()}`;
}
const hexBytes = (v) => Uint8Array.from(v.match(/../g), (b) => Number.parseInt(b, 16));
export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
function signatureBytes(value) {
  if (typeof value !== 'string') throw new Error('invalid_signature');
  const s = value.replace(/^(0x)+/i, '');
  if (/^[0-9a-f]{128}$/i.test(s)) return hexBytes(s);
  if (/^[A-Za-z0-9_-]{86}$/.test(s)) return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=='), (b) => b.charCodeAt(0));
  throw new Error('invalid_signature');
}
// Same raw UTF-8 / WebCrypto Ed25519 convention as embedded-wallet/sdk-provider.mjs.
export async function verifyExact(address, message, signature) {
  try {
    const key = await crypto.subtle.importKey('raw', hexBytes(addressOf(address).slice(2)), { name: 'Ed25519' }, false, ['verify']);
    const bytes = signatureBytes(signature);
    return bytes.length === 64 && await crypto.subtle.verify('Ed25519', key, bytes, new TextEncoder().encode(message));
  } catch { return false; }
}
export function messageSignature(value, address) {
  if (typeof value === 'string') return value;
  if (hasKeys(value, ['type', 'data']) && value.type === 'ed25519') return value.data;
  if (hasKeys(value, ['type', 'signature', 'address']) && value.type === 'ed25519' && addressOf(value.address) === address) return value.signature;
  throw new Error('signature_shape_or_account');
}
// One bounded, inert JSON snapshot, before inspecting or retaining any response.
export function jsonCopy(value) {
  let count = 0, size = 0;
  const visit = (v, depth) => {
    if (++count > 4096 || depth > 20) throw new Error('response_bounds');
    if (typeof v === 'string') { size += v.length; if (size > 65536) throw new Error('response_bounds'); return v; }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    if (!v || typeof v !== 'object' || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw new Error('response_not_json');
    const out = Array.isArray(v) ? [] : Object.create(null), descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(descriptors).some((k) => typeof k !== 'string')) throw new Error('response_not_json');
    for (const [k, d] of Object.entries(descriptors)) {
      if (Array.isArray(v) && k === 'length') continue;
      if (!d.enumerable || !Object.hasOwn(d, 'value') || (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(k))) throw new Error('response_not_json');
      size += k.length; if (size > 65536) throw new Error('response_bounds');
      Object.defineProperty(out, k, { value: visit(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    if (Array.isArray(v) && Object.keys(out).length !== v.length) throw new Error('response_not_json');
    return out;
  };
  return visit(value, 0);
}
export function publicView(value, basis = null, rootPath = '$') {
  const keys = new Set(['type', 'id', 'method', 'success', 'data', 'error', 'code', 'message', 'details', 'address', 'signature', 'hash', 'content', 'status', 'blockNumber']);
  const strings = new Set(['ed25519', 'demosProviderResponse', 'connect', 'sign', 'signTransaction', '']);
  const learn = (v) => {
    if (typeof v === 'string') strings.add(v);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); learn(x); }
  };
  learn(basis);
  const visit = (v, path, parent = null) => {
    if (typeof v === 'string') {
      const account = /^\$(?:\.data)?\.(?:address|content\.(?:from|to|from_ed25519_address))$/.test(path) || (path === '$.data' && hasKeys(parent, ['code', 'data']) && parent.code === 200);
      const signature = (path === '$.data' && basis?.method === 'sign') || (parent?.type === 'ed25519' && ['$.data.data', '$.data.signature', '$.data.signature.data'].includes(path));
      const hash = ['$.hash', '$.data.hash'].includes(path) || /^\$(?:\.data)?\.content\.data\.1\.metadata\.(?:contentHash|envelopeHash)$/.test(path);
      const id = path === '$.id' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
      return strings.has(v) || (!path.startsWith('$.error') && ((account && /^(0x)?[0-9a-f]{64}$/i.test(v))
        || (signature && (/^(0x)*[0-9a-f]{128}$/i.test(v) || /^[A-Za-z0-9_-]{86}$/.test(v)))
        || (hash && /^[0-9a-f]{64}$/.test(v)) || id)) ? v : { omitted: 'unrecognized-string', length: v.length };
    }
    if (Array.isArray(v)) return v.map((x, i) => visit(x, `${path}.${i}`, v));
    if (!object(v)) return v;
    const out = Object.create(null); let unknown = 0;
    for (const [k, x] of Object.entries(v)) { const key = keys.has(k) ? k : `[unknown-field-${++unknown}]`; out[key] = visit(x, `${path}.${key}`, v); }
    return out;
  };
  return visit(value, rootPath);
}
// Fields the bundled SDK's sign() adds to content; named so they can be told
// apart from unknown additions, whose names are never reported.
const SDK_ADDED = ['gcr_edits', 'from_ed25519_address'];
export function fieldDiffs(expected, actual) {
  const diffs = [];
  const visit = (a, b, path) => {
    if (Object.is(a, b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      let unknown = 0;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const p = `${path}.${Object.hasOwn(a, k) || (path === '$.content' && SDK_ADDED.includes(k)) ? k : `[extra-${++unknown}]`}`;
        if (!Object.hasOwn(a, k) || !Object.hasOwn(b, k)) diffs.push({ path: p, expected: Object.hasOwn(a, k) ? a[k] : null, actual: Object.hasOwn(b, k) ? b[k] : null, kind: Object.hasOwn(a, k) ? 'missing' : 'extra' });
        else visit(a[k], b[k], p);
      }
    } else diffs.push({ path, expected: a, actual: b, kind: 'changed' });
  };
  visit(expected, actual, '$');
  return diffs.map((d) => ({ path: d.path, kind: d.kind }));
}
// The bundled SDK's sign() (4.0.16) always sets content.gcr_edits, adds
// content.from_ed25519_address (the signing key) when absent and replaces the
// transaction_fee values. It then serializes the whole content in one fork
// mode: pre-fork, amounts and fees are DEM numbers; post-fork, they are decimal
// OS strings. An honest SDK-based wallet therefore returns ok:false with exactly
// those diffs, all in one mode. They are counted apart from a nonce, recipient
// or signer change, which an honest wallet never makes.
const DEM = 1_000_000_000n;
// Requested fixture values only: a string is OS, a number is whole DEM.
const osOf = (v) => typeof v === 'string' ? BigInt(v) : BigInt(v) * DEM;
const SDK_PROFILES = {
  // Below one DEM there is no pre-fork form: the SDK truncates P4's one OS to 0
  // in the amount and both transfer edits. That is a denomination rewrite, so
  // it is never SDK-expected.
  'pre-fork': { wire: (os) => os % DEM === 0n ? Number(os / DEM) : undefined, fee: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 },
  'post-fork': { wire: (os) => os.toString(), fee: (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) },
};
// The complete ordered edits from SDK GCRGeneration for the two fixed vectors,
// in one profile's wire form. Bind to the request and the connected canonical
// address, never to wallet-supplied transaction fields.
function sdkEditsMatch(edits, requested, address, wire) {
  if (!Array.isArray(edits) || edits.length !== 4) return false;
  const c = requested.content, op = c.data[1], amount = wire(osOf(c.amount));
  if (c.type === 'native' && amount === undefined) return false;
  const edit = (type, operation, value) => ({ type, operation, isRollback: false, account: address, txhash: requested.hash, amount: value });
  // The gas debit is a fixed one DEM. The storage debit is one DEM only because
  // this fixture is below the SDK's 10 KiB storage pricing chunk; it is not a
  // general storage price.
  const gas = edit('balance', 'remove', wire(DEM)), nonce = edit('nonce', 'add', 1);
  const expected = c.type === 'native'
    ? [edit('balance', 'remove', amount), edit('balance', 'add', amount), gas, nonce]
    : [edit('balance', 'remove', wire(DEM)), { type: 'storageProgram', target: op.storageAddress, isRollback: false, txhash: requested.hash,
      context: { operation: 'CREATE_STORAGE_PROGRAM', sender: address, data: { variables: op, metadata: op.metadata } } }, gas, nonce];
  return edits.every((e, i) => object(e) && fieldDiffs(expected[i], e).length === 0);
}
// Every field the SDK's sign() writes, checked in one profile whether or not it
// differs from the request. Fee values come from the wallet's node and are not
// bounded here; only their form is. additional_fee is always zero.
function sdkFields({ wire, fee }, content, address, requested) {
  const amount = wire(osOf(requested.content.amount)), fees = content?.transaction_fee;
  return {
    '$.content.amount': () => amount !== undefined && content?.amount === amount,
    '$.content.transaction_fee.network_fee': () => fee(fees?.network_fee),
    '$.content.transaction_fee.rpc_fee': () => fee(fees?.rpc_fee),
    '$.content.transaction_fee.additional_fee': () => fees?.additional_fee === wire(0n),
    '$.content.from_ed25519_address': () => content?.from_ed25519_address === address,
    '$.content.gcr_edits': () => sdkEditsMatch(content?.gcr_edits, requested, address, wire),
  };
}
const affects = (diff, path) => diff.path === path || path.startsWith(`${diff.path}.`);
const RECIPIENT_PATHS = ['$.content.to', '$.content.data.1.args.0', '$.content.data.1.storageAddress'];
const SIGNER_PATHS = ['$.content.from', '$.content.from_ed25519_address'];
const AMOUNT_PATHS = ['$.content.amount', '$.content.data.1.args.1'];
export function diffSummary(diffs, signed, address, requested) {
  // Each profile counts its unexplained diffs plus every SDK-written field that
  // is unchanged but not in that profile's form; the best profile is reported.
  const [profile] = Object.entries(SDK_PROFILES).map(([name, form]) => {
    const fields = sdkFields(form, signed?.content, address, requested);
    const sdkExpected = (d) => Object.hasOwn(fields, d.path) && fields[d.path]();
    const expected = diffs.filter(sdkExpected).length;
    const gaps = Object.keys(fields).filter((path) => !diffs.some((d) => affects(d, path)) && !fields[path]()).length;
    return { name, sdkExpected, expected, unexpected: diffs.length - expected + gaps };
  }).sort((a, b) => a.unexpected - b.unexpected);
  const ownKey = (d) => { try { return d.path === '$.content.from_ed25519_address' && addressOf(signed?.content?.from_ed25519_address) === address; } catch { return false; } };
  const nonceChanged = diffs.some((d) => affects(d, '$.content.nonce'));
  const recipientChanged = diffs.some((d) => RECIPIENT_PATHS.some((path) => affects(d, path)));
  const signerChanged = diffs.some((d) => SIGNER_PATHS.some((path) => affects(d, path)) && !ownKey(d));
  const amountChanged = diffs.some((d) => AMOUNT_PATHS.some((path) => affects(d, path)) && !profile.sdkExpected(d));
  if (diffs.length === 0) return { reading: 'no-field-diffs', nonceChanged, recipientChanged, signerChanged, amountChanged, sdkProfile: null, sdkExpected: 0, unexpected: 0 };
  const reading = nonceChanged || recipientChanged || signerChanged ? 'nonce-recipient-or-signer-changed'
    : profile.unexpected === 0 ? 'sdk-expected-only' : 'other-unexpected-diffs';
  return { reading, nonceChanged, recipientChanged, signerChanged, amountChanged, sdkProfile: profile.name, sdkExpected: profile.expected, unexpected: profile.unexpected };
}
export async function checkSignedTransaction(requested, signed, address) {
  await assertProbeTransaction(requested);
  const compared = jsonCopy(signed);
  if (object(compared)) {
    if (Object.hasOwn(compared, 'signature')) compared.signature = null;
    if (Object.hasOwn(compared, 'hash')) compared.hash = '';
  }
  const diffs = fieldDiffs(requested, compared);
  const requestedHash = await sha256(JSON.stringify(requested.content));
  const computedHash = object(signed?.content) ? await sha256(JSON.stringify(signed.content)) : null;
  const hashValid = /^[0-9a-f]{64}$/.test(signed?.hash ?? '') && signed.hash === computedHash;
  const hashMatchesRequested = signed?.hash === requestedHash;
  const signatureValid = hasKeys(signed?.signature, ['type', 'data']) && signed.signature.type === 'ed25519'
    && await verifyExact(address, signed.hash, signed.signature.data);
  return { ok: diffs.length === 0 && hashValid && hashMatchesRequested && signatureValid, diffs, diffSummary: diffSummary(diffs, compared, address, requested), requestedHash, computedHash, hashValid, hashMatchesRequested, signatureValid };
}
