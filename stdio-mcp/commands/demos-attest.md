---
description: Link a GitHub / X / Discord account or a domain to your Demos wallet (human-confirmed)
argument-hint: "<github|twitter|discord|domain> <username or hostname>"
allowed-tools: mcp__plugin_demos_demos__demos_network_info, mcp__plugin_demos_demos__demos_identity_proof_payload, mcp__plugin_demos_demos__demos_identity_lookup
---

Attest an identity for: `$ARGUMENTS`

Follow the `demos-safe-flow` skill. Steps:

1. Call `demos_network_info`. If writes are disabled, explain how to enable them (plugin settings: enable writes + keystore) and stop.
2. Call `demos_identity_proof_payload` with the context and username/hostname. Show the proof text and tell the user exactly where to publish it (public gist / post / Discord message, or `https://<host>/.well-known/demos-cci.txt`). Wait until they confirm it is published and give you the URL (for domains, the hostname).
3. Call `demos_identity_attest_prepare` with the kind and the proof URL/hostname.
4. Tell the user in one line what is waiting (the card headline) and ask them to approve or deny it on the out-of-band approval page (or type the fallback code).
5. Call `demos_tx_submit` with the `prepared_id` and `wait_seconds: 120`, passing `confirmation_code` only if the user typed one. Never open approval links or guess codes.
6. Show the receipt, then `demos_identity_lookup` for the wallet to confirm the link.
