/**
 * DACS verifier + offer/accept. Fixtures are derived from the spec text
 * (CORE §B.2/§B.7, DACS-3 §8.5, DACS-5 §10.4), signed with real ed25519 keys —
 * not copied from the implementation under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import canonicalizeMod from 'canonicalize';
import { verifyArtifact, logicalBundleAddress } from '../../src/dacs/verify.js';
import { decodeSig6, verifyDomainSig } from '../../src/dacs/sig.js';
import { canonicalBytes } from '../../src/dacs/jcs.js';
import { harness, keypair, MockWallet } from '../helpers.js';

const canonicalize = ((canonicalizeMod as any).default ?? canonicalizeMod) as (v: unknown) => string;
const H = (s: string) => Buffer.from(sha256(new TextEncoder().encode(s))).toString('hex');

// Independent reference computation straight from the spec text.
function specHash(doc: Record<string, unknown>, omit: string[]): string {
  const c: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!omit.includes(k)) c[k] = v;
  return Buffer.from(sha256(new TextEncoder().encode(canonicalize(c)))).toString('hex');
}
function specSign(sep: string, hashHex: string, priv: Uint8Array): string {
  return Buffer.from(ed.sign(new TextEncoder().encode(sep + hashHex), priv)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const buyer = keypair(21);
const seller = keypair(22);
const orch = keypair(23);
const claim = (k: { pub: Uint8Array }) => 'key:' + Buffer.from(k.pub).toString('hex');
const ref = (s: string) => ({ anchor: { kind: 'storage-program', locator: 'stor-' + H(s).slice(0, 40) }, contentHash: H(s) });

function agreement(): Record<string, any> {
  return {
    agreementVersion: '1',
    jobId: '01JZ0000000000000000000000',
    listingRef: { listingId: 'weather-api', version: 2, contentHash: H('listing') },
    parties: [
      { role: 'buyer', bundleHash: H('bb'), primaryClaim: claim(buyer), vetRecordRef: ref('vb') },
      { role: 'seller', bundleHash: H('sb'), primaryClaim: claim(seller), vetRecordRef: ref('vs') },
    ],
    terms: { deliverable: { deliverableType: 'storage-program', hash: H('deliv') }, price: { amount: '1.5', currency: 'DEM' }, rail: { railId: 'demos-native:DEM' }, deadline: Date.parse('2027-01-01T00:00:00Z') },
    derivedFromPattern: 'fixed-price',
    generatedAt: Date.parse('2026-10-05T00:00:00Z'),
    signatures: [],
  };
}

function signAgreement(doc: Record<string, any>, ...keys: Array<typeof buyer>) {
  const h = specHash(doc, ['signatures']);
  return { ...doc, signatures: keys.map((k) => ({ party: claim(k), algorithm: 'ed25519', value: specSign('dacs-agreement:v1:', h, k.priv) })) };
}

test('agreement: both signatures → accept; one → indeterminate; tamper → reject', async () => {
  const both = signAgreement(agreement(), seller, buyer);
  const r = await verifyArtifact(both, null);
  assert.equal(r.decision, 'accept', JSON.stringify(r.checks));
  assert.equal(r.artifactHash, specHash(agreement(), ['signatures']));
  const offer = signAgreement(agreement(), seller);
  assert.equal((await verifyArtifact(offer, null)).decision, 'indeterminate');
  const tampered = { ...both, terms: { ...both.terms, price: { amount: '0.5', currency: 'DEM' } } };
  assert.equal((await verifyArtifact(tampered, null)).decision, 'reject');
});

test('cross-domain replay: a bundle-domain signature does not verify as an agreement', async () => {
  const doc = agreement();
  const h = specHash(doc, ['signatures']);
  const wrong = { ...doc, signatures: [seller, buyer].map((k) => ({ party: claim(k), algorithm: 'ed25519', value: specSign('dacs-bundle:v1:', h, k.priv) })) };
  assert.equal((await verifyArtifact(wrong, null)).decision, 'reject');
});

test('SIG-6: padded, standard-base64 and hex spellings are rejected', async () => {
  const both = signAgreement(agreement(), seller, buyer);
  const v = both.signatures[0].value as string;
  const raw = Buffer.from(v, 'base64url');
  for (const bad of [v + '==', raw.toString('base64'), raw.toString('hex')]) {
    if (bad === v) continue;
    const doc = { ...both, signatures: [{ ...both.signatures[0], value: bad }, both.signatures[1]] };
    assert.equal((await verifyArtifact(doc, null)).decision, 'reject', bad);
  }
  assert.deepEqual(decodeSig6('AA'), new Uint8Array([0]));
  assert.equal(decodeSig6('AB'), null, 'non-zero residual bits are non-canonical');
  assert.equal(decodeSig6('AA=='), null);
  assert.equal(decodeSig6('a+b/'), null);
});

test('agreement structural rules: CD-1 price, both discriminators, unlisted signer', async () => {
  const nonCanon = signAgreement({ ...agreement(), terms: { ...agreement().terms, price: { amount: '1.50', currency: 'DEM' } } }, seller, buyer);
  assert.equal((await verifyArtifact(nonCanon, null)).decision, 'reject');
  assert.equal((await verifyArtifact({ ...agreement(), payeeBoundAgreementVersion: '1' }, null)).decision, 'reject');
  const outsider = keypair(99);
  const doc = signAgreement(agreement(), seller, buyer, outsider);
  assert.equal((await verifyArtifact(doc, null)).decision, 'reject');
});

test('unresolvable claim schemes are indeterminate, never accept', async () => {
  const doc = agreement();
  doc.parties[0].primaryClaim = 'did:web:buyer.example';
  const h = specHash(doc, ['signatures']);
  doc.signatures = [
    { party: 'did:web:buyer.example', algorithm: 'ed25519', value: specSign('dacs-agreement:v1:', h, buyer.priv) },
    { party: claim(seller), algorithm: 'ed25519', value: specSign('dacs-agreement:v1:', h, seller.priv) },
  ];
  assert.equal((await verifyArtifact(doc, null)).decision, 'indeterminate');
});

function faultBundle(over: Record<string, any> = {}): Record<string, any> {
  return {
    faultBundleVersion: '1',
    jobId: '01JZ0000000000000000000000',
    outcome: 'aborted-by-other',
    faultedParty: 'seller',
    anchoredByRole: 'buyer',
    listingRef: { listingId: 'weather-api', version: 2, contentHash: H('listing') },
    parties: [
      { role: 'buyer', bundleHash: H('bb'), primaryClaim: claim(buyer) },
      { role: 'seller', bundleHash: H('sb'), primaryClaim: claim(seller) },
    ],
    phaseSummary: [{ index: 0, kind: 'pay-dem', outcome: 'ok', txRefs: [{ kind: 'demos', txHash: H('tx1'), blockNumber: 77 }] }],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1_790_000_000_000,
    signatures: [],
    ...over,
  };
}
function signBundle(doc: Record<string, any>, sep: string, ...keys: Array<typeof buyer>) {
  const h = specHash(doc, ['signatures', 'anchoredByRole']);
  return { ...doc, signatures: keys.map((k) => ({ party: claim(k), algorithm: 'ed25519', value: specSign(sep, h, k.priv) })) };
}

test('fault bundle: permissible faultedParty, anchoredByRole excluded from hash, chain tx check', async () => {
  const b = signBundle(faultBundle(), 'dacs-fault-bundle:v1:', buyer);
  const h = await harness();
  h.chain.txs.set(H('tx1'), { hash: H('tx1'), found: true, state: 'included', blockNumber: 77 });
  // with chain checks on, an unanchored bundle is not accepted
  assert.equal((await verifyArtifact(b, h.chain)).decision, 'indeterminate');
  const anchor = 'stor-' + H('anchor').slice(0, 40);
  h.chain.storage.set(anchor, { storageAddress: anchor, data: b });
  const r = await verifyArtifact(b, h.chain, { anchorAddress: anchor });
  // a one-sided abort signed by the anchoring party is admitted but not probative (§10.11)
  assert.equal(r.decision, 'indeterminate', JSON.stringify(r.checks));
  assert.ok(r.checks.some((c) => c.check === 'required-signers' && /not probative/.test(c.detail ?? '')), 'one-sided abort is flagged');
  // the anchored copy carries the same one-sided signature status, so it is indeterminate too (BB-5.9)
  assert.ok(r.checks.filter((c) => c.check !== 'required-signers' && c.check !== 'anchor').every((c) => c.decision === 'pass'), JSON.stringify(r.checks));
  // an anchored copy with its signatures stripped (signatures are outside the hash) is rejected
  h.chain.storage.set(anchor, { storageAddress: anchor, data: { ...b, signatures: [] } });
  assert.equal((await verifyArtifact(b, h.chain, { anchorAddress: anchor })).decision, 'reject');
  h.chain.storage.set(anchor, { storageAddress: anchor, data: b });
  // signed only by the non-anchoring party → reject
  const wrongSigner = signBundle(faultBundle(), 'dacs-fault-bundle:v1:', seller);
  h.chain.storage.set(anchor, { storageAddress: anchor, data: wrongSigner });
  assert.equal((await verifyArtifact(wrongSigner, h.chain, { anchorAddress: anchor })).decision, 'reject');
  // anchoredByRole is not hashed: the seller's copy has the same hash
  const sellerCopy = { ...b, anchoredByRole: 'seller', outcome: 'aborted-by-other' };
  assert.equal((await verifyArtifact(sellerCopy, null)).artifactHash, r.artifactHash);
  // ...but its faultedParty is now impermissible for (aborted-by-other, seller)
  assert.equal((await verifyArtifact(sellerCopy, null)).decision, 'reject');
  // completed outcome requires faultedParty none and both signatures
  const done = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none' }), 'dacs-fault-bundle:v1:', buyer);
  assert.equal((await verifyArtifact(done, null)).decision, 'reject');
  const done2 = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none' }), 'dacs-fault-bundle:v1:', buyer, seller);
  assert.equal((await verifyArtifact(done2, null)).decision, 'accept');
  // a bundle signed under the legacy domain does not verify as a fault bundle
  const wrongDomain = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none' }), 'dacs-bundle:v1:', buyer, seller);
  assert.equal((await verifyArtifact(wrongDomain, null)).decision, 'reject');
  // chain: a not-found tx is indeterminate (not authoritative absence), a failed tx rejects
  const h2 = await harness();
  assert.equal((await verifyArtifact(done2, h2.chain)).decision, 'indeterminate');
  h2.chain.txs.set(H('tx1'), { hash: H('tx1'), found: true, state: 'failed' });
  assert.equal((await verifyArtifact(done2, h2.chain)).decision, 'reject');
});

test('orchestrator as a distinct party is a required signer', async () => {
  const parties = [...faultBundle().parties, { role: 'orchestrator', bundleHash: H('ob'), primaryClaim: claim(orch) }];
  const two = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none', parties }), 'dacs-fault-bundle:v1:', buyer, seller);
  assert.equal((await verifyArtifact(two, null)).decision, 'reject');
  const three = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none', parties }), 'dacs-fault-bundle:v1:', buyer, seller, orch);
  assert.equal((await verifyArtifact(three, null)).decision, 'accept');
});

test('bundle binding (BB-4/BB-5) and anchored copy', async () => {
  const b = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none' }), 'dacs-fault-bundle:v1:', buyer, seller);
  const bh = specHash(b, ['signatures', 'anchoredByRole']);
  const native = 'stor-' + H('native').slice(0, 40);
  const binding: Record<string, any> = {
    bindingVersion: '1',
    jobId: b.jobId,
    role: 'buyer',
    logicalAddress: 'stor-' + H(`${b.jobId}-bundle-buyer`),
    nativeAddress: native,
    bundleContentHash: bh,
    signer: claim(buyer),
  };
  assert.equal(binding.logicalAddress, logicalBundleAddress(b.jobId, 'buyer'));
  const bindHash = specHash(binding, ['signature']);
  binding.signature = { algorithm: 'ed25519', signer: claim(buyer), value: specSign('dacs-bundle-binding:v1:', bindHash, buyer.priv) };
  const h = await harness();
  h.chain.txs.set(H('tx1'), { hash: H('tx1'), found: true, state: 'included', blockNumber: 77 });
  h.chain.storage.set(native, { storageAddress: native, data: b });
  const ok = await verifyArtifact(b, h.chain, { binding });
  assert.equal(ok.decision, 'accept', JSON.stringify(ok.checks));
  assert.equal((await verifyArtifact(binding, null)).decision, 'accept');
  // binding signed by the seller for the buyer role is rejected (BB-5.9)
  const forged = { ...binding, signer: claim(seller), signature: { ...binding.signature, signer: claim(seller) } };
  forged.signature.value = specSign('dacs-bundle-binding:v1:', specHash(forged, ['signature']), seller.priv);
  assert.equal((await verifyArtifact(b, h.chain, { binding: forged })).decision, 'reject');
  // anchored copy differing in content is rejected
  h.chain.storage.set(native, { storageAddress: native, data: { ...b, finalisedAt: 1 } });
  assert.equal((await verifyArtifact(b, h.chain, { anchorAddress: native })).decision, 'reject');
});

test('JCS canonical form matches an independent RFC 8785 serialization and applies NFC (CF-1)', () => {
  const doc = { b: 2, a: [1, 'x'], c: { z: null, y: true } };
  assert.equal(Buffer.from(canonicalBytes(doc)).toString(), canonicalize(doc));
  assert.equal(Buffer.from(canonicalBytes({ n: 'café' })).toString(), '{"n":"café"}');
  assert.throws(() => canonicalBytes({ n: 2 ** 60 }));
  assert.throws(() => canonicalBytes({ s: '\uD800' }));
});

test('offer → accept-and-pay through the tools yields a fully signed, verifiable agreement', async () => {
  // seller side
  const sellerWallet = new MockWallet(keypair(31));
  const hs = await harness({}, { wallet: sellerWallet });
  const buyerWallet = new MockWallet(keypair(32));
  const vet = ref('vet');
  const offer = await hs.call('demos_dacs_create_offer_prepare', {
    role: 'seller',
    listing_ref: { listingId: 'weather-api', version: 1, contentHash: H('listing') },
    self_bundle_hash: H('sb'),
    self_vet_record_ref: vet,
    counterparty: { primary_claim: 'key:' + buyerWallet.address.slice(2), bundle_hash: H('bb'), vet_record_ref: vet },
    price: { amount: '1.25', currency: 'DEM' },
    deliverable: { deliverableType: 'storage-program', hash: H('d') },
    deadline_unix_ms: Date.parse('2027-01-01T00:00:00Z'),
  });
  assert.equal(offer.isError, false, offer.text);
  const signedOffer = await hs.call('demos_tx_submit', { prepared_id: offer.json.prepared_id, confirmation_code: hs.channel.last().code });
  assert.equal(signedOffer.isError, false, signedOffer.text);
  assert.equal(sellerWallet.broadcasts.length, 0, 'signing an offer moves no funds');
  const so = signedOffer.json.signed_offer;
  assert.equal((await verifyArtifact(so, null)).decision, 'indeterminate'); // awaiting countersignature

  // buyer side
  const hb = await harness({}, { wallet: buyerWallet });
  const acc = await hb.call('demos_dacs_accept_prepare', { offer: so });
  assert.equal(acc.isError, false, acc.text);
  assert.equal(acc.json.unsigned_tx.to, sellerWallet.address);
  assert.equal(acc.json.unsigned_tx.amount_dem, '1.25');
  assert.equal(buyerWallet.signs, 0, 'nothing signed before confirmation');
  const done = await hb.call('demos_tx_submit', { prepared_id: acc.json.prepared_id, confirmation_code: hb.channel.last().code });
  assert.equal(done.isError, false, done.text);
  assert.equal(buyerWallet.broadcasts.length, 1);
  assert.equal((await verifyArtifact(done.json.agreement, null)).decision, 'accept');
  assert.equal(done.json.settlement_tx_ref.kind, 'demos');

  // a tampered offer (price lowered after the seller signed) is refused at prepare
  const cheap = { ...so, terms: { ...so.terms, price: { amount: '0.01', currency: 'DEM' } } };
  const bad = await hb.call('demos_dacs_accept_prepare', { offer: cheap });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /counterparty signature/);
});


test('settlement evidence needs phase, amount, finality and an authorised signer', async () => {
  const orchK = keypair(41);
  const mk = (over: Record<string, any> = {}) => {
    const ev: Record<string, any> = {
      evidenceVersion: '1', jobId: 'J1', phase: 'pay-dem', outcome: 'success',
      paymentTxRefs: [{ kind: 'demos', txHash: H('paytx') }], paymentAmount: { amount: '1.5', currency: 'DEM' },
      settlementFinality: { model: 'bft-final' }, observedAt: 1, ...over,
    };
    for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
    const h = specHash(ev, ['signature']);
    return { ...ev, signature: { algorithm: 'ed25519', signer: claim(orchK), value: specSign('dacs-evidence:v1:', h, orchK.priv) } };
  };
  const h = await harness();
  h.chain.txs.set(H('paytx'), { hash: H('paytx'), found: true, state: 'included', blockNumber: 5, content: { type: 'native', amount: '1500000000' } });
  assert.equal((await verifyArtifact(mk(), h.chain)).decision, 'indeterminate', 'no session context → not accept');
  assert.equal((await verifyArtifact(mk(), h.chain, { expectedSigner: claim(orchK) })).decision, 'accept');
  assert.equal((await verifyArtifact(mk(), h.chain, { expectedSigner: claim(buyer) })).decision, 'reject');
  assert.equal((await verifyArtifact(mk({ phase: undefined, paymentAmount: undefined }), h.chain, { expectedSigner: claim(orchK) })).decision, 'reject');
  assert.equal((await verifyArtifact(mk({ settlementFinality: undefined }), h.chain, { expectedSigner: claim(orchK) })).decision, 'reject');
  h.chain.txs.set(H('paytx'), { hash: H('paytx'), found: true, state: 'included', blockNumber: 5, content: { type: 'native', amount: '1' } });
  assert.equal((await verifyArtifact(mk(), h.chain, { expectedSigner: claim(orchK) })).decision, 'reject', 'inclusion is not payment');
});

test('JCS keeps an own "__proto__" member in the hash', async () => {
  const a = JSON.parse('{"agreementVersion":"1","__proto__":{"x":1},"signatures":[]}');
  const b = JSON.parse('{"agreementVersion":"1","signatures":[]}');
  const { artifactHash } = await import('../../src/dacs/verify.js');
  assert.notEqual(artifactHash(a), artifactHash(b));
});

test('binding version and fetched-copy signatures are enforced', async () => {
  const b = signBundle(faultBundle({ outcome: 'completed', faultedParty: 'none' }), 'dacs-fault-bundle:v1:', buyer, seller);
  const bh = specHash(b, ['signatures', 'anchoredByRole']);
  const native = 'stor-' + H('native2').slice(0, 40);
  const mkBinding = (version: string) => {
    const bd: Record<string, any> = { bindingVersion: version, jobId: b.jobId, role: 'buyer', logicalAddress: logicalBundleAddress(b.jobId, 'buyer'), nativeAddress: native, bundleContentHash: bh, signer: claim(buyer) };
    bd.signature = { algorithm: 'ed25519', signer: claim(buyer), value: specSign('dacs-bundle-binding:v1:', specHash(bd, ['signature']), buyer.priv) };
    return bd;
  };
  const h = await harness();
  h.chain.txs.set(H('tx1'), { hash: H('tx1'), found: true, state: 'included', blockNumber: 77 });
  h.chain.storage.set(native, { storageAddress: native, data: b });
  assert.equal((await verifyArtifact(b, h.chain, { binding: mkBinding('2') })).decision, 'reject');
  // the anchored copy has the same hash but a forged signature (signatures are outside the hash)
  const forgedCopy = { ...b, signatures: [b.signatures[0], { ...b.signatures[1], value: b.signatures[0].value }] };
  h.chain.storage.set(native, { storageAddress: native, data: forgedCopy });
  assert.equal((await verifyArtifact(b, h.chain, { binding: mkBinding('1') })).decision, 'reject');
  // anchored copy under the wrong role
  h.chain.storage.set(native, { storageAddress: native, data: { ...b, anchoredByRole: 'seller' } });
  assert.equal((await verifyArtifact(b, h.chain, { binding: mkBinding('1') })).decision, 'reject');
});

test('accept refuses offers with duplicate roles', async () => {
  const buyerWallet = new MockWallet(keypair(52));
  const hb = await harness({}, { wallet: buyerWallet });
  const doc = agreement();
  doc.parties[0].primaryClaim = 'key:' + buyerWallet.address.slice(2);
  doc.parties.push({ role: 'buyer', bundleHash: H('x'), primaryClaim: claim(keypair(53)), vetRecordRef: ref('x') });
  const signed = signAgreement(doc, seller);
  const r = await hb.call('demos_dacs_accept_prepare', { offer: signed });
  assert.equal(r.isError, true);
  assert.match(r.text, /exactly one buyer/);
});

test('CF-5 duplicate member names in JSON text are rejected', async () => {
  const h = await harness({ DEMOS_MCP_ENABLE_WRITES: '0' });
  const both = signAgreement(agreement(), seller, buyer);
  const text = JSON.stringify(both).replace('"agreementVersion":"1"', '"agreementVersion":"1","jobId":"other"');
  const r = await h.call('demos_dacs_receipt_verify', { receipt: text, check_chain: false });
  assert.equal(r.json.decision, 'reject');
  const ok = await h.call('demos_dacs_receipt_verify', { receipt: JSON.stringify(both), check_chain: false });
  assert.equal(ok.json.decision, 'accept');
});


test('payment amount is the SUM over the success set; CF-5 on the signing path', async () => {
  const orchK = keypair(44);
  const ev: Record<string, any> = {
    evidenceVersion: '1', jobId: 'J2', phase: 'pay-dem', outcome: 'success',
    paymentTxRefs: [{ kind: 'demos', txHash: H('p1') }, { kind: 'demos', txHash: H('p2') }],
    paymentAmount: { amount: '3', currency: 'DEM' }, settlementFinality: { model: 'bft-final' }, observedAt: 1,
  };
  ev.signature = { algorithm: 'ed25519', signer: claim(orchK), value: specSign('dacs-evidence:v1:', specHash(ev, ['signature']), orchK.priv) };
  const h = await harness();
  h.chain.txs.set(H('p1'), { hash: H('p1'), found: true, state: 'included', content: { type: 'native', amount: '1000000000' } });
  h.chain.txs.set(H('p2'), { hash: H('p2'), found: true, state: 'included', content: { type: 'native', amount: '2000000000' } });
  assert.equal((await verifyArtifact(ev, h.chain, { expectedSigner: claim(orchK) })).decision, 'accept');
  h.chain.txs.set(H('p2'), { hash: H('p2'), found: true, state: 'included', content: { type: 'native', amount: '1' } });
  assert.equal((await verifyArtifact(ev, h.chain, { expectedSigner: claim(orchK) })).decision, 'reject');

  const buyerWallet = new MockWallet(keypair(54));
  const hb = await harness({}, { wallet: buyerWallet });
  const doc = agreement();
  doc.parties[0].primaryClaim = 'key:' + buyerWallet.address.slice(2);
  const text = JSON.stringify(signAgreement(doc, seller)).replace('"terms":{', '"terms":{"price":{"amount":"100","currency":"DEM"},');
  const r = await hb.call('demos_dacs_accept_prepare', { offer: text });
  assert.equal(r.isError, true);
  assert.match(r.text, /CF-5/);
});


test('agreements missing mandatory §8.5 fields are rejected even when correctly signed', async () => {
  const strip = (f: (d: Record<string, any>) => void) => {
    const d = agreement();
    f(d);
    return signAgreement(d, seller, buyer);
  };
  for (const [name, f] of [
    ['listingId', (d: any) => delete d.listingRef.listingId],
    ['version', (d: any) => delete d.listingRef.version],
    ['bundleHash', (d: any) => delete d.parties[0].bundleHash],
    ['vetRecordRef', (d: any) => delete d.parties[1].vetRecordRef],
    ['deliverableType', (d: any) => delete d.terms.deliverable.deliverableType],
  ] as Array<[string, (d: any) => void]>) {
    assert.equal((await verifyArtifact(strip(f), null)).decision, 'reject', name);
  }
});

test('settlement evidence needs real payment evidence; unknown phases are not accepted', async () => {
  const k = keypair(46);
  const signer = claim(k);
  const mk = (over: Record<string, any>) => {
    const ev: Record<string, any> = { evidenceVersion: '1', jobId: 'J5', outcome: 'success', observedAt: 1, ...over };
    ev.signature = { algorithm: 'ed25519', signer, value: specSign('dacs-evidence:v1:', specHash(ev, ['signature']), k.priv) };
    return ev;
  };
  const h = await harness();
  const stor = 'stor-' + 'd'.repeat(40);
  h.chain.storage.set(stor, { storageAddress: stor, data: {} });
  const viaStorage = mk({ phase: 'pay-dem', paymentTxRefs: [{ kind: 'storage-program', address: stor, writeTxHash: H('w') }], paymentAmount: { amount: '900', currency: 'DEM' }, settlementFinality: { model: 'bft-final' } });
  assert.equal((await verifyArtifact(viaStorage, h.chain, { expectedSigner: signer })).decision, 'reject');
  const unknownPhase = mk({ phase: 'not-a-dacs-phase' });
  assert.notEqual((await verifyArtifact(unknownPhase, h.chain, { expectedSigner: signer })).decision, 'accept');
  const badFinality = mk({ phase: 'pay-dem', paymentTxRefs: [{ kind: 'demos', txHash: H('q') }], paymentAmount: { amount: '1', currency: 'DEM' }, settlementFinality: {} });
  assert.equal((await verifyArtifact(badFinality, h.chain, { expectedSigner: signer })).decision, 'reject');
  const noDelivery = mk({ phase: 'deliver-storage-program' });
  assert.equal((await verifyArtifact(noDelivery, h.chain, { expectedSigner: signer })).decision, 'reject');
});

test('domain signature: an ordinary key verifies, another message fails, small-order keys are refused', () => {
  const hash = H('domain-sig'), sign = (h: string) => Buffer.from(ed.sign(new TextEncoder().encode('dacs-evidence:v1:' + h), buyer.priv)).toString('base64url');
  assert.equal(verifyDomainSig('dacs-evidence:v1:', hash, claim(buyer), 'ed25519', sign(hash)).decision, 'pass');
  assert.equal(verifyDomainSig('dacs-evidence:v1:', hash, claim(buyer), 'ed25519', sign(H('other'))).decision, 'fail');
  const constant = Buffer.from('01' + '00'.repeat(63), 'hex').toString('base64url'); // R = identity, S = 0
  for (const key of ['01' + '00'.repeat(31), '00'.repeat(32), 'ec' + 'ff'.repeat(31), '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05']) {
    const r = verifyDomainSig('dacs-evidence:v1:', hash, 'key:' + key, 'ed25519', constant);
    assert.equal(r.decision, 'fail', key);
    assert.match(r.reason ?? '', /small-order or not canonical/);
  }
});
