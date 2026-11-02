> Seller publication steps below are historical v1 only: v2 has no publication tools or signing routes. Use the baseline fixture for v2 buyer checks.

> V2 simulated buyer testing remains available. Listing publication and seller sign-in are retired; seller workflow sections below describe v1 only. Contact the operator for historical publication recovery. A separate seller kit is coming.

# Offline tester launcher (SIMULATED fixtures only)

`bin/dacs-chatgpt-offline-test.mjs` starts a complete local test setup from the
installed package. You do not need the source tests, dev dependencies or build
tools.

**This is not Demos testnet. It is not funded, not ChatGPT and not security reviewed.**

- The external security review is on hold.
- Live, testnet, ChatGPT and security acceptance are all held. This partial v2 build is
  **not** accepted.
- When a fixture accepts a payment or identity change, that is a simulated
  receipt, not settlement. A successful model reply is not settlement either.

## What it starts

Everything listens on `127.0.0.1` on free ports, fresh for each run.

| Service | What it is |
| --- | --- |
| Plugin | The normal plugin app (`src/config.mjs` + `src/app.mjs`), unchanged. It keeps its normal OAuth, portal approval and independent chain-readback rules, and the launcher adds no routes to the app. Separately, the launcher's own HTTP server answers `/tester/` for the offline-only guided tester dashboard (unless `--no-dashboard`) and passes every other request to the app. The production binary never serves the dashboard. The launcher turns on the simulated-loopback embedded-wallet profile (see below). |
| Fixture chain | A simulated Demos RPC. It serves the reads the plugin uses (including `GET /storage-program/<stor-…>`), the SDK's `getNetworkInfo`/`getNetworkParameters`/`getAddressNonce`/`getTweet`, and `execute` `confirmTx`/`broadcastTx` in the bundled demosdk 4.0.16 envelope. It accepts native DEM sends, GitHub/Twitter identity changes and storage-program CREATE writes (seller listing publication). |
| Fixture directory | A simulated Community directory. It starts with one visible fixed-price baseline listing and indexes seller registrations whose owner signature verifies, from the fixture chain's storage (see below). |
| Proof publisher | A simulated GitHub/X stand-in. It offers `GET /users/<handle>` in the GitHub API shape, plus a plain form where you "publish" your wallet's proof text. |

Every fixture response carries `x-dacs-simulation: fixture`, so the plugin
labels results `simulated-fixture`.

Keys:

- **Baseline seller:** the shipped baseline listing is signed by a synthetic
  seller. A fresh Ed25519 key is made with `node:crypto` for each run, used with
  the bundled `@kynesyslabs/dacs` canonical encoding, and never written to disk
  or printed.
- **Your seller:** a listing you publish through the dashboard's seller wizard
  (or `register_agent`) is signed by your own seller wallet in the portal. The
  launcher holds no seller key for it.
- **Buyer:** the launcher holds no buyer key. Your buyer key is created and
  held in your browser by the experimental embedded wallet, or by your own
  wallet extension.

The launcher contacts no live service: no Demos node, faucet, GitHub, X or
ChatGPT. It builds its environment explicitly and inherits nothing from your
shell. It generates a new random cookie key for each run.

## Run it

```sh
mkdir dacs-tester && cd dacs-tester
npm init -y
npm install /path/to/dacs-agent-commerce-dacs-chatgpt-plugin-1.0.0.tgz --ignore-scripts --no-audit --no-fund --omit=dev
node node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin/bin/dacs-chatgpt-offline-test.mjs
```

It prints the following, and no secrets:

- the plugin MCP URL;
- the embedded-wallet page;
- the fixture origins;
- the fixture listing (`offline-fixture-report` v1, 1.5 fixture DEM) and its seller claim;
- how to stop.

| Option | Meaning |
| --- | --- |
| `--port <n>` | Plugin port on 127.0.0.1. Default: a free port. Use a fixed port to keep the same browser origin, and with it the same embedded wallet vault, across runs. |
| `--redirect-origin <url>` | Loopback OAuth client origin allowed to link accounts. Repeatable. Default `http://localhost:6274` (MCP Inspector). Non-loopback origins are refused. |
| `--keep-state` | Keep the temporary state directory after stopping, for inspection. It is never reused. |
| `--no-dashboard` | Do not serve the guided tester dashboard. By default the launcher prints a `Tester dashboard:` URL (`/tester/` on the plugin origin) and adds that exact loopback origin to the OAuth allowlist, keeping your `--redirect-origin` values. See `TESTER-DASHBOARD.md`. |
| `--json` | Print the public start information as one JSON line. |
| `--verbose` | Print plugin access logs (method, path, status) on stderr. |

