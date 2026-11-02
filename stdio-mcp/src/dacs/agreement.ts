/**
 * DACS-3 negotiate-fixed-price offer / accept helpers (§8.4.1, §8.5).
 *
 * An "offer" is an AgreementDocument (agreementVersion "1",
 * derivedFromPattern "fixed-price") signed by the offering party only. "Accept"
 * verifies the counterparty's signature, countersigns, and (for the native-DEM
 * rail) pays the seller. Both signatures are over
 *   "dacs-agreement:v1:" || sha256hex(JCS(doc minus signatures)).
 */
import { randomBytes } from 'node:crypto';
import { isCanonicalDecimal } from '../amount.js';
import { contentHash } from './jcs.js';
import { addressForClaim, claimForAddress, encodeSig6, SEP, signedBytes, verifyDomainSig } from './sig.js';
import { verifyAgreementStructure, type Check } from './verify.js';

export const DEM_RAIL_ID = 'demos-native:DEM';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i]! % 32];
  return time + rand;
}

export interface PartyInput {
  role: 'buyer' | 'seller';
  primaryClaim: string;
  bundleHash: string;
  vetRecordRef: Record<string, unknown>;
}

export interface OfferInput {
  jobId?: string;
  listingRef: { listingId: string; version: number; contentHash: string };
  self: Omit<PartyInput, 'primaryClaim'>;
  counterparty: PartyInput;
  price: { amount: string; currency: string; unit?: string };
  deliverable: { deliverableType: string; hash: string; schemaUrl?: string };
  deadline: number;
  rail?: { railId: string; railVersion?: number; parameters?: Record<string, unknown> };
}

export type AgreementDoc = Record<string, any> & { signatures: Array<{ party: string; algorithm: 'ed25519'; value: string }> };

const HASH_RE = /^(sha256:)?[0-9a-f]{64}$/;

export function buildOffer(input: OfferInput, selfAddress: string, now = Date.now()): AgreementDoc {
  const selfClaim = claimForAddress(selfAddress);
  if (input.self.role === input.counterparty.role) throw new Error('self and counterparty must have different roles (buyer/seller)');
  if (input.counterparty.primaryClaim === selfClaim) throw new Error('counterparty cannot be this wallet');
  if (!isCanonicalDecimal(input.price.amount)) throw new Error('price.amount must be a positive CD-1 canonical decimal (e.g. "1.5", not "1.50")');
  if (!HASH_RE.test(input.listingRef.contentHash)) throw new Error('listingRef.contentHash must be a sha256 hex');
  if (!HASH_RE.test(input.deliverable.hash)) throw new Error('deliverable.hash must be a sha256 hex');
  for (const p of [input.self, input.counterparty]) if (!HASH_RE.test(p.bundleHash)) throw new Error('party bundleHash must be a sha256 hex');
  if (!Number.isInteger(input.deadline) || input.deadline <= now) throw new Error('deadline must be a future unix-ms integer');
  const rail = input.rail ?? (input.price.currency === 'DEM' ? { railId: DEM_RAIL_ID } : undefined);
  const parties = [
    { role: input.self.role, bundleHash: input.self.bundleHash, primaryClaim: selfClaim, vetRecordRef: input.self.vetRecordRef },
    { role: input.counterparty.role, bundleHash: input.counterparty.bundleHash, primaryClaim: input.counterparty.primaryClaim, vetRecordRef: input.counterparty.vetRecordRef },
  ].sort((a, b) => (a.role === 'buyer' ? -1 : b.role === 'buyer' ? 1 : 0));
  return {
    agreementVersion: '1',
    jobId: input.jobId ?? ulid(now),
    listingRef: input.listingRef,
    parties,
    terms: {
      deliverable: input.deliverable,
      price: input.price,
      ...(rail ? { rail } : {}),
      deadline: input.deadline,
    },
    derivedFromPattern: 'fixed-price',
    generatedAt: now,
    signatures: [],
  };
}

export function agreementHash(doc: Record<string, unknown>): string {
  return contentHash(doc, ['signatures']);
}

export function agreementSigningPayload(doc: Record<string, unknown>): string {
  const sep = 'payeeBoundAgreementVersion' in doc ? SEP.PAYEE_BOUND_AGREEMENT : SEP.AGREEMENT;
  return signedBytes(sep, agreementHash(doc));
}

export function attachSignature(doc: AgreementDoc, claim: string, sig: Uint8Array): AgreementDoc {
  return { ...doc, signatures: [...doc.signatures, { party: claim, algorithm: 'ed25519', value: encodeSig6(sig) }] };
}

export interface AcceptAnalysis {
  hash: string;
  myRole: 'buyer' | 'seller';
  counterpartyRole: 'buyer' | 'seller';
  counterpartyClaim: string;
  price: { amount: string; currency: string };
  payee?: string; // 0x address, for the native DEM rail
  deadline: number;
}

