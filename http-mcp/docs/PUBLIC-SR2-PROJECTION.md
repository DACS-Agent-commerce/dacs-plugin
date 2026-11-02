# Public SR-2 CREATE projection consumer

This is an explicitly enabled offline consumer of the buyer's public signed
Agreement CREATE. It runs on marked literal-loopback simulated fixtures and
stops at `seller-committed`, with purchase status `agreement_pending`. Payment,
claims, Vet, delivery and strict finalization remain held. Fixture inclusion is
simulated evidence; it does not establish consensus or live verification.

Configure the existing buyer capability as
`dacsProtocol.sellerSr2Commitment = { commitmentSubstrate: "fixture", publicProjection: true }`.
The prepared purchase terms bind `sellerAgreementProjection: "public-signed-create"`.
The old `{ commitmentSubstrate: "fixture" }` configuration, omitted capability,
legacy commitment client body `{ jobId }`, fixture seller and Agreement-only
hold keep their existing behavior. This adds no public route or new execution
profile. The application continues to use legacy loopback seller HTTP; the
existing authenticated client/handler is tested separately.

The actual OAuth/MCP `prepare_purchase` and portal Agreement signing path uses
the built-in packaged wallet via the existing browser broker. After the exact
wallet approval creates and natively reads the two-party signed Agreement,
`continueSellerSr2Commitment` selects the matching verified public
`sr2/adapter/` journal record. It exports only `authorizedTransaction`, preserving
its JSON key order, signature and hash. The original receipt binds the
transaction reference and compact signed-transaction proof hash. No plan,
approval flag, wallet lane, key or signing callback is transported. The buyer
operation retains those public signed bytes for subsequent reconciliation.

`createSellerAgentClient.commit(jobId, { signedProjection })` places the complete
optional projection in the existing `/dacs/v1/commitments` body. If authentication
is configured, the existing body hash and peer signature bind the full body.
Authentication and durable intent reservation are unchanged; unsigned or
ambiguous answers retain the existing unavailable/no-resend outcome.

The seller passes the projection and contributed Agreement hash to
`createSellerSr2AgreementAnchor.readAgreement`. Adapter `read` and
`verifyReceipt` treat the supplied projection as untrusted data. They require
its raw signed content to hash to the exact native transaction reference,
verify its Ed25519 signature for the independently expected buyer, compare it
to the executed SDK projection with the pinned helper, then establish fresh
native address/owner/logical name/metadata/artifact-kind bindings and marked
fixture transaction/block inclusion. The consumer binds Agreement SDK
contentHash and verifies its generated receipt against those fresh facts. The
adapter populates no third-party writer plan or journal. Existing retained
writer checks still apply whenever writer state is actually present.

Only after native verification does the seller retain the public projection
in its existing authenticated durable session, before a commitment effect.
Seller restart can reauthenticate it with fresh observations; unavailable
readback still yields HTTP 503. The commitment remains the exact SDK-derived,
seller-signed fixture FinalityCommitmentRecord. The buyer independently reads
and verifies it with `readCommitment`; an HTTP answer alone is not acceptance.
Authenticated transport reconciliation after a lost acknowledgement consumes
the supplied/retained public projection and fresh native/commitment readback
without invoking a signer or submitter.

Current accepting tests are `public-sr2-projection.test.mjs` and
`public-sr2-projection.browser.test.mjs`. They use the realistic normalizing
RPC directly (string executed nonce and changed executed-content hash), the
actual broker/portal/MCP/seller HTTP, one buyer CREATE, one commitment effect,
durable seller restart and held payment. Chrome uses trusted UI approvals and
the existing `DACS_TEST_CHROME` helper; no browser download is performed.
The authenticated consumer test uses the actual seller and packaged buyer
signature through the existing authenticated client/handler, with normal
proposal admission and a lost acknowledgement followed by read-only restart
reconciliation. It does not claim the application currently configures that
authenticated client. The original idealized/realistic-gap witnesses remain
in `seller-sr2-agreement*.test.mjs`.

This is ordinary source functional evidence. The external security review is on hold.
Broader historical failures/skips and a known denial-expiry issue remain open;
these selective functional results do not supersede them. No live transaction,
deployment, plugin installation, release or v0.1 acceptance is established.
