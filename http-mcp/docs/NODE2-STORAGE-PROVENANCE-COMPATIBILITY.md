# Node2 public storage provenance compatibility

The Devnet native transport authenticates a retained `storageProgram` CREATE in two layers before it releases an `observed` receipt:

1. Fresh admitted binding, included transaction status, exact transaction hash/status/block, ordered block membership, and exact full signed CREATE content.
2. A same-origin read of the exact storage address requiring `success`, owner, storage address, program name, canonical data and canonical metadata to match.

Node2's observed public storage-object projection includes every layer-two value above but omits both `createdByTx` and `interactionTxs`. The transport therefore supports exactly two unambiguous provenance representations after layer one has passed:

- both properties are present: `createdByTx` must equal the retained transaction hash and `interactionTxs` must be an array containing it;
- both properties are own-property absent: layer one's included immutable CREATE supplies transaction provenance.

Partial omission, own properties with `undefined` or `null`, wrong types, wrong hashes, missing membership, or any mismatch in the other storage fields remains rejected. The comparison never adds fields to the fetched or retained bytes and does not change signing, fees, approval, journal fencing, confirmation, broadcast or no-resend behavior. This is a single-node TEST compatibility rule, not quorum finality or a normative Standard rule.
