> Historical v1 launcher procedure. Both demo launchers are retired in v2 and refuse before loading configuration. Retained recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})` for original readback; never resend or re-publish. The examples below describe the earlier v1 CLI only.

# Built-in buyer run recovery

The Node2 demo operator retains one buyer run across an application, seller and operator restart. The durable private record binds the idempotency key to the exact buyer, seller, Listing, network identity, operation, job, Agreement and (once returned by the packaged wallet) native payment hash. OAuth credentials and cookies are not persisted. The portal handoff capability is private and never appears in the public receipt or command output.

`driver.resume({ idempotencyKey })` and the CLI `--resume=<same-run-id>` authenticate the same buyer afresh. They use MCP `get_purchase_status` first. A delivery-ready operation is independently read back from the native source. A non-ready operation is reported through the portal only when the original canonical payment hash and original private capability are both retained; no wallet request is made. Missing proof stays `held` with `noResend: true`.

| Case | Expected durable behavior | Source effects on resume |
| --- | --- | --- |
| Completed purchase, then restart | Same operation/job/Agreement/payment/report; fresh native report readback | 0 CREATE, 0 DEM, 0 transaction approvals |
| Portal response lost after an applied report | Original payment hash survives; restart reconciles that hash and returns the authentic report | 0 CREATE, 0 DEM, 0 transaction approvals |
| Exact native payment approval declined | Rejected decision survives; the open session asks the app to cancel the handoff, which it does only from chain-nonce and source-journal proof that nothing was sent; resume returns it locally (an older decline without that record connects once to ask) | 0 payment, 0 source effects; 0 approvals on resume once cancellation is recorded |
| No retained payment hash | Explicit held result | no report guess, resend or replacement purchase |
| New key while an old seller evidence plan cannot be released | Held before `prepare_purchase` | 0 new operation, CREATE, DEM or approval |

The public receipt is an operational receipt, not finality or service acceptance. It reports one-node TEST inclusion limits and `humanAcceptance: not-recorded`.

## Commands

Start a fresh run:

```sh
# Historical v1 only: node scripts/devnet-demo-purchase.mjs --config=/absolute/operator.json --idempotency-key=<fresh-run-id>
```

Resume exactly that run after restart or response loss:

```sh
# Historical v1 only: node scripts/devnet-demo-purchase.mjs --config=/absolute/operator.json --resume=<same-run-id>
```

Keep the same private `stateDirectory`, custody directory, admitted network pin and exact config. Never copy the private run record into logs or evidence.

## Remaining sequential-job boundary

The current protected SR-2 bridge can retain an older seller SettlementEvidence plan at `handoff-issued` while the independently authenticated source record has already supported delivery-ready. Its readback-only `resume` can still return `authorization-required`. The operator therefore refuses a distinct new key before creating an operation. The compatible repair belongs in the protected bridge/adapter: authenticate the exact retained wallet journal record, original public signed projection and fresh native inclusion, then move only that old plan to `verified`. The repair must never issue another handoff or infer authorization from a status string.
