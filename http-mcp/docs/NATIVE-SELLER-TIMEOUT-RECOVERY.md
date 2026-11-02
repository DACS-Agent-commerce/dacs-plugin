# Native seller timeout recovery

This source-only test contract covers a seller operation that runs longer than
the buyer client's 15-second HTTP bound. A timeout is an unknown result: it does
not authorize another payment, another CREATE, lock reclamation, or success.

The actual seller already retains `nativeEvidenceWork` before the wallet
boundary. Its authenticated `/dacs/v1/payments` reconciliation checks the exact
transaction, payer, Agreement, commitment, SDK permit, signed projection, and
fresh native readback before advancing delivery. This path is not legacy-only.

The deterministic witness delays the return from one genuine SettlementEvidence
wallet CREATE by 16 seconds. While that original job owns the durable job fence,
four exact authenticated retries remain held and cause no extra effects. After
the original job naturally releases the fence, one exact retry recovers the
same purchased report with seven total CREATEs, one payment, and zero resends.

The application consumer test now waits for its owned in-flight seller job to
finish before spending its existing four read-only retry attempts. Cleanup also
waits for the owned job before closing SQLite stores and loopback servers. This
is test lifecycle synchronization, not timeout inflation or a production
success shortcut. Product guards, the 15-second client bound, assertions,
wallet approvals, signatures, receipts, SDK phases, and no-resend behavior are
unchanged.

Scope is owned-loopback TEST only. It establishes neither Node2 finality nor a
live fixed-price, security, release, or deployment acceptance.
