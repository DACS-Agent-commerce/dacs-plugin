> The demo launchers are retired in v2 and refuse startup. CLI signal examples below are historical v1 behavior. Programmatic shutdown uses `operator.close()`; recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})`.

# Commitment on Agreement signature

`DACS_COMMIT_ON_SIGNATURE=on` overlaps the existing buyer Agreement CREATE
and seller FinalityCommitmentRecord CREATE. The default is `off`. The built-in
operator supplies the switch to both the app and seller composition; external
compositions must supply `commitOnSignature: true` to `createSellerAgent` (or
`createDevnetDemoComposition`) as well as enabling the app switch. Enabling
the seller option requires a `durableDirectory`; ephemeral sellers are
refused before any effect. The genuine native composition already requires
durable seller state.

After wallet approval, the browser broker durably journals the buyer's signed
Agreement CREATE before returning permission for the buyer wallet to broadcast.
Only then does it notify the signature path. The buyer sends the complete
Agreement and public signed CREATE on the authenticated
`/dacs/v1/commitments/signature` route. The seller registers that route, and the
buyer client exposes it, only when the switch is on; with it off the seller's
route table is main's and the path answers `404 not_found` before any
reservation. The seller reconstructs the Agreement
from its retained proposal and verified contributions, compares full canonical
bytes and content hash, and independently verifies the buyer's CREATE signature,
writer, native address, operation and exact Agreement envelope. A buyer-supplied
approval flag or transaction hash alone is insufficient. Signed transaction JSON
order is preserved through transport and restart because the native transaction
hash binds that order.

The buyer and seller keep their existing writers; the seller never broadcasts or
relays the buyer's transaction. The broker starts the seller request without
waiting for its answer, so both broadcasts can overlap before Agreement readback.
Both can reach the same block if they precede its boundary. This does not remove
wallet approval latency or guarantee block placement. An adapter without the
approved-CREATE notification uses the ordinary sequential path. After a buyer
process restart that loses the notification, recovery remains readback-only.

A signed CREATE proves authorization, not broadcast, inclusion, available funds
or a valid current nonce. To close that gap, the seller atomically reserves one
durable unresolved early-commitment slot per buyer wallet claim across all its
jobs. Reservation precedes commitment signing. Cancellation, expiry, account
changes and restart never release this slot. Only the seller's fresh authenticated
readback of that job's exact Agreement releases it, matched by job id, so a crash
between the reservation and the session save does not orphan it; there is no
time-based reset. A held slot refuses another job's early request definitely
(`409 seller_signature_buyer_unresolved`, no effect). An early request for an
already committed job only reads back and takes no slot.
Missing or indeterminate readback holds it indefinitely. This bounds loss from
unbroadcast Agreements to at most one early commitment CREATE per buyer wallet
per seller durable store (subject also to the existing global budgets and seller
fee cap). It can block a buyer whose authorized CREATE never lands.

New wallet keys can each consume one slot: this does not prevent Sybil attacks
or unpaid commitments after buyers actually pay for Agreement CREATEs. Main's
Listing, Vet and context publications are outside this new bound. A buyer
can still withhold a signed transaction, submit one with a stale nonce, insufficient
funds or another network, or never finish payment. Payment remains held in all
such cases. Independent current-network inclusion is established by the existing
readback gates, not by the early signature proof. Existing seller approval,
write-budget and fee-cap controls remain necessary. Destroying or replacing the
seller's durable state loses this bound, as it loses the existing recovery fences.

The built-in operator also binds early writes to its custody buyer claim when
`openBuyerAccess` is false, via the seller's `signatureBuyer` option. This check
is enforced on the seller, including direct peer requests; the app's refusal
alone is insufficient. Open mode retains its existing scoped delegation checks.
External compositions with restricted buyer admission must supply the trusted
`signatureBuyer` claim rather than relying on a buyer-side resolver.

## Operator shutdown and restart

With either switch state, `operator.close()`, the returned listener's
`running.close()` and the prepared composition's `close()` return the same
memoized shutdown promise. Programmatic callers use that owned shutdown primitive;
callers using the old `running.close() → application.close() → agent.close() →
prepared.close()` sequence get the same order. Application and seller-agent
resource closes are idempotent once attached to the operator.

Shutdown first refuses new MCP/app actions and seller requests and closes the
directory listener; it stops accepting seller connections when its request
drain starts, after a delivery-evidence resume pass in flight (below). The app
wallet relay remains available for admitted requests to finish their approved
work. It tracks each admitted app/seller request until its handler and response
have both ended.

- **Switch off:** admitted app and seller requests share one 10-second grace.
  After it, new connection reservations are refused and the source closes
  (below), which ends any seller inclusion wait. A seller CREATE that Node2
  already accepted is then never re-signed: the next start reads its retained
  hash back. If that readback shows it pending, the seller's resend recovery may resend the
  identical signed bytes once, only after proving the transaction absent and
  the nonce unconsumed ([SELLER-POLICY-AND-DELIVERY-EVIDENCE.md](SELLER-POLICY-AND-DELIVERY-EVIDENCE.md),
  "How the original transaction is kept"). Outside shutdown the switch-off connection owner
  still refuses contention as on main; it has no queue.
- **Switch on:** app requests have the existing 30-second grace. Admitted seller
  requests are awaited until they end, because one may be past its retained
  no-resend publication intent and still need its queued seller-wallet
  reservation; those stay granted after the app grace, while other waiting and
  new reservations are refused. Once every seller request has ended, all are
  refused.

An Agreement plan step that already answered 202 (`plan_in_progress`) keeps
running without its request, often waiting for the seller's Vet approval while
it holds a `seller-artifacts.sqlite` lane. It drains within the same grace as
the admitted requests. After the drain, shutdown cuts a manual seller approval
still waiting. A cut is not an operator decision: the approval ends with
`operator_closing`, the seller approval evidence records nothing for it (no
`rejected` line), nothing is signed or sent, and a later answer is ignored. An
approval asked after that ends the same way at once. A plan step then releases
its lane and ends, waited for at most 10 more seconds. The party Vet store
closes next, before the source, so a plan step still running fails its next Vet
state write like a crash. A plan cut this way saves no plan and sends no Vet
CREATE.

A write whose approval is cut keeps its journaled intent at stage `closing`
(no transaction hash), never `denied`. Nothing was signed for it, so it stays
askable: a `closing` intent reads as absent, and the next publish of the same
artifact (the next seller request or the next `verify_deal` for that purchase;
for held delivery evidence also the operator's resume pass) asks the operator
again, from a fresh nonce. Once approved, it lands exactly once.

A cut Deliverable is asked again the same way, by the next seller request or
`verify_deal`: the resume pass runs only for purchases at `delivery-ready` with
evidence pending, so it never re-asks a Deliverable. Its delivery runner is left
ambiguous, which otherwise holds a paid purchase read-back-only. The seller
re-runs delivery only when the artifact anchor proves the cut itself: a
`closing` intent exactly as the cut wrote it (`operator_closing`, no hash) and
no signed transaction for its address retained by the source or the seller
wallet. That proof is an in-process value, never a journal field. Every other
absent, unknown, issued or broadcast Deliverable stays read-back-only,
including the `intent` a crash leaves while the wallet is still asking.

A payment-evidence (`pay-dem`) approval cut by shutdown records nothing and
signs nothing, and the seller records its answer as `indeterminate`
(`operator_closing`), never `rejected`. It is not asked again: its handoff was
issued before the wallet was asked, so, as after a crash at that point, later
calls only read it back.

The cut comes after two waits that have no bound of their own:

- **A delivery-evidence resume pass.** With `sellerDeliveryEvidence` on, a pass
  in flight is awaited at the start of shutdown, before the grace. That
  includes a SettlementEvidence approval waiting inside it.
- **Switch on: an admitted seller request.** These are awaited until they end
  (above), and that includes an approval waiting inside one. With the switch off,
  the cut does end it after the grace.

So a manual seller approval already waiting when `close()` starts also has an
absolute deadline: **15 seconds after
`close()` starts**, whatever shutdown is then waiting for, including those two
waits, a manual approval still waiting ends undecided exactly as at the cut.
The first approval asked after `close()` started opens one late window of 15
seconds from that ask. Every later ask gets only what remains of that same
window, and once it has ended a new ask ends undecided at once, without being
asked. However many admitted writes ask in turn, their approvals end within 15
seconds of the first of them. A human prompt therefore cannot hold shutdown
forever, yet an admitted write that first asks after that deadline can still
be asked, within the one late window: with the switch on, an early commitment
held past its no-resend intent and waiting for its queued seller-wallet
reservation still lands when the operator answers within it.
Nothing is recorded, signed or sent for a cut approval, and its write stays
askable (stage `closing`, above). The holder then unwinds, releasing its lane
locks and the seller's `seller-state.sqlite` job lock, and shutdown goes on.
The deadline is fixed; no setting changes it. It is later than the switch-off
request grace (10 s), so with the switch off it normally falls after the cut.
It is half the 30-second `stop_grace_period` in `deploy/compose.yaml`, the only
supervisor stop grace this repository documents (it applies to the plain plugin
server, below), which leaves 15 seconds for a cut approval's holder to unwind
before such a grace ends. With the switch on it falls inside the 30-second app
grace; the first seller request that asks for a manual approval after it still
has 15 seconds from that ask, and later ones share that window.

The plan bound also limits what "before the source" covers. A plan step that
ends within those 10 seconds writes nothing after the source closes. A plan step
still running when they end (for example, past its approval and inside a slow
source call) can still write its artifact-journal `issued` or error record and
its attempt note after the source closes. Those records are readback-only, and
the lane wait below covers them.

After that, shutdown closes the Node2 source and connection owner, then
waits up to 10 seconds for **this instance's** durable lane locks in the three
journals `node2-transport.sqlite`, `seller-artifacts.sqlite` and
`seller-wallet.sqlite`. The app database stays open during the source and lane
unwind. New MCP actions are refused throughout that wait, including direct
`operator.close()` with the switch off. Only after its own lanes release does
shutdown close the app listener, application database, seller agent, journals,
custody wallets and stores. It checks this instance's lanes once more right
before the application database closes: admitted app work can still take a lane
after the wait (locking needs no source), and then close refuses with
`journal-busy` as below instead of closing the database under it.
Foreign-instance rows are neither awaited nor removed. Switch-off purchase,
signing, broadcast, fee, recovery and ordinary connection-contention behavior
outside shutdown is unchanged.

A holder that never ends and makes no source call now refuses close with
`journal-busy` after about 10 seconds of lane waiting (on main with the switch
off it refused immediately). An in-flight source RPC can add up to its existing
10-second timeout first. Shutdown never removes a holder's row. A lane-wait refusal
also cuts any remaining listeners, while leaving the application database and
journals open. A second close
in the same process returns the **same refusal**, even after that holder releases;
there is no retry state machine and that call deletes nothing. Programmatic callers await `operator.close()` and preserve its refusal cause
before recovery. The retired CLI signal behavior is historical v1 only.

The stop budget, plus scheduling and background-worker cleanup:

| Switch | Phases | Budget |
| --- | --- | --- |
| off | 10 s request grace (app and seller) + up to 10 s for a plan step still running + up to 10 s for an in-flight source RPC + 10 s lane wait + the application's existing 10 s background purchase-poll drain | about **40 s**, **50 s** with a plan step still running at the grace; a delivery-evidence resume pass in flight is awaited first, up to the 15 s approval deadline while it waits for a manual approval and with no upper bound while it waits for its current holder (below) |
| on | 30 s app grace, then admitted seller requests **until they end** + 10 (plan step) + 10 + 10 + 10 | at least **60 s** (70 s with a plan step still running), with no upper bound while an admitted seller request waits (for inclusion, up to the source's 120-second inclusion wait per CREATE, or behind a connection lease that never releases) or a delivery-evidence resume pass waits for its current holder; a manual approval inside either ends at the 15 s deadline, or, if asked after `close()` started, within 15 s of the first such ask |

In both settings a background evidence-publishing pass that is being stopped is
awaited first. It can wait for its current holder, as on main, which has no
bound, or for a manual approval, which ends undecided at the 15-second deadline
(above).

Nothing in this repository supervises the operator. `deploy/compose.yaml` runs
the plain plugin server, not these scripts, so its `stop_grace_period` does not
apply to them. Whatever supervises the operator needs a stop timeout of at least
the budget above (about 50 seconds off, 70 seconds on, plus margin). No finite
timeout covers every case with the switch on, nor in either setting while a
resume pass waits for its current holder. Killing the process preserves
signed intents and may leave lock rows for explicit recovery.

A kill before the approval deadline, while a manual approval waits inside a
seller job (a stop timeout under 15 seconds, a SIGKILL), also leaves that job's row in the
`seller_locks` table of `seller-state/seller-state.sqlite` (job, owner and PID).
Nothing was signed for that approval, but no cut ran either: its artifact intent
stays at stage `intent`, which, unlike a `closing` intent, is only ever read
back. Nothing removes such a row at start: the next request or resume pass for
that job reclaims it once the row's holder lease shows the killed process has
exited on this boot, even if its PID is in use again (for example when a
container runs the operator as PID 1 again). Until then, or when nothing can
prove the holder gone (another boot, an unreadable lease, an earlier row
format), that job answers `seller_state_busy`, with a notice on stderr. Such a
row is released explicitly with `releaseAbandonedLock({ job, owner })`, after
the checks in "Abandoned seller-state locks" in
[DURABLE-WALLET-JOURNAL.md](./DURABLE-WALLET-JOURNAL.md). The abandoned-lock
procedure below covers the three wallet journals.

After a refused close or a killed process, preserve all three journals and
retained signed intents. Before restarting, independently establish that the
holder process has ended. If its lock rows remain, use the journal's
[`inspectLocks()` and `releaseAbandonedLock({ key, instance, fence })`](DURABLE-WALLET-JOURNAL.md#abandoned-locks-explicit-operator-action)
for only those exact abandoned rows. There is no automatic timeout or lock
deletion. Removing a lock grants no resend permission: resume the interrupted
buyer step through `verify_deal`, which reads retained signed work back without
signing or broadcasting it again. Fresh later phases still require their
existing approvals and readback gates.

Native composition checks connection readiness before retaining an early
attempt. Draining an admitted early commitment permits its one retained send
and readback attempt to finish; it does not prove broadcast, inclusion or
finality. Failed readback stays held for recovery. Buyer work cut at the grace
fails and resumes through `verify_deal`. A definite pre-attempt connection refusal
leaves ordinary commitment available after Agreement readback. A buyer's
exclusive lease can delay the seller until the buyer's inclusion wait finishes;
no native latency gain or same-block placement is claimed in that case. The
switch-off connection owner still rejects contention as on main.

The seller persists a commitment-attempt marker before signing. An early
commitment returns `commitment-held`; it does not advance the seller's payment
state or completed commitment phase. Every later early request is readback
only, including across restart. Transport reconciliation of an early request
never creates the marker or reserves a slot.

The ordinary commit, which first authenticates the Agreement, keeps main's
no-resend boundary: the native publisher (or the fixture anchor effect) durably
retains its issuance intent before any wallet request, and once an intent exists
only readback is possible. So if the early attempt failed before that intent
(a transient read, a refused connection, a nonce read), the ordinary commit can
sign the same retained record bytes and publish once. After the seller has seen
its early commitment present, the ordinary commit is readback-only: a later
missing observation never authorizes another CREATE. Unknown outcomes never
authorize another broadcast.

Payment still follows the existing Agreement receipt and commitment readback
gates, plus fresh Agreement and commitment verification before native payment
handoff. A missing or indeterminate Agreement keeps the purchase held. The
normal seller commit route can promote the early record only after authenticating
the Agreement anchor; the buyer independently reads the commitment.

CORE §5.1 permits commitment submission on valid required party signatures.
DACS-3 CA-4 permits retaining the Agreement off-chain, so a commitment over a
valid signed Agreement whose separate anchor does not land is allowed by the
standard. This plugin profile nevertheless requires both readbacks. CA-1 and
DACS-4 PIPE-6 require a verified finalized commitment before irreversible
settlement. The existing demo's one-node observations remain explicitly weaker
than independently established consensus finality.