**Stop:** press Ctrl-C (SIGINT) or send SIGTERM. The launcher closes only what
it started:

- the plugin server;
- the MCP handler and database;
- the three fixtures;
- its temporary directory (unless `--keep-state`).

It exits 0 on a clean stop. It exits 1 if stopping fails or takes longer than 10 s.

## Core profile (implemented, simulated only)

The launcher sets:

- `DACS_EMBEDDED_WALLET_WRITES=simulated-loopback`;
- `DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN=<proof publisher>`;
- `DACS_IDENTITY_WRITES=simulated-fixture-only`;
- a loopback `DACS_CHAIN_RPC_URL`.

With these, the app's same-origin wallet relay (`/portal/api/wallet-rpc`) forwards
the browser SDK's requests to the fixture chain, and GitHub user lookups to the
proof publisher. The embedded wallet can then pay, add or remove GitHub and
Twitter identities, and publish a seller listing (sign the identity, listing
and directory-registration messages, and send one storage-program CREATE),
all against the fixtures.

`POST /portal/api/embedded-wallet/profile` on the plugin origin reports this
public, non-secret profile; in the launcher it answers `writes:
"simulated-loopback"`, `evidenceMode: "simulated-fixture"`, `label: "SIMULATED
loopback fixture (not Demos testnet)"` and `capabilities: {payment: true,
identity: true, publication: true}`. The source test `overnight-ui.test.mjs`
checks this for both the programmatic launcher and the CLI.

Payment and identities were exercised end to end from the installed tarball in
real Chromium; built-in-wallet publication was exercised from source in real
Chromium (`overnight-ui.browser.test.mjs`); see Tests below. Production and
live enabling stay held.

## Tester checklist (embedded wallet, all simulated)

The guided tester dashboard (see `TESTER-DASHBOARD.md`) walks through these
steps with buttons, without an MCP Inspector, and adds a seller wizard (publish
your own listing, then buy it from a separate buyer). The manual MCP route
below stays available. `OVERNIGHT-UI.md` is a step-by-step validation guide
that needs no source.

1. **Start.** Run the launcher. Note the MCP URL and the proof publisher URL.
2. **Sign in.**
   1. Connect an MCP client with OAuth (for example
      `npx @modelcontextprotocol/inspector`, Streamable HTTP) to the MCP URL.
   2. In the portal sign-in page, choose **Use the experimental embedded wallet**.
   3. **Create wallet** with a password, and write down the recovery phrase the
      page shows.
   4. Click **Connect wallet**, then **Sign in and allow**, and **Approve** the
      `account-login` request.
3. **Find the listing.** `search_agents` with `offline fixture`, then
   `get_listing`. Expect `transactable: true`, 1.5 DEM (`1500000000` OS) and
   `chainMode: simulated-fixture`.
4. **Buy.**
   1. Call `prepare_purchase` and open its approval link.
   2. Unlock the wallet, click **Connect wallet**, then **Approve exact terms**.
   3. Approve the approval challenge.
   4. Approve the transaction. It shows the seller, `1500000000`, your address,
      the nonce and "SIMULATED".
   5. **Expect a "Simulated purchase receipt"** with the transaction hash.
      `get_purchase_status` should be `settled_verified`, with `settlement` showing:
      - `chainMode: simulated-fixture`;
      - payer = your address;
      - payee = the listing seller;
      - `amountOs: 1500000000`;
      - `txNonce` = `expectedNonce` (1 for a fresh wallet).

   This is a simulated receipt from the fixture chain, not real settlement.
5. **Add a GitHub identity.**
   1. Call `start_identity_action` with `action: add`, `kind: github` and open the link.
   2. Click **Use my connected wallet**, then **Get proof text from my wallet**, and approve.
   3. Open the proof publisher. Choose `github`, enter a handle (letters,
      digits and `-` only), paste the proof text and publish.
   4. Paste the returned `https://gist.github.com/<handle>/<id>` URL into the
      portal, click **Use this proof URL**, then **Approve in my wallet**.
   5. Expect "Association observed on chain." `get_identities` should show
      the handle under the GitHub context (`simulated-fixture`).

   Twitter uses the same steps with an `https://x.com/<handle>/status/<id>` URL
   from the publisher. The source browser test `overnight-ui.browser.test.mjs`
   exercises Twitter add and remove through the dashboard with the embedded
   wallet; the installed-package checker still covers GitHub only.
6. **Remove the identity.** Call `start_identity_action` with `action: remove`,
   `kind: github`, `username: <handle>`. Then **Use my connected wallet**,
   **Approve in my wallet**, and expect "Association no longer observed on
   chain." Your published proof and past transactions are not deleted.
