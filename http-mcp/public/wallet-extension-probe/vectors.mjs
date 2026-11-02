import { addressOf, sha256 } from './checks.mjs';

export const MESSAGE_VECTORS = Object.freeze([
  `dacs-bundle-presentation:v1:${'0'.repeat(64)}`,
  'wallet-extension-probe.invalid requests a DACS wallet signature\n\nHarmless probe only. No login or purchase authorization.\n\norigin: https://wallet-extension-probe.invalid\npurpose: wallet-extension-probe\nnonce: fixed-probe-nonce\nissued-at: 2000-01-01T00:00:00.000Z\nexpires-at: 2000-01-01T00:00:01.000Z',
  'DACS wallet probe — café ∑ 🧪',
]);
export const PROBE_NETWORK = 'wallet-extension-probe-unbound';
export const PROBE_CHAIN_IDENTITY = '0'.repeat(64);
// Every probe requests nonce 1; the adapter refuses to ask for a signature
// until the account's current nonce is at least 1.
export const PROBE_NONCE = 1;
// Throwaway-account cap: 10 DEM in OS. P4 risks one self-transfer plus fees,
// and P5 a public storage-program create plus storage fees.
// The cap is a pre-sign read; deposit and account-switch races remain.
export const PROBE_MAX_BALANCE_OS = 10_000_000_000n;
const canonical = (v) => JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map((x) => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, JSON.parse(canonical(v[k]))])) : v);
const fee = () => ({ network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null });
function envelope(content, nonce, timestamp) {
  if (!Number.isSafeInteger(nonce) || nonce !== PROBE_NONCE || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('invalid_coordinates');
  return { content: { ...content, nonce, timestamp, transaction_fee: fee() }, signature: null, hash: '', status: '', blockNumber: null };
}
export function nativeVector({ from, nonce, timestamp }) {
  from = addressOf(from);
  const to=from, amount='1';
  return envelope({ type: 'native', from, to, amount, data: ['native', { nativeOperation: 'send', args: [to, amount] }] }, nonce, timestamp);
}
export async function storageVector({ from, nonce, timestamp }) {
  from = addressOf(from);
  const logicalAddress = 'dacs3:agreement:wallet-extension-probe', programName = logicalAddress.replace(/:/g, '%3A');
  // Deliberately unsigned, bounded ASCII fixture; never a purchase Agreement.
  const artifact = { agreementVersion: '1', jobId: 'wallet-extension-probe', statement: 'Harmless unsigned test Agreement. No authorization.', signatures: [] };
  const contentHash = await sha256(canonical({ agreementVersion: artifact.agreementVersion, jobId: artifact.jobId, statement: artifact.statement }));
  const envelopeHash = await sha256(canonical(artifact));
  const storageAddress = `stor-${(await sha256(`${from}:${programName}:${nonce}:`)).slice(0, 40)}`;
  const tx = envelope({ type: 'storageProgram', from, to: storageAddress, amount: 0,
    data: ['storageProgram', { operation: 'CREATE_STORAGE_PROGRAM', storageAddress, programName, encoding: 'json', data: artifact,
      metadata: { logicalAddress, contentHash, envelopeHash, artifactKind: 'Agreement' }, acl: { mode: 'public' }, salt: '', storageLocation: 'onchain' }] }, nonce, timestamp);
  tx.content.from_ed25519_address = from;
  tx.content.network = PROBE_NETWORK; tx.content.chainIdentity = PROBE_CHAIN_IDENTITY;
  return tx;
}

export async function assertProbeTransaction(transaction) {
  const c=transaction?.content;
  const expected=c?.type==='native'?nativeVector(c):c?.type==='storageProgram'?await storageVector(c):null;
  if(!expected||JSON.stringify(transaction)!==JSON.stringify(expected)) throw new Error('invalid_probe_transaction');
}
