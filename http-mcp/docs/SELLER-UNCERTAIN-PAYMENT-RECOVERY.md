# Seller uncertain-payment recovery

This repair is limited to the authenticated seller `/payments` reconciliation
path for a durable native `SettlementEvidence` work checkpoint. It does not
make an HTTP retry authoritative and it does not retry a wallet operation.

When the original CREATE may already have applied, the seller now reduces the
retained checkpoint only after all of these existing authorities agree:

- authenticated transport scope, buyer, seller, job, Listing and Agreement;
- retained payment hash, payer, settlement binding and evidence content hash;
- the SDK receipt-store permit for the same authorization (available or the
  same already-consumed fulfilment handoff);
- the seller writer, logical address, signed CREATE projection, native receipt
  and the included payment tuple observed through the pinned source reader.

Only a `present` authenticated read persists the recovered public projection
and receipt. A retry never invokes `anchorEvidence`. Missing, malformed,
conflicting, wrong-writer, wrong-content and wrong-payment observations stay
held. Once recovered, the seller enters the existing durable SDK delivery WAL;
an already-consumed permit resumes only its retained fulfilment.

The owned-loopback regression injects a failure after the genuine
`SettlementEvidence` wallet CREATE applies but before its receipt/projection is
saved in seller state. The cached `operation_uncertain` command then recovers
the same job, Agreement and payment, creates one Deliverable, and remains
effect-free across restart/replay. It also retains the pre-existing lost
Deliverable-response recovery.

Limits: this is ordinary SOURCE/owned-loopback evidence. The test restarts the
application and seller services and creates a fresh seller-agent instance in
the same Node test process. A distinct-OS-process seller-state reconstruction
was not executed. Public Node2, faucet, real wallets/DEM,
TLS effects, independent finality, live E2E and the separate
issued-fee-approval limitation remain outside this result, and it is not a security review.