7. **Back up and recover.**
   1. In the unlocked wallet, choose **Export encrypted backup** and keep the text.
   2. In a fresh browser profile on the same origin, open the embedded-wallet
      page, choose **Restore backup**, paste the text, and **Unlock** with your
      password.
   3. Expect the same address.
8. **Stop.** Press Ctrl-C. Every listener closes and the state is deleted.

## What the fixture chain checks

The fixture chain checks every transaction at confirm, and again at broadcast,
where it never trusts the client's copy of the confirm result. It requires all of these:

- `hash == sha256(JSON.stringify(content))`.
- An `ed25519` signature over the UTF-8 hash string, verified with `node:crypto`
  against the key in `content.from`.
- `content.nonce == current nonce + 1`.
- A native DEM `send`, a GitHub/Twitter `web2_identity_assign` /
  `web2_identity_remove`, or a storage-program `CREATE_STORAGE_PROGRAM`.

For an identity assign, the proof URL must have been published on the proof
publisher for the same kind and handle. Its `demos:dw2p:ed25519:…` text must
verify for the sender (ed25519 over `"dw2p"`).

For a storage-program CREATE (`content.type: storageProgram`,
`data: ["storageProgram", {operation, storageAddress, programName, encoding,
data, salt, …}]`):

- `storageAddress` must equal `content.to` and the Community derivation
  `stor-` + first 40 hex of `sha256("<from>:<programName>:<nonce>:<salt>")`
  for this sender and this transaction's nonce;
- nothing may exist at that address yet (no overwrite);
- `encoding` must be `json` and `data` an object of at most 64 KiB;
- at most 200 storage programs per run.

The stored bytes are exactly `data`, owned by `content.from`, served at
`GET /storage-program/<stor-…>` as `{success, data, owner, programName}`. The
fixture does not interpret the listing; the plugin's readback compares the
canonical bytes the seller signed.

An accepted broadcast goes into a new block. The plugin then reads it back on
its own, through `getTransactionStatus`/`getTxByHash`/`getBlockByNumber` (the
pay-DEM observer), `gcr_routine getIdentities` and the storage-program read.

## What the fixture directory checks

`GET /api/dacs/listings` (`q` matches title and description, `primaryClaim`,
`category`, `limit` ≤ 50, `cursor`) and
`GET /api/dacs/listings/<id>/<version>?seller=<claim>` serve the indexed
listings. `POST /api/dacs/register` (the body the portal's **Register with
directory** sends) is indexed only when:

- `primaryClaim` is `did:demos:agent:<64 lowercase hex>`, `displayName` is
  set, and `listingAnchors` holds 1 to 8 `stor-` locators;
- `ownerSignature.signedAt` is within 10 minutes, `ownerSignature.message` is
  exactly the Community registration message for this body, and the signature
  (hex or base64url) verifies for the claim's wallet;
- each anchor exists on the fixture chain, is owned by the claim's wallet, and
  holds a listing presented and signed by that claim.

Indexed anchors get the same summary shape as the baseline listing, with the
content hash of the stored bytes; the answer is
`{ok: true, ownerVerified: true, queued: false, indexed, skipped}`. Errors are
`400` (malformed or stale), `401` (signature) or `422` (nothing indexable,
with the reasons). The directory is still only a discovery hint: the plugin's
`get_listing` verifies the chain bytes, signatures and validity itself.

## Simulated limitations (exact)

- **No real chain.** There is no consensus, finality, peers, balances, gas or
  fees: `getNetworkParameters` reports fee 0, and a send is accepted whatever
  the balance. Block timestamps come from the local clock.
- **Signing and requests.**
  - Only ed25519 is supported, with one sender key per address. Alternate or
    dual signing (`from_ed25519_address` different from `from`) is refused.
  - The confirm "validity" is unsigned, because the fixture holds no node key.
  - The SDK's `identity`/`signature`/`timestamp` request headers are not checked.
- **Network calls.** `getNetworkInfo` always reports the OS-denomination fork
  as active. `nodeCall` methods not listed above answer `result: 400`, and their
  names are counted in `chainStats().unknownNodeCalls`.
- **Proofs and identities.**
  - Web2 proofs use the legacy `dw2p` format, which is not bound to the handle.
    The `web2ProofBinding` fork is not simulated.
  - GitHub user ids are a stable hash of the handle.
  - `getTweet` answers `{success, tweet:{username, userId, text, url}}`, and only
    for URLs published on the fixture.
- **Seller.** The seller's public endpoint is `https://seller.invalid/...`. No
  delivery happens.
