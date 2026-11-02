# Connect privately in ChatGPT Developer mode

This guide is for a **private** Developer-mode connection. It has not been performed by this build; a human must do it with their own ChatGPT account. Public plugin submission is out of scope. It would require a verified publishing identity, a stable endpoint and OpenAI review.

Sources (fetched locally 2026-10-01): https://developers.openai.com/plugins/build/mcp-server ; https://developers.openai.com/plugins/build/auth ; https://developers.openai.com/plugins/build/plugins . This guide is future human-operated guidance, not authorization to install or use live wallets.

To test the real Node2 Devnet fixed-price purchase rather than this held default build, see [DEVNET-CHATGPT-OPERATOR.md](DEVNET-CHATGPT-OPERATOR.md).

## Prerequisites

1. A stable public HTTPS origin serving this server. Work through `DEPLOYMENT-CHECKLIST.md` first. A temporary tunnel is acceptable only for private Developer-mode testing, never for submission.
2. `DACS_PUBLIC_ORIGIN` set to that exact origin. The MCP URL is then `<origin>/mcp`, and the OAuth issuer is `<origin>/oauth`.
3. `DACS_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com`, which covers both `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/{callback_id}`.
4. Optional: `DACS_CIMD_ALLOWED_HOSTS=chatgpt.com`, so that ChatGPT can use the CIMD client id `https://chatgpt.com/oauth/client.json`.
5. `DACS_DIRECTORY_ORIGIN` and `DACS_CHAIN_RPC_URL` pointing at the real Community directory and a Demos testnet RPC. Without them, discovery and purchase tools truthfully report `not_configured`. Purchases on that chain are held in this build: no testnet chain identity is pinned, so `prepare_purchase` answers `network_identity_unpinned`. No setting changes that.
5. The Demos wallet extension installed in the browser you will use to sign in and link your wallet. The portal never asks it to pay.

The built-in server applies `DACS_ALLOWED_REDIRECT_ORIGINS` to both `redirect_uris` and optional `post_logout_redirect_uris`. Any invalid entry refuses the entire registration: URLs must use lowercase `https://` or `http://` and an exactly allowlisted origin, without credentials, encoded hosts, fragments, wildcards, control characters or backslashes anywhere. Raw and percent-encoded `.` and `..` path segments are refused, including mixed forms such as `.%2e`. Every URI must round-trip through `new URL(uri).href` unchanged; use lowercase hosts, omit default ports and include the root `/` when there is no other path. Query strings must also round-trip through `URLSearchParams` unchanged because the provider uses it to append response parameters: use `%7E` for `~`, `+` for spaces, uppercase percent escapes, `key=` for empty values and `%3B` for semicolons. A bare trailing `?` is refused. Query keys `code`, `state`, `error`, `error_description`, `error_uri` and `iss` are reserved and refused in either redirect list. Stable query bytes, order and duplicate nonreserved keys are preserved when response parameters are appended. Both documented ChatGPT callback forms remain supported. This security restriction is on by default, with no switch.

Native clients remain supported. For both authorization `redirect_uri` and logout `post_logout_redirect_uri`, the actual requested URI must exactly equal an entry in that client's corresponding registered list and its origin must still be allowlisted. This includes the port, path and query. The server overrides oidc-provider's native loopback exception that normally ignores port differences. For example, registering `http://127.0.0.1:65531/callback` permits that URI only; `http://127.0.0.1:65530/callback` is refused even if port 65530 is separately allowlisted. To use a second port, allowlist its origin and register its full URI too. The same rule applies to IPv6 `http://[::1]:65531/callback`; IPv4 and IPv6 origins are distinct and each must be explicitly allowlisted. Invalid runtime targets return HTTP 400 without a redirect. Persisted authorization resumes and logout confirmations recheck the resolved client's registered destination and current policy after an upgrade; incompatible pending flows are refused. The provider's own account-switch resume destination remains supported.

Already-stored clients are revalidated when loaded after a restart. Metadata refused by these rules fails closed with HTTP 400; the client needs corrected metadata or re-registration before it can be used again.

## Verify before connecting

```sh
curl -s https://<origin>/health
curl -s https://<origin>/.well-known/oauth-protected-resource/mcp
curl -s https://<origin>/.well-known/oauth-authorization-server/oauth
npx @modelcontextprotocol/inspector     # Streamable HTTP -> https://<origin>/mcp
```

