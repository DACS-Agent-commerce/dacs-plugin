> Historical v1 launcher procedure. Both demo launchers are retired in v2 and refuse before loading configuration. Retained recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})` for original readback; never resend or re-publish. The examples below describe the earlier v1 CLI only.

# Devnet operator purchase CLI

In v1 the built-in CLI held before payment because independent finality of the seller commitment is not established. A fresh key could publish the pre-payment artifacts but sent no native payment and produced no report. Resuming the same held key kept the operation held; a new key was no way around the gate. Recovery of already-issued payments used only the retained original payment hash and authorized no new payment.

`scripts/devnet-demo-purchase.mjs` is retired and refuses startup. The historical v1 invocation accepted one durable run argument:

```sh
# Historical v1 only: node scripts/devnet-demo-purchase.mjs --config=/absolute/operator.json --idempotency-key=<new-key>
# Historical v1 only: node scripts/devnet-demo-purchase.mjs --config=/absolute/operator.json --resume=<same-key>
```

The command requires a real terminal. Every seller CREATE and every buyer signature, Agreement CREATE, and native payment prints its complete public request plus an approval hash. Approval requires typing `APPROVE <that exact hash>`. Blank input, an altered hash, or any other response is a normal rejection. The operator config supplies fee ceilings but cannot approve a request, unless it turns on seller policy mode (off by default; see [SELLER-POLICY-AND-DELIVERY-EVIDENCE.md](SELLER-POLICY-AND-DELIVERY-EVIDENCE.md)), which decides the purchase's seller CREATEs by a fixed policy. Buyer approvals stay manual.

The CLI test runs this unchanged script as a subprocess under an OS pseudo-terminal. Its controller independently recomputes the displayed request and approval hashes, checks buyer and seller identities, Listing pin, job, Agreement, network identity, payment amount, payee, purpose, and the complete debit components before entering the exact response. It does not inject an approval callback or call the buyer driver directly.

An already-completed key from an earlier or separately authenticated composition can be resumed by a later whole process using the same private state and custody directories. Resume authenticates again, returns the original operation, payment, and report, and performs no CREATE, payment, or transaction approval. A deliberate new key has its own operation, job, Agreement and approvals, then stops at the current finality hold. In a separately authenticated composition that can reach a native-payment prompt, rejecting that prompt retains a declined result and performs no transfer.

The tests use a source-owned loopback Node2 process, test-owned throwaway custody, explicit test CA routing, and normalized source block time. They are not public Node2, live DEM, consensus finality or full DACS acceptance evidence, and they are not a security review.
