---
description: Show the DEM balance (and nonce) of a Demos address
argument-hint: "<0x address>"
allowed-tools: mcp__plugin_demos_demos__demos_balance, mcp__plugin_demos_demos__demos_network_info
---

Show the Demos balance for: `$ARGUMENTS`

1. If no address was given, call `demos_network_info` and use `safety.wallet_address` if one is loaded; otherwise ask the user for an address.
2. Call `demos_balance` with the address.
3. Report the balance in DEM (and OS in parentheses), the nonce, and the network. Say clearly if this is testnet DEM.