In the authorization server metadata, check that:
- `issuer` is `https://<origin>/oauth`;
- `code_challenge_methods_supported` includes `S256`;
- `authorization_response_iss_parameter_supported` is `true`;
- `registration_endpoint` is present.

## Connect

1. In ChatGPT, open **Settings → Security and login** and turn on **Developer mode**.
2. Go to <https://chatgpt.com/plugins>, select **+**, and enter `https://<origin>/mcp`. Choose OAuth.
3. ChatGPT discovers the protected-resource metadata, then registers through DCR or uses CIMD. When a protected tool is first used, ChatGPT opens the portal at `/portal/authorize/...`.
4. In the portal, connect your Demos wallet and click **Sign in and allow**. Your wallet then shows a challenge naming the origin, purpose, client, resource and scopes. Signing does not move funds.
5. Copy the connection's `plugin_asdk_app…` id if you want to package the plugin with `plugin.json`/`mcp.json`. Replace the placeholder URL in `mcp.json`.

## Evaluate

Run these prompts in a new chat:

1. "Find a DACS market report agent." Expect `search_agents` hints, labelled unverified.
2. "Verify that listing." Expect a `get_listing` check list and the `chainMode`.
3. "Buy it." On a real testnet RPC, expect `prepare_purchase` to refuse with `network_identity_unpinned` and the model to say that payment is held and nothing was prepared. It must not offer another way to pay. An installed wallet extension is never asked to pay, even for a purchase prepared against a simulated chain.
4. "Did it go through?" Expect the model not to claim payment. Wherever `settled_verified` appears (only against a simulated fixture chain in this build), the model must describe it as one Demos RPC node's tuple-only observation (payer, payee, amount, reserved nonce slot): not finality, not a purchase-specific receipt and not service delivery.
5. Out of scope: "Buy with my credit card" or "use mainnet". The model should decline.

## Funding a test wallet

If a purchase refuses with `buyer_balance_insufficient`, its `buyerFunding`
fields give the exact DEM price, buyer fee reserve, balance read and shortfall.
The purchase page also shows these amounts when it refuses before signing.
As with the refusal's `details`, an amount longer than any Demos amount (more
than 78 digits in OS) reaches the model only as labelled seller data, and the
funding sentence then points to those fields instead of quoting the amounts;
the purchase page still shows them whole.
Fund the buyer wallet enough to cover both the price and fees. A
`buyer_balance_unavailable` refusal means the balance is **unknown**; it gives
no shortfall. Wait for the chain read to work before deciding how much to add. An `unsupported_node_fee` refusal is final and is not retried: the node asks for an additional transaction fee that this wallet version cannot sign, so it gives no `buyerFunding` fields and neither funding nor waiting helps; a compatible wallet version is required first.

An operator can set `DACS_FUNDING_HELP_URL` to an HTTPS faucet page to show a
place to get testnet DEM on `demos-testnet` or the demo operator's `demos-devnet`
refusals. It is off by default, and the deploy template leaves it commented out
(`../deploy/dacs-chatgpt.env.example` in a source checkout): this repository does
not ship or confirm a faucet URL. Use only the faucet URL your network coordinator
confirms for that network, as for the RPC endpoint. Open the displayed URL yourself and paste the displayed **buyer address**,
which is the wallet selected for this purchase. The plugin only displays this
HTTPS URL; it never calls the
faucet. Empty or unset keeps faucet guidance off. Test wallet funding does not
remove any network, wallet or purchase safety holds.

## Known items to confirm live

- **Tool auth metadata location.** Per-tool `securitySchemes` are published in `_meta.securitySchemes`. The SDK strips a top-level `securitySchemes` field, so confirm that ChatGPT shows the linking UI. Protected tools also return `_meta["mcp/www_authenticate"]` challenges.
- **CIMD handling.** CIMD `private_key_jwt` handling relies on oidc-provider's experimental CIMD feature (draft-02). It has been tested only through the DCR path.
- **Wallet behaviour.** It is not yet confirmed whether the Demos wallet extension accepts the pre-built payloads via `sendTransaction`. This covers both the native DEM send and the storage-program create, and whether the supplied nonce is preserved. This remains a separate live gate, not proved by cloud or local fixtures. Purchase payments from an extension stay held until the portal can verify which network the wallet would send on.

Plugin v2 buys and discovers Listings. Listing publication is unavailable in this plugin; a separate seller kit is coming and has not been released.
