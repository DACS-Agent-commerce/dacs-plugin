# Sequential devnet operator purchases

The built-in devnet operator may execute more than one purchase in sequence with the same seller custody session. Each purchase still has its own buyer idempotency key, operation, job, Agreement, payment, seller evidence, deliverable, and exact buyer/seller approvals. The published Listing is reused.

## Seller wallet journal routing

The seller keeps one packaged SDK wallet session and one nonce authority. `walletFactory({ anchorJournal })` returns a serialized facade over that session. For the duration of each wallet request, an asynchronous request-local context routes the SDK wallet's atomic journal calls to the journal supplied by the bridge or artifact anchor. Outside that context the custody journal remains the default.

This routing is necessary because the SR-2 bridge reconciles `sr2/wallet/*` records. Writing the same genuine signed transaction to the custody journal under the SDK's unprefixed key leaves the bridge handoff pending even when Node2 accepted it. The facade does not copy, synthesize, or mark a receipt verified; it only lets the existing bridge consume the authentic wallet record it requested.

Requests remain serialized. Journal selection is request-local rather than a mutable global delegate: the operator does not redirect an in-flight request, create a second signer session, or split nonce ownership.

## Restart and uncertain readback

Completed buyer runs retain their own public receipt and private resume capability. After a full operator restart, resuming either completed key reads and returns its original report and payment hash without another CREATE, DEM transfer, or transaction approval. A fresh OAuth wallet signature is still required for each resumed application session.

If the original seller source readback is unavailable after an applied SettlementEvidence CREATE, the existing adapter and wallet records remain pending. A distinct next key is held before prepare, so it creates no operation, job, approval, CREATE, or DEM transfer. Reading an older completed run after restart does not release or overwrite that newer pending lane.

These guarantees are exercised by `test/devnet-operator-sequential-prefixed.test.mjs` through the real loopback operator app, OAuth/MCP/portal flow, packaged SDK wallets, seller bridge, native source, and durable buyer-run store. The test source is deterministic and owned by the test harness; it is not public Node2 finality or live DEM evidence.
