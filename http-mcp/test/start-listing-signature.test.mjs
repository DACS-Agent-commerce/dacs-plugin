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

const vectors = (file) => JSON.parse(readFileSync(new URL(`../../../.stack/ref/standard/conformance/vectors/security/${file}`, import.meta.url), 'utf8'));

// DACS-1 §6.3.4: the CF-1 canonical form with the top-level signature member
// omitted, every other member kept, hashed with SHA-256.
const listingHash = ({ signature, ...rest }) => sha256Hex(canonicalize(rest));

// Signs the Listing as its seller does: "dacs-listing:v1:" || Listing hash.
function resign(listing, signer, as = signer.claim) {
  const { signature, ...draft } = listing;
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
  const dialog = describeIntent(intent);
  for (const shown of ['Price: 2.5 DEM (2500000000 OS)', `Deliverable: storage-program (schema urn:fixture), hash ${intent.agreement.deliverable.hash}`,
    `Delivery deadline: ${new Date(NOW + 3_600_000).toISOString()} (1 hour(s) after generation, from the Listing)`]) assert.ok(dialog.includes(shown), shown);
});

test('a Listing with no signature is refused', async () => {
  const s = await scenario({ mutate: ({ signature, ...listing }) => listing });
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
