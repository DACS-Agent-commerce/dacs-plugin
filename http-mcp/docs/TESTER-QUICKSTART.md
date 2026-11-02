# Tester quickstart (partial v2, package 1.0.0, private, offline testing)

This guide is for a person trying the installed DACS ChatGPT plugin package:

- **Installed-package usage:** run the server from a package tarball and check it locally.
- **Installed offline fixture operator:** try the built-in wallet and simulated commerce without a wallet extension or live services.
- **Source-developer fixture tests:** run the repository's test suites against simulated services.

These instructions do not connect to ChatGPT or the live Demos testnet. The embedded wallet uses the real SDK to create fresh local keys, but its automated write flows use visibly simulated fixtures and no funds. This partial-v2 build has **not** been accepted: every live check is still outstanding. The external security review is on hold.

## What the plugin does

- **Buyers** find a signed DACS seller agent, verify its listing, and prepare a **fixed-price DEM testnet** purchase. They approve the exact terms and then the transfer **in their own wallet**. Testnet DEM is not real money.
- **Sellers** cannot publish Listings with this plugin. A separate seller kit is coming and has not been released. Contact the operator about existing v1 publications; never resend or re-publish.
- **Identity links:** `get_identities` shows the identity links the configured Demos node reports for your own linked wallets. That is one node's answer timestamped by the plugin server, not finalized or authenticated chain state. These are associations, not KYC or proof of identity. A failed read is shown as unavailable, never as "no identities". Adding or removing a link (`start_identity_action`) is an offline candidate and is **held** on a normal server (`DACS_IDENTITY_WRITES=held`) until real-wallet checks are done.
- The normal server never holds your key or signs for you. In the explicit offline profile its relay forwards browser-signed transactions to the simulated chain. Purchases and identity changes count only after independent chain readback. The offline fixture operator holds a fresh synthetic seller key, never the buyer's key.

## 1. Default extension mode: set up your Demos account in your own wallet

In the default extension mode, account creation and recovery happen **only inside the Demos wallet extension**, using its own **Create** or **Import** screens. In that mode this plugin, its portal, ChatGPT and the server:

- never ask for, display, store or log a seed phrase, mnemonic or private key;
- never create a wallet for you;
- never call the wallet's internal setup functions.

There is also an **experimental, default-off embedded wallet** that a tester can
explicitly select in the portal. It creates/imports keys locally in the browser
and supports encrypted backup, lock/unlock and approved signing. Its phrase and
password stay in that browser page, never in ChatGPT or the server. It is not
security reviewed. The external security review is on hold. On a normal server, writes are off; in the
explicit simulated-loopback profile, which the installed offline tester
launcher uses, it supports native fixed-price purchases, GitHub/Twitter identity
add/remove. Listing publication is unavailable in this plugin. The fixture
provides the baseline seller and Listing; use your throwaway buyer wallet.
See `OVERNIGHT-CORE.md` for historical v1 publication context (operator recovery
only), and `OFFLINE-TESTER.md` for
the installed simulated setup and `EMBEDDED-WALLET-TESTER.md` for key lifecycle
checks. Do not treat the extension-mode promises above as a
description of the embedded wallet's local key-entry screen.

Once your wallet holds an account:

1. Open the portal link the plugin gives you, in the browser where the wallet is installed.
2. Click **Connect wallet**. The portal only receives your **public address**.
3. Sign the one-time challenge. It names the site, the purpose and the account, and it does not move funds.

Linking an existing account uses this same flow (`start_wallet_link`). Linking never merges two plugin accounts, and a wallet already linked to another account is refused.

### Unresolved before real-wallet use

- **Sign request shape.** The portal sends `sign` with `params: [message]`, the plain challenge string that reviewed wallet source (Demos wallet 0.5.7) reads as `params[0]`. This matches the source only; sign-in and linking have **not** been tried with an installed wallet.
- **Wallet network.** Nothing here can tell which network your installed wallet uses. A label in the portal is not proof. Checking it is a live step that has not been done.
- **Transaction payloads.** It is unconfirmed whether the wallet accepts the portal's pre-built `sendTransaction` payloads (see `CHATGPT-DEVELOPER-MODE.md`).

## 2. Run the installed package locally

You need Node.js 22.13 or later (`engines.node` is `>=22.13.0`); the recorded runs used Node 22.22.0. The package is private: install it from a tarball you were given. It is not published to npm.

