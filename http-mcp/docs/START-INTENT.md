# One Start approval (embedded wallet)

`DACS_INTENT_APPROVAL=off|on` defaults to `off`. With the switch on, the
experimental embedded wallet can approve one bounded purchase Start. Payment
keeps its separate approval and transfer path. Extensions keep per-step dialogs.

`DACS_INTENT_APPROVAL=on` is refused together with `DACS_PORTAL_AUTO_ADVANCE=on`
(`loadConfig`, `createApp` and the portal router fail at startup, naming both).
Auto-advance serves purchase pages its own rewrite of `portal.js`, built from
the file without the Start hooks, and keeps its own per-tab wallet-request
journal and a standalone Agreement CREATE action, none of which is held to a
Start. `DACS_READBACK_CACHE=1` composes with it: the cache holds only a
purchase's verified, included Agreement readback for the payment gates. The
Start records, the wallet's fence and the issuance check never read through
it, and every intent route reads the purchase from its durable record.

The dialog shows the Listing pin, seller, price, network and source-pin caveats,
account, wallet, job, terms hash, deliverable hash and schema, buyer/seller
identity hashes, exact Agreement generation time and delivery deadline, and
any delegated app session public key with its exact validity window. It lists
signatures, planned writes and nonces, fee ceilings and Start expiry. On
devnet the CREATE step also makes four operator RPC auth signatures: two for
the source bind and signature requests, one when the node validates the record
(`confirmTx`) and one when it broadcasts it (`broadcastTx`). The SDK makes the
last two inside its own node request. Each signs only SHA-256 of
`ed25519:<address>:<timestamp>`, signs no transaction and moves no funds; the
operator refuses a stale or reused source set. The dialog lists them with the
CREATE.

Covered profiles are `fixed-price-pay-dem/v1` on the simulated fixture and
`sr2-wallet-agreement/v1` on the source-pinned devnet Agreement transport,
without an Agreement context. Fixture writes are server-side simulated writes;
devnet covers one buyer Agreement CREATE with a ceiling of 4 DEM. The planned
write list and total fee calculation support additional steps without changing
the intent format, but no buyer Vet write is enabled yet.

The wallet hash-checks the signed Listing supplied at Start against the
approved Listing pin and verifies its one ed25519 signature by the seller.
It refuses, with the `listing` reason (or `anchor`), a Listing or purchase
with: a presentation kind other than `per-claim`; a seller claim that is not
a Demos agent key; a `revocationState`; no SR-2 anchor in the purchase terms;
a signature value that is not 86 characters; a seller key of small order
(which has no private key); or a browser without Ed25519. A deliverable schema must be an absolute URI without
spaces. It derives the deliverable, seller identity hash and
deadline interval from that material. It rebuilds the entire Agreement from
these facts, the checked buyer identity, exact approved time, fixed payout
rules and fixed not-performed Vet references. The structured server draft must
match exactly. Delegation payloads must match the displayed key, window and
scope exactly. Broker challenges are re-rendered and checked, including their
time bounds. The wallet's Agreement CREATE request must match the checked
Agreement, wallet, chain, nonce and exact debit ceiling. The existing SDK
verifies both Agreement signatures, builds the CREATE itself and keeps its
write journal and no-resend fencing.

Operator and DEM-delivery context profiles keep per-step approvals. The current
DEM capability requires seller-signed records for both parties and does not
expose their provenance to the browser. A buyer-written seller Vet needs new
producer, consumer, broker and wallet artifact support; the one-approval path
refuses these contexts until that work is done.

A mismatch stops before the affected signature or write. The Start lives for
at most 10 minutes. Locks, wallet/session changes, newer Starts, peer-tab
Starts and expiry invalidate it, including pending work: a signature that
completes after the drop is discarded.

For the Agreement CREATE, the wallet holds every step of the CREATE request
until the wallet records it as issued: each SDK signature (the source auth
signatures and the CREATE transaction), each node request (reads,
`confirmTx`) and each source phase (bind, signature, broadcast), checked
before it starts and again before its answer is used (including source errors),
and the issuance itself,
where the Start must still be the current one, its wallet unlocked and
unchanged, and its expiry not reached. A replaced, locked or expired Start
therefore signs nothing more, starts no new node or source request, gets
no wallet dialog for its CREATE, is never issued or broadcast, and closes the
purchase as for a stopped CREATE. The source lease release still runs: it only
frees the lease, signs nothing and sends nothing for the record. A request
already sent when the Start is dropped, including the SDK's automatic retries
of it, cannot be recalled; its answer is discarded. Once issued, the CREATE is broadcast once (with the `broadcastTx`
auth signature) and only read back; a later drop changes nothing about it.

Durable IndexedDB claims, keyed by the
server's Start record, are written before each purchase signature request
(identity, delegation, Agreement, anchor or broker session), so none of these
is requested twice under one approval, even after a reload or in another tab.
The four operator RPC auth signatures are not claimed: each is fresh by
design (the operator refuses a reused or stale source set), so a claim could
only refuse, never reuse. Instead the wallet builds them itself and allows
exactly these inside the one CREATE request: the two source ones and
`confirmTx` before issuance, `broadcastTx` only after. The covered CREATE
request is one-shot: a second invocation is refused, so the allowance never
restarts.
After an interruption before the Agreement CREATE reaches the wallet, the
buyer starts again: the new Start is a new record and a new approval, and it
may sign the same messages again. A stopped CREATE is different: the broker
has already handed it to the wallet, and the broker records any wallet
refusal at that point as final. The wallet reports it with the reason it
stopped (`superseded`, `expiry` or `wallet`; "Nothing was sent"), and the
purchase closes as `agreement_rejected` with nothing written or paid; the
buyer prepares a new purchase. Without durable
storage the embedded wallet keeps the per-step dialogs. Devnet Start also
requires the session module's source-phase marker; without it the portal keeps
per-step approvals. Existing write
recovery remains readback-only.

The new `/intent/{start,plan,sign}` routes require a current Start record. The
original `/agreement/*` routes retain their original admission checks. Server
Start generations are allocated before awaits, and linkage is rechecked before
issuance. Planned nonces still use the configured chain reader; a difference
from the wallet's pinned relay causes safe refusal and requires a new purchase
or aligned configuration.

With the switch off, the shipped portal assets are byte-identical to main and
are served through ordinary static middleware. With the switch on, exact hooks
are inserted at startup, including one in the embedded wallet's session module
(`sdk-provider.mjs`) that lets the Start's fence see each source phase before
it is sent and after its answer or error; without a Start it changes nothing. Missing or duplicate anchors, pre-existing hooks or
legacy markers cause startup failure. No marked hook bytes ship in the original
assets, and alternate URL spellings cannot expose hooks with the switch off.
