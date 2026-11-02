/**
 * Unsigned prepare tools for the keyless HTTP surface.
 * These handlers quote public chain data and return a draft. They do not open
 * a wallet, sign, or submit.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { normalizeAddress } from './config.js';
import type { ChainReader } from './chain.js';
import { osToDem } from './amount.js';
import { killSwitchEngaged } from './mandates.js';
import { maybeParseJson } from './json.js';
import { agreementHash, analyzeOfferForAccept } from './dacs/agreement.js';
import { assertAllowlisted, assertAttestationProof, assertOfferText, LISTING_INPUT, nativeAmountOs, quoteFeeOs, unsignedListing, unsignedOffer } from './prepare_core.js';
import { listingHash, listingLogicalAddress, opaqueListingProgramName } from './dacs/listing.js';
import { claimForAddress } from './dacs/sig.js';

const ADDRESS = z.string().describe('Demos address: 0x followed by 64 hex characters');

const oneOf = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .refine((v) => (values as readonly string[]).includes(v), { message: `must be one of: ${values.join(', ')}` })
    .describe(`one of: ${values.join(', ')}`) as unknown as z.ZodType<T>;

const ATTESTATION_REF = z.object({
  anchor: z.object({
    kind: oneOf(['storage-program', 'ipfs', 'https'] as const),
    locator: z.string().min(1),
  }),
  contentHash: z.string(),
  signer: z.string().optional(),
});

type Guarded = <A>(fn: (a: A) => Promise<unknown>) => (a: A) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

function refuseIfKilled(config: Config): void {
  if (killSwitchEngaged(config.stateDir)) throw new Error(`kill switch engaged (${config.stateDir}/KILL exists): unsigned prepare is refused`);
}

function draft(body: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: 'keyless',
    holds_keys: false,
    signed: false,
    submit: 'refused',
    next: 'Take this unsigned draft to a local demos-mcp stdio process to approve and sign. This server will not submit it.',
    ...body,
  };
}

export function registerKeylessPrepareTools(
  server: McpServer,
  opts: { chain: ChainReader; config: Config; guarded: Guarded; now: () => number },
): void {
  const { chain, config, guarded, now } = opts;

  server.registerTool(
    'demos_tx_prepare',
    {
      title: 'Prepare a DEM transfer (unsigned)',
      description:
        'Keyless draft of a native DEM transfer. Quotes the fee from the public node and returns unsigned fields. This server holds no keys and will not sign or submit.',
      inputSchema: {
        to: ADDRESS,
        amount_dem: z.string().optional().describe('Amount in DEM as a decimal string, e.g. "1.5"'),
        amount_os: z.string().optional().describe('Amount in base units (OS) as a digit string; 1 DEM = 1000000000 OS'),
        from: ADDRESS.optional().describe('Public sender address to print on the draft. Not a key.'),
        memo: z.string().max(140).regex(/^[\x20-\x7e]*$/, 'memo must be printable ASCII').optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (a: { to: string; amount_dem?: string; amount_os?: string; from?: string; memo?: string }) => {
      refuseIfKilled(config);
      const amountOs = nativeAmountOs(a);
      const to = normalizeAddress(a.to);
      const from = a.from ? normalizeAddress(a.from) : null;
      if (from && from === to) throw new Error('refusing to pay this address itself');
      assertAllowlisted(config.recipientAllowlist, to);
      const quote = await quoteFeeOs(chain);
      return draft({
        unsigned_tx: {
          type: 'native',
          from,
          to,
          amount_os: amountOs.toString(),
          amount_dem: osToDem(amountOs),
        },
        fee_quote_dem: osToDem(quote),
        network: config.network,
        ...(a.memo ? { memo_local_only: a.memo } : {}),
      });
    }),
  );

  server.registerTool(
    'demos_identity_attest_prepare',
    {
      title: 'Prepare an identity attestation (unsigned)',
      description:
        'Keyless draft of an identity attestation. Checks the proof shape and quotes the fee. This server holds no keys and will not sign or submit.',
      inputSchema: {
        kind: oneOf(['github', 'twitter', 'discord', 'domain'] as const),
        proof: z.string().min(1).max(500),
        from: ADDRESS.optional().describe('Public wallet address to print on the draft. Not a key.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (a: { kind: 'github' | 'twitter' | 'discord' | 'domain'; proof: string; from?: string }) => {
      refuseIfKilled(config);
      assertAttestationProof(a.kind, a.proof);
      const quote = await quoteFeeOs(chain);
      return draft({
        unsigned_tx: { type: 'identity', kind: a.kind, proof: a.proof, from: a.from ? normalizeAddress(a.from) : null },
        fee_quote_dem: osToDem(quote),
        network: config.network,
      });
    }),
  );

  server.registerTool(
    'demos_dacs_create_offer_prepare',
    {
      title: 'Prepare a DACS offer (unsigned)',
      description:
        'Build an unsigned DACS fixed-price offer for a public address you pass in. This server does not sign it and does not hold a key.',
      inputSchema: {
        self_address: ADDRESS.describe('Public address of the offering party. Not a key.'),
        role: oneOf(['seller', 'buyer'] as const).optional(),
        job_id: z.string().max(64).regex(/^[0-9A-Za-z_-]+$/).optional(),
        listing_ref: z.object({ listingId: z.string().min(1).max(128), version: z.number().int().nonnegative(), contentHash: z.string() }),
        self_bundle_hash: z.string(),
        self_vet_record_ref: ATTESTATION_REF,
        counterparty: z.object({
          primary_claim: z.string().min(3).max(300),
          bundle_hash: z.string(),
          vet_record_ref: ATTESTATION_REF,
        }),
        price: z.object({ amount: z.string(), currency: z.string().max(32).default('DEM'), unit: z.string().max(32).optional() }),
        deliverable: z.object({ deliverableType: z.string().max(64), hash: z.string(), schemaUrl: z.string().max(500).optional() }),
        deadline_unix_ms: z.number().int().positive(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded(async (a: {
      self_address: string;
      role?: 'seller' | 'buyer';
      job_id?: string;
      listing_ref: { listingId: string; version: number; contentHash: string };
      self_bundle_hash: string;
      self_vet_record_ref: Record<string, unknown>;
      counterparty: { primary_claim: string; bundle_hash: string; vet_record_ref: Record<string, unknown> };
      price: { amount: string; currency: string; unit?: string };
      deliverable: { deliverableType: string; hash: string; schemaUrl?: string };
      deadline_unix_ms: number;
    }) => {
      refuseIfKilled(config);
      const self = normalizeAddress(a.self_address);
      const doc = unsignedOffer(a, self, now());
      return draft({ agreement_hash: agreementHash(doc), unsigned_offer: doc, from: self });
    }),
  );

  server.registerTool(
    'demos_dacs_accept_prepare',
    {
      title: 'Prepare to accept a DACS offer (unsigned)',
      description:
        'Check a counterparty-signed DACS offer and return an unsigned accept draft for a public address. This server does not countersign, pay, or submit.',
      inputSchema: {
        self_address: ADDRESS.describe('Public address of the accepting party. Not a key.'),
        offer: z.union([z.string(), z.record(z.any())]),
        pay: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (a: { self_address: string; offer: unknown; pay?: boolean }) => {
      refuseIfKilled(config);
      assertOfferText(a.offer);
      const self = normalizeAddress(a.self_address);
      const doc = maybeParseJson(a.offer);
      const an = analyzeOfferForAccept(doc, self, now());
      const quote = an.payee && a.pay !== false ? await quoteFeeOs(chain) : 0n;
      return draft({
        agreement_hash: an.hash,
        role: an.myRole,
        counterparty_claim: an.counterpartyClaim,
        unsigned_accept: { from: self, pay: a.pay !== false, payee: an.payee ?? null, fee_quote_dem: osToDem(quote) },
      });
    }),
  );

  server.registerTool(
    'demos_dacs_listing_prepare',
    {
      title: 'Prepare a DACS-1 listing (unsigned)',
      description:
        'Build an unsigned DACS-1 service listing (§6.3.4) for a public address you pass in. This server does not sign, anchor, or hold a key. Take the draft to a local demos-mcp stdio process to approve and sign.',
      inputSchema: { self_address: ADDRESS.describe('Public address of the listing publisher. Not a key.'), ...LISTING_INPUT },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded(async (a: any) => {
      refuseIfKilled(config);
      const self = normalizeAddress(a.self_address);
      if (a.seller_claim && a.seller_claim !== claimForAddress(self)) throw new Error('seller_claim is not the claim of self_address; refusing to draft a listing for someone else');
      const doc = unsignedListing(a, self, now());
      const logical = listingLogicalAddress(String(doc.seller.identity.presentedBy), doc.listingId, doc.listingVersion);
      return draft({ unsigned_listing: doc, listing_template_hash: listingHash(doc), logical_address: logical, storage_program_name: opaqueListingProgramName(logical), from: self });
    }),
  );
}
