# Seller SR-2 Agreement consumer (offline, simulated)

The original observations below are retained as historical evidence for the
legacy capability `{ commitmentSubstrate: "fixture" }`, which still exhibits
the realistic-node missing-projection gap. The explicitly enabled
`{ commitmentSubstrate: "fixture", publicProjection: true }` consumer now
conveys and verifies the public signed CREATE; see
[`PUBLIC-SR2-PROJECTION.md`](PUBLIC-SR2-PROJECTION.md) for the current repaired
accepting path and its separate limitations. The old idealized control and
realistic-gap tests remain unchanged.

Ordinary implementation evidence; not a security review, not v0.1 acceptance,
no live or Devnet transaction. The external security review is on hold. Node2's observed identity
`83082fbb…7dd4` stays OBSERVED_ONLY_NOT_TRUSTED_PIN and is not used.

## What changed

| File | Change |
| --- | --- |
| `src/dacs/seller-sr2-agreement-consumer.mjs` (new) | `createSellerSr2AgreementAnchor({ rpcUrl })` builds the existing `createDemosSr2Adapter` over a seller-private read-only journal and exposes `readAgreement({ logicalAddress, writer })`: adapter `read(..., { expectedWriter, expectedArtifactKind: 'Agreement' })`, receipt bound to the artifact's SDK contentHash, then adapter `verifyReceipt(...) === 'valid'`. Returns `present` (artifact, SDK-shaped ref `{ anchor: storage-program/<logical>, contentHash }`, `native` = source, evidence mode, native address, tx ref, receipt), `absent`, `indeterminate` (adapter `indeterminate`) or `rejected`. Also `sellerSr2CommitmentConfig` (buyer capability `{ commitmentSubstrate: "fixture" }`) and the marker. |
| `src/dacs/seller-agent.mjs` | Optional `agreementAnchor` capability on `createSellerAgent`. `commit` (and the durable `reconcileTransport` commitment readback) read the buyer Agreement through it when configured; otherwise the fixture read is unchanged. The commitment is still `commitFixedPriceAgreement` over the exact read artifact (same contentHash check, same signer, same fixture-substrate FinalityCommitmentRecord). `session.agreementRef` is the read's ref; `session.agreementAnchor` and the commit answer name the native record. |
| `src/dacs/protocol-purchases.mjs` | Optional `dacsProtocol.sellerSr2Commitment`. Wallet Agreement purchases prepared with it carry `terms.protocol.sellerCommitment`; after the native Agreement anchors the buyer requests the seller commit and reads the commitment back (`readCommitment`, fixture substrate). On `verified` the stage becomes `seller-committed`; status stays `agreement_pending`, `assertAgreementPaymentHeld` still refuses payment. Limits name the native Agreement and the fixture commitment explicitly. Without the capability nothing changes. |

`app.mjs` passes `dacsProtocol` through, so the buyer capability is consumed by
the actual app. The seller capability is consumed by the actual
`createSellerAgent` behind the existing `createSellerHttpHandler`; the plugin
does not run a seller, so wiring it into a deployed seller is operator work.

## Exact remaining gap (realistic node model)

The agreement chain fixture returns the executed transaction with
wire-normalized fields (string `nonce`, `timestamp`, amounts). The SR-2 adapter
authenticates a CREATE as a third party by requiring
`sha256(JSON.stringify(executedContent)) === txHash` plus the signature; only
when it holds the writer's retained signed projection (`authorizedTransaction`,
embedded path) does it compare that projection with the executed content.
A seller holds no such projection, so the adapter rejects the buyer's genuine
packaged-wallet CREATE with `invalid: transaction lacks the exact writer
authorization`; the seller answers `agreement_anchor_invalid` and the buyer stays
`agreement-anchored` (payment held). Seeding the seller's adapter journal with a
fabricated retained plan would forge adapter state and is not done.

Minimal upstream contract (outside this ownership):

1. `demos-sr2-adapter.mjs`: a read-only third-party verify entry, e.g.
   `read(logicalAddress, { expectedWriter, signedProjection })`, that runs the
   existing embedded checks (`demosTransactionContentMatches`, signature over the
   hash, native/inclusion binding) with a caller-supplied public signed
   transaction instead of a retained plan, and persists nothing.
2. A buyer→seller channel for that public signed projection: e.g. a
   `seller-http.mjs` client/route field on `/dacs/v1/commitments` (bound by the
   authenticated transport), or a published record the seller can read.
3. Then `createSellerSr2AgreementAnchor` passes the projection through; no other
   change in this slice is needed.

## Accepting control (idealized seller view)

`exactContentNode: true` in the test harness gives the SELLER ONLY an RPC view
whose `getTxByHash` returns the transaction exactly as signed (standing in for
contract 1+2); the buyer and plugin keep the realistic node. There the unchanged
adapter `read`/`verifyReceipt` return `present`/`valid`, the seller commits, the
buyer reads the commitment back and stops at `seller-committed` with payment held.

## Tests

- `test/seller-sr2-agreement.test.mjs`: accepting control (idealized seller view);
  durable seller restart (explicit host SKIP, see below); exact gap on the realistic
  node with a witness that executed content no longer hashes to the signed hash;
  direct consumer absent/indeterminate/malformed; seller 503 on unavailable chain;
  default seller compatibility; no-capability compatibility; capability shape.
- `test/seller-sr2-agreement.browser.test.mjs`: Chrome trusted approvals, one CREATE,
  seller commit from the native read, portal at `seller-committed`, payment held.

Host finding: the pinned SDK private store refuses durable seller state when an
ancestor of the temp directory is group/world-writable
(`filesystem fenced session store path component is group/world writable:
<temp directory>`). This is likely the cause of the historical
`dacs-seller-recovery` 14 failures on that host.

## Held

Payment, claims, DACS-4/5, strict finality, Vet, live network, node2 identity.
The external security review is on hold. The commitment record is fixture-substrate only.
