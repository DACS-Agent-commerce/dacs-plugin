# DACS ChatGPT plugin (partial v2, package 1.0.0, private)

**Not ready for public deployment.** Buyer SDK integration and
browser protocol migration remain incomplete. Listing publication and the
in-process demo seller are retired. A separate seller kit is coming; it has
not been released. Contact the operator about any open v1 publication.

A separately installable Node package. It lets a ChatGPT user:

- discover signed DACS seller agents;
- independently verify a listing against the Demos chain and the DACS reader;
- link their own account and wallet;
- prepare a fixed-price DEM **testnet** purchase that they approve in their own wallet;
- inspect durable progress and independently checked evidence.

Status: **partial v2 has not been accepted for deployment.** Outstanding:
- every live check: an installed Demos wallet, the Demos testnet node, and ChatGPT developer mode;
- the open items listed in `docs/TESTER-QUICKSTART.md` under "Unresolved before real-wallet use".

The external security review is on hold.

## State of this repository

This package does not install or start here, and about half of its tests fail.

- `package.json` depends on a vendored SDK archive (`vendor/`) that is not in
  this repository, so `npm ci` stops with a missing-file error.
- `src/app.mjs` and nine other modules import modules that are not carried
  (`src/dacs/` and five related modules; see `PROVENANCE.md` at the repository
  root, "Not carried"), so the server stops at startup with a module-not-found
  error. That code is planned to come from the published SDK instead.
- The test files that import those modules fail when they load. `npm run
  test:ci` runs every file under `test/` and reports those as failures
  (`docs/CI.md`, "Carry-over entries").
- The "Local startup" and "Tests" steps below, and `docs/TESTING.md` and
  `docs/CI.md`, describe the source tree this package was imported from. They
  cannot be followed here until the switch to the published SDK is done.

Every result recorded for this build is from simulated local fixtures. Testnet only: no mainnet, no real money, no hosted seller code.

Trying the package? Start with `docs/TESTER-QUICKSTART.md`. For extension-free
offline testing, `docs/OFFLINE-TESTER.md` describes the shipped fixture operator:
browser-held wallet creation/import, linking, native fixed-price purchases and
GitHub/Twitter add/remove. All writes are explicitly simulated; normal server
writes remain held/default-off. Listing publication is unavailable in this plugin.

## Architecture

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP via `@modelcontextprotocol/server` 2.2.0 `createMcpHandler`. Serves 2025-era clients through the stateless fallback and 2026-07-28 clients per request. Anonymous calls are allowed. A presented bearer token must verify. |
| `GET /health` | Liveness and configuration status. It never reports chain, payment or ChatGPT installation success. |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata. `resource` is `<origin>/mcp`. |
| `/oauth/*` | Built-in OAuth 2.1 authorization server (`oidc-provider` 9.12.2). Details below. |
| `/portal/*` | Trusted wallet signing portal. ChatGPT links out to it, because a wallet extension cannot be assumed inside the ChatGPT iframe. |

The built-in authorization server provides:
- authorization code with PKCE S256, which is mandatory;
- RFC 8707 resource indicators, issuing RFC 9068 JWT access tokens with `aud` set to `<origin>/mcp`;
- RFC 9207 `iss` on every authorization response;
- dynamic client registration and Client ID Metadata Documents, both allowlist-restricted;
- refresh tokens for every client that allows the `refresh_token` grant. Without `offline_access`, which ChatGPT does not request, a refresh token stops working when the ~24 h sign-in session ends; with it, a refresh token lasts up to 30 days;
- durable SQLite storage.

A user signs in by signing a fresh, one-use wallet challenge. The challenge is bound to the domain, its purpose, the OAuth interaction, the client, the resource and the scopes. Alternatively, `DACS_AUTH_MODE=external` verifies tokens from your own identity provider. Wallets are then linked through the portal.

### Tools

