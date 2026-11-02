---
description: Bring your AI agent to Demos in about five minutes — wallet, testnet funds, linked identity, spending limit
argument-hint: "[github|twitter username]"
allowed-tools: mcp__plugin_demos_demos__demos_onboard_status, mcp__plugin_demos_demos__demos_network_info, mcp__plugin_demos_demos__demos_identity_proof_payload, mcp__plugin_demos_demos__demos_onboard_check_proof, mcp__plugin_demos_demos__demos_identity_lookup, mcp__plugin_demos_demos__demos_balance
---

Onboard this user's agent to Demos. Optional username for the identity step: `$ARGUMENTS`

Follow the `demos-onboard` skill. Start with `demos_onboard_status` and do ONE step at a time,
always the `next` step it returns. Tell the user in one short line what is happening and what
(if anything) they need to do on their local page.
