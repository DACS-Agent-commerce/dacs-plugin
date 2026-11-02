> Historical v1 launcher procedure. Both demo launchers are retired in v2 and refuse before loading configuration. Retained recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})` for original readback; never resend or re-publish. The examples below describe the earlier v1 CLI only.

# Node2 Devnet operator in ChatGPT Developer mode

The built-in Node2 Devnet operator (`DEVNET-FIXED-PRICE-DEMO.md`) normally listens and advertises only on loopback. For a **private** ChatGPT Developer-mode test it can keep listening on loopback while advertising a public HTTPS origin served by a TLS-terminating tunnel or proxy. Use `scripts/devnet-demo-compose.mjs`, not `devnet-demo-purchase.mjs`: ChatGPT drives the buyer, and the local CLI buyer driver refuses this mode.

## Configuration

Add two optional keys to the exact operator config:

```json
{
  "externalOrigin": "https://<tunnel-host>",
  "allowedRedirectOrigins": ["https://chatgpt.com"]
}
```

- `externalOrigin` must be an exact public HTTPS origin (no path, credentials, query or loopback host). It becomes `DACS_PUBLIC_ORIGIN`, so the OAuth issuer is `<origin>/oauth` and the MCP URL is `<origin>/mcp`; `DACS_TRUST_PROXY=1` is set only in this mode.
- `allowedRedirectOrigins` (one to four HTTPS origins) is accepted only with `externalOrigin`; the advertised origin is always allowed.
- `publicOrigin`, the seller and the directory still listen on loopback. Host validation accepts the advertised host plus loopback for the in-process wallets.

Point the tunnel at `publicOrigin` (for example `cloudflared tunnel --url http://127.0.0.1:<port>`), put its URL in `externalOrigin`, then start compose in a TTY so the seller's exact CREATE approvals can be reviewed.

## What ChatGPT sees

When the app is composed with the Devnet Agreement transport plus native seller commitment and delivery, the MCP instructions and `prepare_purchase` description state that purchases are real fixed-price DEM purchases on Demos Devnet, and `prepare_purchase` defaults to protocol `dacs-sr2-wallet-agreement`. Other builds keep the default "real testnet payment is held" wording and no default protocol.

Access tokens are bound to the MCP resource, so OIDC userinfo could only answer 401; ChatGPT treated that as a failed connection. Userinfo is not enabled or advertised. OAuth errors (`oauth_error`), refused bearer tokens (`mcp_bearer_refused`) and each tool's outcome (`mcp_tool`) are logged with codes, scopes and result only, never token values, arguments or bodies.

## Buyer wallet

The test seller authenticates seller-peer requests only as the operator's own test buyer custody. In the portal, import that throwaway buyer's recovery phrase into the embedded wallet through a private local channel (never chat, logs or config) and link that exact address; another wallet is refused at the Agreement step and has no test DEM.

## Limits

This is a temporary private test exposure of a single-node TEST target, not deployment, public-directory submission or production trust. Anyone with the tunnel URL can reach the server while it runs; every seller CREATE still needs the operator's exact approval, and only the test buyer can complete a purchase. A quick tunnel changes its URL on restart, which requires re-adding the plugin.