/** Validate an incoming offer for acceptance by `selfAddress`. Throws with a clear reason. */
export function analyzeOfferForAccept(doc: unknown, selfAddress: string, now = Date.now()): AcceptAnalysis {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('offer must be a JSON object');
  const d = doc as Record<string, any>;
  const pb = 'payeeBoundAgreementVersion' in d;
  if (('agreementVersion' in d) === pb) throw new Error('offer must carry exactly one of agreementVersion / payeeBoundAgreementVersion');
  if (pb ? d.payeeBoundAgreementVersion !== '1' : d.agreementVersion !== '1') throw new Error('unsupported agreement version');
  if (d.derivedFromPattern !== 'fixed-price') throw new Error('only negotiate-fixed-price offers can be accepted here');
  // full DACS-3 §8.5 structural validation, shared with the verifier
  const structural: Check[] = [];
  verifyAgreementStructure(d, pb ? 'PayeeBoundAgreementDocument' : 'AgreementDocument', structural);
  const bad = structural.filter((c) => c.decision !== 'pass');
  if (bad.length) throw new Error(`offer is malformed: ${bad.map((c) => c.detail).join('; ')}`);
  const selfClaim = claimForAddress(selfAddress);
  const parties: any[] = Array.isArray(d.parties) ? d.parties : [];
  const roleCount = (r: string) => parties.filter((p) => p?.role === r).length;
  if (roleCount('buyer') !== 1 || roleCount('seller') !== 1) throw new Error('offer must name exactly one buyer and exactly one seller');
  if (new Set(parties.map((p) => p?.primaryClaim)).size !== parties.length) throw new Error('offer parties must have distinct primary claims');
  for (const p of parties) {
    if (!/^(sha256:)?[0-9a-f]{64}$/.test(String(p?.bundleHash)) || !p?.vetRecordRef || typeof p.vetRecordRef !== 'object') {
      throw new Error(`party ${String(p?.role)} lacks a bundleHash / vetRecordRef`);
    }
  }
  const me = parties.find((p) => p?.primaryClaim === selfClaim);
  if (!me || (me.role !== 'buyer' && me.role !== 'seller')) throw new Error(`this wallet (${selfClaim}) is not a buyer/seller party in the offer`);
  const other = parties.find((p) => p?.primaryClaim !== selfClaim && (p?.role === 'buyer' || p?.role === 'seller'));
  if (!other || other.role === me.role) throw new Error('offer must name exactly one counterparty with the other role');
  const hash = agreementHash(d);
  const sigs: any[] = Array.isArray(d.signatures) ? d.signatures : [];
  if (sigs.some((s) => s?.party === selfClaim)) throw new Error('this wallet already signed this agreement');
  const cs = sigs.find((s) => s?.party === other.primaryClaim);
  if (!cs) throw new Error('offer is not signed by the counterparty');
  const sep = pb ? SEP.PAYEE_BOUND_AGREEMENT : SEP.AGREEMENT;
  const v = verifyDomainSig(sep, hash, cs.party, cs.algorithm, cs.value);
  if (v.decision !== 'pass') throw new Error(`counterparty signature ${v.decision}: ${v.reason ?? ''}`);
  const terms = d.terms ?? {};
  const price = terms.price ?? {};
  if (typeof price.amount !== 'string' || !isCanonicalDecimal(price.amount) || typeof price.currency !== 'string') throw new Error('offer price is not a CD-1 canonical amount');
  if (!Number.isInteger(terms.deadline) || terms.deadline <= now) throw new Error('offer deadline has passed or is invalid');
  let payee: string | undefined;
  if (terms.rail?.railId === DEM_RAIL_ID) {
    if (price.currency !== 'DEM') throw new Error(`rail ${DEM_RAIL_ID} requires currency DEM`);
    const seller = parties.find((p) => p?.role === 'seller');
    if (pb) {
      const bindings = (terms.payoutBindings ?? []).filter((b: any) => b?.railId === DEM_RAIL_ID);
      if (bindings.length !== 1) throw new Error(`offer must carry exactly one ${DEM_RAIL_ID} payout binding`);
      payee = bindings[0].payeeAddress;
    } else {
      payee = addressForClaim(String(seller?.primaryClaim)) ?? undefined; // pay-dem Tier-1: destination is the seller's key
    }
    if (!payee) throw new Error('cannot determine the DEM payee for this offer (seller claim is not key:<hex>)');
  }
  return {
    hash,
    myRole: me.role,
    counterpartyRole: other.role,
    counterpartyClaim: other.primaryClaim,
    price: { amount: price.amount, currency: price.currency },
    payee,
    deadline: terms.deadline,
  };
}
