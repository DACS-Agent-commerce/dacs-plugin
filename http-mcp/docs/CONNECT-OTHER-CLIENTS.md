# Connect other MCP clients

This server exposes Streamable HTTP MCP at `<DACS_PUBLIC_ORIGIN>/mcp` and, in
`DACS_AUTH_MODE=builtin`, OAuth at `<DACS_PUBLIC_ORIGIN>/oauth`. Clients must
support authorization code with PKCE S256 and the MCP resource indicator.
OAuth sign-in still opens the wallet-signature portal in a browser; use a
browser with the supported Demos wallet. Signing in does not move funds.

**unrun:** Claude web, desktop and mobile custom connectors, Claude Code,
Codex CLI, Gemini CLI and VS Code have not been tested with real clients.
The automated tests use the real in-process authorization server and the MCP
SDK with ephemeral fixture wallets. There was no network access to confirm
client callback URLs or current setup instructions.

## Claude custom connectors (web, desktop or mobile)

Check the client's own documentation at setup for its **exact callback URL**,
OAuth support and any platform-specific requirements. Do not guess a callback
from the product's website or reuse one from another platform.

1. Add the callback's exact HTTPS origin to the comma-separated
   `DACS_ALLOWED_REDIRECT_ORIGINS`. An origin includes scheme, hostname and
   any non-default port; it excludes path, query and fragment. Keep
   `https://chatgpt.com` in the list if ChatGPT should keep connecting. For
   example, if the documented callback were
   `https://client.example:8443/oauth/callback`, append
   `https://client.example:8443` (illustration only, not a Claude callback).
2. If the client uses a Client ID Metadata Document (CIMD), add the exact
   hostname serving its HTTPS client-id document to `DACS_CIMD_ALLOWED_HOSTS`.
   Keep `chatgpt.com` if needed. This list controls document fetching and does
   not authorize redirect origins; both settings must be correct. Clients
   using dynamic client registration (DCR) need no CIMD hostname addition.
3. Restart the server with the changed environment, then configure the
   client's custom connector to use `<DACS_PUBLIC_ORIGIN>/mcp` and OAuth.
   Follow its sign-in flow and approve the wallet challenge in the portal.

Web clients remain subject to the redirect-origin allowlist. The loopback
switch below does not grant web clients additional redirects. These settings
apply to the built-in authorization server; an external issuer has its own
registration and redirect policy.

## CLI and native desktop clients

Claude Code, Codex CLI, Gemini CLI and VS Code may receive OAuth callbacks on
a local listener whose port changes between runs. Check each client's own
documentation and registration metadata before setup. To permit this pattern:

```dotenv
DACS_ALLOW_LOOPBACK_REDIRECTS=1
```

The default is `0` (off), and only the exact value `1` enables it. It is a
feature switch file, `src/switches/DACS_ALLOW_LOOPBACK_REDIRECTS.switch`
([SWITCHES.md](SWITCHES.md)), with no deploy restriction: `preflight-env`
accepts `0` and `1`. Enabling it allows DCR clients registering
`application_type: native` to use HTTP sign-in redirects (`redirect_uris`) on
exactly `127.0.0.1`, `[::1]` or `localhost`, with any valid port and path. No
redirect-origin addition is needed for those native HTTP loopback callbacks. A
client that omits `application_type` defaults to `web` and does not get this
allowance. No private-use URI scheme allowance is added. Logout redirects
(`post_logout_redirect_uris`) are not covered: they stay on
`DACS_ALLOWED_REDIRECT_ORIGINS` and must match a registered URI exactly.

With the switch off, a native client is treated like a web client: its
redirect must be on `DACS_ALLOWED_REDIRECT_ORIGINS`, and only the exact
registered URI is accepted at sign-in. oidc-provider alone would let any port
through for a native loopback redirect; the server's own redirect matcher
does not. So an allowlisted `http://127.0.0.1:<port>` origin admits only that
port. The MCP client SDK registers loopback redirects as `native` unless the
client says otherwise, and CLI clients usually choose a new port on each run,
so local MCP clients need this switch, not an allowlist entry.

Registration is open, so a client chooses its own `application_type` and
`client_name`. While the switch is on, the consent page labels native clients
as an unverified local app whose name is self-declared. Only approve one you
started yourself.

Loopback callbacks follow the same form rules as allowlisted redirects. A
redirect URI must be exactly what URL parsing serializes: it has a path (at
least `/`), no explicit default port such as `:80`, no leading zeros in the
port, no `.` or `..` segments, and query bytes that re-encode unchanged. It
may not use `code`, `state`, `error`, `error_description`, `error_uri` or
`iss` as query keys. Control characters, spaces, backslashes, `#` and `*` are
refused.

For example, with the switch on, a native registration for
`http://127.0.0.1:49152/callback` can authorize with
`http://127.0.0.1:49153/callback`. Only the port may differ (oidc-provider's
native loopback matching): the registered hostname, path and query must still
match. A client can register other paths, but cannot
substitute an unregistered path during authorization. Fragments and userinfo
are refused, as are look-alike hosts, shortened/numeric IP aliases and
IPv4-mapped IPv6 addresses. Non-loopback HTTP redirects are refused.

This switch does not require `DACS_ALLOW_INSECURE_LOCALHOST=1`; the server's
public origin should remain HTTPS. It does not change CIMD fetching, CORS,
PKCE or token/refresh policy. A client allowing the `refresh_token` grant can
refresh without `offline_access`, but those refresh tokens stay bound to the
roughly 24-hour sign-in session and stop working when it ends. Only tokens
issued with granted `offline_access` can outlive that session under the
existing 30-day stored expiry policy.

## Tools without the ChatGPT status card

All tools return text content, so a client can use them without rendering the
ChatGPT card. Some also provide structured content. Tool availability still
depends on the requested OAuth scopes and configured services:

- Public discovery: `search_agents`, `get_listing`.
- Account and wallet: `get_profile`, `get_account_status`, `get_identities`,
  `start_identity_action`, `start_wallet_link`.
- Purchase preparation and readback: `prepare_purchase`,
  `get_purchase_status`, `verify_deal`, `cancel_wallet_handoff`.

Open any returned portal/approval URL in the browser to complete the user's
wallet interaction, then use the status/readback tools. Client sign-in does
not enable held wallet writes or change purchase admission. An unknown write
outcome remains readback-only; do not retry a broadcast or request a second
payment.

Plugin v2 buys and discovers Listings. Listing publication is unavailable in this plugin; a separate seller kit is coming and has not been released.
