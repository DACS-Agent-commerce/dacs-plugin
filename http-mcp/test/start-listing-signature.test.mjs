// The pinned Listing checks of the Start wallet (public/portal-intent/intent.mjs
// buildIntent): signed once by its seller, the seller's identity carries the
// signing key, supported version and shapes, and the SR-2 anchor is named.
// Everything is built here from SDK primitives and generated test keys, so the
// test does not grade the wallet with its own helpers. SIMULATED fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize, sha256Hex, signedBytes } from '@kynesyslabs/dacs';
import * as wallet from '../public/portal-intent/intent.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing, fixtureLocator } from './fixtures/listings.mjs';

const { buildIntent, describeIntent, IntentMismatch } = wallet;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const JOB = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PURCHASE = 'pur_test_listing_signature';
const ANCHOR = { kind: 'storage-program', locator: fixtureLocator('seller-listing') };

const vectors = (file) => JSON.parse(readFileSync(new URL(`./fixtures/standard-vectors/${file}`, import.meta.url), 'utf8'));

// DACS-1 §6.3.4: the CF-1 canonical form with the top-level signature member
// omitted, every other member kept, hashed with SHA-256.
// A copy of an object without the named members.
const omit = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

const listingHash = (listing) => sha256Hex(canonicalize(omit(listing, 'signature')));

// Signs the Listing as its seller does: "dacs-listing:v1:" || Listing hash.
function resign(listing, signer, as = signer.claim) {
  const draft = omit(listing, 'signature');
  const value = signer.signBytes(signedBytes('dacs-listing:v1:', listingHash(draft))).toString('base64url');
  return { ...draft, signature: { algorithm: 'ed25519', signer: as, value } };
}

const osOf = (amount) => String(BigInt(Math.round(Number(amount) * 1000)) * 1_000_000n);

// The purchase view and Start facts for one pinned Listing. mutate(listing,
// seller, other) returns the Listing the server pins; the terms always carry
// the hash and price of that Listing, as the server computes them.
async function scenario({ mutate = (listing) => listing, anchor = ANCHOR, listingRef = (ref) => ref } = {}) {
  const seller = createEphemeralWallet();
  const other = createEphemeralWallet();
  const buyer = createEphemeralWallet();
  const pinned = mutate(fixtureListing(seller, { now: NOW }), seller, other);
  const amount = pinned.pricing?.price?.amount ?? '2.5';
  const terms = {
    profile: 'dacs-chatgpt-plugin/fixed-price-dem-purchase/v1', operation: 'purchase', network: 'demos-testnet', rail: 'demos-native:DEM',
    domain: { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null },
    buyer: { accountId: 'acct_test_1', wallet: buyer.address },
    seller: { claim: seller.claim, payee: seller.address },
    listing: listingRef({ listingId: pinned.listingId, version: pinned.listingVersion, contentHash: listingHash(pinned), ...(anchor === undefined ? {} : { anchor }) }, seller),
    price: { amount, amountOs: osOf(amount) },
    approvalExpiresAt: new Date(NOW + DAY).toISOString(),
    protocol: { profile: 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1', jobId: JOB },
  };
  const buyerDid = buyer.claim;
  const bundle = { bundleVersion: '1', presentedBy: buyerDid, presentedAt: NOW, sessionNonce: sha256Hex(`dacs-chatgpt-plugin:${PURCHASE}:${JOB}:${buyerDid}:${NOW}`), claims: [{ ref: buyerDid }] };
  const view = { id: PURCHASE, termsHash: sha256Hex(canonicalize(terms)), expiresAt: new Date(NOW + DAY).toISOString(), terms };
  const start = { intent: { id: 'r'.repeat(22), expiresAt: new Date(NOW + 10 * 60_000).toISOString() }, listing: pinned, agreement: { generatedAt: NOW }, identity: { bundle }, delegation: null, wallet: {} };
  return { seller, other, buyer, terms, view, start, run: () => buildIntent({ view, start, wallet: buyer.address, now: NOW }) };
}

// The wallet refuses with IntentMismatch on `field`, saying `reason`.
const refuses = (promise, field, reason) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof IntentMismatch, `refused with ${error?.name}: ${error?.message}`);
  assert.equal(error.field, field);
  assert.match(error.message, reason);
  return true;
});

