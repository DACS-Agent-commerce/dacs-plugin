# Guided seller → buyer validation (SIMULATED fixtures only)

**SIMULATED ONLY.** Everything here runs against local fixtures started by the
offline launcher. It is not Demos testnet, not funded, not ChatGPT and not a
security review. A fixture receipt is not settlement. The external security
review is on hold. Live, testnet, ChatGPT and v0.1 acceptance are held.

This guide needs no source. It says what to open, what to press, what you
should see and what to record, mapped to clauses C1–C7. Every step uses public
pages only: the tester dashboard, the built-in wallet page, the portal pages
the dashboard links to, and the local proof publisher. `TESTER-DASHBOARD.md`
is the full dashboard reference; `OFFLINE-TESTER.md` describes the launcher.

## What you need

- The **Tester dashboard** address you were given (the launcher prints it on
  its `Tester dashboard:` line). Everything else is reached from there.
- **Two browser profiles**, for example a normal window and a private window.
  The built-in wallet keeps one wallet per browser profile, and the seller and
  the buyer must be different wallets. **No browser extension is needed.**
- Fresh throwaway passwords. Never record a password or recovery phrase in
  evidence. The dashboard never shows them.
- Keep each role in the same browser window for the whole run. The built-in
  wallet is stored in that browser profile; a new profile or cleared site
  data loses it. If that happens, see C5 step 6 (**Start over**).

Wallet dialogs: every wallet request opens a dialog with **Reject** and
**Approve** buttons. Escape closes it as a rejection.

## C1 — Dashboard, labels, built-in wallet, sign-in

1. Open the dashboard. Expect a banner that stays on screen: **SIMULATED
   ONLY** / "No real funds. Not Demos testnet. Not ChatGPT. Not security
   reviewed. A fixture receipt is not settlement." Step **1 Start** shows
   `Plugin: Running (fixture chain configured, fixture directory configured)`,
   `Evidence: simulated-fixture (local fixtures only)`, a **Run** id and "No
   browser extension is needed." The dashboard has no password field.
2. **Open the built-in wallet page** (opens a tab) → fill the password fields
   → **Create wallet**. The page shows **Wallet unlocked**, an `Address`
   (`0x…`, public) and a **Recovery phrase** box (only on that page; do not
   record it). Close the tab.
3. Seller profile, section **S Seller wizard**, **S1**: press **Sign in as
   seller**. The tab goes to the portal page **Link your DACS account**; the
   requesting app reads `DACS offline tester dashboard - seller (SIMULATED)`.
   Press **Use the experimental embedded wallet**, type the password, **Unlock**,
   then **Connect wallet** (expect "Connected: 0x… (experimental embedded
   wallet)"), then **Sign in and allow**, and **Approve** the dialog showing
   `purpose: account-login` and your address. Back on the dashboard: `Seller
   signed in. Linked wallet: 0x…`.
4. Buyer profile: open the same dashboard address, create a second wallet the
   same way, and use step **2 Sign in** → the same portal steps. Expect
   `Signed in. Linked wallet: 0x…` with a **different** address.

Evidence: screenshots of the banner and both sign-in statuses; the two public
addresses.

## C2 — GitHub and Twitter identities (buyer profile)

1. Step **5**: **Add test Twitter identity** → the line "Twitter add:" shows
   `prepared` or `awaiting_wallet` → **Open Twitter add review in the portal**
   (new tab) → **Use the experimental embedded wallet**, unlock, **Connect
   wallet** → **Use my connected wallet** → **Get proof text from my wallet** →
   **Approve**. The proof text (`demos:dw2p:ed25519:…`) appears.
2. On the dashboard open the **local proof publisher** link: choose kind
   `twitter`, enter a handle (letters, digits, `_` or `-`, up to 39), paste the
   proof text, **Publish SIMULATED proof**. Copy the URL shown under
   "SIMULATED proof URL (paste this into the portal):". Nothing is posted to
   X; only the fixture resolves it.
3. In the portal tab: paste the URL, **Use this proof URL**, **Approve in my
   wallet**, **Approve** → "Association observed on chain."
