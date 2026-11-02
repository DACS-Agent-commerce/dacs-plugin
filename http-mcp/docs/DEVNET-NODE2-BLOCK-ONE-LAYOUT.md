# Node2 block-one database-id layout

Status: explicit, run-scoped single-node TEST compatibility policy. It is not a production chain pin, validator-quorum finality result, wallet authority or payment evidence.

The observed Node2 success envelope is exactly `{result:200,response:<block>,require_reply:false,extra:""}`. Its public block height and database identifier differ by one: requested block 1 has `number:1,id:2`; requested block 2 has `number:2,id:3`. Block 2 must be confirmed and its `content.previousHash` must equal block 1's canonical hash.

Observation requires `blockOneLayout:"node2-number-id-plus-one-empty-extra/v1"` together with the explicit literal-error block-zero policy. It reads blocks 0, 1 and 2 under one deadline. The layout token, block-one hash, block-two hash, predecessor identity and observed envelope token are included in the observation hash. Admission separately requires exact review of the layout token and block-two hash.

At runtime the admitted transport passes the immutable reviewed block-two hash into the native reader. The reader repeats the exact block-one/block-two checks on the active connection and requires the fresh confirmed block-two hash to equal that admission value. Only then does it omit block one's reviewed database `id` alias from the value supplied to the unchanged binder. The binder still requires canonical block number 1, confirmed status, exact predecessor identity, fresh uncached/unredirected receipts and stable transport context. Legacy aligned `number:1,id:1` inputs remain on their existing path.

Wrong offsets, missing or changed envelope fields, null-extra responses, wrong height/status/hash/predecessor, a fresh block-two hash different from exact admission review, conflicting identity aliases, block-two discontinuity, timeout, stale reads, and changed connections remain held. No public RPC or value-moving action is performed by the offline tests.