// The seller's bundle changed by edit(bundleWithoutPresentation), presented with
// `presentation` (default: the seller's own per-claim signature over the new
// bundle hash), and the Listing signed again, so only the identity differs.
function withIdentity(listing, seller, edit, presentation) {
  const bundle = omit(listing.seller.identity, 'presentation');
  const next = edit(structuredClone(bundle));
  const value = seller.signBytes(signedBytes('dacs-bundle-presentation:v1:', sha256Hex(canonicalize(next)))).toString('base64url');
  const identity = { ...next, presentation: presentation ?? { kind: 'per-claim', signatures: [{ ref: seller.claim, signature: value }] } };
  return resign({ ...listing, seller: { ...listing.seller, identity } }, seller);
}

// A browser whose WebCrypto lacks Ed25519: digests work, importing an Ed25519 key does not.
async function withoutEd25519(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const real = globalThis.crypto;
  const subtle = new Proxy(real.subtle, {
    get(target, name) {
      if (name === 'importKey') return async (format, key, algorithm, ...rest) => {
        if (algorithm?.name === 'Ed25519') throw new DOMException('Ed25519 is not supported', 'NotSupportedError');
        return target.importKey(format, key, algorithm, ...rest);
      };
      const member = target[name];
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  Object.defineProperty(globalThis, 'crypto', { value: { subtle }, configurable: true, writable: true });
  try { return await run(); } finally { Object.defineProperty(globalThis, 'crypto', original); }
}

// ---------------------------------------------------------------------------
// Checks 1 and 2: exactly one ed25519 signature by the seller, verified
// ---------------------------------------------------------------------------

test('control: a correctly signed Listing is accepted and the dialog shows its terms unchanged', async () => {
  const s = await scenario();
  const intent = await s.run();
  assert.equal(intent.price.amount, '2.5');
  assert.equal(intent.agreement.deliverable.deliverableType, 'storage-program');
  assert.equal(intent.agreement.deadlineAfterMs, 3600 * 1000);
  assert.deepEqual({ ...intent.anchor }, ANCHOR);
  assert.deepEqual(Object.keys(intent.listing), ['listingId', 'version', 'contentHash'], 'the Listing reference the Agreement and delegation carry is unchanged');
  const dialog = describeIntent(intent);
  for (const shown of [`Listing anchor (SR-2): ${ANCHOR.locator}`, 'Price: 2.5 DEM (2500000000 OS)', `Deliverable: storage-program (schema urn:fixture), hash ${intent.agreement.deliverable.hash}`,
    `Delivery deadline: ${new Date(NOW + 3_600_000).toISOString()} (1 hour(s) after generation, from the Listing)`]) assert.ok(dialog.includes(shown), shown);
});

test('a Listing with no signature is refused', async () => {
  const s = await scenario({ mutate: (listing) => omit(listing, 'signature') });
  await refuses(s.run(), 'listing', /is not signed/);
});

test('a Listing signed by another key, with the signer field naming the seller, is refused', async () => {
  const s = await scenario({ mutate: (listing, seller, other) => resign(listing, other, seller.claim) });
  await refuses(s.run(), 'listing', /does not verify for its seller/);
});

test('a correctly signed Listing whose price was raised from 2.5 to 9.5 DEM keeps no valid signature', async () => {
  const s = await scenario({ mutate: (listing) => ({ ...listing, pricing: { ...listing.pricing, price: { amount: '9.5', currency: 'DEM' } } }) });
  assert.equal(s.terms.price.amount, '9.5');
  await refuses(s.run(), 'listing', /does not verify for its seller|changed after it was signed/);
});

test('two signatures are refused, as a signature array and as an extra signatures member', async () => {
  const asArray = await scenario({ mutate: (listing) => ({ ...listing, signature: [listing.signature, listing.signature] }) });
  await refuses(asArray.run(), 'listing', /more than one signature/);
  const extra = await scenario({ mutate: (listing, seller) => resign({ ...listing, signatures: [listing.signature] }, seller) });
  await refuses(extra.run(), 'listing', /more than one signature/);
});

test('a signature that is not ed25519 is refused', async () => {
  const s = await scenario({ mutate: (listing) => ({ ...listing, signature: { ...listing.signature, algorithm: 'ecdsa-secp256k1' } }) });
  await refuses(s.run(), 'listing', /algorithm this wallet cannot check/);
});

test('a valid signature by someone other than the seller is refused', async () => {
  const s = await scenario({ mutate: (listing, seller, other) => resign(listing, other) });
  await refuses(s.run(), 'listing', /someone other than its seller/);
});

test('a malformed signature envelope is refused', async () => {
  const s = await scenario({ mutate: (listing) => ({ ...listing, signature: { ...listing.signature, extra: 1 } }) });
  await refuses(s.run(), 'listing', /malformed signature/);
});

test('a signature spelled with non-zero residual bits is refused although it decodes to the same bytes', async () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const s = await scenario({ mutate: (listing) => {
    const { value } = listing.signature;
    // The last of an 86-character value carries 4 unused bits; the canonical spelling has them zero.
    const spelled = `${value.slice(0, -1)}${alphabet[alphabet.indexOf(value.at(-1)) + 1]}`;
    assert.deepEqual(Buffer.from(spelled, 'base64url'), Buffer.from(value, 'base64url'));
    return { ...listing, signature: { ...listing.signature, value: spelled } };
  } });
  await refuses(s.run(), 'listing', /does not verify for its seller/);
});

test('a browser without Ed25519 refuses, it never skips the signature check', async () => {
  const s = await scenario();
  await withoutEd25519(() => refuses(s.run(), 'listing', /cannot check Ed25519 signatures/));
});

// signature-value-encoding-v0.1 (CORE SIG-6): the vector names run below.
test('signature value encoding vectors: the conforming verifier path', async (t) => {
  const set = vectors('signature-value-encoding-v0.1.json');
  const ran = [];
  for (const v of set.vectors.filter((x) => x.mode === 'conforming-verifier' || x.name === 'undeclared-legacy-encoding-rejected')) {
    await t.test(v.name, () => {
      const decoded = wallet.decodeSignatureValue(v.value);
      const accepted = decoded !== null && decoded.length === 64;
      assert.equal(accepted, v.expected === 'accept');
      // A wire-stage rejection never yields bytes; an algorithm-stage one decodes and then fails on length.
      if (v.want.failureStage === 'wire') assert.equal(decoded, null);
      if (v.want.decodedLength !== undefined) assert.equal(decoded?.length, v.want.decodedLength);
    });
    ran.push(v.name);
  }
  assert.deepEqual(ran, ['canonical-base64url-unpadded', 'standard-base64-same-bytes-rejected', 'padded-base64url-same-bytes-rejected', 'embedded-whitespace-rejected', 'impossible-length-rejected',
    'non-zero-residual-bits-rejected', 'canonical-wire-wrong-ed25519-length-rejected', 'undeclared-legacy-encoding-rejected']);
});

// listing-preserve-unknown-v0.1: the Listing hash keeps unknown members, and
// the signature over "dacs-listing:v1:" || hash verifies only for them as signed.
test('preserve-unknown Listing vectors: hash and signature', async (t) => {
  const set = vectors('listing-preserve-unknown-v0.1.json');
  const [keyRef] = Object.keys(set.publicKeys);
  const did = `did:demos:agent:${keyRef.slice('key:'.length)}`;
  const hashOf = listingHash;
  const verifies = (listing) => wallet.ed25519Valid(did, `dacs-listing:v1:${hashOf(listing)}`, listing.signature.value);
  const apply = (listing, transform) => {
    const out = structuredClone(listing);
    if (transform.kind === 'none') return out;
    const path = transform.path.split('.');
    const last = path.pop();
    const parent = path.reduce((node, key) => node[key], out);
    if (transform.kind === 'set') parent[last] = transform.value; else delete parent[last];
    return out;
  };
  for (const v of set.vectors) {
    await t.test(v.name, async () => {
      const listing = apply(set.fixtures[v.fixture].listing, v.transform);
      assert.equal(hashOf(listing), v.want.computedArtifactHash);
      assert.equal(await verifies(listing), v.want.signature === 'valid');
    });
  }
});

// ---------------------------------------------------------------------------
// Check 3: the seller's identity carries the signing key
// ---------------------------------------------------------------------------

test('a Listing whose seller identity presentation signatures were emptied is refused', async () => {
  const s = await scenario({ mutate: (listing, seller) => withIdentity(listing, seller, (b) => b, { kind: 'per-claim', signatures: [] }) });
  await refuses(s.run(), 'listing', /identity presentation does not sign every claim/);
});

test('a seller identity presentation signed by another key is refused', async () => {
  const s = await scenario({ mutate: (listing, seller, other) => withIdentity(listing, seller, (b) => b, {
    kind: 'per-claim', signatures: [{ ref: seller.claim, signature: other.signBytes(signedBytes('dacs-bundle-presentation:v1:', sha256Hex(canonicalize(omit(listing.seller.identity, 'presentation'))))).toString('base64url') }] }) });
  await refuses(s.run(), 'listing', /identity presentation does not verify under the seller’s key/);
});

test('a seller identity changed after its presentation was signed is refused', async () => {
  const s = await scenario({ mutate: (listing, seller) => {
    const { presentation } = listing.seller.identity;
    return withIdentity(listing, seller, (b) => ({ ...b, presentedAt: b.presentedAt + 1 }), presentation);
  } });
  await refuses(s.run(), 'listing', /identity presentation does not verify under the seller’s key/);
});

test('a seller identity that does not name the signing key is refused', async () => {
  const s = await scenario({ mutate: (listing, seller, other) => withIdentity(listing, seller, (b) => ({ ...b, claims: [{ ref: other.claim }] })) });
  await refuses(s.run(), 'listing', /identity does not name the key that signed the Listing/);
});

test('a seller identity holding a claim this browser cannot verify is refused, naming its kind', async () => {
  const s = await scenario({ mutate: (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, claims: [...b.claims, { ref: 'lei:529900T8BM49AURSDO55' }] })) });
  await refuses(s.run(), 'listing', /holds a lei claim, which this wallet cannot verify/);
});