4. Dashboard: **Refresh identities** → `Twitter handles: <handle>`; "Twitter
   add:" shows `association_observed`.
5. Choose the handle under **Observed Twitter handle**, **Remove test Twitter
   identity** → **Open Twitter remove review in the portal** → wallet unlock
   and connect → **Use my connected wallet** → **Approve in my wallet** →
   **Approve** → "Association no longer observed on chain." Dashboard:
   **Refresh identities** → `Twitter handles: none observed`; "Twitter
   remove:" shows `removal_observed`.
6. Repeat with **Add test GitHub identity** / **Remove test GitHub identity**
   (publisher kind `github`; handle of letters, digits and `-` only); the
   dashboard shows it under `GitHub handles`.

Evidence: the Readback / handles rows before and after each change.

**If an identity request is refused or stopped before anything is sent.**
Recovery happens in the same run, with the same wallet, and needs no
launcher restart (rules in `IDENTITY-RECOVERY.md`):

- **Impossible GitHub handle** (for example one containing `_`): **Use this
  proof URL** is refused with "“<handle>” cannot be a GitHub username …
  Nothing was sent to your wallet." The page stays at the proof step:
  publish the gist under a valid handle (letters, digits, single hyphens) and
  paste the new URL in the same action.
- **The built-in wallet stops before sending** (for example a mistyped or
  unpublished post URL: "the configured Demos node did not answer getTweet;
  nothing was signed"): **Approve in my wallet** opens no wallet dialog. The
  portal shows the wallet's answer, "Nothing was signed or sent.", and says
  the action is closed and a new identity action can be started. **Refresh
  identities** shows the add as `failed_before_send`. It is not listed under
  **Unfinished steps**.
- **Cancel before approving**: **Cancel this identity action** on the portal
  page closes the action as `cancelled`; nothing reaches the wallet.
- Then press **Add test … identity** again. It starts a new action with a
  new portal link (even if you did not refresh first). Complete it with a
  correct, published proof; it reaches `association_observed`. Purchases are
  never blocked.
- Still blocking, by design: if the wallet was asked and its answer does not
  show that nothing was sent (for example the page closed during approval),
  the add stays `readback_pending`/`outcome_unknown`, and a new identity
  action for that wallet is refused with `identity_operation_in_progress`
  until readback shows the change. Nothing is retried.

## C3 — The seller publishes a NEW listing with the built-in wallet (seller profile)

1. **S2 Describe the listing**: type a unique **Service title** (for example
   `Haiku review 7f3a`) and a **Fixed price (fixture DEM)** that is not 1.5
   (for example `2.75`), then **Prepare listing**. A price like `5.120` is
   shown afterwards as `5.12`, with the note "You typed 5.120; the listing
   uses 5.12 DEM." Expect under **S4**:
   `Status: awaiting_identity_signature`, your title and price, and the stage
   list `done: Listing prepared…`, `next: Identity and exact listing signed…`,
   the other four `not yet`. Nothing is published yet.
2. **S3**: **Open publication approval in the portal** (new tab). The portal
   page is **Publish your seller agent listing**, with your title and price in
   the details and a **Publication stages** list (the page's SIMULATED notice
   appears once fixture chain evidence exists; the wallet panel shows its own
   "SIMULATED: this page is configured with a local fixture chain…" notice):
   "Identity presentation signed", "Listing signed", "Storage write approved
   and broadcast", "Independent chain readback", "Directory registration
   submitted", "Discoverable in directory".
3. **Use the experimental embedded wallet**, unlock the seller wallet,
   **Connect wallet**.
4. **Sign identity** → the dialog shows a `dacs-bundle-presentation:v1:…`
   message → **Approve**.
5. **Sign listing** → the dialog shows a `dacs-listing:v1:…` message →
   **Approve**.
6. The wallet then asks for the storage write: action `publish DACS listing
   (storage program create)`, your title and price, a `stor-…` storage
   address, the storage fee, and "SIMULATED loopback fixture" → **Approve**.
   Expect "Storage write approved and broadcast: verified", "Independent chain
   readback: verified", "Directory registration submitted: your action is
   needed", "Discoverable in directory: not reached yet", and the text "Chain
   readback verified your signed listing."
7. Dashboard (seller profile): **Refresh publication status** → `Status:
   chain_verified`, stages `done` × 4 then `next: Registered with the fixture
   directory…`, `Chain evidence: verified by readback (simulated-fixture,
   SIMULATED)`, `Buyer search: not found by a title search yet`. (Verified on
   chain is not yet discoverable.)
8. Portal tab: **Register with directory** → the dialog shows a
   `dacs-directory registration` message with your seller claim → **Approve**.
   The log says "Directory registration submitted." Stages: "Directory
   registration submitted: reported, not yet independently verified",
   "Discoverable in directory: waiting for readback".
9. **Check directory again** → "Discoverable in directory: verified".
10. Dashboard: **Refresh publication status** → `Status: directory_visible`,
    all six stages `done`, `Buyer search: found: "<your title>" at <your
    price> DEM (simulated-fixture directory hint)`.

Rejecting any dialog sends nothing; the stage stays where it was. Before the
storage write, **Cancel unpublished listing** on the dashboard ends it as
`cancelled` (a `cancelled` stage, nothing later `done`).

Evidence: the S2 form, the portal stage list after steps 6, 8 and 9, and the
dashboard S4 facts after steps 7 and 10.

## C4 — A separate buyer finds and buys the new listing (buyer profile)

1. Step **3**: type the seller's exact title in **Search the directory by
   title** → **Search directory**. Expect `1 result(s) for "<title>"`, the
   title, the seller's price and the tag `seller-published`. (The shipped
   baseline listing is tagged `baseline fixture` and costs 1.5.)
