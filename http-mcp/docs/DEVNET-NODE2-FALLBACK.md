# Node2 single-node TEST identity fallback (block-one predecessor)

Status: opt-in, run-scoped, single-node TEST source change. Not a production trust pin, quorum finality or live E2E result.

## What changed (owned files only)

- `src/devnet-demo/operator-network.mjs`
  - `observeNode2Identity({..., blockZeroUnavailable:'literal-error', timeoutMs=10000})`. Without the option, behavior is byte-identical to before: one block-zero read, and the same refusal text.
    - With the option, a valid block zero still yields the unchanged v1 record.
    - Only an exact block-zero SDK envelope starts the fallback: the legacy keys `{result,response}`, the legacy result-200/null-extra shape, or the observed exact result-400 shape `{result:400,response:'error',require_reply:false,extra:'Block number not provided'}`. That leads to one block-one read under the same deadline.
    - The observed string-extra representation is named in the hashed observation; it is not conflated with the legacy two-field or null-extra shapes.
    - Block one must be an exact `result:200` envelope. Its block must have `number === 1`, any `id` equal to 1, and `status:'confirmed'`. Its `hash` and `content.previousHash` must be canonical lowercase 64-hex, and the two must differ. Any `previousHash`/`chainIdentity`/`genesisHash` alias must equal the predecessor. The two reads must be in order and at most 60000 ms apart.
    - The result is `dacs-node2-single-node-predecessor-observation/v1` with `identitySource:'confirmed-block-one-predecessor'`, `blockZeroResult`, `blockOneHash` and a run-scope statement.
  - `admitObservedNode2Identity` dispatches predecessor observations.
    - To admit one, the operator must review `reviewedIdentitySource:'confirmed-block-one-predecessor'`, `reviewedChainIdentity` and `reviewedBlockOneHash`, and supply a `TEST-` pin version. An observation of the current string-extra envelope additionally requires `reviewedBlockZeroEnvelope` to equal its recorded token.
    - The admission (`dacs-node2-single-node-predecessor-test-admission/v1`) keeps `identitySource`, `blockOneHash` and a derived `fallbackDocumentation` that embeds the observation hash.
    - Block-zero admissions are unchanged (v1 format and keys), and they refuse predecessor review material.
  - `readNode2Admission` verifies both formats exactly. A predecessor admission is checked against its schema, derived documentation, TEST pin, trust text and order-independent hash.
  - `createAdmittedNode2DemoTransport` passes the protected binder's existing strict `{blockZeroUnavailable:'literal-error', documentation}` policy **only** for a re-verified predecessor admission. Block-zero (v1) admissions pass `fallback:null`, as before.
- `scripts/devnet-demo-operator-bootstrap.mjs`
  - `observe` adds `[--block-zero-unavailable=literal-error]`.
  - `admit` adds `[--reviewed-identity-source=confirmed-block-one-predecessor --reviewed-block-one-hash=<64hex> --reviewed-block-zero-envelope=<recorded-envelope>]`; the last option is required only when the observation records the current four-field envelope.
  - Default commands and outputs are unchanged.

Consumers: `src/devnet-demo/operator.mjs` already composes `readNode2Admission → createNode2TransportOwner → createAdmittedNode2DemoTransport`. It needs no change and picks up predecessor admissions automatically.

## Current source behavior

The bounded read-only observation returned `{result:400,response:"error",require_reply:false,extra:"Block number not provided"}`. The native transport maps that object to the binder's existing literal marker only when the exact envelope token is present in an independently hashed and explicitly reviewed predecessor admission. A legacy admission still maps only its exact two-field result-400 representation. Null-extra, cross-policy substitutions and changed shapes stay held.

This is source-only compatibility behavior. The protected binder and locked SDK are unchanged. Offline tests prove the exact observation/admission/transport composition and negative boundaries; they do not prove a new public Node2 run.

## Not done / not claimed

- No public Node2 call, wallet, faucet, signature or broadcast.
- No live E2E and no deploy approval. The external security review is on hold.
- Any observed block hash remains run-scoped single-node TEST material, not a production pin.
