# Native wallet transport source capability (default absent/held)

This implements a native-only **source capability**, not live Devnet authority,
a complete DACS purchase, or another simulated profile. No
environment/config/model flag or `approved:true` constructs the capability.
Production defaults and the existing `testnet-held` and simulated profiles are
unchanged. No trusted Devnet chain pin or independent acceptance is supplied by
this change. The observed node2 identity is not admitted as a pin.

`createDevnetNativeTransport` consumes independently supplied `expected` pins
through the existing unchanged `createDemosNetworkBinder`. The expected schema
is `{network, chainIdentity, pinVersion, endpoint, transportAuthority}` with a
canonical HTTPS endpoint. The optional reviewed `fallback` is exactly the
existing binder's documented literal-error block-one predecessor policy; there
is no default fallback or observed-node pin admission. The transport owner must
be independently trusted and tied to actual egress, not constructed by copying
the expected values:

- `getContext()` returns the actual network, exact HTTPS endpoint, authority and
  reconnect connection ID.
- `acquireConnectionFence()` returns `{context, release()}` and holds that
  actual endpoint/connection through local wallet signature, SDK confirmation
  and one broadcast. Expired leases refuse further actions; they do not release
  a fence under an in-flight signature. Local provider release or explicit app
  close releases it. A lost client release remains held for owner reconciliation.
  App close admits no new work and drains bounded in-flight relay operations
  before releasing fences or permitting the caller to close the journal.
- `journal` is an explicitly injected existing durable public wallet journal
  (`get/put/entries/withWalletLock`), not a new signer or secret store.
- `fetchImpl` defaults to ordinary HTTPS fetch. A custom implementation is a
  trusted transport boundary and must honor the binder/HTTP no-cache, no-
  redirect, bounded response, timeout and actual-route context contracts.

Pass the returned opaque capability as `createApp({..., nativeWalletTransport})`.
App/router reject serialized capabilities or approval booleans. Only this
programmatic source seam mounts the new profile, binding and fixed-RPC routes.
No CLI/env/public enabling option exists. The relay has bounded JSON, fixed
HTTPS destination, no redirects and no retry. Failures are HTTP500, never the
502/503/504 statuses automatically retried by SDK4.0.16. It does not require a
simulation response/header. Only native preparation reads and original signed
native confirm/broadcast requests pass; SDK auth must belong to the sender.

An explicit same-origin consumer reads
`POST /portal/api/devnet-native-wallet-profile`, then calls the exported
`createDevnetNativeWalletTransport(profile)` and supplies its descriptor to the
existing `createSdkWalletSession` / `openEmbeddedWallet` bridge. The actual app-
served bridge/UI/bundled SDK path is executed in the new Chrome test with a
normal trusted exact-debit approval. No SDK bundle/private methods are changed.

Before local signature and before send, the provider consumes fresh protected
binder observations while the actual transport-owner fence stays held. The
normal wallet approval shows payer/payee/amount/nonce, SDK gas, node fees, total
debit and the explicit pin/context. SDK4.0.16 signs the original native payload;
the new profile additionally requires hash/signature validity and byte-identical
node-confirmed transaction bytes. It never mutates signed bytes or adds chain/
purchase fields. Identity, listing, SR-2 CREATE and other writes remain held.

Before the one broadcast, the existing durable host journal retains and rereads
the original public signed transaction and network-binding record exactly. Both
wallet-lane and hash-specific records preserve old receipts and fence newer
pending sends. Unknown applied/unapplied outcomes are readback-only across app
restart; retained hashes are never reconfirmed or resent. `readNativeTransfer`
uses fresh pinned RPC status/transaction/block membership, checks execution
projection against the original signed bytes, and records only single-RPC
inclusion: tuple-only attribution, no native purchase commitment, no finality.
Older receipt readback cannot release a newer issued intent.

For the native Agreement consumer, a hash-bound failed execution is read back
without releasing the lane. `cancel_wallet_handoff` can resolve it only after
fresh bound-network failure and nonce reads prove the saved nonce fence still
holds, and the confirmed block at the reported height lists the failed hash.
That height must be a safe non-negative integer; otherwise nothing is written.
A missing, pending, unavailable or inconsistent block keeps the lane held.
Block membership requires an array containing the exact hash; a string,
object, null or missing transaction list cannot release the lane.
Cancellation rechecks an uncertain purchase's reported hash even after
a transient observation erased the cached failure. Both nonce reads accept a
bare number or `{ nonce: number }`, requiring a safe non-negative integer.
The transport retains the original failed intent and signed bytes,
releases only its matching current lane, and never reconfirms or resends that
hash. An advanced nonce leaves the lane held. The transport's `walletBinding()`
refuses any body carrying `failedNonceFence` or `consumedByHash` with
`invalid_params` for every relay (including the operator bootstrap and
in-process seller relays); the public portal binding route answers it with 400;
the server-side purchase flow passes these proofs, through `binding()`.
Later confirmed readback can
still record inclusion without touching a replacement's lane. This rule follows
node `61b8e75`: stored hashes are excluded from admission and block construction
regardless of status (`src/libs/blockchain/mempool.ts:180`,
`src/libs/consensus/v2/PoRBFT.ts:732`); failed edits do not consume the nonce
(`src/libs/consensus/v2/routines/mempoolFilters.ts:112`).

