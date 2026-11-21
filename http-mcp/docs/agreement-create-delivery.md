# Agreement CREATE delivery

The client's wallet handoff stores one canonical request per purchase and returns
`outcome_unknown` immediately. It signs and sends nothing. Its public random delivery
id survives a lost response; authenticated purchase views expose only its id and state.

The standalone router uses the purchase handoff token, linked buyer wallet and live
Start. The buyer signs an `agreement-create-claim` challenge binding the purchase,
terms, Agreement, Start, delivery, request hash and expiry. One app transaction consumes
that challenge, changes `issued` to `claimed`, and stores the capability hashes.
Only the winning claim returns the stored bytes as base64, their hash, a journal
capability and a relay capability. Repeated claims return state only.

The journal capability permits evidence access, independently of effect authority.
Effect authority rechecks purchase admission, binding, stop input, purchase state and
Start expiry. An issued delivery may follow a newer matching Start; a claim never moves.
A recovery pass requires a live recovery Start, the journal capability and complete
bounded history proving no possible earlier dispatch or unknown confirmation. It
returns a fresh relay capability, revokes older ones and records the signed-byte hash
and history digest. It returns no bytes and permits no new claim or signature.

The app database and client's wallet journal have separate transactions. A lost claim
answer leaves the purchase readback-only; no capability or delivery is reissued.
If the client committed its handoff before the delivery was stored, resume remains
readback-only and a claim challenge reports `delivery_missing`. Start a new purchase.
The host supplies mounting and the admission, binding and stop inputs.

## Upgrade

The two delivery tables are added under schema version 3 with no migration. A version 3
data file written by an earlier build lacks them and is refused with
`purchase_state_schema_mismatch`. This pre-release build needs a fresh data directory;
the earlier file is not changed.
