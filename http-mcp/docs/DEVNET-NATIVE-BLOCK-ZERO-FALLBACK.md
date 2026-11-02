# Devnet native Node2 block-zero fallback

The Demos network binder already supports one reviewed compatibility policy: when block zero is the literal string `error`, it may authenticate the independently pinned chain identity from a confirmed block-one predecessor. The policy is default-absent and requires `{ blockZeroUnavailable: "literal-error", documentation: "<reviewed reference>" }`.

Node2 has used two distinct representations for that result. Legacy run-scoped admissions convert only the exact two-field object `{ "result": 400, "response": "error" }`. The current observed representation is `{ "result": 400, "response": "error", "require_reply": false, "extra": "Block number not provided" }`; it is converted only when the observation and operator-reviewed admission contain the exact envelope token `node2-result-400-error-require-reply-false-block-number-not-provided/v1`. The two policies are not interchangeable.

Both conversions apply only to the block-zero binder read and only when the binder's non-null fallback policy has already passed synchronous schema validation. The transport passes the binder its existing literal `error`; the binder still performs the block-one, predecessor, expected-identity, status, freshness, connection, and pin checks.

The conversion does not apply by default, at block one, to result-400 null-extra envelopes, to missing/changed fields, to arbitrary extra text, to any other status, to null or malformed data, or to transport failures/timeouts. It does not change ordinary RPC handling, create a pin, authorize a wallet, or weaken signed/broadcast/readback paths.
