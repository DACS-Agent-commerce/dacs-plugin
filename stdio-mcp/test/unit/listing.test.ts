/**
 * DACS-1 listing tests. Expected values come from the DACS-Standard spec text (§6.3.4, CORE §B.1/B.2/B.7)
 * and its conformance vector conformance/vectors/security/listing-preserve-unknown-v0.1.json
 * (copied verbatim to test/fixtures), not from this implementation's own output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { harness, keypair, MockWallet } from '../helpers.js';
import { signedEnvelope } from '../../alignment/index.mjs';
import { bundleHash, listingHash, listingLogicalAddress, opaqueListingProgramName, verifyListing } from '../../src/dacs/listing.js';
import { canonicalBytes } from '../../src/dacs/jcs.js';

const V = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../fixtures/listing-preserve-unknown-v0.1.json'), 'utf8'));
const NOW = 1_790_000_000_000; // inside the fixture validity window
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const fixture = (name: string) => clone(V.fixtures[name].listing);
const failedAt = (r: { checks: Array<{ check: string; decision: string }> }) => r.checks.find((c) => c.decision === 'fail')?.check;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function transformed(listing: any, t: any) {
  const out = clone(listing);
  if (t.kind === 'none') return out;
  const segs = t.path.split('.');
  let parent = out;
  for (const s of segs.slice(0, -1)) parent = parent[s];
  if (t.kind === 'set') parent[segs.at(-1)] = t.value; else delete parent[segs.at(-1)];
  return out;
}

// ---- conformance vector: hashes, signature, preserve-unknown, new-type refusal ----
test('vector: listing hash is sha256(JCS(listing minus signature)) and identity bundle hash omits presentation', () => {
  for (const n of ['listing-with-inert-extension', 'listing-with-unknown-phase']) {
    assert.equal(listingHash(V.fixtures[n].listing), V.fixtures[n].artifactHash, n);
  }
  assert.equal(bundleHash(V.fixtures['listing-with-inert-extension'].listing.seller.identity), V.fixtures.identityBundleHash);
});

test('vector: preserve-unknown cases (inert extension verifies; mutation/removal break the signature)', () => {
  const base = fixture('listing-with-inert-extension');
  for (const c of V.vectors.filter((v: any) => v.fixture === undefined || v.fixture === 'listing-with-inert-extension').slice(0, 3)) {
    const cand = transformed(base, c.transform);
    assert.equal(listingHash(cand), c.want.computedArtifactHash, c.name);
    const r = verifyListing(cand, { now: NOW, revocation: 'absent' });
    if (c.want.signature === 'valid') assert.equal(r.decision, 'accept', JSON.stringify(r.checks));
    else { assert.equal(r.decision, 'reject', c.name); assert.equal(failedAt(r), '4-signature'); }
  }
});

test('vector: unknown phase kind is refused even though the signature verifies', () => {
  const c = V.vectors.find((v: any) => v.name === 'valid-signature-unknown-phase-kind-refuses');
  const r = verifyListing(fixture(c.fixture), { now: NOW, revocation: 'absent' });
  assert.equal(r.decision, 'reject');
  assert.equal(r.checks.find((x) => x.check === '4-signature')?.decision, 'pass');
  assert.equal(failedAt(r), '7-pipeline');
});

// ---- spec rules ----
test('LR-3/RB-5: without a revocation result the decision is indeterminate, never accept; revoked is reject', () => {
  const l = fixture('listing-with-inert-extension');
  assert.equal(verifyListing(l, { now: NOW }).decision, 'indeterminate');
  assert.equal(verifyListing(l, { now: NOW, revocation: 'indeterminate' }).decision, 'indeterminate');
  assert.equal(verifyListing(l, { now: NOW, revocation: 'revoked' }).decision, 'reject');
});

test('LR-2 order halts on the first failure (schema before signature; validity before signature)', () => {
  const l = fixture('listing-with-inert-extension');
  const bad: any = { ...l, listingVersion: 0, signature: { ...l.signature, value: 'AAAA' } };
  const r = verifyListing(bad, { now: NOW });
  assert.equal(failedAt(r), '1-schema');
  assert.equal(r.checks.length, 1);
  assert.equal(failedAt(verifyListing(l, { now: l.validity.notAfter + 1 })), '3-validity');
  assert.equal(failedAt(verifyListing(l, { now: l.validity.notBefore - 1 })), '3-validity');
  assert.equal(failedAt(verifyListing({ ...l, dacsVersion: '2' }, { now: NOW })), '2-dacsVersion');
});

test('§6.3.4 size cap: canonical form over 16384 bytes is rejected', () => {
  const l = fixture('listing-with-inert-extension');
  l.futureOptionalMetadata = { pad: 'x'.repeat(16400) };
  assert.equal(failedAt(verifyListing(l, { now: NOW })), '4-canonical');
});

test('SIG-6 / domain separation: std-base64 value and a wrong-domain signature are rejected', () => {
  const l = fixture('listing-with-inert-extension');
  const raw = Buffer.from(l.signature.value, 'base64url');
  assert.equal(failedAt(verifyListing({ ...l, signature: { ...l.signature, value: raw.toString('base64') } }, { now: NOW })), '4-signature');
  assert.equal(failedAt(verifyListing({ ...l, signature: { ...l.signature, value: l.signature.value + '=' } }, { now: NOW })), '4-signature');
});

test('step 8: a pay-* phase needs a non-empty acceptedRails; step 9: signer must be a bundle claim (needs re-signing, so check ordering only)', () => {
  const priv = new Uint8Array(32).fill(77); const pub = ed.getPublicKey(priv);
  const claim = 'key:' + Buffer.from(pub).toString('hex');
  const mk = (over: any) => {
    const identity: any = { bundleVersion: '1', presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
    identity.presentation = { kind: 'per-claim', signatures: [{ ref: claim, signature: Buffer.from(ed.sign(new TextEncoder().encode('dacs-bundle-presentation:v1:' + bundleHash(identity)), priv)).toString('base64url') }] };
    const d: any = {
      dacsVersion: '1', listingVersion: 1, listingId: 'x', seller: { identity, displayName: 'S' },
      offering: { title: 't', description: 'd', category: 'a.b', tags: [], deliverable: { kind: 'external', description: 'x' } },
      buyerRequirement: { requirementVersion: '1', required: [] }, pipeline: [{ kind: 'negotiate-fixed-price' }, { kind: 'pay-x402', parameters: { rail: 'r' } }],
      pricing: { kind: 'fixed', price: { amount: '1', currency: 'USDC' } }, terms: {}, validity: { notBefore: 1 }, ...over,
    };
    d.signature = { algorithm: 'ed25519', signer: over.__signer ?? claim, value: Buffer.from(ed.sign(new TextEncoder().encode('dacs-listing:v1:' + listingHash(d)), priv)).toString('base64url') };
    return d;
  };
  assert.equal(failedAt(verifyListing(mk({}), { now: NOW })), '8-acceptedRails');
  assert.equal(verifyListing(mk({ acceptedRails: [{ railId: 'x402:USDC' }] }), { now: NOW, revocation: 'absent' }).decision, 'accept');
  assert.equal(failedAt(verifyListing(mk({ acceptedRails: [{ railId: 'r' }], __signer: 'key:' + 'ab'.repeat(32) }), { now: NOW, revocation: 'absent' })), '4-signature'); // sig made by another key
  // non-canonical price (CD-1) fails schema
  assert.equal(failedAt(verifyListing(mk({ pricing: { kind: 'fixed', price: { amount: '1.50', currency: 'USDC' } } }), { now: NOW })), '1-schema');
});

test('CF-4 logical address and Demos opaque colon-free write input', () => {
  const claim = 'key:' + '11'.repeat(32);
  assert.equal(listingLogicalAddress(claim, 'weather-band', 1), `dacs1:key%3A${'11'.repeat(32)}:weather-band:v1`);
  assert.equal(listingLogicalAddress('cci-xm:evm:mainnet:0x1234', 'a', 2), 'dacs1:cci-xm%3Aevm%3Amainnet%3A0x1234:a:v2');
  const name = opaqueListingProgramName(listingLogicalAddress(claim, 'weather-band', 1));
  assert.equal(name.includes(':'), false);
  assert.throws(() => listingLogicalAddress(claim, 'bad id', 1));
  assert.throws(() => listingLogicalAddress(claim, 'ok', 0));
});

// ---- tool flow through the alignment engine ----
const B = (over: any = {}) => ({
  listing_id: 'weather-api', listing_version: 1, display_name: 'Weather Co',
  offering: { title: 'Hourly weather', description: 'forecast', category: 'data.weather', tags: ['weather'], deliverable: { kind: 'attested-payload', payloadFormat: 'application/json' } },
  pricing: { kind: 'fixed', price: { amount: '1.25', currency: 'DEM' } },
  ...over,
});

test('listing prepare -> off-chat approval of the exact hash -> signed listing verifies; receipt carries the card hash', async () => {
  const wallet = new MockWallet(keypair(51));
  const h = await harness({}, { wallet });
  const p = await h.call('demos_dacs_listing_prepare', B());
  assert.equal(p.isError, false, p.text);
  assert.equal(p.json.status, 'awaiting_human_approval');
  assert.equal(p.json.signed, false);
  assert.equal(wallet.signs, 0, 'nothing signed before approval');
  assert.equal(wallet.broadcasts.length, 0);
  assert.ok(p.json.alignment, 'alignment decision returned with the prepare');
  assert.match(JSON.stringify(p.json.card.details), /dacs1:key%3A/);
  assert.match(p.json.action_digest, /^[0-9a-f]{16}$/);
  assert.match(h.channel.last().digest, /^[0-9a-f]{64}$/);
  assert.ok(h.channel.last().digest.startsWith(p.json.action_digest), 'the off-chat approval is bound to the same action hash');
  const noCode = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id });
  assert.equal(noCode.isError, true);
  assert.equal(wallet.signs, 0);
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r.isError, false, r.text);
  assert.equal(wallet.broadcasts.length, 0, 'a listing moves no funds');
  assert.equal(r.json.receipt.alignment.card_hash.length > 0, true);
  assert.equal(r.json.receipt.alignment.tier, 2);
  const signed = r.json.signed_listing;
  const v = await h.call('demos_dacs_listing_verify', { listing: signed, revocation: 'absent', expect_pin: r.json.listing_pin });
  assert.equal(v.json.decision, 'accept', v.text);
  assert.equal(v.json.pin.contentHash, listingHash(signed));
  assert.equal(r.json.listing_pin.contentHash, listingHash(signed));
  assert.equal(signed.signature.signer, 'key:' + wallet.address.slice(2));
  assert.equal(sha(canonicalBytes({ ...signed, signature: undefined })), r.json.listing_pin.contentHash);
  assert.equal(r.json.anchored, false);
  // tampering after signing is caught by the read tool
  const t = await h.call('demos_dacs_listing_verify', { listing: { ...signed, pricing: { kind: 'fixed', price: { amount: '0.01', currency: 'DEM' } } }, revocation: 'absent' });
  assert.equal(t.json.decision, 'reject');
  // pin mismatch refused
  const m = await h.call('demos_dacs_listing_verify', { listing: signed, revocation: 'absent', expect_pin: { ...r.json.listing_pin, contentHash: '0'.repeat(64) } });
  assert.equal(m.json.decision, 'reject');
});

test('alignment gate is invoked: a forbidden category is refused at prepare (A7) and nothing is staged', async () => {
  const h = await harness();
  const r = await h.call('demos_dacs_listing_prepare', B({ offering: { ...B().offering, category: 'fraud' } }));
  assert.equal(r.isError, true);
  assert.match(r.text, /alignment refuse: A7/);
  assert.equal(h.channel.messages.length, 0);
});

test('STOP refuses a listing prepare', async () => {
  const h = await harness();
  fs.writeFileSync(path.join(h.config.stateDir, 'STOP'), 'stop');
  const r = await h.call('demos_dacs_listing_prepare', B());
  assert.equal(r.isError, true);
  assert.equal(h.wallet.signs, 0);
});

test('impersonation refused: presenting another wallet\'s claim never reaches approval or signing', async () => {
  const h = await harness();
  const other = 'key:' + keypair(99).address.slice(2);
  const r = await h.call('demos_dacs_listing_prepare', B({ seller_claim: other }));
  assert.equal(r.isError, true);
  assert.match(r.text, /alignment refuse: A3|impersonation/);
  assert.equal(h.channel.messages.length, 0);
  assert.equal(h.wallet.signs, 0);
  // a foreign pre-built bundle is refused the same way
  const bundle = { bundleVersion: '1', presentedBy: other, presentedAt: 1, claims: [{ ref: other }] };
  const r2 = await h.call('demos_dacs_listing_prepare', B({ seller_identity: bundle }));
  assert.equal(r2.isError, true);
  assert.equal(h.wallet.signs, 0);
});

test('tier 2 outside a mandate: approval is required and a guessed or missing code signs nothing', async () => {
  const h = await harness();
  const p = await h.call('demos_dacs_listing_prepare', B());
  assert.equal(p.json.status, 'awaiting_human_approval');
  for (const args of [{ prepared_id: p.json.prepared_id }, { prepared_id: p.json.prepared_id, confirmation_code: 'approved-by-tool' }]) {
    const r = await h.call('demos_tx_submit', args);
    assert.equal(r.isError, true);
  }
  assert.equal(h.wallet.signs, 0);
});

test('within a signed standing mandate that names dacs-listing-sign, the listing is tier 1 (no prompt); a payment scope does not leak in', async () => {
  const h = await harness({}, { beforeServer: (stateDir, w) => {
    const dir = path.join(stateDir, 'alignment'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const human = generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(dir, 'human-key.json'), JSON.stringify({ public_key: human.publicKey.export({ type: 'spki', format: 'pem' }).toString() }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'mandate.json'), JSON.stringify(signedEnvelope({ type: 'mandate', id: 'lst', actor: w.address, network: 'testnet', scopes: ['dacs-listing-sign'], counterparties: ['chain'], max_os: '0', cap_os: '0', expires_at: Date.now() + 60000 }, human.privateKey)), { mode: 0o600 });
  } });
  const p = await h.call('demos_dacs_listing_prepare', B());
  assert.equal(p.json.status, 'standing_mandate_ready', p.text);
  assert.equal(h.channel.messages.length, 0);
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.receipt.alignment.tier, 1);
  // an offer is outside that mandate's scopes and still needs a human
  const pay = await h.call('demos_tx_prepare', { to: keypair(8).address, amount_dem: '1' });
  assert.equal(pay.json.status, 'awaiting_human_approval');
});

test('LP-3: versions are monotonic with no skips, tracked per publisher claim and listing id', async () => {
  const h = await harness();
  const skip = await h.call('demos_dacs_listing_prepare', B({ listing_version: 2 }));
  assert.equal(skip.isError, true);
  assert.match(skip.text, /listingVersion must be 1/);
  const p = await h.call('demos_dacs_listing_prepare', B());
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  assert.equal(r.isError, false, r.text);
  const again = await h.call('demos_dacs_listing_prepare', B());
  assert.equal(again.isError, true);
  const v2 = await h.call('demos_dacs_listing_prepare', B({ listing_version: 2 }));
  assert.equal(v2.isError, false, v2.text);
  const other = await h.call('demos_dacs_listing_prepare', B({ listing_id: 'other' }));
  assert.equal(other.isError, false, other.text);
});

test('the listing pin is accepted by the existing offer tool as listing_ref (LR-1 hand-off)', async () => {
  const h = await harness();
  const p = await h.call('demos_dacs_listing_prepare', B());
  const r = await h.call('demos_tx_submit', { prepared_id: p.json.prepared_id, confirmation_code: h.channel.last().code });
  const pin = r.json.listing_pin;
  const vet = { anchor: { kind: 'https', locator: 'https://x.example/v' }, contentHash: sha('v') };
  const offer = await h.call('demos_dacs_create_offer_prepare', {
    role: 'seller', listing_ref: pin, self_bundle_hash: sha('sb'), self_vet_record_ref: vet,
    counterparty: { primary_claim: 'key:' + keypair(52).address.slice(2), bundle_hash: sha('bb'), vet_record_ref: vet },
    price: { amount: '1.25', currency: 'DEM' }, deliverable: { deliverableType: 'storage-program', hash: sha('d') },
    deadline_unix_ms: Date.parse('2027-01-01T00:00:00Z'),
  });
  assert.equal(offer.isError, false, offer.text);
});