A superseded native payment also resolves its retained source intent after
fresh bound reads prove a different confirmed native hash consumed the same
sender and nonce, with matching block inclusion. The sender is the nonce owner
as settlement reads it (`from_ed25519_address` when present, even if malformed,
else `from`); when `from` is an
alternate signing key, the bound account nonce must also show that nonce used,
and a status read of the retained transfer made after it must return the node's
absent answer (`state: unknown`); any other status is refused and retried
later. The original signed bytes
stay retained at `stage: failed`, with `failure.supersededByHash`; nothing is
resent. Only the matching current source lane is released. The purchase
database commits supersession and its consuming-hash proof first. If source
resolution is interrupted (including between the intent and lane writes),
retry hashless `verify_deal` on the superseded purchase or recheck its settled
owner. The source signature lane stays fenced until that retry completes.
Observed intents and intents with a different retained failure cannot be
rewritten as superseded. A matching retained supersession proof repairs only
an unfinished lane write, without fresh node reads or an intent rewrite. A
retained nonce-fence failure (from an interrupted cancel) is also accepted as
proof and repairs the lane the same way.
The same proof runs when a purchase's own reported hash is a different
confirmed transfer at its nonce (settled or `payment_mismatch`): its other
retained intents at that sender and nonce are released and recorded on it.
Already resolved failures keep their original evidence. Completed source
resolution is recorded on the purchase, so later owner or replacement
rechecks skip source reads and journal writes; an unverified re-read of the
same purchase keeps that record. An unchanged pending reason
does not append another history event.
A settlement whose body is signed by an alternate key no longer supersedes
competing reservations of the same nonce by itself. A native-agreement-payment
purchase at that nonce becomes `superseded` only when its reported hash was
released by this settlement's `supersededByHash` proof (never on a vacuous
proof without a source journal). A nonce-fence failure never counts: it proves
only that its own transfer cannot land, not that the wallet's nonce was used.
A purchase without a reported hash, publications and other reservations keep
their state and resolve through their own verification. For the same reason
the handoff race guard (`nonce_readback_unavailable`) counts only the durable,
insert-only record of wallet-signed nonce use (`wallet_nonce_consumptions`),
written when a confirmed wallet-signed body is read at the nonce (settled or
a slot-consuming mismatch, whatever the purchase's status, a cancelled
purchase too) and never removed by a later read, pointer move or supersession.
The guard never reads a purchase's observation or settlement. State written
before this record existed carries no signer provenance and never blocks a
handoff; the handoff's own fresh nonce read already covers it.
A later unverified re-read of the same hash keeps the observation's recorded
slot consumption, and a pointer whose observation records wallet-signed
consumption is never replaced or detached, so a later read of another hash
cannot erase it.
Alternate-signed consumption never pins the pointer: it may be replaced by a
corrected hash or detached by a rejected or failed re-read.
Resolution stays pending while a signature lease or source request can still
issue an intent, and checks again after scanning the journal. An expired lease
with no running confirm or broadcast cannot issue one, so it does not hold
resolution; the resolution's own fenced readback frees it. Before retaining
a new native intent, broadcast also reads the bound sender nonce and refuses
an already consumed slot. These checks do not resend retained transactions.
The shared payment observer requires confirmed source inclusion; a retained
failed execution cannot authorize seller intake, settlement evidence or
delivery. Only native purchase verification uses `observePurchaseTransfer` to
classify a fresh canonical failure as `execution_failed` and request the
existing nonce/block proof for cancellation. It never treats that failure as
a consumed or settled payment. It returns the source verdict as
`sourceDisposition`; a failed verdict with a confirmed body read neither
settles nor consumes the slot, and the next `verify_deal` reads everything again.

The pinned node executes with `from_ed25519_address || from`; the pinned SDK
payment observer instead uses a present owner field even when it is null or
empty. This app follows the SDK: such malformed owner fields are refused as
payment evidence even if the node debits `from`. This does not select a different
payer or change execution.

## Held consumer gap

The protected purchase UI still deliberately selects only its existing
simulated profile, and `needPaymentNetwork` still requires a simulated purchase
domain. This change does not reinterpret those operations or enable native
Devnet purchase payments/Agreement CREATE. A later explicitly reviewed consumer
must bind genuine purchase terms/domain and supply a genuine independently
trusted transport owner/pin, then select this existing native-only source seam.
No unused adapter is claimed: new tests execute this seam through the actual
app/bridge/UI/provider/SDK relay, but not through an unheld purchase workflow.
Native signed bytes still contain no job or commitment field. Seller,
Agreement, Vet, ST11, claims/delivery/completion, auth, journal implementation,
network binder, config and pins are protected and unchanged.

## Ordinary source evidence

New `test/devnet-native-transport.test.mjs` covers actual bundled SDK acceptance,
marker-free owned HTTPS TEST pin observations, exact8.5DEM debit, durable
original bytes, accepted/unknown applied/unapplied readback, restart/no resend,
wallet decline, late unavailable binding, default/old-held/native-only controls
and same-buyer later transfer/retained older receipt, plus app restart while the
one broadcast is in flight. The browser-prefixed test
uses the actual app-served wallet UI with a trusted exact-debit click. TEST TLS
certificate/authority are ephemeral, local, not live network authority; the
helper never disables global TLS verification. Tests are discovered by the
unchanged ordinary `npm test` root glob.

This is ordinary functional SOURCE evidence only. Trusted live pin admission, live wallet compatibility, complete purchase/native
attribution and finality gates are not established by these tests. No public
RPC, real payment, deployment, SDK/config pin change or genuine key inventory.
