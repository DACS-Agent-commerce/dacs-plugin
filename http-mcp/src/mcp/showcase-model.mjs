import { sellerData } from './seller-content.mjs';

const NAMES = ['Identify', 'Vet', 'Negotiate', 'Settle', 'Verify'];
const STATES = new Set(['pending', 'verified', 'rejected', 'held', 'unknown', 'missing', 'passed', 'included', 'delivery-ready', 'payment-evidenced', 'failed', 'cancelled', 'expired', 'superseded']);
const stage = /^stages\.([0-4])$/;
const row = /^stages\.[0-4]\.evidence\.\d+$/;

// Model-only copy of the plain human projection. Paths AND values must qualify;
// a new field (including an object/array with seller-chosen keys) is wrapped
// whole by default. Fixed prose is conservatively labelled too: matching a
// familiar sentence is not evidence of its origin. Never inspect diagnostics
// to decide whether they are safe, and never unwrap a purported input envelope.
export function showcaseProgressForModel(ledger) {
  function copy(value, path = '') {
    if (value == null) return value;
    if (path === 'version' && value === 1) return value;
    const name = /^stages\.([0-4])\.name$/.exec(path);
    if (name && value === NAMES[Number(name[1])]) return value;
    if (/^stages\.[0-4](?:\.evidence\.\d+)?\.state$/.test(path) && STATES.has(value)) return value;
    if (/^stages\.[0-4]\.evidence\.\d+\.block$/.test(path) && Number.isSafeInteger(value) && value >= 0) return value;
    if (/^stages\.[0-4]\.evidence\.\d+\.artifactHash$/.test(path) && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
    if (/^stages\.[0-4]\.evidence\.\d+\.txHash$/.test(path) && typeof value === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(value)) return value;
    if ((path === 'stages' || /^stages\.[0-4]\.evidence$/.test(path)) && Array.isArray(value)) {
      return value.map((child, i) => copy(child, `${path}.${i}`));
    }
    if ((path === '' || stage.test(path) || row.test(path)) && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key.includes('.') ? sellerData(child) : copy(child, path ? `${path}.${key}` : key)]));
    }
    return sellerData(value);
  }
  return copy(ledger);
}
