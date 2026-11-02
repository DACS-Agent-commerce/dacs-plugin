# Purchase receipt and owner-only evidence export

`DACS_SHOWCASE_RECEIPT=off|on` defaults to `off` and parses to
`config.showcaseReceipt`. This feature supplies server-side pure functions only:

```js
buildPurchaseReceipt(operation, { accountId, enabled: config.showcaseReceipt === 'on', now });
exportPurchaseEvidence(operation, { accountId, enabled: config.showcaseReceipt === 'on', now });
```

Import from `src/portal/purchase-receipt.mjs`. `now` is an epoch millisecond
number or a function returning one (default `Date.now`). No network, signing,
write, reconciliation, or broadcast occurs. Off refuses with
`showcase_receipt_disabled`; an absent/different account refuses with
`receipt_not_owner`, before any other field is read. The owner is read from the
`accountId` property descriptor: it must be an own data property, so no getter
runs. The module then takes one snapshot of the operation and reads only that.
The snapshot holds only what the two documents use, and calls nothing on the
input. `terms`, which the plugin builds when it prepares the purchase, is copied
whole: own, enumerable data properties of plain objects (prototype
`Object.prototype` or null) and dense arrays. An accessor, a `toJSON` function, a
proxy, a class instance (including `Date`), a symbol key, a `__proto__` key or a
non-finite number in it refuses the purchase with `receipt_invalid_operation`,
and an undefined value is treated as JSON treats it: an omitted key, or null in
an array. This copy has fixed budgets (depth 48; 100,000 objects, object keys
and array slots; 8,000,000 characters of keys and strings); larger terms refuse
with `receipt_invalid_operation`. An array's length is charged before its keys
are listed, and an object's key count before any of its values is copied (an
object's keys are listed before they are counted).

Everything else is read by name, by property descriptor, along fixed paths: the
operation's `accountId`, `kind`, `id` and `status`; the prepare-time Listing
checks and their evidence; and, under `state.protocol`, the stage, the fields in
the artifact table below, the deadline observations, the Agreement-context
marker and the Listing's `offering.title`. Nothing else is listed or read: not
the rest of the signed Listing (which can nest past the budgets and still
verify), the delivered report, the seller's answers kept for payment evidence,
claims, attempts, or anything stored later. Nothing stored there can change or
block an export, and an accessor or proxy there is never reached. On a path, an
accessor, a non-enumerable property, a proxy, an array hole, or a function,
symbol, bigint or non-finite value refuses the purchase, and so does a class
instance (including `Date`, or an `Array` subclass) in place of an expected
object or list. The two lists on paths (the eight prepare-time checks, and up to
four Agreement or planned parties) are read by index; a longer list is read as
empty. Any other object or array, class instance or not, where a value or the
other kind of container is expected is kept only as an empty one of its kind
and never read; no check accepts it. The finality and Vet limits are taken from
`protocolView()` over the terms and stage alone, because in `protocolView()`
they depend only on the terms (profile, Agreement-context source and transport
binding).
The snapshot must name the same account both as
owner and as `terms.buyer.accountId`, or it refuses with `receipt_not_owner`.
Unknown/malformed purchases, a missing Listing anchor, unsupported profiles and a
post-payment protocol stage without `settled_verified` refuse with
`receipt_invalid_operation`. So does a purchase stored before network binding,
which has no `terms.domain`. The stored price must be exactly what the purchase
path writes: a canonical positive DEM amount (`normalizeDemAmount` in
`src/dacs/listing.mjs`, at most 9 fraction digits) with its base units in
`amountOs`, which has at most 78 digits (`OS_DIGITS_MAX` in
`src/dacs/chain.mjs`, the bound on node balances). A purchase stored before
that bound with a longer price refuses with `receipt_invalid_operation`; the
portal view still shows it whole. Only refusals made by this module during the same call keep their code
and message: any other failure while projecting, including an `OperationError`
thrown by the caller's `now` or by the operation, or a refusal from an earlier
call thrown again, becomes `receipt_invalid_operation` with a fixed message. Invalid time refuses with
`receipt_invalid_time`. Statuses are those of `PURCHASE_STATUS_HELP` in
`src/purchases.mjs`. Supported stored profiles are ordinary
DEM purchases without protocol state, fixed-price-pay-dem/v1,
sr2-wallet-agreement/v1, and devnet-pay-dem-purchase/v1 under the
`dacs-chatgpt-plugin/` namespace.

