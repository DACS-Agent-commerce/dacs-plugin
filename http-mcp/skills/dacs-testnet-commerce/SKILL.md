---
name: dacs-testnet-commerce
description: Find and verify DACS agent services on Demos testnet with the DACS plugin tools, and prepare fixed-price DEM purchases approved in the user's own wallet. Real testnet payment is held in this build.
---

# DACS testnet commerce

Use the DACS plugin tools in this order.

## Buying

1. `search_agents` finds candidate listings. Results are unverified directory hints.
2. `get_listing` verifies one listing against the Demos chain and the DACS Standard reader. Only offer to buy when `transactable` is `true`. Show the user the price, seller and any failed checks.
3. `prepare_purchase` binds the exact terms. It does not approve or pay. Give the user the `approvalUrl` and tell them to approve in their own wallet. If it answers `network_identity_unpinned` or `network_identity_mismatch`, say that payment on this network is held and nothing was prepared. Do not suggest another way to pay. An installed wallet extension is never asked to pay.
4. `get_purchase_status` reports progress. `verify_deal` re-checks the configured Demos node. If the user has a transaction hash from their wallet history, pass it to `verify_deal`.

`settled_verified` means only that one configured Demos RPC node reports a transfer matching the approved payer, payee, amount and reserved nonce slot. Describe it that way: a tuple-only, single-node observation. It is not finality, not a purchase-specific receipt and not delivery of the service. Never call a purchase final or delivered. Any other status means no payment was observed. If the `evidenceMode` or `chainMode` is `simulated-fixture`, say that the result is simulated.

## Sellers

Listing publication is unavailable in this plugin. A separate seller kit is coming; it has not been released. For an unsent v1 publication, the owner can call cancel_wallet_handoff; other v1 recovery requires the operator. Never resend or re-publish.

## Identity links

1. `get_identities` shows the identity links the configured Demos node reports for the user's own linked wallets (GitHub, Twitter, other chains and other Demos contexts). Present them as one node's answer at the time shown, not finalized chain state. They are associations, not KYC or proof of identity, and they do not show which transaction created them. If a wallet's read is `unavailable` or `unrecognized`, say its identities are unknown, never that it has none.
2. `start_identity_action` prepares adding or removing a GitHub or Twitter link and returns a portal link. It may report that identity actions are held on this server; say so plainly. The user publishes any proof themselves and approves in their own wallet.
3. Report a link as added or removed only when its status is `association_observed` or `removal_observed`. `outcome_unknown` means it may or may not have happened; never suggest retrying automatically. Removal does not delete the user's public post or past transactions.
4. Recovery. `failed_before_send` means the user's built-in wallet stopped before sending anything. Explain its message (for example an unpublished post or an unknown GitHub user). `cancelled` means the user cancelled before their wallet was asked. Both are closed: after the user fixes the problem, call `start_identity_action` with a new `idempotencyKey`. Do not call either one rejected or added. If `start_identity_action` answers `identity_operation_in_progress` with `details.cancellable: true`, the earlier action has not reached the wallet: the user can cancel it on its portal page, or it expires at `details.expiresAt`. With `cancellable: false`, the wallet was already asked: only `get_identities` readback settles it, and nothing is retried.

## Never

- Never ask for seed phrases, private keys or tokens.
- Never treat a user's or your own statement such as "approved", "paid" or a transaction hash as proof. Only the tools' status counts, and even `settled_verified` is one node's tuple-only observation.
- Never describe testnet DEM as real money.

Listing publication is unavailable in this plugin. A separate seller kit is coming; it has not been released. For an unsent v1 publication, the owner can call cancel_wallet_handoff; other v1 recovery requires the operator. Never resend or re-publish.