- **Storage programs.** Only CREATE is simulated (no update, delete, ACL or
  binary encoding); there are no storage fees.
- **Directory.** Registration indexes immediately (no queue); there is no
  revocation or de-listing.
- **Storage fee.** The embedded wallet shows the SDK's storage fee and gas for
  the write; the fixture chain charges nothing (no balances).
- **Limits.**
  - Request bodies: 256 KiB (64 KiB for the directory, 4 KiB for proofs).
  - Request timeout: 15 s.
  - Per run: at most 1000 transactions, 200 proofs, 200 storage programs,
    200 directory listings and 100 recorded registrations.

## Lost your built-in wallet during a run

The built-in wallet lives in one browser profile, for one dashboard address.
You lose it if you:

- open the dashboard in a new browser profile or private window;
- clear the site data;
- use another browser.

The dashboard keeps the seller and buyer sign-ins for the whole launcher
run, so a new profile shows **Sign in** / **Sign in as seller** disabled,
and the portal links need the old wallet.

The dashboard says this where you need it:

- next to each sign-in: "Your built-in wallet is stored in this browser
  profile. Keep using the same browser window for the whole run. Lost it (new
  window or profile, cleared site data)? Press Start over as a new buyer (or
  seller) and sign in with a new wallet, or restart the launcher.";
- next to the purchase and publication portal links: "Approve with the same
  built-in wallet that signed in …".

**Start over (same run).**

1. Press **Start over as a new buyer** (step 2) or **Start over as a new
   seller** (S1). The role shows `Not signed in.` / `Seller not signed in.`,
   and focus moves to its sign-in button.
2. Sign in with a new built-in wallet and continue. A new buyer wallet
   completing a baseline purchase was checked; so was a new seller wallet
   preparing a new listing.

The earlier session is not deleted and nothing on the plugin, fixture chain or
directory is changed or cancelled.

- The dashboard lists it under **Earlier buyer sign-ins in this run (as last
  observed)** or **Earlier seller sign-ins in this run (as last observed)**:
  the old wallet, and the purchase or listing with the status it last had.
  For example: "purchase pur_… for offline-fixture-report was
  awaiting_approval. Last observed status, not refreshed; only that wallet can
  approve anything still pending."
- Anything still pending stays with the old wallet. If you still have that
  wallet, cancel a pending purchase (**Cancel pending purchase**) or listing
  (**Cancel unpublished listing**) before **Start over**.
- The evidence file lists these under `earlier`.

**Or restart the launcher**, which starts a fresh run with nothing left over.

If you exported the wallet's encrypted backup, restoring it in the new
profile, at the same dashboard address, gives back the same wallet: open
**Open the built-in wallet page**, use **Restore backup**, then **Unlock**
with the password. The installed-package checker verifies this restore in a
fresh browser context.

## Identity action refused, stopped or cancelled before anything was sent

The full rules are in `IDENTITY-RECOVERY.md`. In short, one identity action
per wallet can be in flight. An action that never reached the chain is
closed, so it no longer blocks that wallet. You do **not** need to restart the
launcher for this.

**A GitHub proof URL whose handle GitHub cannot have** (for example one with
an underscore). The proof publisher accepts such a handle; GitHub does not.
The portal refuses the URL at the proof step (`invalid_proof_url`): "“<handle>”
cannot be a GitHub username (letters, digits and hyphens only), so your
wallet could not look it up. Nothing was sent to your wallet. …" The action
stays at the proof step. Publish the proof under a GitHub-valid handle
(letters, digits, single hyphens) and paste that URL into the same action.

**The built-in wallet stops before sending.** Example: a mistyped post URL,
or a proof that was not published. No approval dialog opens. The portal
shows the wallet's own answer, for example: "Your wallet answered: the
configured Demos node did not answer getTweet; nothing was signed
(upstream_unavailable). Nothing was signed or sent." It then says: "This
action is closed and nothing was retried. Fix what the wallet reported (for
example, publish the proof first or use your real handle), then start a new
identity action for this wallet, from ChatGPT or from the tester dashboard."
The action's status is `failed_before_send`. Reloading the page or opening
it in a new tab shows the same closed state, and the wallet is not asked
again. The same wallet can start a new identity action in the same run.

**You change your mind before approving.** Every portal page before the
wallet is asked shows **Cancel this identity action**. The action becomes
`cancelled`; nothing was sent.