Why 22.13: the server stores its state with the built-in `node:sqlite`, which
Node only loads without the `--experimental-sqlite` flag from 22.13.0. Every
locked dependency accepts 22.13.0, and the shipped server code uses no Node API
added later (`test/overnight-package.test.mjs` checks both). Only Node 22.22.0
has actually been run; 22.13.x itself has not been executed. Node still prints
an `ExperimentalWarning` for SQLite when the server starts. It is harmless.

Platforms: the recorded installs, starts and browser checks ran on Linux x64
only. macOS and Windows have **not** been tested. The locked production
dependencies have no native addons, install scripts or OS/CPU restrictions, so
nothing platform-specific is compiled at install time; that is an expectation,
not a tested result.
On Windows, the source-checkout checkers (`scripts/*.mjs`, `deploy/scripts/*`)
look for npm in Unix install locations or start `npm.cmd` without a shell, so
expect them to fail there. That covers the source-checkout checks only; the
installed package itself has not been tried on Windows either.

```sh
mkdir dacs-tester && cd dacs-tester
npm init -y
npm install /path/to/dacs-agent-commerce-dacs-chatgpt-plugin-1.0.0.tgz --ignore-scripts --no-audit --no-fund --omit=dev
```

### Try the complete simulated setup

```sh
node node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin/bin/dacs-chatgpt-offline-test.mjs
```

This shipped operator starts the normal app and fresh loopback-only chain,
directory and proof fixtures. It prints the MCP URL, embedded-wallet page and
local proof publisher. Use a fresh throwaway wallet; never enter its recovery
material into chat. Follow `OFFLINE-TESTER.md` for normal OAuth sign-in, wallet
linking, the fixed-price fixture purchase, GitHub/Twitter association and
removal, backup/recovery and clean shutdown. A simulated receipt is not testnet
settlement. No real GitHub/X post is needed or made.

### Run the normal server without fixtures

Start the installed binary on loopback. `DACS_OAUTH_COOKIE_KEYS` must be a fresh random value of at least 32 characters; never reuse one from an example.

```sh
PORT=8787 HOST=127.0.0.1 \
DACS_PUBLIC_ORIGIN=http://127.0.0.1:8787 DACS_ALLOW_INSECURE_LOCALHOST=1 \
DACS_DATA_DIR=./data DACS_OAUTH_COOKIE_KEYS=<32+ random characters> \
npx dacs-chatgpt-plugin
```

Stop it with Ctrl-C in that terminal. To run it under a process supervisor, start
`node_modules/.bin/dacs-chatgpt-plugin` directly instead of `npx`. Sending SIGTERM to
the `npx` process alone stops npx but leaves the server running. The server itself
exits 0 on SIGTERM or Ctrl-C.

Check it from another terminal:

```sh
curl -s http://127.0.0.1:8787/health
npx @modelcontextprotocol/inspector   # Streamable HTTP -> http://127.0.0.1:8787/mcp
```

What to expect with no directory or chain configured:

- `/health` reports `"status": "ok"`, with `dependencies.directory.configured` and `dependencies.chain.configured` both `false`.
- The MCP server lists its tools. `search_agents` returns an error saying discovery is **not configured**.
- Nothing falls back to simulated data. `not_configured` is the honest answer, not a failure of your setup.

Set `DACS_DIRECTORY_ORIGIN` and `DACS_CHAIN_RPC_URL` only to services you trust. See `../.env.example` for every setting; it contains placeholders only.

## 3. Source-developer fixture tests

These run from a source checkout, not the installed package. Every chain, directory and wallet service in them is a **simulated local fixture** with ephemeral keys, so passing them is not wallet, testnet or ChatGPT evidence. See `TESTING.md` for the runtime, short-`TMPDIR` advice and replay commands.

The installed app's minimum remains Node22.13. The source-only installed-operator
acceptance checker uses `node:module.registerHooks` and requires Node22.15 or
later with that API available; use the tested Node22.22.0 for the complete source
acceptance queue. This does not add a dependency or change the shipped runtime's
engine requirement.

```sh
cd http-mcp
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check:package
```

## Not covered here

- Connecting the plugin in ChatGPT: see `CHATGPT-DEVELOPER-MODE.md`. It has not been done by this build.
- Deployment: see `DEPLOYMENT-CHECKLIST.md`. An isolated test image has been built and checked for startup, restart, public MCP and asset integrity. No deployment or live acceptance is implied.
- Mainnet, fiat, custody and hosted seller agents are out of scope.

