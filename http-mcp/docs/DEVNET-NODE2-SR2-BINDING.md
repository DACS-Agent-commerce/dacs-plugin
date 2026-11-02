# Node2 SR-2 source binding

Status: source-only, run-scoped TEST compatibility path. It is not public Node2, validator finality, wallet authority, payment evidence or release readiness.

An SR-2 adapter using the opaque Agreement-capable native transport obtains chain identity from `observeBinding()`. Every call is a fresh binder observation under the transport's tracked task set, durable source-read lock and actual connection fence. The method does not return a configured pin without observation, cache a prior success, or bypass close/context/freshness checks.

The adapter accepts only the exact binder record shape and requires its binding version, binding id, network, chain identity, pin version, endpoint and transport authority to match the transport declaration. A mismatch is held. The fixture-only loopback branch retains its direct confirmed block-zero check.

The layout and four-field Node2 admissions can therefore reach SR-2 name-index reads after the same reviewed block-zero fallback, block-one predecessor, block-two continuation/hash, current context and connection checks used by the native binder. Changed continuation, changed identity, changed context or connection, unavailable owner and closed capability all hold before the name index. Fences release after failure and source reads remain serialized. Offline tests use only deterministic `.invalid` stubs and perform no CREATE, signature, payment or broadcast.
