# Node2 storageProgram binding-omission readback

Status: narrow source/offline compatibility rule. It is not a live reconciliation, finality claim, security approval, or DACS v0.1 acceptance.

The public live run retained a signed `storageProgram` CREATE containing exact `content.network` and `content.chainIdentity` values bound to the admitted Node2 source. `getTxByHash` returned the same included hash and documented integer/GCR projections, but omitted those two content properties together. The durable issued row correctly stayed fenced rather than being relabelled observed.

The transport now permits one comparison-only projection after a fresh binder recovery: for a retained `storageProgram`, the signed binding must contain nonempty strings exactly equal to the active admitted `network` and `chainIdentity`. If the fetched execution content lacks both own properties, a new comparison object restores only those two retained values. The retained signed transaction and fetched response remain untouched. The existing SDK `demosTransactionContentMatches` check still decides all remaining content equivalence, and the existing hash, confirmed status, block number, ordered membership, storage owner/address/program/data/metadata and no-resend guards remain mandatory.

The rule does not apply when only one property is absent, either property is present with a different/null/non-string value, the retained binding differs from the admission, an alias or any other structural difference exists, or the transaction is a native DEM payment. It does not change preparation, signing, confirmation, broadcast, journal sequencing, txhash carrier scope, or storage provenance.

Offline coverage uses an injected `.invalid` transport and public-safe live-shaped fields. It includes both-omitted and exact-binding accepting controls, partial/present/retained mismatch boundaries, alias and unrelated-field changes, hash/status/block/storage failures, a native-payment isolation control, journal/no-send assertions, restart readback, and wrong-implementation witnesses for global binding ignore and either-field restoration.

The operator cleanup helper is also null-safe: closing an operator before its seller server exists no longer masks the original operation failure, while a real listening test server still closes normally.
