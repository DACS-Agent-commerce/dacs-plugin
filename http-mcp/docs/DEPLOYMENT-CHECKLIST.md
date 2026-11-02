# Deployment-ready checklist (no deployment authorized in this build)

Tick each item on the target host before connecting ChatGPT. Nothing here has been deployed.

## Build

- [ ] `npm ci --ignore-scripts` from `package-lock.json`. The vendored SDK is pinned by sha512 integrity.
- [ ] `npm test`, `npm run test:browser` and `npm run check:package` all pass on the release commit.
- [ ] Canonical deployment bundle: from the `http-mcp/` package root, use `docker build -f deploy/Dockerfile -t dacs-chatgpt-plugin:1.0.0 .` (see `../deploy/RUNBOOK.md` in the plugin source checkout; the `deploy/` bundle is not part of the installed package). It runs as `node`, uses `/var/lib/dacs-chatgpt` for persistent data, includes `HEALTHCHECK`, and declares `STOPSIGNAL SIGTERM`. An actual image build and container run remain unverified; the simpler root `Dockerfile` is a separate alternative and its `/data` layout is not interchangeable with this bundle.

## Configuration (host secret manager; never commit)

- [ ] `DACS_PUBLIC_ORIGIN` is the final stable HTTPS origin. Changing it changes the OAuth issuer and the token audience.
- [ ] `DACS_OAUTH_COOKIE_KEYS`: one or more random keys of at least 32 characters each. Rotate by prepending a new key.
- [ ] `DACS_DATA_DIR` is on persistent, backed-up storage. The SQLite database holds:
  - accounts and wallets, operations, approvals and write coordinates;
  - OAuth grants;
  - the server's token signing keys.
- [ ] `DACS_TRUST_PROXY=1` only behind a TLS-terminating proxy you control.
- [ ] `DACS_DIRECTORY_ORIGIN` is the Community directory HTTPS origin.
- [ ] `DACS_CHAIN_RPC_URL` is a Demos testnet RPC. Confirm `DACS_DEM_AMOUNT_ENCODING` matches the network's OS-denomination fork state.
- [ ] `DACS_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com` and `DACS_CIMD_ALLOWED_HOSTS=chatgpt.com`.
- [ ] For an external IdP: set `DACS_AUTH_MODE=external` and `DACS_OAUTH_ISSUER` to the exact issuer.
  - The IdP must put the MCP resource URL in `aud`.
  - It must support S256 PKCE.
  - It must return `iss` in authorization responses.

## Network and operations

- [ ] HTTPS only. The proxy forwards `/mcp` without buffering SSE, plus `/oauth`, `/portal`, `/.well-known` and `/health`.
- [ ] A single replica is recommended. SQLite in WAL mode is multi-process safe on one host, and the rate limiter is per-process, so also rate-limit at the proxy.
- [ ] Logs show method, path, status and duration only. Confirm that no `Authorization` headers, query strings or bodies are logged by the proxy.
- [ ] Monitor `/health`, 5xx rates and `mcp_protocol_error` / `tool_error` log events.
- [ ] Backups of `DACS_DATA_DIR`. Losing the database orphans OAuth links and pending operation coordinates.

## Public-directory eligibility (open question, not verified)

- [ ] **Commerce category.** On 2026-10-01 we re-fetched OpenAI's ChatGPT UI guidance (<https://developers.openai.com/plugins/build/chatgpt-ui>). Its checkout guidance limits generally approved commerce to **physical goods** unless OpenAI explicitly enables another category.
  - This plugin sells agent **services** on **Demos testnet**, so its eligibility for public-directory submission is **not verified** and must not be promised.
  - This is not a definitive rejection. Private Developer-mode connection is a separate, still-unverified gate; it does not establish public-directory eligibility.
  - Resolving it needs OpenAI's review and any explicit enablement, through the normal submission process. The plugin's scope has not been changed for it.

## Before calling anything "live"

- [ ] At least one listing verified with `chainMode: public-chain-read`, meaning not `simulated-fixture`.
- [ ] A genuine wallet `sendTransaction` exercised on testnet with the user's approval. Funded execution was not authorized in this build.
- [ ] A private Developer-mode connection performed by the human owner (`CHATGPT-DEVELOPER-MODE.md`).
