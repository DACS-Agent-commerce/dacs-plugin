> V2 simulated buyer testing remains available. Listing publication and seller sign-in are retired; seller workflow sections below describe v1 only. Contact the operator for historical publication recovery. A separate seller kit is coming.

# Guided tester dashboard (SIMULATED fixtures only)

The offline launcher (see `OFFLINE-TESTER.md`) also serves a small browser
dashboard. It walks a tester through the whole flow with buttons, forms and
links, so they do not need an MCP Inspector, JSON or tool schemas.

**SIMULATED ONLY: no real funds, not Demos testnet, not ChatGPT, not security
reviewed.** A fixture receipt is not settlement. The dashboard shows this in a
banner that stays on screen.

## Start it

```sh
node node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin/bin/dacs-chatgpt-offline-test.mjs
```

Open the URL printed on the `Tester dashboard:` line, for example
`http://127.0.0.1:<port>/tester/`. Pass `--no-dashboard` to turn it off. No
browser extension is needed.

The dashboard lives only in the offline launcher. The production binary
(`bin/dacs-chatgpt-plugin.mjs`) does not serve it.

## How it works

- The dashboard runs on the plugin's own loopback origin, under `/tester/`.
  The launcher's HTTP server answers these routes and passes every other
  request to the unchanged plugin app.
- It is an ordinary OAuth client of the plugin, with **two independent
  sign-ins**, each its own client registration and token set:

  | Role | Redirect URI | Scopes | Portal "Requesting app" |
  | --- | --- | --- | --- |
  | Buyer (step 2) | `<origin>/tester/oauth/callback` | `dacs.account.read dacs.purchases.write dacs.identities.write` | `DACS offline tester dashboard (SIMULATED)` |
  | Seller (step S1) | `<origin>/tester/oauth/seller-callback` | `dacs.account.read dacs.agents.write` | `DACS offline tester dashboard - seller (SIMULATED)` |

  Both use the normal authorization-code + PKCE portal and the pinned official
  `@modelcontextprotocol/client`, and call the normal MCP tools. The only
  allowlist change is its own callback origin, `http://127.0.0.1:<port>`; your
  `--redirect-origin` values are kept.
- The OAuth tokens stay in the launcher process. The browser only sees public
  status: addresses, statuses, amounts and portal links.
- The dashboard never asks for, receives or stores your wallet password,
  recovery phrase or encrypted backup. It never reads the wallet vault. It
  never signs, approves or publishes anything. You do all of that yourself in
  the existing wallet page, the portal pages and the local proof publisher.

## Two roles, two wallets

The seller and the buyer must be **different wallets**. The built-in wallet
keeps one wallet per browser profile (per page origin). Use one window for the
seller and a private window or a second browser profile for the buyer, open
the same dashboard address in both, and create one throwaway wallet in each.
Both windows show the same dashboard state. Preparing a purchase while the
buyer wallet equals the seller wallet is refused with: "The buyer wallet is
the seller wallet. Sign in as the buyer with a second throwaway wallet …".

## Lost wallet: Start over

The dashboard keeps each role's sign-in for the whole launcher run. If the
browser profile that holds a role's built-in wallet is lost, use **Start over
as a new buyer** (step 2) or **Start over as a new seller** (S1). Each button
is shown whenever that role has a sign-in, and is reachable with Tab.

- The role returns to `Not signed in.` / `Seller not signed in.` and focus
  moves to its sign-in button. Sign in with a new built-in wallet.
- The previous session moves to **Earlier buyer sign-ins in this run (as
  last observed)** or **Earlier seller sign-ins in this run (as last
  observed)**: the old wallet and the status its purchase, identity changes or
  listing last had. The list ends with "Last observed status, not refreshed;
  only that wallet can approve anything still pending." (or "… can continue
  its publication.").
- Nothing is cancelled or rewritten on the plugin, fixture chain or
  directory. The old operations stay on the old account and only the old
  wallet can continue them.

A hint next to each sign-in, and next to the purchase and publication portal
links, says that the wallet is stored in this browser profile and points to
Start over or a launcher restart.

## Steps

A **Steps** list at the top links to every section, and **Suggested next**
points at the step most testers would do next.

1. **Start.** The dashboard shows whether the plugin and fixtures are running
   and the launcher **Run** id. Open the built-in wallet page and create a
   **throwaway** wallet there.

**S. Seller wizard: publish your own simulated listing.**

