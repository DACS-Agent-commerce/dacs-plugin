# Exact native fee approval recovery

Fresh operator recovery accepts an issued native payment only when one retained approval proves the exact public wallet request. Native approval evidence now includes `requestProjectionFormat: dacs-node2-operator-native-payment-approval-request/v1` and `approvedRequest`. The request contains the public payer/payee, amount, nonce, complete debit display, network pin and RPC endpoint; the exact schema excludes unknown fields. Sign and Agreement CREATE evidence retain their existing representation. No private key, wallet inventory, token, seed or runtime credential is retained by this projection.

The existing request and approval hashes continue to cover `JSON.stringify(request)` and `JSON.stringify({scope,request})`. Recovery recomputes both from the retained request with its original field order. It also compares that request to the retained run, exact job/Agreement, amount, nonce and admitted stable network/RPC tuple. It verifies each signed network, RPC and additional fee independently, the null signed RPC fee recipient, fixed SDK gas and exact signed balance/nonce edit set, plus the original signature/hash/payment tuple. A matching total alone cannot establish authority.

Recovery may refresh a transport connection: an original approval's `connectionId` remains hash-bound public history, while equality across reconnects applies to network, chain identity, endpoint, pin version, transport authority and binding id. Requiring the old connection id would reject genuine fresh-process readback. Signed native transactions remain tuple-only evidence; this repair does not add native chain or purchase commitments or finality.

Missing, legacy hash-only, malformed, conflicting, rejected or ambiguous approval evidence holds. Legacy evidence cannot be upgraded by inferring fees from a candidate. An unreadable JSONL file or an unassignable native approval also holds. Valid approvals for a distinct job do not authorize the current job. Recovery continues to require one authentic issued candidate and verified original included readback; unavailable or mismatched readback holds. It never requests another approval or sends another payment.

Normal TTY approval still requires the operator to type the exact `APPROVE <approvalHash>` string. Configuration booleans are not authority. The existing explicit injected authorization callback is used only by the deterministic tests here.

| Changed contract | Entry point / helper / consumer | Accepting control | Negative or boundary outcome |
| --- | --- | --- | --- |
| Durable exact public request | `createExactBuyerApproval.approve`; `nativeRequestDebit` | Complete native request retains the same hashes and reconstructible public fields | Unknown or noncanonical native projection rejected; ceiling and scope mismatches reject before callback |
| Exact approval hash reconstruction | `readExactNativePaymentApproval`; actual operator `createBuyerDriver` recovery callback | Round-trip request/approval hashes match the authorizer and evidence | Mutated request, bad request/approval hash, unknown schema and legacy evidence HOLD before readback |
| Exact fees and gas | `recoverIssuedPayment`; signed native journal candidates | Authentic OS-string and whole-DEM candidates recover the original hash | Same-total network/RPC or additional-fee splits, RPC recipient, gas or custom-charge changes HOLD; zero wallet sends or new approvals |
| Exact source binding | `recoverIssuedPayment`; retained intent, approval and issued row | Same stable tuple with a fresh connection id recovers | Endpoint/network/chain/pin/authority/binding changes or conflicting signed aliases HOLD before readback |
| Unique authorization and original issuance | `recoverIssuedPayment`; JSONL evidence and native journal | Exact job approval selected independently of unrelated valid jobs | Missing/unreadable/unassignable/duplicate/conflicting evidence and absent/invalid/ambiguous candidates HOLD |
| Existing unknown/no-resend behavior | `recoverIssuedPayment`; source binding readback | Included original receipt recovers | Unavailable or mismatched readback HOLD with zero new sends/approvals/journal writes |
| Existing normal approval | Sign flow and exact native scope/ceiling | Normal sign approval is retained and consumes its expectation | Non-TTY operation and an `approved:true` flag fail; scope/ceiling differences fail before callback |

Run the focused cases using the repository's locked Node runtime:

```sh
node --experimental-vm-modules --disable-warning=ExperimentalWarning --test test/fee-approval-recovery-offline.test.mjs
```

The unchanged default `node --test test/fee-approval-recovery-offline.test.mjs` also discovers this file and starts the same flagged test child. It removes only the inherited Node test-runner context and requests TAP explicitly, so the parent checks the child's exit and pass/fail/skip summary.

These source-only cases load the actual `operator.mjs` module, construct `createDevnetDemoOperator`, attach an inert composition, call its `createBuyerDriver`, and invoke the real captured `recoverIssuedPayment` callback. They use genuinely verified ephemeral test-owned Ed25519 signatures over deterministic public transaction content. HTTP/HTTPS listeners, custody, seller composition, buyer driver transport and chain readback are explicit inert mocks; TLS is never established, wallets are never created, and no RPC, faucet, purchase or public effect occurs. A JSON realm bridge passes fixture data to the actual pinned SDK canonicalizer because it deliberately rejects foreign Array prototypes. This evidence proves the operator recovery boundary and fail-closed controls, not packaged-wallet signing, real driver resume/MCP, seller delivery, live end-to-end purchase, native readback authenticity or v0.1 acceptance. Those interactions are not covered here.
