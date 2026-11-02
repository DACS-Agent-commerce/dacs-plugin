/**
 * Shared prepare checks. The full stdio server and the keyless surface both call these
 * so fee quotes, allow-lists, proof shapes, and offer builds cannot drift apart.
 */
import type { ChainReader } from './chain.js';
import { demToOs, parseOs } from './amount.js';
import { hasDuplicateMembers } from './dacs/verify.js';
import { z } from 'zod';
import { buildOffer, type AgreementDoc } from './dacs/agreement.js';
import { buildListing, type ListingDoc } from './dacs/listing.js';

export async function quoteFeeOs(chain: ChainReader): Promise<bigint> {
  const info = await chain.networkInfo();
  return quoteFeeOsFromParams((info.params ?? null) as Record<string, unknown> | null);
}

export function quoteFeeOsFromParams(p: Record<string, unknown> | null): bigint {
  const num = (k: string) => {
    const v = p?.[k];
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`node fee parameter ${k} is invalid`);
    return v;
  };
  if (!p || typeof p.networkFee !== 'number') throw new Error('node did not state its fee parameters; refusing to prepare');
  const dem = num('networkFee') + num('rpcFee') + num('additionalFee');
  return BigInt(Math.round(dem * 1e9));
}

export function assertAllowlisted(allowlist: readonly string[] | null | undefined, to: string): void {
  if (allowlist && !allowlist.includes(to)) {
    throw new Error(`recipient ${to} is not on the configured allow-list (DEMOS_RECIPIENT_ALLOWLIST)`);
  }
}

export function nativeAmountOs(input: { amount_dem?: string; amount_os?: string }): bigint {
  if ((input.amount_dem === undefined) === (input.amount_os === undefined)) {
    throw new Error('give exactly one of amount_dem or amount_os');
  }
  const amountOs = input.amount_dem !== undefined ? demToOs(input.amount_dem) : parseOs(input.amount_os!);
  if (amountOs <= 0n) throw new Error('amount must be positive');
  return amountOs;
}

const PROOF_HOSTS: Record<'github' | 'twitter' | 'discord', RegExp> = {
  github: /^https:\/\/(gist\.github\.com|gist\.githubusercontent\.com|raw\.githubusercontent\.com)\//,
  twitter: /^https:\/\/(x\.com|twitter\.com)\/[^/]+\/status\/[0-9]+/,
  discord: /^https:\/\/(discord\.com|ptb\.discord\.com|canary\.discord\.com|discordapp\.com)\/channels\/[^/]+\/[^/]+\/[^/]+/,
};

const DOMAIN_HOST = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

export function assertAttestationProof(kind: 'github' | 'twitter' | 'discord' | 'domain', proof: string): void {
  if (kind === 'domain') {
    if (!DOMAIN_HOST.test(proof)) throw new Error('for kind "domain", proof must be the hostname');
    return;
  }
  if (!PROOF_HOSTS[kind].test(proof)) throw new Error(`proof for ${kind} must be an https URL on the expected host`);
}

export interface OfferToolFields {
  role?: 'seller' | 'buyer';
  job_id?: string;
  listing_ref: { listingId: string; version: number; contentHash: string };
  self_bundle_hash: string;
  self_vet_record_ref: unknown;
  counterparty: { primary_claim: string; bundle_hash: string; vet_record_ref: unknown };
  price: { amount: string; currency: string; unit?: string };
  deliverable: { deliverableType: string; hash: string; schemaUrl?: string };
  deadline_unix_ms: number;
}

export function unsignedOffer(input: OfferToolFields, selfAddress: string, nowMs: number): AgreementDoc {
  const role = input.role ?? 'seller';
  return buildOffer(
    {
      jobId: input.job_id,
      listingRef: input.listing_ref,
      self: { role, bundleHash: input.self_bundle_hash, vetRecordRef: input.self_vet_record_ref as Record<string, unknown> },
      counterparty: {
        role: role === 'seller' ? 'buyer' : 'seller',
        primaryClaim: input.counterparty.primary_claim,
        bundleHash: input.counterparty.bundle_hash,
        vetRecordRef: input.counterparty.vet_record_ref as Record<string, unknown>,
      },
      price: input.price,
      deliverable: input.deliverable,
      deadline: input.deadline_unix_ms,
    },
    selfAddress,
    nowMs,
  );
}

