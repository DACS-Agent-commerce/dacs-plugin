# Purchase Agreement readback reuse

`DACS_READBACK_CACHE=1` enables in-memory reuse of the existing verified native
Agreement reader result at the buyer's payment gates. The default is `0`.
Only that reader is cached: seller commitment, payment evidence,
transfer observation and Deliverable reads retain their existing paths.

A reusable result must be positive, established inclusion from the existing
SR-2 Agreement reader. Its exact transaction hash, block hash/height/time,
content hash, logical address, native address and writer must match the retained
purchase receipt. The key also includes the entire receipt and caller scope:
Agreement, original signed projection, buyer wallet and source binding. The
scope is keyed by its exact JSON bytes as well as its canonical form, because
Demos signs `JSON.stringify` bytes: a reordered signed projection reads fresh.
A changed coordinate or scope reads fresh. Every existing purchase comparison,
source binding observation and wallet journal/nonce fence still runs.
Unestablished, missing, pending, malformed and failed observations never enter
the cache. No balances, nonces, latest-state reads or writes enter it.

What a hit still reads depends on the gate:

- Payment handoff and wallet lane (`reuseVerified` false): the current-state
  half of the read runs again on every hit, namely the chain identity (or source
  binding), the exact name-index search, the native GET, and the comparison of
  native address, data, metadata, owner and creation provenance with the cached
  authenticated receipt. Only the signed transaction and its containing block are
  not re-read. A mismatch evicts the entry and holds payment.
- Pre-approval and post-payment (`reuseVerified` true): only the source binding
  is observed (source path); the fixture path reads nothing.

What a hit does not detect: a reorg between the first read and the gate that
leaves this exact program in place (for example, the same CREATE re-included in
another block), and any change to transaction or block data the receipt pins.
Receipt `state` is the SDK label; `included` is accepted as before and this
cache does not make it final. On the pre-approval and post-payment gates a hit
also does not see a changed program; the next payment gate does.

Entries belong to one purchase only. Operation stage notifications drop them
on cancellation, expiry, refusal or completion, including `delivery-ready` and
the failed stages `claim-rejected`, `evidence-rejected`, `delivery-rejected` and
`bundle-rejected`. Every lookup and insertion also checks the durable purchase's
current lifecycle. A read in flight when any end notification arrives does not
insert, and a hit whose purchase ends or whose entry is evicted during its
current-state check reads fresh instead. Shutdown clears the cache and prevents
further insertion. Restart starts empty. A purchase takes a slot only when a
result is inserted. The cache holds at most 256 purchases and 16 scopes per
purchase; eviction causes fresh reads and never changes write authorization.

The pre-existing native source reader's short TTL reuse on
pre-approval/post-payment calls is unchanged with either switch value, so calls
after an ended stage reuse as before. With the switch off, payment handoff and
lane calls still read fresh, and public outputs and request bytes are
unchanged. One-node inclusion remains one-node inclusion; the cache adds no
finality claim, new verifier, write retry or resend path.

The portal already answers `protocol/recheck` within about one second, retains
one in-flight workflow per purchase and polls pending responses at one-second
intervals. That timing behavior is already on in the base and is independent
of this switch. This PR leaves that workflow and its ordering unchanged.