2. **Verify and choose** → `Result: Verified: transactable`, `Title: <title>`,
   `Price: <price> DEM (<OS> OS, fixture DEM)`, `Evidence: simulated-fixture
   chain readback (SIMULATED)`. Step 4 shows `Buying: "<title>" for <price>
   DEM (fixture DEM), verified.`
3. **Prepare simulated purchase** → `Status: awaiting_approval`, the amount
   with the new OS value, `Pays` = the seller's address, and "No receipt yet.
   Waiting or unavailable is not completion."
4. **Open review in the portal** → wallet unlock and connect → **Approve exact
   terms** → **Approve** the `approve-purchase` dialog → **Approve** the
   transfer dialog (seller address, amount in OS, your address, SIMULATED) →
   the portal shows **Simulated purchase receipt**.
5. Dashboard: no receipt until **Refresh receipt**; then `settled_verified`
   and the **Simulated purchase receipt** box (amount, payer = buyer, payee =
   seller, transaction hash, "simulated-fixture (SIMULATED receipt from the
   fixture chain; not settlement)").

Vary the title and price each run; the search result, verification, terms and
receipt must all show the new values, never 1.5.

## C5 — Reload and interruption

1. With a purchase `awaiting_approval`: open the review, then close the portal
   tab without approving. Reload the dashboard. **Unfinished steps** lists
   `Simulated purchase (awaiting_approval)` with a hint. **Prepare simulated
   purchase** again shows `awaiting_approval (same pending purchase returned,
   not a new one)` and the same **Operation** id.
2. Reject: open the review, **Approve exact terms**, press **Reject**. The
   portal log says "the request was not approved; nothing was signed".
   **Refresh receipt**: still `awaiting_approval`, no receipt. **Cancel
   pending purchase** → `cancelled`, no receipt, no review link.
3. After a settled purchase, reload: still `settled_verified`, no review link,
   nothing under Unfinished steps. Pressing **Prepare simulated purchase**
   again starts a new purchase (`awaiting_approval`, new Operation id); the
   settled one, with its receipt (payer, payee, transaction), stays listed
   under **Finished purchases kept from this sign-in** and in the evidence
   download (`buyer.completedPurchases`). A cancelled or failed purchase is
   kept there too, never with a receipt.
4. Seller: reload with a listing in progress. The form is filled again, the
   listing appears under Unfinished steps, and **Prepare listing** with the
   same fields shows "(same pending listing returned, not a new one)".