The caller must authenticate the account and retrieve the operation with
`ops.get(accountId, purchaseId)`. Handoff tokens alone never authorize an
export. Account IDs come from authenticated server context, never request
body fields. Public sharing has no authority or redaction design yet.
There are no route, MCP, or rendering hooks yet.

Both documents record observations made by this server at the listed times.
`generatedAt` is generation time, **not** verification time. Inclusion and an
SDK finality label do not establish BFT finality. Payment observation is one
RPC tuple only. Missing observation metadata stays null, rather than being
filled from current operator configuration. Human acceptance is not recorded.
A preview ends at `delivery-ready`: Verify is pending with its reason.
`completed` requires the stored completed stage, both role-copy references,
bundle hash, verification timestamp and both signatures; this still carries
the original profile's finality/Vet limits. The module does not redo these
checks or establish service quality, business identity, satisfaction, fault,
refund, or strict ST-11 compliance.

## Exact v1 schema

All fields below are always present; unavailable scalars and optional objects
are `null`. An artifact's `reference`, `block` and `observation` are always
objects, with null leaves when unavailable.
There are no additional keys. Brackets denote each element of a fixed array.
The export embeds exactly the receipt schema. Optional nested objects have
exactly the listed fields whenever non-null. Strings are bounded, single-line
text with no Unicode control (Cc) or format (Cf) characters, which include every
zero-width and bidirectional control, and no line (Zl) or paragraph (Zp)
separators; hashes are 64 lowercase hex, wallet addresses optionally start `0x`,
identity claims are `did:demos:agent:` plus 64 lowercase hex. Storage locators
are `stor-` plus 40 (native CREATE) or 64 (SDK logical/bundle) lowercase hex, or
bounded DACS logical addresses `dacsN:<kind>:<id>` (no `/`, so never URL-shaped). Numeric
blocks/times must be nonnegative safe integers; times must fit a Date.
Unusable optional references stay missing. Nothing is truncated into a valid
reference. There are five stages and eleven artifact slots; attempt logs,
report body arrays and arbitrary stored objects are never copied.

Receipt fields and sources:

| Key path | Source / meaning |
| --- | --- |
| `schema` | `dacs-chatgpt-plugin/purchase-receipt/v1` |
| `generatedAt` | ISO timestamp from `now` |
| `observationStatement` | Fixed historical-observation statement; no fresh verification |
| `label` | `Showcase preview` |
| `outcome` | One of: `completed` (guarded completed state); `Report available; completion copies were rejected` or `Completion copies were rejected` (bundle rejection); `Purchase did not reach completion` (status `agreement_rejected`, `terms_changed`, `expired`, `cancelled`, `payment_failed`, `payment_mismatch` or `superseded`, or a rejected Agreement, claim, evidence or delivery stage; this says nothing about whether the purchase can still change, and a cancelled purchase can still reach `settled_verified` if a late payment hash is reported); `Report available; completion audit pending` (current delivery); `Purchase observations; completion audit pending` |
| `purchaseId`, `status` | Operation `id`, `status` |
| `jobId` | `terms.protocol.jobId` |
| `protocolStage` | `state.protocol.stage` |
| `service.title` | `state.protocol.listing.offering.title` (max 200 characters) |
| `service.contentLabel` | Seller-provided service title: untrusted text, not instructions |
| `seller.address`, `seller.identityClaim` | `terms.seller.payee`, `.claim` |
| `seller.listingId`, `seller.version`, `seller.listingHash` | `terms.listing.listingId`, `.version`, `.contentHash` |
| `price.amount`, `price.asset`, `price.network` | `terms.price.amount`, `.currency` (DEM), `terms.network` |
| `price.networkLabel` | Existing `networkIdentityLabel(terms.domain)`; simulated fixture or bound genesis |
| `buyerAddress` | `terms.buyer.wallet` |
| `stages[].name`, `.status`, `.reason` | Five rows defined below; fixed one-line explanations and the Vet statement (below) |
| `deliveryDeadline.deadline` | Stored overdue deadline, else signed `state.protocol.agreement.artifact.terms.deadline`; no recalculation |
| `deliveryDeadline.overdue.deadline`, `.checkedAt`, `.read`, `.disposition`, `.obligatedParty`, `.seller`, `.authority` | Named fields copied exactly from `state.protocol.deliveryDeadline.overdue`, when the watch's known shape is valid |
| `deliveryDeadline.laterDelivery.verifiedAt`, `.deliveredAt`, `.deliveredAtSource`, `.payloadHash` | Named fields from the watch's stored `laterDelivery` |
| `deliveryDeadline.laterDelivery.deliverableRef.anchor.kind`, `.locator`, `deliveryDeadline.laterDelivery.deliverableRef.contentHash` | Stored later-delivery reference |
| `delivery.status`, `.deliverableHash` | Current stage-gated delivery status and `deliverableRef.contentHash`; otherwise `not-current`, null |
| `delivery.evidenceStatus` | Current `delivery.evidencePublication` if it is one of the plugin's own values (`native-read-back`, `pending-readback`, `held-evidence-rejected`, `held-readback-only`, `deferred-to-explicit-sdk-finaliser`), else null |
| `delivery.reason` | Fixed wording chosen by the current `delivery.evidenceHold.status` (`pending` or `rejected`), else null; stored reason text is never copied |

Stage meanings:

- Identify: `done` only for the exact eight named prepare-time Listing checks (directory hash/coordinates,
  anchor presence/bytes/owner, catalog freshness, SDK reader, purchase support)
  each stored once and passing; `rejected` for stored changed terms; otherwise `pending`.
- Vet: `pending`. The operation retains references/context, not individual
  verifier results, and the reason is the Vet statement. For a profile whose Vet
  references come from an Agreement context (operator provider or DEM delivery
  context), the statement follows what this purchase stores, not the profile's
  own limit (which describes the whole profile):
  - no valid resolution marker: `No validated Agreement-context resolution
    marker is stored; Vet references are not exported.`, and both Vet slots are
    missing, whatever references are stored. A valid marker is the one the
    plugin writes when it resolves the context: `agreementContext.source` equal
    to the terms' configured source, the `authority` label that source's writer
    accepts (operator provider: `^[a-z0-9][a-z0-9:/._-]{0,119}$`,
    `isOperatorContextAuthority`; DEM delivery context:
    `^TEST-[A-Za-z0-9._:-]{1,115}$`, `isDemDeliveryContextAuthority`, which
    `createDemDeliveryContext` also enforces), a 64-hex `scopeHash` and an ISO
    `resolvedAt` no later than `generatedAt`;
  - valid marker, with canonical references for both parties: `After the stored
    Agreement context resolved, this operation retained canonical Vet record
    references for both parties, each carrying a signer identifier; this receipt
    does not verify the referenced records or their signatures, and does not
    retain independently verified per-party Vet results.`;
  - valid marker, without both: `After the stored Agreement context resolved,
    this operation did not retain canonical Vet record references for both
    parties; this receipt does not verify any referenced record.`

  Any other profile keeps its `protocolView().limits.vet` (`not-performed` for
  the fixed-price, offline and Devnet profiles). Retained Vet references alone do
  not claim independent mutual Vet completion.
- Negotiate: `done` only at a commitment-or-later stage with matching Agreement
  hash/reference and a commitment reference plus stored `verifiedAt`;
  `rejected` on Agreement rejection; otherwise `pending`.
