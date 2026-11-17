/**
 * Copy of the Directory's response schemas, so the test replies can be checked against the contract
 * itself. Source: the public Community repo, reference-implementations/dacs-directory,
 * src/catalog/contracts.ts at 4d428984 (`artifactProfiles`, `scanProgressSchema`, `listingSummarySchema`,
 * and the two constants they use). Update this file from there when the Directory contract changes.
 */

export const artifactProfiles = ["dacs-v0.1", "legacy-sdk-v0.1", "fixture-listing"] as const;

export const scanProgressSchema = {
  type: "object", additionalProperties: false,
  required: ["cursor", "tip", "lag", "cursorAdvancedAt", "lastSuccessfulFullScanAt", "fromTx"],
  properties: Object.fromEntries(["cursor", "tip", "lag", "cursorAdvancedAt", "lastSuccessfulFullScanAt", "fromTx"]
    .map((key) => [key, { type: ["integer", "null"], minimum: 0 }])),
} as const;
// Local Directory constraint: non-negative safe integer counts and Unix milliseconds.
const safeUint = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

// ECMAScript `\s` outside the control range, spelled out so that validators
// whose `\s` differs (Python's omits U+FEFF) read the pattern the same way.
const PATTERN_SPACE = "\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const CANONICAL_STRING_PATTERN =
  `^[^${PATTERN_SPACE}\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^${PATTERN_SPACE}\\u0000-\\u001f\\u007f])?$`;

export const listingSummarySchema = {
  $id: "/schemas/listing-summary.v2.schema.json",
  title: "DACS Directory ListingSummary",
  description: "Discovery projection with unassessed transaction readiness. Pay-bearing Listings use concrete pay phases; pay-alternative and procurement Listings are outside this Directory profile.",
  type: "object",
  required: ["listingId", "version", "contentHash", "anchor", "seller", "offering", "pricing", "status", "catalogObservedAt", "transactionReadiness"],
  properties: {
    listingId: { type: "string", minLength: 1 },
    version: { type: "integer", minimum: 1 },
    contentHash: { type: "string", minLength: 1 },
    anchor: {
      type: "object", required: ["kind", "locator"], additionalProperties: false,
      properties: { kind: { type: "string" }, locator: { type: "string" } },
    },
    seller: {
      type: "object", required: ["primaryClaim", "displayName"], additionalProperties: false,
      properties: { primaryClaim: { type: "string" }, displayName: { type: "string" } },
    },
    artifactProfile: { enum: artifactProfiles },
    publicEndpoint: { type: "string", format: "uri" },
    reachabilityHint: {
      type: "object",
      required: ["status", "checkedAt"],
      additionalProperties: false,
      properties: {
        status: { enum: ["reachable", "unreachable", "unknown"] },
        checkedAt: { type: "integer", minimum: 0 },
        surface: { type: "string", format: "uri" },
      },
    },
    offering: {
      type: "object", required: ["title", "category", "tags"],
      properties: {
        title: { type: "string" }, description: { type: "string" }, category: { type: "string" },
        tags: { type: "array", items: { type: "string" } }, rails: { type: "array", items: { type: "string" } },
        paymentPhases: {
          type: "array",
          items: { type: "object", required: ["kind", "rail"], properties: { kind: { type: "string" }, rail: { type: "string" } } },
        },
        flowPhases: { type: "array", items: { type: "string" } },
        delivery: { type: "array", items: { type: "string" } }, negotiation: { type: "array", items: { type: "string" } },
        deliverable: { type: "object" },
      },
    },
    pricing: {
      type: "object", properties: {
        kind: { enum: ["fixed", "negotiable", "auction", "metered"] }, priceHint: { type: "string" },
        currency: { type: "string" }, unit: { type: "string" }, minPct: { type: "number" },
        maxPct: { type: "number" }, selectionRule: { type: "string" }, minTotalHint: { type: "string" },
      },
    },
    status: { enum: ["active", "revoked"] },
    revocation: {
      type: "object",
      required: [
        "sellerPrimaryClaim", "listingId", "listingVersion", "listingContentHash",
        "logicalAddress", "markerAnchor", "markerContentHash",
      ],
      additionalProperties: false,
      properties: {
        sellerPrimaryClaim: { type: "string", minLength: 1 },
        listingId: { type: "string", minLength: 1 },
        listingVersion: { type: "integer", minimum: 1 },
        listingContentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        logicalAddress: { type: "string", pattern: "^dacs1-revoked:" },
        markerAnchor: {
          type: "object", required: ["kind", "locator"], additionalProperties: false,
          properties: { kind: { type: "string" }, locator: { type: "string" } },
        },
        markerContentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
    catalogObservedAt: { type: "integer" },
    transactionReadiness: {
      type: "object",
      required: ["disposition", "reason"],
      additionalProperties: false,
      properties: {
        disposition: { const: "unassessed" },
        reason: { type: "string", minLength: 1 },
      },
      description: "Catalog admission is not buyer/session admission. Run the current SDK Listing reader with buyer-local dependencies before transacting.",
    },
    reputationHint: {
      type: "object",
      description: "TP-1 observed history; completion and fault rates and numeric reputation scores are unavailable. bundleCount is recomputed on read from the retained records the seller reputation counts; a missing or malformed cached hint uses the listing category and the catalog snapshot window. categoryScope equals offering.category or is a dot-separated prefix of it, and windowStart <= windowEnd (Unix milliseconds).",
      additionalProperties: false,
      required: [
        "categoryScope", "completionRate", "counterpartyAdjustedCompletionRate", "counterpartyFaultRate",
        "averageBuyerRating", "averageSellerRating", "bundleCount", "windowStart", "windowEnd",
        "computedAt", "metricsUnavailableReason", "metricsProfile", "observedOutcomesLabel",
      ],
      properties: {
        categoryScope: {
          type: "string",
          minLength: 1,
          // No leading or trailing white space, C0 control or DEL; NFC cannot be expressed here.
          pattern: CANONICAL_STRING_PATTERN,
          description: "A canonical string: equal to its trim(), NFC-normalized, and free of C0 control characters and DEL.",
        },
        completionRate: { type: "null" },
        counterpartyAdjustedCompletionRate: { type: "null" },
        counterpartyFaultRate: { type: "null" },
        averageBuyerRating: { type: "null" },
        averageSellerRating: { type: "null" },
        metricsUnavailableReason: { const: "Completion verification unavailable" },
        metricsProfile: { const: "TP-1" },
        observedOutcomesLabel: { type: "string" },
        bundleCount: safeUint,
        windowStart: safeUint,
        windowEnd: safeUint,
        computedAt: safeUint,
      },
    },
    inspection: {
      type: "object",
      required: ["artifactType", "maturity", "href"],
      additionalProperties: false,
      properties: {
        artifactType: { const: "directory-service-profile" },
        maturity: { enum: ["listed", "sample-backed", "callable", "strict-bundle-history", "live-paid"] },
        href: { type: "string", format: "uri-reference" },
      },
    },
  },
  allOf: [{
    if: { properties: { status: { const: "revoked" } }, required: ["status"] },
    then: { required: ["revocation"] },
    else: { not: { required: ["revocation"] } },
  }],
} as const;