| Tool | Auth (`_meta.securitySchemes`) | Annotations |
| --- | --- | --- |
| `search_agents` | noauth | read-only, open-world |
| `get_listing` | noauth | read-only, open-world |
| `get_profile` (`openai/profile`) | `dacs.account.read` | read-only |
| `get_account_status` | `dacs.account.read` | read-only |
| `start_wallet_link` | `dacs.purchases.write` or `dacs.agents.write` | read-only (returns a signed one-use portal link, valid 10 minutes) |
| `prepare_purchase` | `dacs.purchases.write` | write, idempotent, open-world; does not approve or pay |
| `get_purchase_status` | `dacs.account.read` | read-only |
| `verify_deal` | `dacs.purchases.write` | write (status only), idempotent, open-world |
| `cancel_wallet_handoff` | `dacs.purchases.write` / `dacs.agents.write` | write (status only), idempotent, open-world; allowed only while the wallet nonce proves nothing was sent |
| `get_identities` | `dacs.account.read` | read-only, open-world; public on-chain identity links of your own linked wallets, with raw-response hash and observation time |
| `start_identity_action` | `dacs.identities.write` (proposed, offline candidate) | write (prepares only), idempotent, open-world; **held** unless `DACS_IDENTITY_WRITES=simulated-fixture-only` and the chain is a simulated fixture |

**Identity links (offline candidate, not reviewed).** `get_identities` makes one `gcr_routine` `getIdentities` read per linked wallet through the configured chain RPC and projects it with the pinned `@kynesyslabs/dacs` `parseCciRecord` (all eight Demos identity contexts). The answer is one configured node's, read without request authentication or state proofs and timestamped by this server's clock: it is not finalized, authenticated or cross-checked chain state. With no RPC it fails as `not_configured`; if every read fails it fails as `identity_reads_unavailable`; a single failed wallet is `unavailable` with `claims: null`. It never returns an empty list for an unreadable chain and never uses fixture data. Identity links are associations, not KYC, legal identity or proof of personhood, and an observed link does not show which transaction created it. `start_identity_action` prepares adding or removing a GitHub or Twitter link (cross-chain is deferred) and returns a portal link. In the portal the user's own wallet provides the proof text, the user publishes it themselves, and the wallet is asked exactly once; the server never signs or broadcasts. A wallet `USER_REJECTED` ends the action as rejected before send; a timeout, closed window or unclear error leaves the outcome unknown and nothing is retried. Completion is decided only by readback of the exact wallet, kind and handle. Removal unlinks on chain; it does not delete the public post, gist or past transactions, and does not unlink the wallet or delete the account. Real identity writes stay held until the live checks listed in `get_identities.identityActions.requiredLiveChecks` are done.

Two small MCP Apps views come with the tools: `ui://dacs/listings-v3.html` (`ui://dacs/listings-v5.html` instead when `DACS_IDENTITY_GITHUB_SIGNALS=on`) and `ui://dacs/status-v5.html` (`ui://dacs/status-report-v2.html` instead when `DACS_SHOWCASE_REPORT_VIEW=1`, which adds the verified purchased report: [docs/PURCHASED-REPORT-VIEW.md](docs/PURCHASED-REPORT-VIEW.md)). They are self-contained, use empty CSP allowlists, and use the open MCP Apps bridge. Every tool works without them. Template versions are not plugin version bumps; listings v2 decodes the seller-data envelopes that listing text fields now arrive in, v3 adds the optional seller identity observation, and v4 adds the optional GitHub statistics. Those GitHub numbers are display only and not a DACS Vet result (each `signals` object carries the fixed `vetStatus: "not-vet"` and a label beginning “Display only — not a DACS Vet result; nothing recorded on chain.”); a Vet-backed version is planned.

### Consent and evidence model

- **No tool accepts approval, an account or completion from the model.** Purchase approval exists only as a consumed wallet-signed challenge, and the server re-derives that challenge's binding from the stored terms. The binding covers:
  - operation, terms hash, owner account and buyer wallet;
  - seller, payee, listing id/version and content hash;
  - amount in DEM and OS, network and rail.
