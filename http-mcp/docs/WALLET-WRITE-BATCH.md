# Wallet write batches (standalone, opt-in)

`src/wallet/write-batch.mjs` exports `createWalletWriteBatch`. No production
caller imports it. Configuration, the seller agent, purchase flow, SDK and
single-write paths are unchanged. There is no enabling environment switch.

The factory takes an explicit `openDurableWalletJournal` instance, `network`,
`chainIdentity`, public `wallet` address and these caller-owned callbacks:

| Callback | Contract |
| --- | --- |
| `readNonce(scope)` | Return the current on-chain account nonce as a nonnegative safe integer, from the pinned chain. Called once per admitted batch. |
| `sign(transaction, {...scope, nonce})` | Sign the approved transaction at the supplied explicit nonce, without sending it. Return the original public signed JSON projection. |
| `verifySigned({...scope, transaction, signedBytes, hash, nonce})` | Return exactly `true` only after checking the original hash/signature, wallet, approved payload, fees, edits and network binding. |
| `broadcast({...scope, signedBytes, hash, nonce})` | Send the exact retained bytes once. Return exactly `{disposition: 'submitted', hash}` on an unambiguous acknowledgement; do not retry internally. |
| `readback({...scope, signedBytes, hash, nonce})` | Read the original transaction without signing, confirming or sending it. Return an observation containing `wallet`, `hash`, `nonce`, `disposition` and the evidence needed by the verifier. |
| `verifyIncluded({...scope, signedBytes, hash, nonce, observation})` | Return exactly `true` only for authenticated inclusion of this exact signed write, including its applicable content/provenance checks. HTTP acceptance or storage visibility alone is insufficient. |

`scope` is `{network, chainIdentity, wallet}`. These callbacks are a trusted
adapter boundary, not proof booleans supplied by an MCP client. The batch module
does not implement a Demos proof codec, fees, approvals or connection fencing.
WS7 must supply those existing checks through its adapter. Callbacks must have
bounded transport timeouts; an unresolved promise retains the wallet lock.

## Journal and prefix-adapter contract

`journal` must expose the underlying durable journal's 32 lowercase hex
`journalId` and async `get(key)`, `put(key, value)`, `entries()` and
`withWalletLock(key, work)`. `put` must durably commit before resolving;
`get` must preserve exact JSON and propagate integrity errors. The lock must
exclude every writer and process using that wallet lane until `work` settles.
It must preserve the journal's holder fencing and abandoned-lock behavior.
`entries()` returns `[logicalKey, value]` pairs from the same namespace.

For the demo's wallet namespace, a complete wrapper is:

```js
const prefix = 'demo/wallet/';
const batchJournal = {
  journalId: journal.journalId,
  get: key => journal.get(prefix + key),
  put: (key, value) => journal.put(prefix + key, value),
  entries: async () => (await journal.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value]),
  withWalletLock: (key, work) => journal.withWalletLock(prefix + key, work),
};
```

Use the identical prefix for lanes, batch archives and nonce-floor records;
keep it stable across restarts and use the same physical lane as single writes.
The current `artifact-anchor.mjs` wallet delegate exposes only `get`, `put` and
`withWalletLock`; it cannot be passed directly to this factory. WS7 must forward
`journalId` and `entries()` as above. Lock inspection and explicit abandoned-lock
release use the underlying journal and the **prefixed physical lane key**.

## Submission and recovery

`submit({batchId, step, writes})` accepts 1–64 unsigned transactions, each naming
the wallet and an explicit `content.nonce`. `step` identifies one purchase step;
the caller must not combine writes across protocol dependencies. Batch ids are
unique for this wallet, chain and network and cannot be reused after resolution.

The module holds `JSON.stringify([network, chainIdentity, wallet])` through
the entire operation. All participating writers must use that same underlying
journal and lane key, including any journal prefix adapter. Noncooperating
external wallet users cannot be fenced by a local journal. An existing unresolved
single-write lane is also refused before signing. The unchanged SDK anchor's
stage check refuses a `batch-unresolved` lane when it shares this journal/key.

