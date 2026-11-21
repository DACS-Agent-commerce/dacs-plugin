import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';
import * as client from '@kynesyslabs/dacs-client';
import { buildPurchaseReceipt, exportPurchaseEvidence } from '../src/portal/purchase-receipt.mjs';

const at = Date.parse('2026-10-08T12:00:00Z'), iso = new Date(at).toISOString();
const options = { accountId: 'TEST-owner', enabled: true, now: () => at };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const BUYER = `0x${'1'.repeat(64)}`, SELLER = '2'.repeat(64), CHAIN = 'c'.repeat(64), JOB = 'TEST-job';
const ref = (name) => ({ anchor: { kind: 'storage-program', locator: `dacs4:${name}:${JOB}` }, contentHash: sha(name) });
const buyerClaim = `did:demos:agent:${BUYER.slice(2)}`, sellerClaim = `did:demos:agent:${SELLER}`;

// A Demos anchor receipt in the core's readable shape, for the Deliverable.
const demosReceipt = () => ({ receiptVersion: '1', substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read',
  logicalAddress: ref('deliverable').anchor.locator, nativeAddress: `stor-${'e'.repeat(64)}`, contentHash: ref('deliverable').contentHash,
  transactionRef: { kind: 'demos-storage-program', value: 'b'.repeat(64) }, writer: buyerClaim, state: 'finalized', observationDisposition: 'established',
  observedAt: at, blockRef: { id: 'f'.repeat(64), height: '42', timestamp: at }, evidence: { kind: 'demos-block-proof', value: 'TEST-proof' } });
const vetParty = (role, locatorJob = JOB, contentHash = sha(`${role}-vet`)) => {
  const party = role === 'buyer' ? buyerClaim : sellerClaim;
  return { role, vetRecordRef: { anchor: { kind: 'storage-program', locator: compositeVerificationAddress(locatorJob, party) }, contentHash, signer: sellerClaim } };
};