- **Coordinates are saved before any wallet handoff.** They are the sender, the nonce fence, the expected nonce, the target and the exact unsigned payload. Only one transaction can consume the expected nonce. Re-entry returns the same payload, and only while the fence proves nothing was consumed.
- **Settlement is accepted only from chain readback.** The SDK's `observePayDemTransferCore`, plus the transaction nonce, must show the exact approved payer, payee, amount and expected nonce. A reported or model-supplied hash is only a pointer. It can finalize a purchase only after the chain shows that transaction is from the buyer wallet at the expected nonce; any other pointer is rejected and the purchase stays unresolved. An unknown outcome is `payment_uncertain`. At most one unresolved wallet handoff may exist per wallet, across purchases and any retained v1 publication reservations, because they share the wallet's nonce space.
- **A listing is `transactable` only when every check below agrees.** Directory results are discovery hints only.
  - the directory detail matches its own summary;
  - the storage-program readback equals the detail;
  - the anchor owner is the seller key;
  - the SDK ordered reader returns `verified` (signature, identity, validity window, revocation with a catalog observation under 24 h, rails);
  - the listing is fixed-price DEM.
- **Evidence from a fixture service is labelled `simulated-fixture`.** Fixture services send `x-dacs-simulation`. A fixture result is never reported as live.

### DACS protocol purchase (offline fixture slice, not reviewed)

`prepare_purchase` with `protocol: "dacs-pay-dem"` runs one fixed-price native-DEM DACS purchase with a seller agent acting as phase orchestrator. It is available only when the app is created with the programmatic `dacsProtocol` option (`{ anchorUrl, sellerEndpoint(claim) }`, loopback only; there is no environment variable), and only on the simulated fixture chain. Otherwise it refuses as `dacs_protocol_unavailable` or `dacs_protocol_held`. Legacy purchases are unchanged.

- **Agreement first.** In the portal the user's wallet signs, in order: an IdentityBundle presentation, the SDK-planned payee-bound Agreement, and an SR-2 write authorization for the Agreement anchor. The pinned SDK's durable exchange carries the proposal to the seller agent, which re-derives the Agreement from its own Listing and refuses any changed price, payee, Listing or job. The seller then anchors a FinalityCommitmentRecord.
- **Payment only after an independent commitment readback.** The plugin reads the commitment back through the SDK commitment gate (resume path; it never signs or submits one) before the approval challenge and again before the handoff. The approval binds `dacs-job`, `dacs-agreement`, `dacs-commitment` and `dacs-commitment-signer`. The transfer pays exactly the committed payee and amount, using the existing nonce fence and single send.
- **After the transfer is observed,** the plugin submits a payment claim for the same transaction (retries never re-send). The seller agent verifies it with the SDK seller intake and publishes DACS-4 payment evidence at the SB-1 address, then the test report and its delivery evidence. The plugin verifies both with the SDK `verifySettlementEvidence` against its own observed transaction, block and amount. The wallet then counter-signs the DACS-5 bundle, and both copies are verified with the SDK bundle-copy and divergence checks.
- **Status keeps five layers apart:** transfer (one RPC, tuple-only), DACS purchase evidenced, service delivered, completed copies, and human acceptance, which is always `not-recorded`.
- **Limits:**
  - SR-2 anchors live in a SIMULATED loopback fixture substrate (`src/dacs/fixture-anchors.mjs`, not carried in this repository), not Demos storage.
  - DACS-2 Vet is not performed; the parties' `vetRecordRef`s are unresolved placeholders.
  - The rail registry pin is an operational `1` for the in-code DEM rail.
  - The strict DACS-5 ST-11 finalizers and the SDK's `publishSellerSessionSettlement`/`runFulfilmentCore` are not used.
  - The seller agent's state is in memory, and its HTTP adapter has no peer authentication.
  - Finality is not independently established.

  See `src/dacs/purchase-protocol.mjs` and `src/dacs/seller-agent.mjs` (neither is carried in this repository).

## Configuration

