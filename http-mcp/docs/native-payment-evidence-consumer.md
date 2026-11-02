# Native payment evidence consumer — SOURCE/loopback only

The opt-in consumer now connects the actual buyer MCP/portal payment report and
`verify_deal` to the unchanged seller HTTP `/dacs/v1/payments` route. The seller
uses the pinned SDK `createPayDemSellerObserver`, `verifySellerPaymentIntake`,
`signComponentArtifact` and `verifySettlementEvidence`. Its signed artifact has
the genuine nine SettlementEvidence fields, no invented `artifactType`, payer,
phase-index or Agreement-hash signed fields. The canonical SDK payment address
binds job/rail/phase; the retained seller work additionally binds the exact
buyer, Listing pin, signed Agreement hash, commitment hash and native transfer.

Enablement requires an explicitly constructed
`createNativePaymentEvidenceConsumer({rpcUrl, anchorEvidence})` capability, not
Boolean consent, a model decision or a caller-supplied verified verdict. Buyer
configuration uses `dacsProtocol.nativePaymentEvidence`; seller configuration
uses `createSellerAgent({nativePaymentEvidence, ...})`. Both consume only the
owned literal `http://127.0.0.1` fixture origin. Only fresh prepared native
Agreement/payment terms receive the immutable capability marker. Default and
older prepared operations remain at `payment-observed`, without a seller claim.

The seller retains the exact SDK-signed artifact and an issued-once attempt in
its existing authenticated durable session before invoking the seller-owned
wallet boundary. Later calls/restarts perform native evidence readback only;
they never invoke that anchor callback again or resend payment. No fixture
DACS-4 receipt or historical fixture-delivery publisher is used by this branch.
Buyer acceptance requires fresh SR-2 read/receipt authentication, pinned SDK
signature/amount/tuple verification and a fresh observer matching the same
transfer, payer/payee, amount, block and inclusion time after commitment.

## Earlier executed outcome and current experimental repair

The earlier actual MCP/portal + packaged buyer wallet + seller HTTP + durable restart tests
reach valid SDK intake/signing. The current unchanged wallet bridge then refuses
`artifactKind:'SettlementEvidence'` with `invalid: explicit Agreement kind and
exact normative job address are required`. Native evidence remains absent and
the public result stays `native-payment-evidence-held`, `not-evidenced`,
`not-delivered`. The required delivered-outcome oracle is deliberately retained
outside shipped source and is red, not TODO/skipped or presented as acceptance.

The test boundary uses an actual packaged buyer wallet only to exercise this
pre-owner kind refusal. It does **not** establish seller wallet authority: that
wallet must never sign as the seller. A later accepting integration requires an
explicit seller wallet whose public account matches the Listing signer and
durable public signed-CREATE projection recovery. No genuine successful or
unknown-after-apply SettlementEvidence CREATE has been executed yet.
The native-payment unknown-after-apply case has been executed and never resends.

SDK intake emits `settlementFinality.model:'bft-final'` from one node's consistent
included/status/body/confirmed-block view. This exact SDK field is preserved;
it is **not** independent validator-quorum proof, authenticated live native
finality or permission to deliver. Listing admission, rail pin and seller
commitment remain explicitly fixture-backed. Vet, the consumed V2 fulfilment
audit/handoff, native deliverable publication, strict ST-11, DACS-5 completion and
human acceptance remain held. External seller intake/session eligibility,
network pins and all live paths are unchanged. Full v0.1 is not accepted.

## Minimal next integration, not a protocol rewrite

1. Compose an independently accepted explicit SettlementEvidence kind repair
   for the protected wallet bridge/provider without changing signed bytes.
2. Bind an explicit seller-owned wallet to the same Listing signer; retain and
   convey only its public exact signed CREATE for normalized native readback,
   including unknown-result/restart recovery. Never borrow buyer authority.
3. Execute genuine native payment-evidence CREATE/readback accepting and unknown
   controls through these consumers, requiring the same canonical tuple/time.
4. Obtain actual consumed V2 fulfilment/Vet-audit context and supported native
   deliverable/evidence publication before adding delivery. A signed SDK payment
   label alone cannot replace that context or independent finality authority.

No SDK/Standard modification, fabricated authority, live purchase, payment
resend, pin invention or completion-unhold is proposed here.

## Current consumed public projection implementation

The new copy mechanically imports the genuine nine-field SettlementEvidence
bridge/provider kind delta without altering signed bytes. Its test boundary now
uses a fresh RAM-only fixture operator and the unchanged packaged SELLER wallet
at the same seller address, never the buyer wallet. A separate synchronous signer
is derived only from newly generated TEST material shared in RAM via supported
wallet import. No browser/session secret is exported/read; no material is logged
or persisted. This does NOT prove a production noncustodial async-wallet to
synchronous authenticated-seller-store authority resolver.

The bridge's `demosEvidence.signedTransaction` is canonical proof text, NOT a
lossless projection of the SDK's original JSON.stringify(content) signing order.
Parsing/restringifying that text can invalidate the transaction's unchanged hash.
An explicitly scoped read-only public wallet-journal capability therefore recovers
the ORIGINAL signed CREATE, without changing content, hash or signature. Fresh
native authentication is required before the seller returns those exact public
bytes through HTTP; the buyer reauthenticates them independently. A receipt proof
hash cannot reconstruct them. Missing original projection remains held. Unknown
journal state is never rewritten to invented writer success or another send.
Only true native absence maps to absent; invalid/rejected and indeterminate/
unavailable retain their distinct native status/reason/code.

The focused Node checks now PASS 7/7: actual MCP/portal native payment, SDK intake
and seller signature, normal packaged SELLER-wallet CREATE, original public
projection and independent buyer readback; native-payment unknown after apply;
seller evidence CREATE unknown after apply with seller public-journal/app durable
restarts and no resend; default/old terms; constructed capability; distinct reader
states and actual absence/unavailability. The positive controls require exactly
one seller wallet CREATE approval/callback and retain the exact artifact/signature.
These are source assets exercised under Node, not a real Chrome UI/installed
package/live-chain claim. Current task-parent receipts retain the earlier red
Agreement prerequisite, wrong test relay URL and canonical-projection rejection;
none is erased or converted to a skip. Existing HTTP/SDK/nonce guards and timeouts
remain unchanged. A separate legacy process-restart proposal-publication failure
remains unresolved in affected checks. Delivery/Vet/ST11/finality/completion and
all live paths remain held; full v0.1 remains not accepted.