export function assertOfferText(offer: unknown): void {
  if (typeof offer === 'string' && (offer.charCodeAt(0) === 0xfeff || hasDuplicateMembers(offer))) {
    throw new Error('offer JSON has a BOM or repeats a member name (CF-5); refusing');
  }
}

/** Input shape of demos_dacs_listing_prepare (same on the stdio and keyless surfaces). */
export const LISTING_INPUT = {
  contains_private_data: z.boolean().optional(), minimal_private_data: z.boolean().optional(), private_consent: z.boolean().optional(),
  listing_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/, 'listing_id must be URL-safe ASCII'),
  listing_version: z.number().int().min(1).describe('Monotonic per listing_id, starting at 1; versions are not skipped (LP-3)'),
  display_name: z.string().min(1).max(200),
  public_endpoint: z.string().max(500).regex(/^https:\/\//).optional(),
  seller_claim: z.string().min(3).max(300).optional().describe('Primary claim to present. Must be this wallet (key:<hex>); anything else is refused as impersonation.'),
  seller_identity: z.record(z.any()).optional().describe('A complete IdentityBundle. Omit to have the wallet build and present its own at signing.'),
  offering: z.object({
    title: z.string().min(1).max(200), description: z.string().max(2000), category: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(32)).max(16),
    deliverable: z.record(z.any()).describe('DeliverableSpec, e.g. {kind:"attested-payload", payloadFormat:"application/json"}'),
    extendedDescriptionUrl: z.string().max(500).optional(), extendedDescriptionHash: z.string().max(80).optional(),
  }),
  buyer_requirement: z.record(z.any()).optional(),
  pipeline: z.array(z.object({ kind: z.string().max(64), parameters: z.record(z.any()).optional() })).min(1).max(32).optional(),
  pricing: z.record(z.any()).describe('PricingSpec (DACS-4), e.g. {kind:"fixed", price:{amount:"1.5", currency:"DEM"}}'),
  accepted_rails: z.array(z.record(z.any())).max(16).optional(),
  terms: z.record(z.any()).optional(),
  not_before_unix_ms: z.number().int().positive().optional(),
  not_after_unix_ms: z.number().int().positive().optional(),
  required_capabilities: z.array(z.string().max(8)).max(5).optional(),
};

export type ListingToolFields = { [K in keyof typeof LISTING_INPUT]: z.infer<(typeof LISTING_INPUT)[K]> };

export function unsignedListing(a: ListingToolFields, selfAddress: string, nowMs: number): ListingDoc {
  return buildListing({
    listingId: a.listing_id, listingVersion: a.listing_version, displayName: a.display_name, publicEndpoint: a.public_endpoint,
    sellerClaim: a.seller_claim, sellerIdentity: a.seller_identity as Record<string, unknown> | undefined,
    offering: a.offering as any, buyerRequirement: a.buyer_requirement, pipeline: a.pipeline as any, pricing: a.pricing,
    acceptedRails: a.accepted_rails, terms: a.terms, notBefore: a.not_before_unix_ms, notAfter: a.not_after_unix_ms,
    requiredCapabilities: a.required_capabilities,
  }, selfAddress, nowMs);
}

export const LISTING_VERIFY_INPUT = {
  listing: z.union([z.string(), z.record(z.any())]).describe('The signed listing as JSON'),
  revocation: z.enum(['absent', 'revoked', 'indeterminate']).optional().describe('Your own RB-4..RB-6 revocation result. Omitted means unestablished, so the decision is at best indeterminate.'),
  expect_pin: z.object({ listingId: z.string(), version: z.number().int(), contentHash: z.string() }).optional().describe('LR-1 pin to match, e.g. an offer\'s listing_ref'),
};
