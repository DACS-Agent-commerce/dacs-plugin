// Linux adaptation of the read-only interop gap witness helper. The default
// path points at a frozen seller reference, and the reference is checked by
// recomputing its canonical 17-file digest (snapshot-helper algorithm). The unchanged Demo resolver/responder are imported directly, never
// copied or modified. TEST-ONLY: no production/public Agreement route. Only
// the plugin-portal refusal path is adapted (the component accepting control
// stays in the interop owner's witness).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { canonicalize, contentHash, identityBundleHash, signedBytes, ed25519Verify, publicKeyFromRaw,
  createInMemoryFencedSessionStore, compositeVerificationAddress } from '@kynesyslabs/dacs';
import { seedSellerListing } from './flows.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { createSellerHttpHandler } from '../../src/dacs/seller-http.mjs';

export const SELLER_REFERENCE = process.env.DACS_SELLER_INTEROP_REFERENCE ?? '/nonexistent/dacs-seller-interop-reference';
export const SELLER_REFERENCE_DIGEST = 'dbe07f9c9cff45fa2a4af106b80614ce59c5ac19b9acf5c147aa315c78a298bf';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let reference;

async function referenceManifest(root) {
  const files = {};
  async function walk(p) {
    for (const n of (await readdir(p)).sort()) {
      if (['node_modules', '.git', '.DS_Store'].includes(n)) continue;
      const x = join(p, n), s = await lstat(x);
      if (s.isDirectory()) await walk(x);
      else if (s.isFile()) files[relative(root, x)] = hash(await readFile(x));
      else throw new Error(`unexpected seller reference entry ${x}`);
    }
  }
  await walk(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

async function sellerReference() {
  if (reference) return reference;
  assert.equal(isAbsolute(SELLER_REFERENCE), true, 'the artifact-bound seller reference must be an absolute path');
  const files = await referenceManifest(SELLER_REFERENCE);
  assert.equal(Object.keys(files).length, 17, 'frozen seller reference has exactly 17 files');
  assert.equal(hash(JSON.stringify(files)), SELLER_REFERENCE_DIGEST, 'unchanged seller reference digest');
  assert.equal(files['vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz'], '79934553cf3f952de4a442c8db306b68a2d5cd5947b3f1258ac9ac2caa5a69a3');
  const context = await import(pathToFileURL(join(SELLER_REFERENCE, 'v2/seller/agreement-context.mjs')));
  const service = await import(pathToFileURL(join(SELLER_REFERENCE, 'v2/seller/listing-service.mjs')));
  reference = { ...context, ...service };
  return reference;
}

export async function startInteropSeller(t, h, { listingId, nowMs = Date.now() } = {}) {
  const api = await sellerReference();
  const wallet = createEphemeralWallet(), vetWriter = createEphemeralWallet(), steward = createEphemeralWallet();
  const { listing } = seedSellerListing(h, wallet, { listingId, now: nowMs, summary: { observedAt: new Date(nowMs).toISOString() } });
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) };
  const stateDir = await mkdtemp(join(tmpdir(), 'dacs-current-broker-interop-'));
  const intake = await api.createSellerListingService({ sellerDid: wallet.claim, stateDir, now: () => nowMs });
  const intakeAddress = await intake.listen(); const intakeOrigin = `http://127.0.0.1:${intakeAddress.port}`;
  t.after(async () => { await intake.close(); await rm(stateDir, { recursive: true, force: true }); });
  const storedResponse = await fetch(`${intakeOrigin}/v1/listings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listing, listingPin: pin }) });
  const stored = await storedResponse.json(); assert.equal(storedResponse.status, 201, JSON.stringify(stored));
  assert.equal(stored.validation.sessionEligible, false); assert.equal(stored.publication.dacsActive, false);
  const listingReads = [], received = [], progress = [], signed = [], published = [], verifiedVets = [];
  let responder;
  const contributions = new Map(), proposals = new Map();
  const agent = {
    claim: wallet.claim, listingPin: pin,
    async receiveProposal(body) {
      received.push(structuredClone(body));
      assert.equal(typeof responder, 'function', 'operator TEST facts must be installed before proposal, never learned from it');
      const result = await responder({ proposal: body.proposal, transportIdentity: body.transportIdentity });
      progress.push(result);
      if (result.disposition === 'complete') {
        proposals.set(body.proposal.proposalHash, structuredClone(body.proposal));
        return { disposition: 'complete', contribution: result.result.sellerContribution };
      }
      return { disposition: result.disposition, stage: result.stage, reason: result.reason };
    },
    agreementState(identity) { return { proposal: proposals.get(identity.proposalHash) ?? null, contribution: contributions.get(identity.proposalHash) ?? null }; },
  };
  const server = createServer(createSellerHttpHandler(agent));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  h.endpoints.set(wallet.claim, origin);

  async function installOperatorFacts({ jobId, buyerBundle }) {
    assert.equal(received.length, 0, 'facts must precede submitted proposal');
    const empty = { requirementVersion: '1', required: [] };
    const bundles = new Map([[wallet.claim, structuredClone(listing.seller.identity)], [buyerBundle.presentedBy, structuredClone(buyerBundle)]]);
    const vets = new Map(), trusted = new Map();
    for (const [party, bundle] of bundles) {
      const requirement = party === wallet.claim ? empty : listing.buyerRequirement;
      const unsigned = { recordVersion: '1', jobId, evaluatedParty: party, bundleHash: identityBundleHash(bundle),
        requirementHash: api.requirementHash(requirement), freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: nowMs };
      const record = { ...unsigned, signature: { algorithm: 'ed25519', signer: vetWriter.claim,
        value: vetWriter.signBytes(signedBytes('dacs-composite:v1:', contentHash(unsigned))).toString('base64url') } };
      const ref = { anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party) }, contentHash: hash(canonicalize(record)), signer: vetWriter.claim };
      vets.set(party, { record, ref });
      trusted.set(party, { recordRef: structuredClone(ref), expectations: { jobId, evaluatedParty: party,
        bundleHash: identityBundleHash(bundle), requirement: structuredClone(requirement), verifier: vetWriter.claim, freshness: [], dealSpecific: [] } });
    }
    const rail = { railId: 'demos-native:DEM', railVersion: 1, phaseHandler: 'pay-dem' };
    const railHash = hash(canonicalize(rail));
    const railSig = steward.signBytes(signedBytes('dacs-rail:v1:', railHash));
    const railValid = ed25519Verify(signedBytes('dacs-rail:v1:', railHash), railSig, publicKeyFromRaw(steward.publicKeyRaw));
    assert.equal(railValid, true);
    const io = {
      async readListing(query) {
        const path = `/v1/listings/${encodeURIComponent(query.listingId)}/versions/${query.version}/artifact?contentHash=${query.contentHash}`;
        const response = await fetch(`${intakeOrigin}${path}`), bytes = await response.text();
        listingReads.push({ pin: structuredClone(query), status: response.status, bytes });
        return response.status === 200 ? { disposition: 'present', value: JSON.parse(bytes) } : { disposition: 'absent', reason: `local artifact HTTP ${response.status}` };
      },
      revocation: { nowMs: () => nowMs, surfaces: [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: nowMs }], readMarker: async () => null, verifyMarkerSignature: () => false },
      loadRailResolution: () => ({ trustPhase: 'PA-1', trustPolicyAcceptsPA1: true, registry: { state: 'not-used', entries: [], definitions: [] }, inCodeDefinitions: [{ ...rail, governanceAnchoring: 'in-code', signatureValid: railValid }] }),
      readPartyBundle: async ({ party }) => bundles.has(party) ? { disposition: 'present', value: structuredClone(bundles.get(party)) } : { disposition: 'absent', reason: 'unknown TEST party' },
      readVet: async ({ evaluatedParty }) => vets.has(evaluatedParty) ? { disposition: 'present', value: structuredClone(vets.get(evaluatedParty)) } : { disposition: 'absent', reason: 'no TEST record' },
    };
    const deps = { nowMs: () => nowMs, resolve: async () => null, resolveRecipe: async () => null, isRecipeSignerAuthorized: () => false,
      isVerifyResultSignerAuthorized: () => false, verifyAuthorityAttestation: () => 'unresolved',
      resolvePublicKey: async (signature) => signature.signer === vetWriter.claim ? publicKeyFromRaw(vetWriter.publicKeyRaw) : null,
      verify: ({ signedBytes: bytes, signature, publicKey }) => ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKey) };
    const strict = api.createSdkCompositeVetVerifier({ selectTrusted: async ({ evaluatedParty }) => structuredClone(trusted.get(evaluatedParty) ?? null), deps });
    const policy = { nowMs: () => nowMs, trustedVetWriters: [vetWriter.claim], sellerRequirement: empty, payeeAddress: wallet.address,
      verifyPartyVet: async (input) => { const result = await strict(input); verifiedVets.push({ evaluatedParty: input.expected.evaluatedParty, status: result.status }); return result; } };
    const resolveContext = api.createAgreementContextResolver({ sellerDid: wallet.claim, io, policy });
    responder = api.createSellerAgreementResponder({ sellerDid: wallet.claim, resolveContext, store: createInMemoryFencedSessionStore(), workerId: 'TEST-current-broker-interop',
      leaseNowMs: () => nowMs, sign: (bytes, context) => { signed.push(context.party); return wallet.signBytes(bytes).toString('base64url'); },
      reconcileSellerSignature: () => ({ disposition: 'absent', reason: 'no prior TEST signature' }),
      transport: { publishSellerContribution: (contribution, identity) => { contributions.set(identity.proposalHash, structuredClone(contribution)); published.push(structuredClone(contribution)); return { disposition: 'submitted' }; },
        reconcileSellerContributionPublication: (identity) => contributions.has(identity.proposalHash) ? { disposition: 'present', value: contributions.get(identity.proposalHash) } : { disposition: 'absent', reason: 'not published' } } });
  }
  return { wallet, listing, pin, origin, stored, received, progress, signed, published, listingReads, verifiedVets, installOperatorFacts };
}