**The wallet was asked and the outcome is not known** (for example, the
portal's report never reached the server). This is unchanged: the action
stays open until chain readback shows the change. Meanwhile, that wallet's
new identity actions are refused with `identity_operation_in_progress`, and
the action can no longer be cancelled ("An identity action can be cancelled
only before your wallet is asked; this one was already asked."). Purchases
and publications are not affected.

### On the tester dashboard

The dashboard follows the same rule, in the same running launcher:

1. After **Refresh identities**, the closed action shows its status and
   handle, for example `failed_before_send (<handle>)` or `cancelled`. A closed
   action is not listed under **Unfinished steps**.
2. Press the same **Add test GitHub identity** / **Add test Twitter identity**
   button again. It starts a **new** action with a new portal review link, not
   the closed one. Finish it with a correct proof URL. **Refresh identities**
   then shows `association_observed` and the handle.

No launcher restart is needed. A restart still works, but it starts a fresh run
and discards every sign-in, listing, purchase and identity from the old one.

## Reset, persistence and recovery

- **Every run starts fresh.** The fixture chain, directory and proofs live in
  memory, and the plugin's database lives in a new temporary directory.
  Stopping discards all of it. A restart has a new seller, and every nonce is 0.
- `--keep-state` only leaves the plugin's temporary directory on disk for
  inspection. Restarting does **not** reuse it.
- **Embedded wallet:**
  - The phrase and encrypted vault live in your browser, for the page origin
    `http://127.0.0.1:<port>`.
  - Use `--port` to keep the same origin between runs.
  - The portable recovery path is the **encrypted backup export**. Restoring it
    in a fresh browser context was tested.
  - The launcher never sees or stores your phrase, password or backup.

## Programmatic use

```js
import { startOfflineTester } from '<package>/bin/dacs-chatgpt-offline-test.mjs';
const h = await startOfflineTester({ port: 0, redirectOrigins: ['http://localhost:6274'], keepState: false, logLevel: 'silent' });
// h.origin, h.mcpUrl, h.embeddedWalletUrl, h.fixtures.{chain,directory,proofs},
// h.listing.{listingId,version,seller,sellerAddress,price,locator,label},
// h.coreProfile, h.stateDir, h.chainStats() (now also storagePrograms),
// h.directoryStats() -> {listings, registrations, indexed, refused},
// h.dashboardUrl (with dashboard: true)
await h.stop(); // idempotent; closes every owned handle, removes fresh state
```

The runtime imports only `src/`, `bin/offline-fixtures/` and runtime
dependencies. It never imports `test/`, `wallet-build/` or dev dependencies;
the installed-artifact checker verifies this.

## Tests (source checkout)

- **`scripts/check-offline-tester-package.mjs [--keep]`: installed-artifact check.**
  1. Packs the source (scripts off) and cold-installs it with production
     dependencies.
  2. Imports and starts the **installed** launcher, recording every module it
     resolves.
  3. Drives real Chromium (`DACS_TEST_CHROME`) through: OAuth sign-in with a
     fresh embedded wallet; listing verification; an exact-terms purchase with
     one broadcast and the server's receipt; GitHub add/remove through the
     proof publisher; backup restore.
  4. Checks stop and reset.
  5. Runs the installed CLI `--json` with SIGTERM.

  A missing browser is a failure. `--keep` keeps the tarball and install
  project and prints their path.

  The source checker itself needs Node >= 22.15 (tested on 22.22.0). On an
  older Node it fails with a clear preflight message. The installed launcher
  still runs on Node >= 22.13.

  The backup step waits for the export to finish (backup text shown with a
  value, wallet not busy) before reading it. It also checks the actual installed
  UI: the backup textbox is concealed before export and in the restored locked
  view, and becomes visible with its value after export. A previous CSS rule
  overrode `hidden`; the scoped hidden rule now preserves that state.
- **`test/offline-tester-package.test.mjs`:** the checker's import oracle, its
  secret scan, its TCP port probe and argument parsing.
- **`test/offline-tester.test.mjs`:** covers
  - start/stop;
  - the MCP listing workflow and refusal without OAuth;
  - the core profile (relay and GitHub lookup through the app);
  - the SDK wire envelope (`getTweet`, confirm fields, broadcast `txHash`);
  - fixture confirm/broadcast with ed25519 verification and independent readback;
  - wrong-signer, altered-content and forged-validity rejections;
  - proof publication and identity readback;
  - body limits;
  - the CLI lifecycle.
- **`test/browser/offline-tester.browser.test.mjs`:** real Chrome loads the
  embedded-wallet page from the launched plugin, and round-trips the proof form.
- **`test/overnight-ui.test.mjs`** and
  **`test/browser/overnight-ui.browser.test.mjs`:** storage-program writes,
  directory indexing, and the dashboard seller wizard with a separate buyer;
  see `OVERNIGHT-UI.md`.