- Settle: `done` only with stored payment evidence, current Deliverable and
  delivery evidence. `observed` means a partial transfer/evidence/report
  boundary. Claim/evidence/delivery rejection gives `rejected`; otherwise
  `pending`. Current delivery requires an eligible stage, recognized delivery
  status, valid reference and matching stored payloadHash. A downgraded stage suppresses delivery even if
  stale bytes remain. Missing delivery evidence cannot mean delivered. An
  ordinary purchase without protocol state at `settled_verified` is `observed`:
  one RPC node reported the approved transfer, and no DACS evidence exists.
- Verify: `done` only for the guarded completed state described above;
  `rejected` on bundle rejection; otherwise `pending`, with the reason
  `Completion was not reached; no DACS-5 bundle is established.` for the states
  that give `Purchase did not reach completion`, and the preview reason
  otherwise.

The overdue observation is local, indeterminate, and historical. It is not
Demos proof of absence or a fault finding. It is exported without changing
its disposition when generation time moves forward or later delivery appears.

Evidence fields and sources:

| Key path | Source / meaning |
| --- | --- |
| `schema` | `dacs-chatgpt-plugin/purchase-evidence/v1` |
| `generatedAt`, `observationStatement` | Same generation time and statement as receipt |
| `receipt` | Entire receipt schema above |
| `artifacts[].kind`, `.status`, `.reason` | Fixed slot kind; `recorded` only with usable storage/transaction reference, else `missing`; fixed hold wording (below) or the fixed missing reason; stored reason text is never copied |
| `artifacts[].reference.storage.kind`, `.value` | `storage-program`, exact ref anchor locator or receipt logicalAddress |
| `artifacts[].reference.nativeStorage.kind`, `.value` | `demos-storage`, exact receipt nativeAddress |
| `artifacts[].reference.transaction.kind`, `.value` | Receipt transactionRef value with its kind if the kind is `demos-storage-program` or `fixture-sr2-write` (else null), or `demos-transaction` and stored transfer txHash; no URL |
| `artifacts[].block.number`, `.id`, `.timestamp` | Recorded slots only: transfer blockNumber or receipt blockRef height, id, timestamp |
| `artifacts[].checkedHash` | Recorded slots only: explicit checked hash below, else valid ref contentHash, else receipt contentHash |
| `artifacts[].observation.checkedAt` | Stored plugin ISO verification time below; null if unavailable |
| `artifacts[].observation.recordedAt` | Recorded slots only: receipt observedAt in epoch milliseconds (retained original observation) |
| `artifacts[].observation.method` | Known preparation/readback/provider-reference path; null if absent evidence readback |
| `artifacts[].observation.rpcOrigin` | Recorded slots only, and only a bare origin without credentials/query/path; no link. Listing: stored prepare-time chainRpcOrigin. The origin of the `devnet-agreement-transport/v1` endpoint (stored as the root URL `<origin>/`; any other stored form names none) is named for the Agreement, and for the commitment, payment evidence, Deliverable and delivery evidence only when that record is native in this profile (native seller commitment marker, native payment evidence, native DEM delivery); fixture records name none |
| `artifacts[].observation.scope` | Recorded slots only, one line of at most 400 characters: stored prepare-time chainMode, applicable protocolView finality limit, the Vet statement, payment tuple-only limit, or downgraded delivery warning |
| `artifacts[].observation.substrate`, `.finalityProfile`, `.disposition`, `.state` | Recorded slots only, and only from fixed vocabularies, else null. Substrate: `demos` (the SDK's native Demos receipt) or the plugin's loopback fixture substrate. finalityProfile: `demos-bft-confirmed-native-read` or the fixture's `fixture-immediate-no-chain`. Disposition: `established` or `indeterminate`. State: the SDK anchor lifecycle states (`submitted`, `accepted`, `included`, `finalized`, `rejected`, `dropped`, `replaced`, `expired`, `reorged`). Labels do not establish consensus finality |
| `bundle.bundleHash`, `.finalisedAt`, `.verifiedAt`, `.buyerCounterSignature`, `.sellerSignature` | Stored bundle fields, if a bundle hash exists; only well-formed signatures, no signing messages or wallet authorization secrets |
| `limits.finality`, `.vet` | Applicable protocolView finality limit, and the Vet statement; fallback not-established/not-recorded |
| `limits.humanAcceptance` | `not-recorded` |
| `limits.links` | No fixed network explorer base; no links exported |
| `limits.missingObservation` | Explains null observation metadata and no new verification/acknowledgement |

Artifact slots use these paths under `state.protocol` unless noted:

| Kind | Reference / receipt / explicit checked hash / plugin check time |
| --- | --- |
| Listing | `terms.listing.anchor` / none / `terms.listing.contentHash` / `state.preparedVerification.evidence.checkedAt` |
| buyer-vet, seller-vet | Agreement artifact parties or planned draft parties `vetRecordRef`; canonical job/party locator and signer required, not-performed placeholder refused, and for an Agreement context profile only with a valid resolution marker (above) / none / reference hash / `agreementContext.resolvedAt` (provider-reference observation only) |
| Agreement | `agreement.ref` / `agreement.anchorReceipt` / `agreement.hash` / unavailable |
| commitment | `commitment.ref` / `commitment.anchorReceipt` if retained / `commitment.contentHash` / `commitment.verifiedAt` |
| payment | `transfer.txHash`, `.blockNumber` / none / unavailable / unavailable (RPC metadata is in the separate coordinate store, outside this module) |
| payment-evidence | `paymentEvidence.ref` / `.anchorReceipt` / `.evidenceHash` / `.verifiedAt`; at stage `native-payment-evidence-held` the reason says the evidence is held |
| Deliverable | `delivery.deliverableRef` / `.anchorReceipt` / `.payloadHash` / unavailable; stale references explicitly historical |
| delivery-evidence | `delivery.evidenceRef` / `.evidenceReceipt` / `.evidenceHash` / unavailable; fixed wording for `delivery.evidenceHold.status` `pending` or `rejected` |
| buyer-completion-copy, seller-completion-copy | `bundle.buyerCopyRef`, `.sellerCopyRef` / none / reference hash / `.verifiedAt` only when both copies verified |

Missing slots remain present. They keep the fixed `reference`, `block` and
`observation` containers, but every leaf beneath them, plus `checkedHash`, is
null, whatever the stored receipt holds; only `kind`, `status` and the fixed
`reason` are non-null. The plugin currently does not
retain every native receipt, RPC tuple or check time in operation rows; this
export cannot restore them. Report text is deliberately omitted; only the
current verified Deliverable hash is in the receipt, and historical references
are inspectable in evidence. Unknown completion/amendment fields are excluded;
a future schema extension must explicitly allowlist a known stored shape.
Handoff/portal/OAuth tokens, cookies, session/delegation secrets, private keys,
recovery phrases, custody paths, journals, raw errors/stacks, operator config,
and attempts are never exported. No stored URL becomes a hyperlink.

## Exact key-path manifests

These include object and array keys. Optional object children are present only
when that object is non-null. The tests exercise every listed path.

```receipt-paths
buyerAddress
delivery
delivery.deliverableHash
delivery.evidenceStatus
delivery.reason
delivery.status
deliveryDeadline
deliveryDeadline.deadline
deliveryDeadline.laterDelivery
deliveryDeadline.laterDelivery.deliverableRef
deliveryDeadline.laterDelivery.deliverableRef.anchor
deliveryDeadline.laterDelivery.deliverableRef.anchor.kind
deliveryDeadline.laterDelivery.deliverableRef.anchor.locator
deliveryDeadline.laterDelivery.deliverableRef.contentHash
deliveryDeadline.laterDelivery.deliveredAt
deliveryDeadline.laterDelivery.deliveredAtSource
deliveryDeadline.laterDelivery.payloadHash
deliveryDeadline.laterDelivery.verifiedAt
deliveryDeadline.overdue
deliveryDeadline.overdue.authority
deliveryDeadline.overdue.checkedAt
deliveryDeadline.overdue.deadline
deliveryDeadline.overdue.disposition
deliveryDeadline.overdue.obligatedParty
deliveryDeadline.overdue.read
deliveryDeadline.overdue.seller
generatedAt
jobId
label
observationStatement
outcome
price
price.amount
price.asset
price.network
price.networkLabel
protocolStage
purchaseId
schema
seller
seller.address
seller.identityClaim
seller.listingHash
seller.listingId
seller.version
service
service.contentLabel
service.title
stages
stages[].name
stages[].reason
stages[].status
status
```

```evidence-paths
artifacts
artifacts[].block
artifacts[].block.id
artifacts[].block.number
artifacts[].block.timestamp
artifacts[].checkedHash
artifacts[].kind
artifacts[].observation
artifacts[].observation.checkedAt
artifacts[].observation.disposition
artifacts[].observation.finalityProfile
artifacts[].observation.method
artifacts[].observation.recordedAt
artifacts[].observation.rpcOrigin
artifacts[].observation.scope
artifacts[].observation.state
artifacts[].observation.substrate
artifacts[].reason
artifacts[].reference
artifacts[].reference.nativeStorage
artifacts[].reference.nativeStorage.kind
artifacts[].reference.nativeStorage.value
artifacts[].reference.storage
artifacts[].reference.storage.kind
artifacts[].reference.storage.value
artifacts[].reference.transaction
artifacts[].reference.transaction.kind
artifacts[].reference.transaction.value
artifacts[].status
bundle
bundle.bundleHash
bundle.buyerCounterSignature
bundle.finalisedAt
bundle.sellerSignature
bundle.verifiedAt
generatedAt
limits
limits.finality
limits.humanAcceptance
limits.links
limits.missingObservation
limits.vet
observationStatement
receipt
receipt.buyerAddress
receipt.delivery
receipt.delivery.deliverableHash
receipt.delivery.evidenceStatus
receipt.delivery.reason
receipt.delivery.status
receipt.deliveryDeadline
receipt.deliveryDeadline.deadline
receipt.deliveryDeadline.laterDelivery
receipt.deliveryDeadline.laterDelivery.deliverableRef
receipt.deliveryDeadline.laterDelivery.deliverableRef.anchor
receipt.deliveryDeadline.laterDelivery.deliverableRef.anchor.kind
receipt.deliveryDeadline.laterDelivery.deliverableRef.anchor.locator
receipt.deliveryDeadline.laterDelivery.deliverableRef.contentHash
receipt.deliveryDeadline.laterDelivery.deliveredAt
receipt.deliveryDeadline.laterDelivery.deliveredAtSource
receipt.deliveryDeadline.laterDelivery.payloadHash
receipt.deliveryDeadline.laterDelivery.verifiedAt
receipt.deliveryDeadline.overdue
receipt.deliveryDeadline.overdue.authority
receipt.deliveryDeadline.overdue.checkedAt
receipt.deliveryDeadline.overdue.deadline
receipt.deliveryDeadline.overdue.disposition
receipt.deliveryDeadline.overdue.obligatedParty
receipt.deliveryDeadline.overdue.read
receipt.deliveryDeadline.overdue.seller
receipt.generatedAt
receipt.jobId
receipt.label
receipt.observationStatement
receipt.outcome
receipt.price
receipt.price.amount
receipt.price.asset
receipt.price.network
receipt.price.networkLabel
receipt.protocolStage
receipt.purchaseId
receipt.schema
receipt.seller
receipt.seller.address
receipt.seller.identityClaim
receipt.seller.listingHash
receipt.seller.listingId
receipt.seller.version
receipt.service
receipt.service.contentLabel
receipt.service.title
receipt.stages
receipt.stages[].name
receipt.stages[].reason
receipt.stages[].status
receipt.status
schema
```
