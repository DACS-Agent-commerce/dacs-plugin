# Purchase portal auto-advance

`DACS_PORTAL_AUTO_ADVANCE=on` enables purchase page readbacks; the default is
`off`. It is refused together with `DACS_INTENT_APPROVAL=on` (the
embedded wallet's one Start approval, [START-INTENT.md](START-INTENT.md)): startup fails,
naming both switches. Only purchase HTML selects the generated `auto-portal.js` entry. Its
controller (`src/portal/purchase-auto-advance.mjs`) sits outside the static
asset directory and, like the entry, is served only when the switch is on; with
it off the asset routes are main's. All existing portal and embedded wallet
assets remain unchanged. Exact source hooks,
and exactly one HTML script entry, fail closed at startup when the enabled entry
no longer matches the renderer.

The page checks Agreement/commitment, payment observation, claim, evidence,
delivery and completion readbacks. It stops at a new signature screen, a
terminal result or a profile's deferred completion boundary. Delays start at
500 ms and grow to at most eight seconds when state is unchanged or unavailable;
progress (status, stage, signature readiness, transaction outcome, delivery and
completion references) resets the delay. Observation times, deadline
projections, poll metadata and attempt notes do not count as progress. Requests
time out after ten seconds. Portal actions pause polling and await its
outstanding read before asking the wallet.
The server shares one verification workflow per purchase using purchase-poll.
Signature readiness follows the displayed stage. A `notSaved` view (one
check that lost to newer saved progress) offers nothing to sign, including the
standalone CREATE, and the page keeps reading until it sees the saved state.

Unknown wallet outcomes, lost/truncated HTTP responses, `outcome_unknown`,
`upstream_unavailable`, `buyer_balance_unavailable` (the buyer balance could not
be read from the chain; the page logs the server's text first) and the 409 conflicts whose answer is in the saved
purchase state (`invalid_state`, `protocol_check_stale`, `hash_conflict`,
`already_countersigned`, `native_payment_already_issued`) trigger state reads.
The portal answers almost every other refusal with 409 too, so a 409 alone
triggers nothing: every other refusal (an insufficient balance and its funding sentence, `unsupported_node_fee` (a node additional fee this wallet version cannot sign; not retried),
purchase limits, wallet, signature, seller delegation, Agreement context or
terms, network identity, an unavailable protocol) is final for the buyer and
the page logs the server's text, as the manual page does. Automatic reads
continue only where the purchase is in a readback stage or this tab already
asked the wallet for that step. `buyer_access_closed` goes further: the page
shows the refusal message on first load or during a later read, stops automatic
reads and offers only a manual Re-check. A successful Re-check updates the page
but leaves automatic reads stopped; reload to resume polling after access is restored. After a balance refusal at the plan step, fund the buyer wallet and
open the purchase link again in a new tab (not a reload or a duplicate of this
tab): this tab already asked for the identity signature, so it will not ask for
it again. The same holds for an unreadable balance at the plan step: the page keeps
reading, and the plan is retried from a new tab once the chain read works. At the
identity step nothing was asked yet, so the same page continues. Recovery never invokes a wallet action, reissues a signature or replays a
transfer. Once payment has reached the wallet, the page suppresses payment
actions, even if a later response shows an earlier approval state. The page
retains a valid public transaction hash for verification only while the server
holds none: once a read shows a recorded pointer (including one corrected
through `verify_deal`), or the server reports `hash_conflict`, later reads stop
supplying it. The server attaches the page's hash atomically and only where no
pointer is recorded; it never replaces one, so a `verify_deal` correction made
before the page's next read stands. Replacing a pointer stays the explicit
`verify_deal` correction. Pagehide is final: no late result restarts polling,
and the page asks the wallet nothing more (including the second signature of a
step), starts no check, makes no fallback read and renders nothing. A
signature, broker session or response that returns after pagehide submits
nothing, an action that was waiting for a read does not start, and a payment
that never reached the wallet reports no wallet error. The result of a payment
the wallet was already asked for is still reported, whatever its error code.
One known gap: with an opt-in loopback test broker, a response that returns
after pagehide can still post the broker's one-time CREATE claim. The wallet
is not asked, but that CREATE cannot then be approved again. A hashless uncertain
payment can remain unresolved: use the wallet history and `verify_deal` to supply
its hash. The broker's explicit one-time CREATE approval stays a buyer action.

Each wallet request (Agreement, purchase approval, bundle counter-signature,
Agreement CREATE, payment) is journaled in the tab's `sessionStorage` under
`dacs:auto:<purchase id>:<kind>` with the value `asked`, immediately before the
wallet is asked. Nothing else is stored, and the tab keeps it until the tab is
closed. A journaled request is never asked again in that tab, by recovery or by
a reload: the step stays readback-only until the server shows it recorded, or
the purchase ends. This includes a request the buyer rejected in the wallet.
If the tab cannot record the entry, nothing is asked. The broker session lives
only in page memory; after a reload the standalone CREATE action first
authenticates a new session through the broker's challenge, then claims the
CREATE.

An embedded wallet stays unlocked during the active purchase until five minutes
without trusted foreground input, purchase end, or pagehide. Hidden tabs also
have a five-minute limit, checked on return if browser timers were throttled.
Background readbacks and synthetic events never extend unlock time. These limits
call the wallet's existing `lock()` handle: its approval is cancelled, sensitive
fields and phrase references cleared, and the SDK session discarded. JavaScript
string memory has the same garbage-collection limitation as manual locking.
Extension wallet key lifetime remains controlled by that wallet.
