> The demo launchers are retired in v2 and refuse startup. CLI signal examples below are historical v1 behavior. Programmatic shutdown uses `operator.close()`; recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})`.

# Seller policy approval and delivery evidence (both off by default)

The built-in Node2 operator has two separate seller switches. Both are off unless the operator config names them:

```json
{
  "sellerApproval": { "mode": "policy" },
  "sellerDeliveryEvidence": { "enabled": true }
}
```

With neither field, every seller CREATE needs `APPROVE <hash>` in the controlling TTY, and a purchase ends at `delivery-ready`. Turn policy mode on only after the L5 abuse limits have landed.

## What policy mode changes

Policy mode replaces the TTY decision for a purchase's seller CREATEs (vet records, commitment, payment evidence, Deliverable and, if enabled, delivery evidence) with a code decision in `src/devnet-demo/operator-approval.mjs`. The Listing CREATE at startup still needs manual `APPROVE <hash>`.

Policy mode does **not** change the source `transportBinding`. The operator passes the delivery-evidence switch and a policy completion callback to the source transport (`src/devnet-demo/operator.mjs:168`). The callback does not change the binding. The next section covers the binding change that switch causes.

The same policy function checks the declared debit against the existing cap
in `prepare`, before signing, then rechecks at `confirmTx`. The counted amount
is `max(declared totalOs, confirmed sender storage/gas removals)`, in exact
integer OS. It supplies both the cap decision and hourly accounting. L4's
2026-10-07 Node2 run declared 4 DEM per seller CREATE: storage 1, SDK gas 1,
network 1 and RPC 1. Source at node `61b8e75` suggests storage CREATEs debit
only their storage/gas removals (separate `transaction_fee` distribution is
native-only), but no live balance change established that reading. Until a
live balance change settles the discrepancy, count the larger of the two.

Legacy whole DEM numbers and canonical OS strings are converted exactly;
missing/malformed fee data refuses confirmation. SDK gas need not equal 1 DEM.
A prepared decision is consumed once. Policy cancellation and budgets are
checked again at confirmation. Successful policy preparation creates no
approved ledger entry; final evidence retains the confirmation, declared total,
confirmed removals and counted total. Manual approvals keep their existing
budget exemptions and count once; confirmation annotates their prior approval.

A request is approved only if all of these hold (`policyRefusal`, `budgetRefusal`):

- It is the exact seller CREATE request shape, for this seller wallet, source binding and chain identity, with seller amount 0.
- Its complete debit is within both `sellerFeeBudget.maxTotalOs` and `sellerApproval.maxWriteTotalOs`.
- Its CREATE bytes, storage fee, logical address and metadata match the artifact.
- It is for an existing purchase of the current Listing pin, with the same Agreement hash and Deliverable binding.
- The amounts match the purchase price exactly: the Deliverable binding's `purchaseAmount`, and the payment evidence's `paymentAmount`.
- The purchase stage allows that kind:
  - payment and delivery SettlementEvidence and the Deliverable only once the app has verified the buyer's payment for that job (`settled_verified`);
  - vet records and the FinalityCommitmentRecord only before that, and only while the purchase is still open: `agreement_pending` or `awaiting_approval`, with its approval window not yet elapsed. A cancelled, expired or otherwise ended purchase gets no more seller writes.
- A vet record's `evaluatedParty` is the purchase's buyer or the seller itself.
- The job has had fewer than 6 approved attempts that were sent or are still outstanding.
- The hourly budget across all jobs has room for the complete fee-inclusive debit, before or after payment.

### Limits (all optional fields of `sellerApproval`)

| Field | Default | Meaning |
| --- | --- | --- |
| `maxWriteTotalOs` | `"4000000000"` (4 DEM) | Cap on one write's counted debit. L4 declared 4 DEM per CREATE on 2026-10-07 (storage 1, SDK gas 1, network 1, RPC 1). Until a live balance change settles the source reading, count the larger of the declaration and confirmed removals. Raise the cap if node fees rise, or every write is refused. |
| `maxWritesPerHour` | `24` | Prepared and outstanding policy attempts plus attempts completed in the last rolling hour, across all jobs. |
| `maxTotalOsPerHour` | `"96000000000"` (96 DEM) | Declared ceilings of prepared attempts plus counted debits of outstanding policy attempts and those completed in the last rolling hour, across all jobs. |

The hourly budget is about four complete six-write purchases. An accepted preparation holds its declared debit and one job slot in memory, shared by approval instances using the same evidence path. It writes no ledger line. Decisions and hold changes on that path are serialized within the operator process. A matching confirmation converts its own hold into the single ledger reservation without competing for budget or counting twice; the fee rule still refuses confirmed removals above the declaration. Provisional holds are dropped when confirmation refuses, when the next wallet approval replaces the preparation, or when the wallet releases an attempt before confirmation. These holds do not age out while the process runs and are not persisted; before confirmation no broadcast is authorized. Outstanding ledger reservations never age out. Once inclusion is verified or the broadcast receives a definite refusal, the full fee allowance counts for one rolling hour from that completion, regardless of success. An attempt approved in one hour and completed in the next therefore consumes the next hour's budget. Unknown outcomes and accepted broadcasts without verified inclusion stay held, including across restarts; no automatic release or recovery of those holds is provided.

The packaged operator wallet releases a reservation only when it proves issuance never started. Its read-only nonce, network, source-binding and confirmation checks therefore run while the provisional or ledger reservation is still releasable; a rejection by those checks consumes neither the hourly budget nor the per-job quota. The existing durable `broadcast-started` marker makes an attempt non-releasable before any broadcast. A persistence failure at that marker conservatively keeps the hold.

If completion evidence cannot be recorded, the reservation stays held, even for an unsent refusal. The wallet's original response (including its hash and write proof), or its original thrown error, still reaches the caller. The operator reports the evidence failure on stderr through the existing `devnet-operator-approval-error` channel, regardless of `DACS_TEST_TRACE`.

The purchase is read again at the decision itself. After the budget check reads the ledger, the operator re-reads the purchase synchronously; if a write before payment is no longer open (cancelled, expired or paid), the request is refused with `purchase-closed`. The evidence line is then written, and the answer returned, with nothing awaited in between, so the line always records the final decision. A cancellation during signing is checked again when the policy completes at confirmation; after that decision, it cannot recall a broadcast.

A pre-payment policy refusal is final for that artifact: the wallet journals it as denied, and the artifact is only ever read back after that. After payment, a policy refusal goes to exact manual approval before the wallet decides whether to deny the artifact.

The checks before signing (declared fee cap, debit shape, per-job limit of 6, hourly budget, purchase lookup) still apply after payment. When one of them refuses a payment-evidence, delivery-evidence or Deliverable write, the request goes to the same exact manual approval as manual mode (`APPROVE <hash>` in the TTY, or the authorize callback) instead of being refused (`composeSellerApproval` in `src/devnet-demo/operator-approval.mjs`). The operator can still decline. A refusal before payment (vet records, commitment) stands and never prompts. So policy mode never approves more than manual review would. For example, a Deliverable over 10,240 bytes declaring 5 DEM goes to manual approval before signing; approved, it may broadcast up to that exact declared total even though the policy cap is 4 DEM. Declined, nothing is signed. Before payment, an over-cap declaration is refused in preparation. Confirmation refuses a counted debit above the declaration (or missing/malformed fee data) before broadcast, without another manual override.

### Approval evidence

Every decision appends one line to `stateDirectory/evidence/seller-approvals.jsonl`.

- **Manual approval lines** keep the format `dacs-node2-operator-approval-evidence/v1` with `approvalHash`, `requestBytes`, `method`, `address`, `totalOs`, `decision` and `recordedAt`.
- **Policy lines** add `approvalMode: "policy"`, `policyReason` and a unique `reservationId`. Approved and refused lines have the same base keys; `policyReason` is `null` when approved. Decisions completed at confirmation also retain `confirmation`, `declaredTotalOs`, `confirmedRemovalsOs`, and `countedTotalOs`; `totalOs` equals the counted total. A manually approved confirmation carries `manualApproved: true` without policy fields and annotates the prior manual line, so it does not count as a second write.
- **Attempt completion lines** use `dacs-node2-seller-policy-attempt/v1`, with the original `reservationId` and `approvalHash`, `outcome` (`spent` or `released`) and `recordedAt`. Unknown attempts have no completion line and remain held. Unmatched, duplicate or malformed completion lines fail closed. Older approved policy decisions without a reservation/completion record conservatively remain held; their approval time cannot prove completion. Manual decisions keep their original shape and do not consume the automatic hourly budget.
- **Refusal reasons:**
  - `operator-fee-budget`, `request-shape`, `debit`, `write-fee-cap`, `create-bytes`;
  - `purchase`, `payment-not-observed`, `payment-already-observed`, `purchase-closed`, `payment-amount`, `evaluated-party`;
  - `logical-address`, `listing`, `agreement`, `delivery-binding`;
  - `job-write-limit`, `hourly-write-limit`, `hourly-dem-limit`;
  - `evidence-unreadable`, `policy-check-failed`.
- **Older lines without `requestBytes`.** These are manual lines written before request bytes were retained. The policy reader accepts them and counts them towards neither limit. A line without `requestBytes` that claims policy mode, and any other malformed line, refuses the request (`evidence-unreadable`).

## What delivery evidence changes

After the seller's Deliverable verifies on fresh readback, the seller publishes the SDK's exact signed delivery SettlementEvidence at `dacs4:evidence:<job>`. The buyer reads and verifies it independently.

- While the evidence is not yet readable, or does not verify, the buyer stays at `delivery-ready`. The report stays visible, and `delivery.evidenceHold` says whether the evidence is pending or rejected, and why.
- The buyer moves to `delivered` only once the evidence reads back and verifies.
- DACS-5 bundle finalization and the buyer counter-signature stay deferred.

### It changes the source transportBinding

Enabling it adds `SettlementEvidence` to `transportBinding.demoArtifactPublication.artifactKinds` (`src/devnet-demo/operator-network.mjs:224`). `bindingId` and every other binding field stay the same; a test checks this.

Every seller CREATE embeds the whole binding in `metadata.networkBinding` (`src/devnet-demo/artifact-anchor.mjs:165`). The reader rejects a record whose binding differs from the current one (`src/dacs/demos-sr2-adapter.mjs:282`), and purchase terms are matched on the whole binding (`src/dacs/protocol-purchases.mjs:241`).

From reading the code (**not run**), switching it on or off over an existing state directory means:

- records written under the old setting, including the published Listing, no longer read back, so the startup Listing readback fails (it does not resend);
- purchases created under the old setting no longer match this source's terms.

Treat the switch as a binding change: make it with no purchases in flight, and expect to publish a new Listing.

### Why the evidence is published outside the SDK hooks

The SDK's evidence hooks (`anchorEvidence`, `resolveEvidence`, `reconcileEvidencePublication`) run only inside `advanceDeliveryFinalisation` and `resumeDeliveryFinalisation`. Those functions publish the evidence and then go on to close the final session receipt (`publishFinalSessionReceipt`).

This profile defers that closure by design: the seller's `publishFinalSessionReceipt` returns `indeterminate` (`src/dacs/seller-agent.mjs:742`). The seller's evidence hooks also write to the loopback fixture anchors, and the Node2 demo passes a fixture that refuses all reads and writes (`src/devnet-demo/composition.mjs`).

Routing the evidence through the hooks would need two changes:

- invoking the SDK finaliser for every job, which would leave its write-ahead log parked at an unimplemented final-receipt step;
- rewiring three hooks to the native anchor.

That is not a small, safe change, so it was not made.

Instead, `finishDeliveryEvidence` (`src/dacs/seller-agent.mjs:971`) takes the signed evidence that `runDurableFulfilmentToDeliveryReady` retained. It checks that evidence against the verified Deliverable and the SDK verifier, then publishes it through the same native artifact anchor every other seller CREATE uses.

**How the original transaction is kept on that path:**

1. **Checkpoint first.** The seller persists `deliveryEvidenceWork` (address and evidence hash) before the first publish (`seller-agent.mjs:987`).
2. **Intent before wallet.** The artifact anchor journals the CREATE intent before it asks the wallet. After that, it never asks the wallet to sign that address again, unless an operator shutdown ended the approval before anything was signed (stage `closing`, below). A durably accepted operator CREATE may re-send its identical retained bytes once, only after definite hash absence, an unchanged account nonce (with exact node RPC envelopes for identity, absence and confirmation, and pinned identity-block and ValidityData field sets, including all five success data fields with null gas_operation) and fresh confirmation with identical bytes and fees, the original wallet confirmation shape and no custom charges. The source journal reserves that attempt before dispatch, including across restart. Denied or ambiguous submissions stay readback-only (`src/devnet-demo/storage-write-recovery.mjs`, `src/wallet/devnet-native-transport.mjs`).
3. **Later passes read back.** They publish again only when the journal holds no intent for that address (`seller-agent.mjs:992`), which means the wallet was never asked, or holds one at stage `closing`, which means a shutdown ended its approval before anything was signed. `publish()` checks the journal again under the wallet lock.
   - The buyer's rechecks don't reach these passes: a held evidence answer is a completed seller transport effect, so the transport answers later rechecks from its cache. The operator therefore runs the seller's own `resume` for every purchase the app shows at `delivery-ready` with evidence `pending`, when the operator starts listening and then every 5 minutes (`resumeHeldDeliveryEvidence` in `src/devnet-demo/operator.mjs`). Once the evidence is on chain, the buyer's next recheck reads it back on its own and moves to `delivered`.
   - Shutdown is one shared operation: every listener close and every `operator.close()` waits for the same shutdown, and so does a second, different signal (SIGINT then SIGTERM). Shutdown refuses new app and seller requests (the app's wallet relay stays open for admitted work) and closes the directory listener at once. It starts no new pass and waits for one in flight before it closes the seller and app listeners, the seller agent or any journal, so a pass is never cut off between its readback and its write. A pass asked for after shutdown starts is refused (`operator_closing`); the held evidence is picked up at the next start. A close that starts while the listeners are starting waits for them and then closes them, and that `listen` fails with `operator_closing` instead of running. An operator listens once: a second `listen`, while the first is starting or while it runs, fails with `operator_already_listening`. A `listen` once shutdown has started, including after the owned stop, fails with `operator_closing`. Neither opens anything. To listen again, create a new operator.
   - A manual approval waiting inside that pass does not hold shutdown indefinitely: 15 seconds after `close()` starts it ends undecided (`operator_closing`), and the pass then ends (the approval deadline in `commit-on-signature.md`, "Operator shutdown and restart"). That cut is not an operator decision: no `rejected` line is recorded, and nothing is signed or sent for it. The evidence keeps its retained intent at stage `closing`, never `denied`, so the next start's pass asks the operator again; once approved, the evidence lands once and the purchase reaches `delivered`. A kill before the deadline (a SIGKILL) leaves that job's row in the `seller_locks` table of `seller-state.sqlite`: the next request for that job reclaims it once the row's holder lease shows the killed process has exited, and a row nothing can prove abandoned is released with `releaseAbandonedLock({ job, owner })` (same section).
   - Known gap: the buyer's reads and the seller's writes share one Node2 connection fence, and the fence refuses at once instead of waiting. A buyer recheck that lands while a pass holds the fence fails closed: the view drops from `delivered` (or `delivery-ready`) to `payment-evidenced` and hides the report until the next recheck reads it back. Nothing is resent and nothing is shown that was not read back. The fail-fast fence predates this work; the pass only makes the overlap more likely.
4. **Nonce lane.** The packaged wallet keeps its own nonce lane. A broadcast-started CREATE is released only after authenticated inclusion readback of that original hash. An identical re-send does not release the lane.

These tests in `test/seller-policy-delivery-evidence.test.mjs` cover it:

- a lost response is recovered by readback, with no second CREATE;
- an unknown broadcast outcome is never resent;
- a failure before sending is published exactly once.

If a DACS-5 finaliser is added later, its `anchorEvidence` hook must go through the same artifact anchor, with the same address and exact evidence. It then reads back the evidence already published instead of making a second CREATE.

## Not established

All of this was tested only on owned loopback fixtures; no live Node2 run used policy mode or delivery evidence.
