# Explicit source Agreement transport (default absent)

This is source capability plumbing, not provided live authority or independent
validation. No environment flag, model consent, config `approved: true`, observed
node identity, or payment approval constructs it. The native-only factory remains
native-only. Existing simulated/default/testnet-held profiles are unchanged.

Construct `createDevnetAgreementTransport({ expected, transportOwner, journal,
fetchImpl })` only with independently trusted canonical HTTPS pins, an actual
egress owner implementing the protected binder context/connection-fence contract,
and the existing durable public journal. Supply that opaque capability as
`createApp({ devnetAgreementTransport, ... })`. The separate browser broker
requires the exact capability and journal. New purchase terms carry its immutable
transportBinding under the existing termsHash and wallet-signed challenge. Old
terms/queued operations cannot migrate. No CLI/config enables this source branch.

The existing SDK 4.0.16 public CREATE payload contract is used without changing
the original two-party Agreement body/signatures. Exact pin/binding metadata is
included in CREATE and its duplicated signed storage edit. The same-origin browser
wallet displays the exact storage bytes, hashes, nonce and complete debit, then
signs locally. A fresh binder/actual connection lease spans signature, confirmation
and one broadcast. Confirmation must preserve original signed bytes exactly.
Identity/publication/other storage kinds remain held.

The bridge authenticates original projection hash/signature, SDK signed-to-
executed normalization, native owner/address/data/metadata/provenance, block hash
and transaction membership. It releases its CREATE lane only after independent
readback. Native DEM payment still requires independently read seller commitment,
normal signed purchase approval and separate exact wallet debit approval.
The protected SDK observer reads transaction/block facts in parallel; source reads
serialize actual egress fences. Its included result additionally reauthenticates
the retained full signed transfer before releasing the source journal lane.
Unknown outcomes persist and are readback-only across restart, never resent.

The public read interface is `readRpc(path, body)` and `chainReader()`; every
source observation acquires an actual egress fence and freshly consumes the
protected binder. Read-only seller consumers use their own empty journal and the
public signed projection, never the buyer's writer journal.

Evidence boundaries: seller commitment/directory remain explicitly TEST fixture
substrates in accepting controls. Native Agreement/payment transport plus fixture
commitment is mixed substrate, not strict finality. Portable SR-2 receipts use
unchanged pinned SDK structural fields (including its finalized/profile naming);
those fields are not independent validator/quorum proof. Enclosing source labels
state single-node observation/finality not established. Claims, Vet, delivery,
strict DACS-5 completion and human acceptance remain held.

Owned loopback tests use real TLS with an ephemeral TEST CA trusted only by their
injected client; no simulation response header, global TLS bypass, public RPC,
live funds, actual chain pin or live authority is used. Normal Chrome approvals
execute the actual portal and packaged wallet. Tests cover first purchase,
applied/unapplied unknown payment, restart and same-buyer CREATE/payment
nonce/block 1/2/3/4 with stable unique hashes. Existing legacy contracts are retained.

Unverified/held: live HTTPS RPC compatibility, independently trusted live pin and
egress implementation, consensus finality, browser installed
package and public host deployment. The external security review is on hold. The new Agreement adapter requires direct
block-zero identity observation; binder fallback-only nodes are not accepting
controls and remain held. Wider seller/evidence integration is
separate. This source result does not approve deployment or spending.