See `.env.example`, which contains placeholders only. Required settings:
- `DACS_PUBLIC_ORIGIN`, a stable HTTPS origin;
- `DACS_OAUTH_COOKIE_KEYS`, needed for built-in auth;
- `DACS_DATA_DIR`, on persistent storage.

`DACS_DIRECTORY_ORIGIN` and `DACS_CHAIN_RPC_URL` are optional. If either is unset, the dependent tools report `not_configured`. They never fall back to fixtures.

## Local startup

```sh
cd http-mcp
npm ci --ignore-scripts --no-audit --no-fund
DACS_PUBLIC_ORIGIN=http://127.0.0.1:8787 DACS_ALLOW_INSECURE_LOCALHOST=1 \
DACS_OAUTH_COOKIE_KEYS=<32+ random chars> DACS_DATA_DIR=./.data npm start
# then: npx @modelcontextprotocol/inspector  -> Streamable HTTP -> http://127.0.0.1:8787/mcp
```

The tested packaging contract uses `deploy/Dockerfile` (source checkout), not
the legacy root Dockerfile. It runs as a non-root user, keeps task data in
`/var/lib/dacs-chatgpt`, has a `HEALTHCHECK`, and stops on SIGTERM. See
`docs/DEPLOYMENT-CHECKLIST.md` and `docs/CHATGPT-DEVELOPER-MODE.md`. No deployment
has been performed.

## Tests

```sh
npm test               # node:test: transport, OAuth, external issuer, purchases, sellers, durability, unit
npm run test:browser   # headless local Chrome via playwright-core, simulated wallet provider
npm run check:package  # manifests, pack allowlist, install-from-tarball boot, Dockerfile-step replay
```

All chain, directory and wallet services in the tests are **simulated local fixtures** with ephemeral keys; passing them is not wallet, testnet, ChatGPT or deployment evidence. The tests run only from a source checkout (they are not in the installed package); see `docs/TESTING.md` for the runtime, short-`TMPDIR` and browser-launcher instructions.


## V2 (package 1.0.0)

This is the next major package version after 0.1.0. The owner retains the v1
code separately.
V2 removes ChatGPT Listing publication: the three agent-publication tools,
publish portal and offline seller wizard are unavailable. Existing account
links, scopes, wallet records and historical agent rows are retained. Contact
the operator for historical publication readback and recovery; never resend
or re-publish. The separate seller kit has not been released.
Both legacy demo launchers and the VPS seller pane refuse startup before
loading configuration or publishing. Health reports keep purchase/readback
alerts, open legacy publication blockers and historical issued effects;
they no longer report local seller policy budgets. MCP results label GitHub
repository names as untrusted seller data; the GitHub-enabled listings view
uses a new v5 URI to decode those labels for display.

The existing v1 support core and local purchase engine remain in use.
Buyer SDK adoption and browser protocol migration are deferred to a later release.
OAuth, accounts, the embedded wallet and purchase views keep their existing flow.

## Provenance

- **DACS SDK:** the vendored support-branch build `@kynesyslabs/dacs` 0.1.0-alpha.0 from dacs-sdk `6658691cefed76e2bb576ae959d1ad3bc7eeafec`.
  - Its tarball sha256 is `79934553cf3f952de4a442c8db306b68a2d5cd5947b3f1258ac9ac2caa5a69a3`, and its lock integrity is `sha512-r9hEyQh2…`.
  - This is not SDK main (`a07345a`), and it does not claim full Standard v0.4 conformance. The embedded Standard pin is reported by `/health`.
- **Community DACS Directory** (`community@074f040`, MIT licensed) is the source of:
  - the wallet provider contract;
  - the directory API;
  - storage-program naming and address derivation;
  - the registration message.

  The modules here re-implement these formats; they cite the Community files and functions they follow and contain no copied code that the files show. `PROVENANCE.md` lists every module that names that repository.
- The `validateListingArtifact` dependency wiring is adapted from an earlier demo.

Each module names its source in its header comment.
