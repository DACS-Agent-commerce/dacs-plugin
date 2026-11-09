/**
 * key:<hex> and did:demos:agent:<hex> resolve to the same ed25519 key, so two
 * parties written with those two forms of one key are one party, not two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAgreementStructure, type Check } from '../../src/dacs/verify.js';
import { analyzeOfferForAccept, buildOffer } from '../../src/dacs/agreement.js';
import { claimIdentity } from '../../src/dacs/sig.js';

const HEX = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const h = (c: string) => c.repeat(64);
const party = (role: string, primaryClaim: string) => ({
  role, primaryClaim, bundleHash: h('1'), vetRecordRef: { anchor: { kind: 'demos-storage', locator: 'x' }, contentHash: h('2') },
});
function agreement(buyerClaim: string, sellerClaim: string) {
  return {
    agreementVersion: '1', jobId: 'job-1', listingRef: { listingId: 'l', version: 1, contentHash: h('3') }, derivedFromPattern: 'fixed-price',
    generatedAt: 1, signatures: [], parties: [party('buyer', buyerClaim), party('seller', sellerClaim)],
    terms: { price: { amount: '1', currency: 'DEM' }, deliverable: { deliverableType: 'x', hash: h('4') }, deadline: 2 },
  };
}
const structureProblem = (doc: any) => {
  const checks: Check[] = [];
  verifyAgreementStructure(doc, 'AgreementDocument', checks);
  return checks.find((c) => c.check === 'structure')?.detail ?? '';
};

test('claimIdentity: both forms of one key are the same identity; other claims are themselves', () => {
  assert.equal(claimIdentity(`key:${HEX}`), claimIdentity(`did:demos:agent:${HEX}`));
  assert.notEqual(claimIdentity(`key:${HEX}`), claimIdentity(`key:${OTHER}`));
  assert.equal(claimIdentity('did:web:example.com'), 'did:web:example.com');
});

test('an Agreement whose buyer and seller are one key in two claim forms has duplicate parties', () => {
  assert.match(structureProblem(agreement(`key:${HEX}`, `did:demos:agent:${HEX}`)), /duplicate primaryClaim/);
  assert.doesNotMatch(structureProblem(agreement(`key:${HEX}`, `did:demos:agent:${OTHER}`)), /duplicate primaryClaim/);
});

test('an offer naming this wallet again in the did:demos:agent form as the counterparty is refused', () => {
  const doc = agreement(`did:demos:agent:${HEX}`, `key:${HEX}`);
  assert.throws(() => analyzeOfferForAccept(doc, `0x${HEX}`), /duplicate primaryClaim|distinct primary claims/);
});

test('building an offer whose counterparty is this wallet in the did:demos:agent form is refused', () => {
  const input: any = {
    listingRef: { listingId: 'l', version: 1, contentHash: h('3') },
    self: { role: 'buyer', bundleHash: h('1'), vetRecordRef: party('buyer', '').vetRecordRef },
    counterparty: { ...party('seller', `did:demos:agent:${HEX}`) },
    price: { amount: '1', currency: 'DEM' }, deliverable: { deliverableType: 'x', hash: h('4') }, deadline: 2,
  };
  assert.throws(() => buildOffer(input, `0x${HEX}`, 1), /counterparty cannot be this wallet/);
  input.counterparty.primaryClaim = `did:demos:agent:${OTHER}`;
  assert.doesNotThrow(() => buildOffer(input, `0x${HEX}`, 1));
});
