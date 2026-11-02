# Node2 native transfer readback compatibility

This source-only compatibility rule applies only when the native transport compares an already retained, originally signed post-fork DEM send with `getTxByHash` execution content. It does not change signing, confirmation, broadcast, storage CREATE validation, transaction-hash checks, block membership, or no-resend fencing.

Node2 may project these equivalent JSON values:

| Signed retained field | Accepted Node2 projection |
| --- | --- |
| root `nonce`, root `timestamp`: safe non-negative integer | its exact canonical unsigned decimal string |
| root post-fork `amount`: canonical unsigned OS decimal string | the exactly equal non-negative safe integer number |
| `transaction_fee.network_fee`, `.rpc_fee`, `.additional_fee`: canonical unsigned OS decimal strings | the exactly equal non-negative safe integer numbers |

All other content remains structurally exact. In particular, payer, payee, native type, `data`, GCR edits, fee recipient, object keys, and nested amount-like fields receive no numeric normalization. Wrong values, leading-sign/leading-zero/decimal strings, fractional/negative/unsafe numbers, extra keys, and changed transaction hashes are rejected. The confirmed block must still contain the exact retained hash in ordered membership.

The deterministic regression uses only `.invalid` fetch stubs and an in-memory public journal. The accepting case marks only the exact retained intent and current wallet lane observed, keeps the original signed transaction/signature bytes unchanged, returns the original string amount in the receipt, and makes no confirm or broadcast call. Every rejected projection leaves the issued journal rows unchanged and therefore fenced against resend.

## Fee-display versus balance observation

No production fee change is justified by the evidence available to this task. The packaged wallet's approval total is intentionally the signed debit commitment: transfer amount + SDK 1 DEM gas edit + node-reported network fee + RPC fee + additional fee. Confirmation rechecks those exact GCR edits and fee fields before the single broadcast.

`getTxByHash` numeric projection establishes field equivalence, not how Node2 ultimately applies payer balance accounting. A balance difference can only be attributed after binding exact payer balance observations immediately before and after the inclusion block, excluding intervening transactions, and reconciling them against the retained GCR edits and fee recipient/routing rules. The existing documentation already calls the shown total an upper bound until that live charging behavior is established. This repair therefore changes no approval display, debit calculation, GCR content, fee value, or balance reader.

## Limits

This is ordinary offline source compatibility evidence, not a live Node2 recheck, wallet execution, independent finality proof, release approval, or DACS v0.1 acceptance.