// A settled client-created purchase at delivery-ready, as the client's store keeps it.
function purchase({ receipt = demosReceipt(), parties = [vetParty('buyer'), vetParty('seller')], domain = { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN }, protocol = {} } = {}) {
  const terms = { buyer: { accountId: options.accountId, wallet: BUYER }, seller: { claim: sellerClaim, payee: `0x${SELLER}` },
    listing: { listingId: 'TEST-listing', version: 1, contentHash: sha('listing'), anchor: { kind: 'storage-program', locator: `dacs4:listing:${JOB}` } },
    price: { amount: '2.5', amountOs: '2500000000', currency: 'DEM' }, network: 'demos-testnet', domain,
    protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', jobId: JOB, ...protocol } };
  const state = { protocol: { stage: 'delivery-ready', attempts: [],
    agreement: { ref: ref('agreement'), hash: ref('agreement').contentHash, artifact: { parties } },
    commitment: { ref: ref('commitment'), contentHash: ref('commitment').contentHash, verifiedAt: iso },
    delivery: { status: 'delivery-ready', deliverableRef: ref('deliverable'), payloadHash: ref('deliverable').contentHash, anchorReceipt: receipt } } };
  return { id: 'pur_TESTTESTTESTTEST', accountId: options.accountId, kind: 'purchase', status: 'settled_verified', terms, state };
}
const artifactOf = (op, kind) => exportPurchaseEvidence(op, options).artifacts.find((row) => row.kind === kind);

test('the purchase receipt renders a TP-1 purchase\'s artifacts from client names with no fixture-substrate or devnet-marker branch', () => {
  const op = purchase();
  const receipt = buildPurchaseReceipt(op, options);
  assert.equal(receipt.price.networkLabel, client.networkIdentityLabel(op.terms.domain));
  const deliverable = artifactOf(op, 'Deliverable');
  assert.equal(deliverable.status, 'recorded');
  assert.deepEqual(deliverable.reference.transaction, { kind: 'demos-storage-program', value: 'b'.repeat(64) });
  assert.deepEqual(deliverable.block, { number: 42, id: 'f'.repeat(64), timestamp: at });
  assert.equal(deliverable.observation.substrate, 'demos');
  assert.equal(deliverable.observation.finalityProfile, 'demos-bft-confirmed-native-read');
  assert.equal(deliverable.observation.state, 'finalized');
  assert.equal(deliverable.observation.disposition, 'established');
  assert.equal(artifactOf(op, 'Agreement').reference.storage.value, ref('agreement').anchor.locator);
  const marked = purchase({ protocol: { sellerCommitment: client.DEVNET_NATIVE_COMMITMENT_MARKER } });
  assert.deepEqual(artifactOf(marked, 'commitment'), artifactOf(op, 'commitment'), 'the commitment row does not branch on the devnet marker');
});

test('a receipt whose evidence names a fixture substrate or finality profile is shown as unverified evidence, never as settled', () => {
  for (const change of [{ substrate: 'simulated-loopback-fixture' }, { finalityProfile: 'fixture-only' }, { substrate: 'simulated-loopback-fixture', finalityProfile: 'fixture-only', transactionRef: { kind: 'fixture-sr2-write', value: 'b'.repeat(64) } }]) {
    const row = artifactOf(purchase({ receipt: { ...demosReceipt(), ...change } }), 'Deliverable');
    const label = JSON.stringify(change);
    assert.equal(row.observation.state, null, `${label}: no anchor state is shown`);
    assert.equal(row.observation.disposition, null, label);
    assert.ok(!JSON.stringify(row).includes('fixture'), `${label}: no fixture vocabulary is exported`);
    assert.ok(!JSON.stringify(row).includes('finalized'), label);
  }
});

test('a stored receipt the SDK\'s readable-receipt check rejects (missing version, writer or evidence; malformed member) exports no anchor state, block or transaction, and an indeterminate receipt exports its preserved receipt hash only and is never shown as the current state', () => {
  assert.equal(typeof client.isReadableAnchorReceipt, 'function', 'isReadableAnchorReceipt is absent from @kynesyslabs/dacs-client@0.1.0-alpha.0');
  const without = (key) => { const receipt = demosReceipt(); delete receipt[key]; return receipt; };
  const rejected = { 'missing version': without('receiptVersion'), 'missing writer': without('writer'), 'missing evidence': without('evidence'),
    'malformed block height': { ...demosReceipt(), blockRef: { id: 'f'.repeat(64), height: '042' } }, 'malformed state': { ...demosReceipt(), state: 'settled' } };
  for (const [label, receipt] of Object.entries(rejected)) {
    assert.equal(client.isReadableAnchorReceipt(receipt), false, label);
    const row = artifactOf(purchase({ receipt }), 'Deliverable');
    assert.equal(row.observation.state, null, label);
    assert.deepEqual(row.block, { number: null, id: null, timestamp: null }, label);
    assert.equal(row.reference.transaction, null, label);
    assert.equal(row.evidence, 'unverified', label);
  }
  const preservedReceiptHash = 'd'.repeat(64);
  const indeterminate = { ...demosReceipt(), state: 'submitted', observationDisposition: 'indeterminate', preservedReceiptHash };
  assert.equal(client.isReadableAnchorReceipt(indeterminate), true);
  const row = artifactOf(purchase({ receipt: indeterminate }), 'Deliverable');
  assert.equal(row.receiptHash, preservedReceiptHash);
  assert.equal(row.evidence, 'unverified');
  assert.equal(row.observation.state, null);
  assert.equal(row.reference.transaction, null);
});

test('a Vet ref at another job\'s composite address or equal to the not-performed placeholder is not shown as this purchase\'s Vet', () => {
  const shown = (parties) => artifactOf(purchase({ parties }), 'buyer-vet').reference.storage;
  assert.deepEqual(shown([vetParty('buyer'), vetParty('seller')]), { kind: 'storage-program', value: compositeVerificationAddress(JOB, buyerClaim) });
  assert.equal(shown([vetParty('buyer', 'TEST-job-2'), vetParty('seller')]), null, 'another job\'s composite address');
  const placeholder = client.vetNotPerformedRef(JOB, buyerClaim);
  assert.equal(shown([vetParty('buyer', JOB, placeholder.contentHash), vetParty('seller')]), null, 'the not-performed placeholder');
});

test('networkIdentityLabel shows the genesis label for the TP-1 domain and unbound when there is none', () => {
  assert.equal(buildPurchaseReceipt(purchase(), options).price.networkLabel, `genesis ${CHAIN}`);
  assert.equal(client.networkIdentityLabel(null), 'unbound');
  assert.equal(client.networkIdentityLabel(undefined), 'unbound');
});