5. If the launcher is restarted on the same address, reload an open
   dashboard: a red notice "The offline launcher was restarted since this page
   last loaded…", `Not signed in.`, and no purchase or receipt from the old run.
6. Lost wallet within one run. Open the dashboard in a new browser profile
   while a role is signed in:
   - The sign-in shows the old wallet ("Signed in. Linked wallet: 0x…" or
     "Seller signed in. Linked wallet: 0x…"). **Sign in** (or **Sign in as
     seller**) is disabled.
   - The hint reads "Your built-in wallet is stored in this browser profile.
     Keep using the same browser window for the whole run. Lost it (new window
     or profile, cleared site data)? Press Start over as a new buyer …".
   - Press **Start over as a new buyer** (Tab reaches it; Enter presses it).
     Expect `Not signed in.`, focus on **Sign in**, and a list **Earlier buyer
     sign-ins in this run (as last observed)**. It names the old wallet and,
     for example, "purchase pur_… for offline-fixture-report was
     awaiting_approval. Last observed status, not refreshed; only that wallet
     can approve anything still pending."
   - Create a new wallet, **Sign in**, and buy the baseline listing; it
     settles with the new wallet as payer. The earlier entry is unchanged.
   - **Start over as a new seller** works the same way, with **Earlier seller
     sign-ins in this run (as last observed)**.
   - Nothing on the plugin, chain or directory is cancelled or rewritten by
     Start over.

## C6 — Keyboard and input errors

1. On a fresh page press Tab: **Skip to steps** is first; Enter moves focus
   to the steps. Links in the **Steps** list move focus to their section.
2. Seller form: press Enter with empty fields → "Enter a service title (3 to
   120 characters)." and "Enter a fixed price in DEM, for example 2.75."; focus
   is on the title field, which is marked invalid. Price `1,50` → "Use digits
   with an optional dot and at most 9 decimals…"; `0` → "The price must be
   greater than zero."
3. Search: Enter with an empty search box → "Type part of a service title to
   search for…"; focus returns to the box.
4. Accepting controls: a 3-character title with price `0.000000001`, and a
   120-character title, are accepted.
5. Identity handle error: a GitHub proof URL with a handle such as `p7_stuck`
   is refused at the proof step ("“p7_stuck” cannot be a GitHub username …
   Nothing was sent to your wallet."); paste a corrected URL in the same
   action. See "If an identity request is refused or stopped before anything
   is sent" under C2 (no restart needed).
6. Wallet cancellation: **Reject** or Escape in a wallet dialog declines;
   **Lock** in the wallet while a request is open cancels it. Nothing is signed
   or sent, and the dashboard keeps the previous (pending) status. The
   dashboard's **Help and recovery** section says the same.

## C7 — Evidence download

1. Step **8**: **Download evidence file** (Enter on the focused button works)
   saves `dacs-offline-tester-evidence.json`. The page says "Evidence file
   created on this computer (SIMULATED workflow states only). Nothing was
   sent."
2. It is nonempty JSON with `kind: dacs-offline-tester-evidence`,
   `simulation.evidence: simulated-fixture` and `funded`, `demosTestnet`,
   `chatgpt`, `securityReviewed`, `settlement` all `false`; the seller listing
   (title, price, publication status, stages); the buyer's search, the
   verified target (`baseline: false` for the seller's listing), purchase
   status and receipt; earlier finished purchases of this sign-in with their
   receipts (`buyer.completedPurchases`); identity readback; unfinished steps;
   recent activity.
3. It contains no password, recovery phrase, backup, key, cookie, token,
   portal link (`#t=`) or idempotency key. Public addresses and fixture
   transaction hashes are expected.
4. A cancelled or rejected purchase shows its real status (`cancelled`,
   `awaiting_approval`) with `receipt.observed: false`; never success. This
   holds in `buyer.completedPurchases` too.

## Known limits

- Simulated fixtures only; built-in-wallet publication exists only in the
  launcher's simulated profile.
- The fixture chain charges no fees; the wallet shows the SDK's storage fee
  for information only.
- Checked on Linux with Chromium; other platforms need human confirmation.
