---
description: Buy something on Demos — accept a signed DACS offer and pay, or send DEM (human-confirmed)
argument-hint: "<offer JSON / file path>  |  <amount DEM> to <0x address>"
allowed-tools: Read, mcp__plugin_demos_demos__demos_network_info, mcp__plugin_demos_demos__demos_balance, mcp__plugin_demos_demos__demos_dacs_receipt_verify
---

Purchase request: `$ARGUMENTS`

Follow the `demos-safe-flow` skill exactly.

1. Call `demos_network_info`; if writes are disabled, explain how to enable them and stop. Note the daily cap remaining.
2. If the request is a DACS offer (JSON or a file path):
   - Call `demos_dacs_receipt_verify` on it and report the result (an offer signed only by the seller is expected to be `indeterminate` until countersigned; any `reject` means stop).
   - Call `demos_dacs_accept_prepare` with the offer (`pay: true`).
3. If the request is a plain amount and address, call `demos_tx_prepare` with `to` and `amount_dem`.
4. Tell the user in one line what is waiting (the card headline: what is bought, amount, fee, total, recipient, network). Ask them to approve or deny it on the out-of-band approval page (or, as a fallback, to type the code).
5. Call `demos_tx_submit` with the `prepared_id` and `wait_seconds: 120`, passing `confirmation_code` only if the user typed a fallback code. Never open approval links or guess codes. If they deny, stop.
6. Show the receipt (tx hash, state, block) and, for an offer, the countersigned agreement. If the state is `pending`, tell the user to check later with `demos_tx_get` and NOT to resubmit.
