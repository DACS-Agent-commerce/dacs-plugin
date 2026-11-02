# SR-2 public creation provenance compatibility

For source-bound Node2 reads, the SR-2 consumer accepts the public storage
object with both own properties `createdByTx` and `interactionTxs` absent only
when the expected CREATE hash comes from an exact signed projection or the
wallet bridge's retained authentic authorization. The consumer still verifies
that transaction's hash, signature, writer, operation, derived address, data,
metadata, confirmed block and ordered membership.

Rich public projections remain exact. Partial omission, present `undefined` or
`null`, wrong types, wrong hashes and missing interaction membership reject.
Inputs are not filled in or mutated. Fixture/default reads retain their rich
provenance requirement, and a restart only reauthenticates the original
transaction; it cannot authorize another wallet request or resend.