test('a seller identity with a presentation kind this browser cannot verify is refused', async () => {
  for (const presentation of [{ kind: 'siwd', message: 'm', signature: 's', address: 'a' }, { kind: 'session-key', key: 'k', signature: 's' }, { kind: 'sr1-root', rootClaim: 'did:demos:agent:' + 'a'.repeat(64), aggregateSignature: 's' }]) {
    const s = await scenario({ mutate: (listing, seller) => withIdentity(listing, seller, (b) => b, presentation) });
    await refuses(s.run(), 'listing', new RegExp(`presentation of kind ${presentation.kind} cannot be verified in this browser`));
  }
});

// ---------------------------------------------------------------------------
// Check 4: version and shape gates
// ---------------------------------------------------------------------------

test('a DACS version the wallet does not support is refused', async () => {
  for (const dacsVersion of ['2', '0', 1, undefined]) {
    const s = await scenario({ mutate: (listing, seller) => resign({ ...listing, dacsVersion }, seller) });
    await refuses(s.run(), 'listing', /uses a DACS version this wallet does not support/);
  }
});

test('a signed Listing carrying a revocationState is refused: the wallet cannot make that check', async () => {
  const s = await scenario({ mutate: (listing, seller) => resign({ ...listing, revocationState: { anchor: ANCHOR, contentHash: 'a'.repeat(64) } }, seller) });
  await refuses(s.run(), 'listing', /needs a revocation check this wallet cannot make/);
});

