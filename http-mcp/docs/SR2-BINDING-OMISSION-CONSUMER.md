# SR-2 confirmed storage projection binding

The explicit Node2 source profile authenticates a confirmed `storageProgram`
CREATE against two independently retained views:

- the original signed CREATE projection, supplied by the artifact publisher or
  retained by the embedded-wallet bridge; and
- the freshly fetched transaction/native/block facts under the active opaque
  source capability.

Node2 may omit the CREATE content's own `network` and `chainIdentity`
properties from its confirmed transaction projection. The SR-2 adapter treats
that exact pair omission as a comparison projection only when all of the
following hold:

1. the reader has the original signed projection or retained authentic wallet
   authorization;
2. its two nonempty string bindings exactly match the freshly observed source
   capability's network and chain identity;
3. the fetched content omits both own properties together; and
4. every other signed/executed, native-storage, hash, signature, inclusion,
   block and provenance check succeeds.

The adapter copies the fetched content, restores only those two values in the
copy, and uses that same copy for both the SDK projection matcher and the
source-pin comparison. It never mutates or rewrites the signed projection,
retained authorization, fetched response or portable evidence.

This is not a default network pin or authorization source. Raw-only reads,
partial omission, aliases, present wrong/null/non-string values, stale or
mismatched source pins and unrelated differences remain held. Native DEM
payments do not use this exception. Retained issued operations remain
readback-only: the rule adds no signing, confirmation, broadcast, retry or
resend authority.

Focused offline coverage drives the protected artifact-anchor Listing and
Deliverable consumers and the wallet-bridge embedded authorization path over
injected `.invalid` responses. It also covers restart/no-resend behavior,
input immutability, strict negative boundaries and wrong-implementation
witnesses. These tests establish source compatibility only; they do not prove
public Node2 execution, independent consensus finality, security acceptance or
the complete live fixed-price workflow.