## Seller identities before paying

When `DACS_SELLER_IDENTITIES=on`, search results, the purchase review and the
portal show GitHub handles, X (Twitter) handles and domains reported by the
configured Demos node for the seller claim’s address. Search uses the
directory-asserted claim and shows it in full: its listing-to-seller link is
not verified until `get_listing` or `prepare_purchase`. Purchase preparation
and the portal use the chain-verified terms’ seller claim. The offline
tester enables the panel with clearly labelled simulated fixture identities.
The deployment default is `off`: no seller identity reads or result fields.
Advertised schemas still gain optional fields, and the App resource uses
`listings-v3` (`listings-v5` when `DACS_IDENTITY_GITHUB_SIGNALS=on`; see
below). Seller-provided names are labelled not verified and rendered
separately. In the view they are stripped of invisible direction controls and
collapsed to one line; in the search summary text they appear only inside
their seller-data envelope.

Links come only from that chain read, never from the seller name or Listing
text. Domains use lowercase IDNA A-label spelling; `xn--` labels are marked
as punycode so look-alike names are visible. Invalid values are omitted and
counted as unrecognized entries. Raw entries in all untargeted Web2 buckets
are counted as other associations without showing their contents; parser-omitted
entries also count as unrecognized, so these counts can overlap. Non-Web2
parsed claims and display-cap omissions also count as other associations.
An observed empty category means no links in that category were observed.
Failed, timed-out or unrecognized reads mean **unknown, not empty**. Search
checks up to 10 distinct sellers concurrently within 2 seconds; each RPC is
aborted after at most 1 second. Fresh reads have fixed per-minute quotas:
80 globally for search, 20 per client IP for search, and a separate reserved
40 for purchase review. Cache hits are free. Search has 16 pending slots;
purchase reads have separate capacity and share existing reads by address.
Exhausted quotas or capacity mean **not checked**, with identities unknown.
Observations may be cached for 60 seconds (failures for 5 seconds). Only the
portal’s initial/re-check view request may wait for a fresh read. Other
responses use cached results, label expired ones as cached and preserve the
original observation time; without a cached result they omit the field, and
the page retains the last panel received.

This is one configured node's unauthenticated read, timestamped by the server,
not finalized state, KYC, proof of current account control or reputation. A
linked account may have changed hands. The panel is display only: it changes
no purchase terms, Agreement bytes, hashes or wallet approval requirements.

### Optional GitHub statistics

With both `DACS_SELLER_IDENTITIES=on` and `DACS_IDENTITY_GITHUB_SIGNALS=on`, the
server checks the original gist's claim-bound Ed25519 signature against the
seller's Demos public key before showing GitHub's account creation date and
stars on public, non-fork repositories owned by that numeric GitHub account ID.
Archived repositories count and are marked. The largest three repositories link
to GitHub. Incomplete pages are labelled “at least”; stale results retain their
original timestamps and are shown for at most 24 hours. Followers are optional:
private profiles can report zero to other users. With both switches on,
`search_agents` and `get_listing` declare, and the server serves,
`ui://dacs/listings-v5.html` in place of `listings-v3` (hosts cache views by
URI).

The GitHub numbers are display only and are not a DACS Vet result: every label
begins “Display only — not a DACS Vet result; nothing recorded on chain.” and
every `signals` object carries the fixed plugin field `vetStatus: "not-vet"`; a
Vet-backed version is planned.

Stars can be bought, repository ownership does not establish authorship, and
account age is not this seller's tenure. These are server-checked display facts,
not a trust score, independent chain authentication or a fresh control challenge.
Legacy Demos proofs do not name the account; TLSNotary presentations are unchecked
here. Those links, unresolved proofs and checks outside the time or rate budget
withhold statistics while keeping the linked handle. Search starts fresh checks
for at most 10 GitHub entries per minute globally; buyer review shares cached
results and may wait only within the existing identity deadline; a check cut
short by one caller's deadline while another caller waits longer is reused for
up to 30 seconds, and other failed or partial checks for up to five minutes. Anonymous mode
has a local ceiling of 60 requests/hour and respects GitHub's quota/back-off
headers. The optional server token goes only to GitHub's API. Both switches are
off by default; the offline tester keeps GitHub signals off and makes no GitHub
requests. No contribution count is fetched; inspect the linked GitHub profile.