One nonce read reserves `n+1 .. n+k` under that lock. A stale/skipped plan,
unavailable nonce, overflow or nonce below the previous retained write is refused
before signing. A separate durable per-wallet nonce record also enforces the
maximum nonce reserved by batches or participating single writers and the
highest authenticated chain nonce seen
during reconciliation. Its logical key is
`wallet-batch-nonce/${sha256(lane)}`. An intervening single write cannot erase
it by replacing the lane. Admission requires `n` to be at least both floors,
including after restart; each new reservation therefore starts above them.
Writes are signed sequentially in nonce order. Only after every
signature verifies does one durable lane record retain the complete batch:
identity, step, base nonce, and every exact signed JSON byte string, transaction
hash, nonce, byte digest and disposition. The complete record is reread exactly
before the first send. SQLite uses the existing WAL/`synchronous=FULL` contract.
The reserved nonce floor is committed and reread exactly after the initial lane
write and before the first broadcast. A failure in that gap leaves the retained
batch fenced and recoverable through readback, with nothing broadcast.

All writes initially have `indeterminate` disposition. A matching acknowledgement
changes only that write to `submitted`; it never releases the lane. A timeout,
connection drop, malformed reply or wrong hash stops the send loop. The failing
write and every later write remain indeterminate, including signed writes never
sent. Failure to persist an acknowledgement also stops all later sends.

`reconcile({batchId})` is the only recovery operation. It reads unresolved writes,
validates observations against the retained wallet/hash/nonce and verifies their
evidence. Resolved writes stay resolved. New signing remains refused until every
write is either `included` or `not-landed`. Before releasing the lane, the module
archives the complete resolved batch, so a later single-write lane cannot erase
the batch's replay refusal. `broadcast-accepted` is the existing lane-release
stage spelling; for a batch it means every write was resolved by readback.
Archive and lane writes are separate journal commits. If the archive committed
but the lane did not, `reconcile` recovers its terminal dispositions under the
wallet lock and persists the resolved lane without another readback. The archive
must exactly match the lane's identity, step, base nonce, ordered nonces, hashes,
byte strings and byte digests; already terminal dispositions must agree.
A mismatching archive fails closed. Recovery of an older archived batch never
overwrites a newer batch or single-write lane.

After restart, use `mode: 'open'` and the expected journal id. A process crash
leaves its lock row held. Only the existing explicit `releaseAbandonedLock`
operation, after establishing the holder is dead, removes that lock. It leaves
the complete batch record fenced. Recovery never re-signs, replaces or resends
any retained write, even one that was never broadcast.

## Absence and the DACS mapping

DEMOS-MAPPING §A.1 requires explicit sequential batch nonces. Its §A.2
authoritative-absence paragraph says an ordinary RPC/storage `not found` is
indeterminate; the current mapping supplies no authenticated finalized absence
policy. Existing `devnet-native-transport.mjs` and `artifact-anchor.mjs` release
issued writes only through authenticated positive inclusion. A nonce increment
alone cannot distinguish inclusion with lagging visibility from a missing write.
The mapping's informative operational notes permit idempotent rebroadcast for
an observable failure with unchanged payload and binding. This plugin's stricter
no-resend rule still applies: this module provides no resend operation, including
after a verified `not-landed` result.

Consequently, omitting `absencePolicy` always leaves absent writes unresolved,
even when an RPC reports a higher nonce. No production absence policy is supplied.

A separately reviewed adapter may explicitly provide `{id, verify}`. For an
`absent` observation, `verify` receives the same scope and exact signed-write
request as the inclusion verifier. It must authenticate both non-membership and
the finalized wallet `chainNonce` at a compatible chain state, and prove that
this exact transaction can no longer land under that chain's nonce rules. Only
an exact `true`, with a safe integer `chainNonce > write.nonce`, permits
`not-landed`. Equality remains blocked in this conservative slice. This is a
local transaction disposition, not DACS authoritative artifact absence.
Authenticated chain nonces are retained as a monotonic maximum before any
resolution is persisted, even if some writes remain unresolved. Inclusion also
establishes a chain nonce floor at least as high as that included write's nonce.
Unverified, mismatched or unavailable observations never advance this floor.