- **S1 Sign in as seller.** The tab goes to the normal portal sign-in (the
  portal names the seller client). Choose the experimental embedded wallet,
  unlock the seller wallet, connect it and approve `account-login`.
- **S2 Describe the listing.** Type a **Service title** (3 to 120 characters,
  one line), a **Fixed price** in fixture DEM (greater than zero, digits with
  an optional dot, at most 9 decimals, e.g. `2.75`) and an optional
  **Description** (at most 500 characters). **Prepare listing** (or Enter)
  calls `register_agent`. The listing uses the canonical decimal; after
  Prepare the price field shows it, with a note when it differs from what you
  typed ("You typed 5.120; the listing uses 5.12 DEM."). Everything else is fixed: seller name
  `Offline tester seller (SIMULATED)`, endpoint
  `https://seller.invalid/offline-tester/<listingId>` (never contacted),
  category `services.offline-tester`, tags `offline, simulated, tester`, 7
  days validity, and a listing id made from the title plus a random suffix. A
  SIMULATED label is appended to the description. Problems are shown next to
  each field, the field is marked invalid, and focus moves to the first field
  to fix. Preparing publishes nothing. Pressing it again with the same fields
  returns the same pending listing ("same pending listing returned, not a new
  one"); different fields are refused while one is still being published.
- **S3 Approve publication in the portal.** **Open publication approval in
  the portal** opens the portal page "Publish your seller agent listing" in a
  new tab. With the built-in wallet only (no extension):
  1. **Use the experimental embedded wallet**, unlock the seller wallet,
     **Connect wallet**.
  2. **Sign identity** → the wallet dialog shows a
     `dacs-bundle-presentation:v1:…` message → **Approve**.
  3. **Sign listing** → the dialog shows a `dacs-listing:v1:…` message →
     **Approve**.
  4. The wallet immediately asks for the storage write: action
     `publish DACS listing (storage program create)`, naming your title and
     price, the storage address, the storage fee and "SIMULATED loopback
     fixture" → **Approve**. The portal's **Publication stages** list then
     shows "Storage write approved and broadcast: verified" and "Independent
     chain readback: verified", and the page says "Chain readback verified
     your signed listing."
  5. **Register with directory** → the dialog shows a
     `dacs-directory registration` message with your seller claim →
     **Approve**. The log says "Directory registration submitted." and the
     stages show "Directory registration submitted: reported, not yet
     independently verified" and "Discoverable in directory: waiting for
     readback".
  6. **Check directory again** → "Discoverable in directory: verified".

  **Reject** at any wallet dialog sends nothing; reopen the link to continue.
  **Cancel unpublished listing** (`cancel_wallet_handoff`) is offered on the
  dashboard until the storage write is sent.
- **S4 Check publication.** **Refresh publication status** calls
  `get_agent_status`, then `verify_agent_publication` (an independent re-read
  of the fixture chain and directory), then an anonymous `search_agents` for
  the exact title. Six stages are shown; each is `done` only from what the
  plugin reported or what was read back:

  | Stage | Done when |
  | --- | --- |
  | prepared | `register_agent` returned an operation |
  | signed | status is past `awaiting_listing_signature` |
  | submitted | the wallet reported the storage write (`broadcast_reported` or later) |
  | chain | `get_agent_status.onChainVerified` (exact signed bytes owned by the seller wallet) |
  | directory | `directory_submitted` or `directory_visible` |
  | discoverable | `directory_visible` **and** a title search returns this exact listing |

  `publication_mismatch` shows the chain stage as **FAILED**; a cancelled
  listing shows **cancelled** and no later stage. The facts list shows the
  title, price, listing id, status, storage address, chain evidence
  (`simulated-fixture, SIMULATED`) and the buyer-search result.

2. **Sign in** (buyer). Same portal sign-in with the buyer wallet. If you
   decline, nothing is linked and the dashboard shows that. If the page does
   not move on, a visible link is shown instead.
3. **Find the test service.**
   - **Find test service** looks up the shipped baseline listing
     (`offline-fixture-report`, 1.5 fixture DEM) with `search_agents` and
     verifies it with `get_listing`.
   - **Search the directory by title** + **Search directory** (or Enter) runs
     `search_agents` for any text and lists up to 10 results, each tagged
     `baseline fixture` or `seller-published`. **Verify and choose** runs
     `get_listing` for that result and makes it the purchase target. An empty
     search is explained and focus returns to the search box.
   - The directory result is shown as an **unverified hint**. The fixture
     chain verification is shown separately, with its title, price, seller and
     the `simulated-fixture` evidence label.
4. **Simulated purchase.** The line **Buying:** names the verified target and
   its price.
   1. **Prepare simulated purchase** calls `prepare_purchase`. The dashboard
      keeps the idempotency key, so pressing it again returns the same pending
      purchase ("same pending purchase returned, not a new one"). While one is
      pending, preparing a different listing is refused ("… is still
      awaiting_approval. Approve or cancel it before buying a different
      listing.").
   2. Open the **review link** and approve the exact terms in your wallet,
      inside the portal. **Reject** there leaves it `awaiting_approval`.
   3. **Refresh receipt** calls `get_purchase_status`. Only
      `settled_verified` with `simulated-fixture` evidence shows the
      **Simulated purchase receipt**: amount, network, payer, payee and
      transaction hash. Waiting or unavailable is **not** completion. A
      `Prepare` answer for an already finished purchase shows its plain status,
      with no review link and no receipt until **Refresh receipt** reads it.
   4. **Cancel pending purchase** (`cancel_wallet_handoff`) is offered while a
      purchase is still pending.
   5. **Prepare simulated purchase** after a purchase has finished
      (`settled_verified`, `cancelled`, `payment_failed`, `payment_mismatch`,
      `expired`, `terms_changed` or `superseded`) starts a **new** purchase. It
      keeps the finished one. The finished purchase moves to **Finished
      purchases kept from this sign-in** (newest first), with its terms,
      status and operation. A settled one keeps its simulated receipt (payer,
      payee, transaction hash); if the dashboard had not read that receipt yet,
      it reads it once first. A cancelled or failed one says "No receipt." and
      never gets one. At most the last 10 are kept.
5. **Test GitHub and Twitter identities.**
   1. **Add test GitHub identity** / **Add test Twitter identity** call
      `start_identity_action` and give you portal review links ("Open add
      review in the portal" / "Open Twitter add review in the portal").
   2. Proof text is published on the **local proof publisher** (choose
      `github` or `twitter` there), which is a fixture: nothing is posted to
      GitHub or X.
   3. **Refresh identities** calls `get_identities` and shows the observed
      GitHub and Twitter handles. This is a fixture chain observation, not KYC
      or a verified legal identity.
   4. **Remove test GitHub identity** / **Remove test Twitter identity** offer
      only the handles seen in the last readback.
6. **Manual checks.** Tick these yourself after doing them in the wallet and
   portal pages: lock, unlock, encrypted backup export, restore in a fresh
   profile, and declining a request. Ticks are **tester-marked**; the
   dashboard does not observe them.
7. **Feedback export.** **Download feedback file** saves
   `dacs-offline-tester-feedback.json` (format unchanged): the public step
   statuses, your ticks, the app name/version and evidence label, and your
   note. No addresses, links, keys, transaction hashes, tokens or logs.
8. **Evidence download.** **Download evidence file** saves
   `dacs-offline-tester-evidence.json`; see the schema below. **Recent
   activity** lists the last dashboard actions and their outcome.

## Interruptions, reloads and restarts

- **Reload** is always safe: state lives in the launcher and nothing is
  repeated. **Unfinished steps** lists anything started but not finished
  (sign-ins, the seller publication, the purchase, identity changes) with a
  hint and a link to its section.
- **Closed a portal tab or wallet dialog:** nothing was sent. Reopen the link
  shown in that step, or cancel it. Prepare returns the same pending operation.
- **Launcher restarted:** every start is a fresh run with a new **Run** id.
  An open dashboard shows a red notice ("The offline launcher was restarted
  …") and no state from the old run. Wallets in the browser remain; sign in
  again.
- **Launcher stopped:** a red notice says the page cannot reach the launcher.

## Keyboard

Tab / Shift+Tab move between controls; Enter or Space presses buttons; Enter
submits the listing and search forms. The first Tab reaches **Skip to
steps**. Step links move focus to their section. After a failed action, focus
moves to the message that explains it; for the listing form, to the first
field to fix. A **Help and recovery** section (expandable items) repeats this
guidance on the page.

## Public dashboard API (fixture-only, loopback)

All under the plugin origin. POSTs must have `content-type: application/json`,
`x-dacs-tester: 1`, and no `Origin` header or the dashboard's own origin;
otherwise `403`.

| Route | Answer |
| --- | --- |
| `GET /tester/` | the page (self-only CSP) |
| `GET /tester/api/state` | public state (below) |
| `POST /tester/api/action` `{action, args}` | `{ok, error?, fields?, state}` |
| `POST /tester/api/export` `{feedback}` | `{ok, export}` (feedback file) |
| `POST /tester/api/evidence` `{}` | `{ok, evidence}` (evidence file) |
| `GET /tester/oauth/callback`, `GET /tester/oauth/seller-callback` | OAuth return; `303` to `/tester/#sign-in` or `/tester/#seller` |

Actions: `sign-in`, `restart-sign-in`, `refresh-account`, `seller-sign-in`,
`seller-restart-sign-in`, `seller-refresh-account`, `buyer-start-over`,
`seller-start-over`, `seller-register`
`{title, priceDem, description?}`, `seller-refresh`, `seller-cancel`,
`find-listing`, `search-listings` `{query}`, `verify-listing`
`{listingId, version, seller}` (must be a current search result),
`prepare-purchase`, `refresh-receipt`, `cancel-purchase`, `identity-add`
`{kind: github|twitter}`, `identity-remove` `{username, kind}`,
`refresh-identities`, `checklist` `{item, done}`. A second identical request
while one runs joins it.

State keys: `notice`, `evidence` (`simulated-fixture`), `runId`, `links`,
`fixture` (baseline listing), `signIn` (buyer), `seller.{signIn, listing,
fieldErrors, error}`, `listing.{discovery, verification, search, error}`,
`purchase`, `completedPurchases` (finished purchases of this sign-in, oldest
first: `operationId`, `status`, `terms`, `receipt`, `keptAt`),
`identity.{add, remove, twitter.{add, remove}, observed, error}`,
`checklist`, `earlier.{buyer, seller}` (sessions left with Start over, as
last observed; a buyer entry includes `completedPurchases` with
`operationId`, `status`, `listingId`, `amount`, `receiptObserved`),
`activity`, `unfinished`, `busy`. Sign-in `status` is one of
`signed_out | redirected | signed_in | no_wallet | declined | error`.

### Evidence file schema (`kind: dacs-offline-tester-evidence`, `format: 1`)

`createdAt`, `notice`, `simulation` (`evidence: simulated-fixture`,
`funded/demosTestnet/chatgpt/securityReviewed/settlement: false`), `app`,
`run.id`, `baselineFixture`, `seller.{signIn, wallet, listing.{listingId,
title, priceDem, agentId, operationId, publicationStatus, storageAddress,
onChainVerified, chainMode, directoryVisible, discoverable, checkedAt,
stages[]}}`, `buyer.{signIn, wallet, search, target.{listingId, version,
seller, title, amount, currency, amountOs, transactable, chainMode, baseline},
purchase.{operationId, status, listingId, amount, amountOs, network, payee,
receipt}, completedPurchases[]}` (finished purchases kept when a later one
was prepared, oldest first, same fields as `purchase`),
`identity.{add, remove, twitterAdd, twitterRemove, readback}`,
`unfinished[]`, `earlier.{buyer[], seller[]}` (old wallet, last observed
purchase/identity/listing status, `leftAt`; buyer entries also list
`completedPurchases[]` with `operationId`, `status`, `listingId`, `amount`,
`receiptObserved`), `testerMarked`,
`fixtureCounts.{chain, directory}`,
`activity[]`. It contains public wallet addresses and fixture transaction
hashes; never portal links (`#t=` capabilities), OAuth values, idempotency
keys, passwords, recovery phrases, backups or keys.

## Cancelling and declining

- Close the portal tab, or press **Reject** in the wallet dialog. Nothing is
  retried automatically.
- A declined sign-in links nothing.
- A rejected purchase stays `awaiting_approval` and can be cancelled from the
  dashboard; it never shows a receipt.
- An unpublished listing can be cancelled; it never shows a published stage.
- A rejected identity change reports `rejected_before_send`.
- An identity action the built-in wallet stops before sending is
  `failed_before_send`; one cancelled on its portal page before the wallet is
  asked is `cancelled`. Neither blocks the wallet. See
  `IDENTITY-RECOVERY.md`. The dashboard treats both as finished. They are
  not listed under **Unfinished steps**, and pressing the same **Add test …
  identity** button again starts a new action in the same run, with no
  restart. Details: "Identity action refused, stopped or cancelled before
  anything was sent" in `OFFLINE-TESTER.md`.
- A cancelled purchase never gets a receipt. If you prepare another
  purchase, it stays listed under **Finished purchases kept from this
  sign-in** with "No receipt.".

## Checks (source checkout only)

These test and script files exist only in a source checkout, not in the
installed package.

- `test/tester-dashboard.test.mjs`: loopback startup and assets (no external
  assets), the allowlist change, public-only state, same-origin requests, the
  MCP listing flow, sign-in start and declined callback, export allowlist and
  error scrubbing, CLI wiring, normal MCP unchanged, and that the production
  app never references the dashboard.
- `test/overnight-ui.test.mjs`: fixture storage-program writes and directory
  indexing; seller wizard through publication stages; a separate buyer
  discovering and buying the new listing at its price; input errors; the
  one-pending and buyer-is-not-seller rules; cancellation; restart run id; the
  evidence file; and that the launcher (programmatic and CLI) serves the
  embedded-wallet profile with `capabilities.publication: true` and SIMULATED
  labels. These node checks sign with a test key over the portal HTTP API (no
  browser); the browser test below uses only the built-in wallet.
- `test/browser/tester-dashboard.browser.test.mjs`: real Chromium
  (`DACS_TEST_CHROME`; a missing browser fails) through the original guided
  flow.
- `test/browser/overnight-ui.browser.test.mjs`: real Chromium, two browser
  contexts (seller, buyer), built-in wallet only: keyboard use, form errors,
  reload recovery, seller publication through the portal (identity, listing,
  storage write, chain readback, directory registration, directory visible),
  buyer discovery and purchase of the new listing including a rejection and an
  interrupted approval, Twitter add/remove, keyboard evidence download, and
  the restart notice. Each area is its own reported test; the publication
  test fails if the portal refuses the built-in wallet or any publication step
  fails, and the buyer tests that need the listing then fail too (nothing is
  skipped or reported as blocked). See `OVERNIGHT-UI.md`.
- `test/browser/overnight-ui-recovery.browser.test.mjs`: real Chromium,
  built-in wallet: a Twitter add with a mistyped post URL that the wallet
  refuses before signing, what the portal and dashboard show, that the
  dashboard's **Add test Twitter identity** starts a new action in the same
  run without a restart, that purchases still work, and that Sign in stays
  disabled while Start over is offered. The closed action is not listed as
  unfinished. See "Identity action refused, stopped or cancelled before
  anything was sent" in `OFFLINE-TESTER.md`.
- `test/closure-dashboard-recovery.test.mjs`,
  `test/closure-dashboard-witness.test.mjs`,
  `test/browser/closure-dashboard-recovery.browser.test.mjs` and
  `test/closure-acceptance-dashboard-purchases.test.mjs` (CA-F1): closed
  identity actions count as finished, and Add starts a new one. A finished
  purchase and its receipt are kept when Prepare starts the next one, in the
  dashboard state, in `buyer.completedPurchases` and, after Start over, in
  `earlier.buyer[].completedPurchases`.
- `test/browser/overnight-ui-start-over.browser.test.mjs`: real Chromium,
  built-in wallet: an accepting same-profile purchase; then a new browser
  profile uses Start over (keyboard) for the buyer and the seller, a new
  wallet completes a baseline purchase and prepares a new listing, and the
  earlier operations stay listed with their last observed status; the price
  note ("You typed 5.120; the listing uses 5.12 DEM.").
- `scripts/check-tester-dashboard-package.mjs [--keep] [--screenshot-dir DIR]`
  runs the original flow against the **installed** tarball.
- Browser checks put downloads in a fresh directory under
  `DACS_TEST_DOWNLOAD_PARENT` (use a parent outside `/tmp` with a snap
  browser; a `/tmp` download directory produced empty files).

## Limits

- **Simulated fixtures only.** Live, testnet, ChatGPT and security acceptance
  remain held. This partial v2 build is not accepted.
- **Built-in wallet publication is simulated-loopback only.** It is enabled
  by the launcher's fixture profile; production and testnet profiles do not
  allow it.
- **Tested on Linux only** (Chromium snap, Node 22.22.0). Mac and Windows need
  human confirmation.
- **Held gates.** The external security review is on hold. Live Demos testnet and ChatGPT are
  held.
- **Not a production image.** An older production container image does not
  contain the dashboard.
