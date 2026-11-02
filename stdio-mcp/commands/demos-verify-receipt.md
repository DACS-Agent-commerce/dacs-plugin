---
description: Verify a DACS receipt / artifact (bundle, agreement, settlement evidence) or a demos-mcp receipt
argument-hint: "<path to JSON file, or paste JSON>"
allowed-tools: Read, mcp__plugin_demos_demos__demos_network_info, mcp__plugin_demos_demos__demos_dacs_receipt_verify, mcp__plugin_demos_demos__demos_tx_get, mcp__plugin_demos_demos__demos_storage_read
---

Verify this receipt: `$ARGUMENTS`

1. If the argument is a file path, read the file; otherwise treat it as JSON.
2. Call `demos_dacs_receipt_verify` with the JSON as `receipt` (leave `check_chain` on). For a demos-mcp receipt, pass `expected_signer` = the issuer the user trusts (for receipts from this install: `receipt_issuer` from `demos_network_info`); for SettlementEvidence, the orchestrator's claim from the agreement.
3. Report the `decision` first, in plain words:
   - `accept` — every check passed.
   - `reject` — name each failed check and what it means.
   - `indeterminate` — NOT valid. Name what could not be established (for example an unresolvable signer claim, or a transaction the node did not return; on Demos "not found" is not proof of absence).
4. Never describe `indeterminate` as valid or "probably fine".
