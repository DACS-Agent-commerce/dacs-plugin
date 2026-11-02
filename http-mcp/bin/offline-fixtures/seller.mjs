// SYNTHETIC seller for the offline tester. A fresh Ed25519 key is generated
// with node:crypto for every run, used to sign one fixed-price fixture listing
// with the bundled @kynesyslabs/dacs canonical encoding, and never written to
// disk or printed. It is not a real user's key and controls nothing real.
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonicalize, contentHash, sha256Hex, signedBytes } from '@kynesyslabs/dacs';

export const FIXTURE_LISTING_ID = 'offline-fixture-report';
export const FIXTURE_PRICE_DEM = '1.5';
export const FIXTURE_LABEL = 'SIMULATED offline fixture listing (not Demos testnet)';

export function createSyntheticSeller() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const hex = raw.toString('hex');
  return {
    address: `0x${hex}`,
    claim: `did:demos:agent:${hex}`,
    signBytes: (bytes) => sign(null, Buffer.from(bytes), privateKey),
  };
}

function identityBundle(seller, presentedAt) {
  const unsigned = {
    bundleVersion: '1',
    presentedBy: seller.claim,
    presentedAt,
    sessionNonce: sha256Hex(`offline-fixture:${seller.claim}:${presentedAt}`),
    claims: [{ ref: seller.claim }],
  };
  const hash = sha256Hex(canonicalize(unsigned));
  const signature = seller.signBytes(signedBytes('dacs-bundle-presentation:v1:', hash)).toString('base64url');
  return { ...unsigned, presentation: { kind: 'per-claim', signatures: [{ ref: seller.claim, signature }] } };
}

// Standard-shaped, seller-signed fixed-price DEM listing.
export function buildFixtureListing(seller, { now = Date.now(), listingId = FIXTURE_LISTING_ID, price = FIXTURE_PRICE_DEM } = {}) {
  const draft = {
    dacsVersion: '1',
    listingVersion: 1,
    listingId,
    requiredCapabilities: ['SR-1', 'SR-2'],
    seller: {
      identity: identityBundle(seller, now - 1000),
      displayName: 'Offline Fixture Seller (SIMULATED)',
      // .invalid is reserved and never resolves; the plugin does not contact it.
      publicEndpoint: 'https://seller.invalid/offline-fixture',
    },
    offering: {
      title: 'Offline fixture market report (SIMULATED)',
      description: `${FIXTURE_LABEL}. Synthetic seller key generated for this run only; no real seller, delivery or funds.`,
      category: 'services.market-report',
      tags: ['fixture', 'offline', 'simulated'],
      deliverable: { kind: 'storage-program', schemaUrl: 'urn:dacs-offline-fixture', accessModel: 'public' },
    },
    buyerRequirement: { requirementVersion: '1', required: [], preferredPresentation: 'any' },
    pipeline: [
      { kind: 'negotiate-fixed-price' },
      { kind: 'commit-payee-bound-agreement' },
      { kind: 'pay-dem', parameters: { rail: 'demos-native:DEM' } },
      { kind: 'deliver-storage-program' },
    ],
    pricing: { kind: 'fixed', price: { amount: price, currency: 'DEM' } },
    acceptedRails: [{ railId: 'demos-native:DEM', railVersion: 1 }],
    terms: { deadlineSecAfterCommit: 3600, cancellationPolicy: 'pre-commit', transcriptDisclosurePolicy: 'encrypted-anchored-recommended' },
    validity: { notBefore: now - 60_000, notAfter: now + 7 * 24 * 3600_000 },
  };
  const value = seller.signBytes(signedBytes('dacs-listing:v1:', contentHash(draft))).toString('base64url');
  return { ...draft, signature: { algorithm: 'ed25519', signer: seller.claim, value } };
}

export function storageLocator(seed) {
  return `stor-${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`;
}

// Directory summary in the Community directory shape the plugin projects.
export function directorySummary(listing, locator, observedAt = new Date().toISOString()) {
  return {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator },
    seller: { primaryClaim: listing.seller.identity.presentedBy, displayName: listing.seller.displayName },
    offering: {
      title: listing.offering.title,
      description: listing.offering.description,
      category: listing.offering.category,
      tags: listing.offering.tags,
      rails: ['demos-native:DEM'],
    },
    pricing: { kind: listing.pricing.kind, priceHint: listing.pricing.price.amount, currency: listing.pricing.price.currency },
    publicEndpoint: listing.seller.publicEndpoint,
    artifactProfile: 'dacs-v0.1',
    status: 'active',
    catalogObservedAt: observedAt,
    inspection: { artifactType: 'directory-service-profile', maturity: 'listed', href: '/offline-fixture' },
  };
}