test('a malformed identity bundle is refused', async () => {
  const unsigned = (listing) => omit(listing.seller.identity, 'presentation');
  const cases = {
    'bundle version 2': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, bundleVersion: '2' })),
    'presentedAt as a string': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, presentedAt: '1' })),
    'presentedAt as a fraction': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, presentedAt: 1.5 })),
    'empty claims': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, claims: [] })),
    'claims not a list': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, claims: { ref: seller.claim } })),
    'a claim without a ref': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, claims: [{ ...b.claims[0], ref: undefined }] })),
    'session nonce as a number': (listing, seller) => withIdentity(listing, seller, (b) => ({ ...b, sessionNonce: 7 })),
    'no presenter': (listing, seller) => withIdentity(listing, seller, (b) => { delete b.presentedBy; return b; }),
    'no presentation': (listing, seller) => resign({ ...listing, seller: { ...listing.seller, identity: unsigned(listing) } }, seller),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const s = await scenario({ mutate });
    await assert.rejects(s.run(), (error) => error instanceof IntentMismatch && error.field === 'listing' && /identity bundle has an unexpected shape|belongs to another seller/.test(error.message), name);
  }
});

// presence-only-claim-requirement-v0.7 (DACS-1 §6.3.3 PCR-1..PCR-6): the
// buyerRequirement of each named vector. An `error` vector is a malformed
// requirement and is refused; the others are well-formed and are accepted
// (matching them is the seller's and Vet's job, not this wallet's).
const REQUIREMENT_VECTORS = ['required-presence-key-with-issued-at', 'required-presence-key-without-issued-at', 'presence-max-age-is-invalid', 'presence-recipe-version-is-invalid',
  'verification-required-must-be-boolean', 'empty-member-collections-are-vacuously-satisfied', 'empty-oneof-group-is-invalid', 'oneof-passing-member-cannot-mask-unknown-scheme',
  'presence-parameters-must-be-an-object', 'presence-parameters-match', 'oneof-presence-alternative-passes', 'mixed-required-presence-and-verified-pass', 'verified-member-cannot-use-bare-presence',
  'selector-unrelated-cosigner-is-uncontrolled'];