The fake-chain test's explicit synthetic policy establishes absence for nonce
13 and a finalized nonce of 14. That resolves write 3 as not landed without
authorizing a resend or same-nonce replacement. It makes no claim that the
current Demos RPC implements such evidence.

Offline evidence is in `test/wallet-write-batch.test.mjs`. Its crash helper kills
a real Node process before the lane write, after that write, before the first
broadcast, after a send but before its acknowledgement is retained, after the
first acknowledgement, mid-batch and after archive commit before lane release.
Every retained-batch restart uses readback or exact archive recovery with zero
signatures or broadcasts. A crash before the lane write has no retained batch
to reconcile and no broadcast to recover.
The mutation runner changes temporary module copies only. Process-kill tests do
not establish durability under power loss; the existing durable journal's local
filesystem, backup and rollback assumptions still apply.

## Required WS7 integration and follow-ups

Existing single-write paths remain unchanged. Before enabling mixed
batch/single-write use, WS7 **must** call the exported
`reserveWalletWriteNonce({journal, network, chainIdentity, wallet, baseNonce, nonce})`
inside each single writer's existing wallet-lane lock, after validating the
pinned chain nonce and approved successor, before signing. Keep the same lock
through signing, exact issued-lane retention and the one broadcast. Use the same
complete prefix adapter as the batch factory and keep its prefix stable across
restart. `baseNonce` is the chain read; `nonce` must equal `baseNonce + 1` and be
a safe integer above both the reserved and authenticated chain floors.

The operation returns `true` only after validating admission, committing the
single-write nonce to the **same** independent floor used by batches, and reading
back the exact stored floor. It throws `batch-nonce-clash` for a stale read or
invalid successor; corrupt floors and persistence/readback errors also fail
closed. On any error, the adapter must stop before signing or broadcasting.
The operation does not acquire the lock itself because the existing wallet lock
is non-reentrant. It supplements, and does not replace, the adapter's existing
lane/fence, approval, signature, fee and connection checks. For example:

```js
await journal.withWalletLock(lane, async () => {
  // Existing lane/fence and approval checks, pinned nonce read, scope checks.
  await reserveWalletWriteNonce({
    journal, network, chainIdentity, wallet, baseNonce, nonce: baseNonce + 1,
  });
  // Sign once; retain and reread the exact issued lane; broadcast once.
});
```

A successful reservation stays consumed even if signing fails or the process
exits before a send; never decrease or delete its floor. A nonce at or below
that floor is refused after restart, including for a different payload or the
same signed bytes. A failed exact reread can still follow a successful commit;
reopening must preserve and respect that committed reservation. Reconciliation
remains readback-only, and unknown outcomes retain their existing lane fences.
`checkWalletWriteNonce` remains a read-only preflight for batch validation; it
cannot substitute for durable single-write reservation.

Until WS7 wires this operation into **every participating single-write path**,
the SDK/artifact-anchor and other existing writers do not advance or enforce the
independent floor. Sharing only the journal and lock, or calling only the
read-only check, still permits a lagging single write to reuse a single-owned
nonce and replace a released lane, allowing later batch reuse of that nonce.
Batch-owned reservations remain protected by the batch floor. This module is not
imported into any production path; it does not activate batching or change
existing single-write behavior. Writers outside the shared journal/lock remain outside
this local protection even after WS7.

Follow-ups: wire durable reservation into SDK/artifact-anchor and all other
participating writers in WS7; supply the existing approval, signature, fee and
connection checks for batch callbacks; retain readback-only restart handling
and a transport without retries. A production finalized absence policy remains
a separate reviewed integration requirement.