test('buyer requirements: the Standard vectors', async (t) => {
  const byName = new Map(vectors('presence-only-claim-requirement-v0.7.extract.json').vectors.map((v) => [v.name, v]));
  for (const name of REQUIREMENT_VECTORS) {
    await t.test(name, async () => {
      const v = byName.get(name);
      assert.ok(v, 'vector exists');
      const s = await scenario({ mutate: (listing, seller) => resign({ ...listing, buyerRequirement: structuredClone(v.requirement) }, seller) });
      if (v.expected === 'error') await refuses(s.run(), 'listing', /has a malformed buyer requirement/);
      else assert.equal((await s.run()).price.amount, '2.5');
    });
  }
});

test('buyer requirements that break the shape are refused', async () => {
  const bad = [undefined, null, [], { requirementVersion: '2', required: [] }, { requirementVersion: '1' }, { requirementVersion: '1', required: {} },
    { requirementVersion: '1', required: [], oneOf: {} }, { requirementVersion: '1', required: [], preferredPresentation: 'pigeon' }, { requirementVersion: '1', required: [], primaryClaimSelector: 'nonesuch' },
    { requirementVersion: '1', required: [{ scheme: 'key', verificationRequired: true, maxAge: -1 }] }, { requirementVersion: '1', required: [{ scheme: 'key', verificationRequired: true, recipeVersion: 1.5 }] }];
  for (const buyerRequirement of bad) {
    const s = await scenario({ mutate: (listing, seller) => resign({ ...listing, buyerRequirement }, seller) });
    await refuses(s.run(), 'listing', /has a malformed buyer requirement/);
  }
});

// ---------------------------------------------------------------------------
// Check 5: the SR-2 anchor is named, bound and shown
// ---------------------------------------------------------------------------

const logicalAddress = (claim, id, version) => `dacs1:${claim.replace(/:/g, '%3A')}:${id}:v${version}`;

test('terms that name no SR-2 anchor are refused', async () => {
  const s = await scenario({ listingRef: (ref) => omit(ref, 'anchor') });
  assert.equal(s.terms.listing.anchor, undefined);
  await refuses(s.run(), 'anchor', /name no SR-2 anchor/);
});

test('terms that name a malformed anchor are refused', async () => {
  for (const anchor of [null, 'stor-' + 'a'.repeat(40), { kind: 'storage-program' }, { locator: ANCHOR.locator }, { kind: 'ipfs', locator: ANCHOR.locator },
    { kind: 'storage-program', locator: 7 }, { ...ANCHOR, extra: true }]) {
    const s = await scenario({ listingRef: (ref) => ({ ...omit(ref, 'anchor'), anchor }) });
    await refuses(s.run(), 'anchor', /name no SR-2 anchor/);
  }
});

test('terms that name a different anchor are refused', async () => {
  const different = {
    'the logical address of another Listing': (ref, seller) => logicalAddress(seller.claim, 'another-listing', 1),
    'the logical address of another version': (ref, seller) => logicalAddress(seller.claim, ref.listingId, ref.version + 1),
    'the logical address under another seller': (ref) => logicalAddress(createEphemeralWallet().claim, ref.listingId, ref.version),
    'a native address of the wrong length': () => `stor-${'a'.repeat(39)}`,
    'a native address in capitals': () => `stor-${'A'.repeat(40)}`,
    'a locator that is not an address at all': () => 'https://seller.example/listing',
  };
  for (const [name, locator] of Object.entries(different)) {
    const s = await scenario({ listingRef: (ref, seller) => ({ ...ref, anchor: { kind: 'storage-program', locator: locator(ref, seller) } }) });
    await assert.rejects(s.run(), (error) => error instanceof IntentMismatch && error.field === 'anchor' && /is not this Listing’s anchor/.test(error.message), name);
  }
});

test('the Listing’s own logical address is accepted as its anchor, bound and shown', async () => {
  const s = await scenario({ listingRef: (ref, seller) => ({ ...ref, anchor: { kind: 'storage-program', locator: logicalAddress(seller.claim, ref.listingId, ref.version) } }) });
  const intent = await s.run();
  assert.equal(intent.anchor.locator, s.terms.listing.anchor.locator);
  assert.ok(describeIntent(intent).includes(`Listing anchor (SR-2): ${s.terms.listing.anchor.locator}`));
  assert.ok(Object.isFrozen(intent.anchor));
});

test('an anchor swapped after the terms hash was fixed is refused by the terms hash', async () => {
  const s = await scenario();
  s.terms.listing.anchor = { kind: 'storage-program', locator: fixtureLocator('another-program') };
  await refuses(s.run(), 'terms', /do not match their terms hash/);
});
