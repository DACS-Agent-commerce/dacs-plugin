> Historical v1 publication procedure. Publication tools and signing routes are retired in v2. These seller steps require the preserved v1 release; use the v2 quickstart for buyer workflows.

# Overnight ordinary functional tests (SIMULATED fixtures only)

These tests check ordinary user behaviour of the offline plugin. They read the source, and their expectations come from the public user contract: the MCP tool schemas and descriptions, the portal and dashboard text, and the rule 1 DEM = 10^9 OS. They do not use the plugin's own answers as expected values.

**What these tests are not:**
- not a security review;
- not live Demos testnet, ChatGPT or installed-wallet evidence;
- not full v0.1 acceptance or human approval.

Every check runs against local loopback fixtures, with fresh synthetic wallets.

## Files

These test files exist only in a source checkout. The installed package does not include `test/`.

| File | Level | Runs in |
| --- | --- | --- |
| `test/overnight-acceptance.test.mjs` | MCP tools + portal API, source harness | `npm test` |
| `test/overnight-acceptance-ui.test.mjs` | guided dashboard public HTTP interface + portal API + fixture chain RPC, offline launcher | `npm test` |
| `test/helpers/overnight-acceptance-dashboard.mjs` | dashboard/portal driver; synthetic wallet-extension stand-in (labelled) | — |
| `test/overnight-acceptance-core.test.mjs` | wallet profiles via the portal profile endpoint and config loader, source harness | `npm test` |
| `test/browser/overnight-acceptance.browser.test.mjs` | real Chromium, offline launcher, dashboard, portal and embedded wallet | `npm run test:browser` |
| `test/browser/overnight-acceptance-widget-click.browser.test.mjs` | real Chromium, fixture MCP Apps host (not ChatGPT) | `npm run test:browser` |
| `test/helpers/overnight-acceptance-flows.mjs` | API drivers and independent oracles | — |
| `test/helpers/overnight-acceptance-browser.mjs` | browser drivers (roles, labels and visible text only) | — |
| `test/browser/overnight-ui-recovery.browser.test.mjs` | real Chromium, guided dashboard: recovery after a pre-sign identity refusal | `npm run test:browser` |
| `test/browser/closure-acceptance-identity-recovery.browser.test.mjs` | real Chromium, offline launcher, portal and embedded wallet: R1 recovery, the retained ambiguous-outcome rule, portal cancel | `npm run test:browser` |
| `test/closure-acceptance-identity.test.mjs` | identity report classification, cancel route and proof-step rule via the portal API and MCP tools, source harness | `npm test` |
| `test/helpers/closure-acceptance-identity.mjs` | identity-status oracle from the public contract; proof publisher driver; mistyped-post trigger | — |
| `test/closure-acceptance-dashboard-purchases.test.mjs` | guided dashboard public HTTP interface + purchase portal API + fixture chain RPC, offline launcher: finished purchases kept (state, evidence, Start over) | `npm test` |

## Running

```sh
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/overnight-acceptance.test.mjs
DACS_TEST_CHROME=/path/to/chrome DACS_TEST_DOWNLOAD_PARENT=/a/dir/outside/tmp \
  node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/browser/overnight-acceptance.browser.test.mjs
```

The browser files **fail** in each of these cases:
- `DACS_TEST_CHROME` is missing;
- `DACS_TEST_DOWNLOAD_PARENT` is missing;
- `DACS_TEST_DOWNLOAD_PARENT` is under `/tmp`. A snap browser delivered empty download files there.

None of these cases is a skip.

## Clause map

The clause IDs C1–C7 are the behaviour-contract clauses. Each test pairs its rejection checks with an accepting control that is identical except for the faulty input.

### API level (`overnight-acceptance.test.mjs`)

| ID | Clause | What is checked | Independent expectation |
| --- | --- | --- | --- |
| OA-N0 / N0b | oracle witnesses | DEM→OS conversion; the input-rejection classifier; an unknown hash; a failed-on-chain transfer | 1 DEM = 10^9 OS. Success or a coded domain error is never an input rejection. A failed transfer is never settled. |
| OA-N2 | C4 dynamic | The listing's title and price change after prepare. The same listing id is also published by another seller address. | Approval stops at `terms_changed` before any signature, with nonce unchanged. The new terms are shown and paid. The other seller is paid at its own address and price. |
| OA-N3 ×2 | C2 | GitHub and Twitter: add, then remove. Bad proof URLs (empty, not a URL, wrong host) are refused, then the valid proof is accepted. A wallet "success" alone does not count as observed. | `get_identities` readback changes `[] → [handle] → []`. The wallet request methods and params follow the tool contract. The wallet stays linked. |
| OA-N3b | C2, C6 | `USER_REJECTED` gives `rejected_before_send` and links nothing. Handles that fail the schema are refused. | A well-formed handle reaches the domain check `identity_not_associated`. |
| OA-N4a | C5 | Restart during payment handoff. Restart again after the broadcast, so the wallet report is lost. | Same operation for the same key. The identical payload is re-issued. Status is not settled before readback. `verify_deal` then settles it. Exactly one transfer. No payload once settled. |
| OA-N4b | C5, C6 | Wallet rejects the transfer, then cancel, then restart. A mistyped tx hash. | Never settled. `cancelled` survives restart. No payload. Nonce 0. The typo is refused and the status is unchanged. |
| OA-N5 (seller.test.mjs) / N5b | C6 | Malformed price, title, listing id, endpoint and validity are refused. Purchase errors: short key, unknown listing, wrong version, self-purchase, reused key. | Nothing is created by refused input. Boundary controls are accepted: a 9-decimal price and a 3-character id. A key replay returns the same operation. |

### Dashboard level (`overnight-acceptance-ui.test.mjs`): offline launcher

Expectations come from the tester guides `OVERNIGHT-UI.md` and `TESTER-DASHBOARD.md` and from the behaviour contract, not from the dashboard's own tests. The seller and buyer "wallets" here are synthetic extension-wallet stand-ins. They sign portal messages and SDK-shaped transactions, so they are not evidence for the built-in wallet.

| ID | Clause | What is checked |
| --- | --- | --- |
| OA-U1 | C3, C4, C7 | Two new listings with different titles and prices, and one separate buyer. Publication stages: `prepared` → `signed` (chain not done) → after the reported write, `chain` is done but `directory` and `discoverable` are not → after the owner-signed registration, both are done. A title search finds nothing before that registration. The stored listing is read back through the public storage read. Buyer search, verify, prepare and pay: the receipt appears only after Refresh, and an independent `getTxByHash` readback confirms the transfer. The 1.5 DEM baseline still buys in the same run. The evidence file reflects these actions and contains no portal link, token or idempotency key. |
| OA-U2 | C6 | Every seller-form error documented in the guide is refused with its message and prepares nothing: empty or blank title, 2 or 121 characters, price 0, 0.000, negative, 10 decimals, comma, non-numeric, with a unit. Accepting controls: `abc` at 0.000000001, a 120-character title, and cancel (no later stage done). Empty search. Empty GitHub and Twitter remove handles. |
| OA-U3 | C4 | Buyer and seller with the same wallet: the purchase is refused with the documented explanation. |
| OA-U4 | fixture chain | A correct storage-program CREATE is accepted and readable. A CREATE at an already-used address is refused, leaving the data and nonce unchanged. A later correct write still succeeds. |

Stage-table coverage remains in `overnight-core-seller.test.mjs`; publication
flows remain in `seller.test.mjs` and the dedicated browser suite.

### Profiles (`overnight-acceptance-core.test.mjs`)

Expectations come from the published publication-stage table, the profile endpoint shapes and the held-profile configuration rules in `OVERNIGHT-CORE.md`.

| ID | What is checked |
| --- | --- |
| OA-C1 | **Default profile** is exactly `{writes:"off"}`. The simulated profile reports `capabilities`, and its identity capability follows `DACS_IDENTITY_WRITES`. **Held profile config:** it is accepted only with an https, non-loopback RPC and an explicit network label. It is refused for http, loopback, a missing RPC, a missing or bad label, the fixture GitHub origin, or an unknown value. The default is off. **Held app:** the profile endpoint shape is checked, and the wallet relay is not mounted (404). The RPC host is a reserved `.invalid` name and is never contacted. |

### Browser level (`overnight-acceptance.browser.test.mjs`): installed launcher path

| ID | Clause | What is checked |
| --- | --- | --- |
| OA-B1 | C1, C6 | Banner labels and no password field on the dashboard. Tab order, with sign-in-gated steps unreachable before sign-in. The wallet page opens from the keyboard. Wallet create errors: empty, weak, mismatch, then the valid control. Portal unlock errors: empty, wrong, then the valid control. Escape declines the sign-in: nothing linked, the reason is logged, and the unlock is kept. Keyboard approval: focus starts on Reject, Tab moves to Approve, Enter activates it. Find and Prepare by keyboard. Waiting is not shown as completion. |
| OA-B2 | C4, C5, C7 | The portal reloads while the transfer approval is open: nothing is sent, the state is `payment_handoff`, and the dashboard reload keeps the same operation. Resuming produces exactly one broadcast and the receipt. The settled page offers no further approval. A rejected signature leaves the purchase awaiting approval. A rejected transfer means no broadcast and no receipt. Dashboard cancel leaves the portal with no approval and no receipt. The export file is non-empty JSON in the task-owned download dir, reflects these actions, and carries no address, password or link. |
| OA-B3 ×2 | C2 | GitHub and Twitter through the portal, with the embedded wallet and the local proof publisher. An empty proof URL is refused. Add is approved and observed. The first remove is rejected and the handle stays. The second remove is approved and observed. Readback goes through `get_identities`. Every request stays on the loopback origins. |
| OA-B3b | C6 | A GitHub handle that cannot be a GitHub username (contains `_`): the proof publisher publishes it. The portal must refuse it visibly at the proof step within 30 s, and the refusal must name the problem. The wallet is not asked: no dialog and no wallet answer. The action stays `awaiting_public_proof` in the portal and in `get_identities`. Accepting control in the same action: a corrected GitHub-valid URL reaches the wallet approval and is observed. Readback then shows only the corrected handle, and the wallet can start another identity action. |
| OA-B5 | C2 | The guide's dashboard identity steps, for Twitter and then GitHub: Add, the portal review, the local proof publisher, and wallet approval. After Refresh the handle row shows the handle. Then Remove, wallet approval and Refresh show `none observed`. Exactly four identity writes are made. |

### Identity recovery (R1): `closure-acceptance-identity.test.mjs`, `closure-acceptance-identity-recovery.browser.test.mjs`, `overnight-ui-recovery.browser.test.mjs`

Expected results come from the identity status help texts, the in-flight rule in `OVERNIGHT-CORE.md` ("Identity actions"), the embedded wallet's error codes in `EMBEDDED-WALLET-SDK.md` and the closure identity interface. They do not come from the identity service's classifier. The closure interface:

- `failed_before_send` (terminal) is reached only when an embedded-wallet answer (`wallet: 'embedded'`) is not a success and carries one of the wallet's documented pre-send codes.
- `cancelled` is reached through `POST /portal/api/identity/:id/cancel`, from the four steps before the wallet is asked.
- A GitHub proof URL whose handle has characters outside `[A-Za-z0-9-]` is refused at the proof step (`invalid_proof_url`).
- `identity_operation_in_progress` details add `operationId`, `status`, `expiresAt` and `cancellable`.

A wallet that signed and sent nothing has not changed the chain, so its truthful status is closed: not in flight (`prepared`, `awaiting_wallet`, `awaiting_public_proof`, `review`, `wallet_requested`, `readback_pending` or `outcome_unknown`), not observed and not `expired`.

**Trigger.** After the repair, an underscore GitHub handle no longer reaches the wallet. The trigger is therefore a Twitter add whose pasted post URL is mistyped (last digit of the status id changed). The server checks only its shape. The embedded wallet asks the node for the post (`getTweet`), the fixture does not know it, and the wallet answers `upstream_unavailable` ("nothing was signed") before any dialog. This is an ordinary user mistake, reachable in the real UI.

| ID | Clause | What is checked |
| --- | --- | --- |
| CA-N0 | control | A valid add that the wallet sent is observed by readback. The next action then starts. |
| CA-N1 | C5 | Each of the 11 documented embedded pre-send codes gives `failed_before_send`, and `get_identities` agrees. A second wallet request is refused with 409 `invalid_state`. Viewing again does not reopen the action. Nothing is linked. A new action for the same wallet starts. |
| CA-N2 | C5 | The same code without `wallet: 'embedded'` (absent, `extension` or unrecognised) gives `readback_pending` with classification `unknown`, and blocks. Details: `operationId`, `status`, `expiresAt` and `cancellable: false`. A user rejection is `rejected_before_send` from either wallet. |
| CA-N3 | C5 | Ambiguous embedded answers stay `readback_pending` and block: `outcome_unknown`, `broadcast_rejected`, `internal_error`, `wallet_error`, `sdk_error`, `wrong_wallet`, an unknown code, or no code. The wallet is never asked twice. Boundary: `success: true` together with a pre-send code is not closed; a later readback still resolves it, with no retry. |
| CA-N4 | C5, C6 | Cancel from each of `prepared`, `awaiting_wallet`, `awaiting_public_proof` and `review` gives 200 `cancelled`; a second cancel also gives 200 `cancelled`. `get_identities` agrees, a cancelled action never asks the wallet, and the next action starts. An abandoned open action blocks with `cancellable: true`; cancelling it frees the wallet. |
| CA-N5 | C5 | Cancel after the wallet was asked is refused with 409 `invalid_state` and `details.status`, and changes nothing. Covered states: `wallet_requested`, `readback_pending`, `failed_before_send`, `association_observed`. |
| CA-N6 | C6 | An underscore GitHub proof URL gives 409 `invalid_proof_url` with an explanation, and the action stays at the proof step. The corrected URL in the same action proceeds and is observed. A Twitter underscore handle is unchanged (accepted). |
| CA-R1a | C2, C5, C6 | Browser, mistyped post URL. The built-in wallet refuses before any dialog opens; a passive page observer counts zero. The answer has code `upstream_unavailable` and "Nothing was signed or sent.". The portal and `get_identities` show `failed_before_send`. No "Check chain again" button and no `identity_operation_in_progress` claim; the text says the action is closed and a new identity action can be started. After a reload: same status, and the wallet is not asked again. Then in the same run, with no restart (the refused action is still listed), a new add for the same wallet completes with the correct post URL. Independent readback shows the handle once, and every request stayed on loopback. |
| CA-R1b | C5 | Ambiguous outcome kept. The wallet is asked, the person rejects, and the portal's report never reaches the server (the page's own `/report` request is aborted). The action stays `wallet_requested` and blocks. The reopened portal does not ask the wallet again and offers no cancel. Readback shows nothing linked. Closing the tab is not used: on `pagehide` the embedded wallet locks and answers `locked`, a documented pre-send code. |
| CA-R1c | C5, C6 | An open action blocks a new one (accepting control). **Cancel this identity action** on the portal page then gives `cancelled`, which survives a reload and offers no further step. The wallet starts a new action, and nothing is linked. |
| Dashboard recovery | C2, C5 | Same trigger, from the dashboard. After **Refresh identities** the Twitter add shows `failed_before_send`, the handle is not listed, and after a reload the add is not under Unfinished steps. Then in the same run, **Add test Twitter identity** must start a NEW action: status `prepared`/`awaiting_wallet` and a different portal link. That action completes (`association_observed`, handle listed), with no identity error and no restart notice. Purchases are not blocked. **Sign in** stays disabled while signed in. |

The wrong-implementation witness is the frozen input candidate itself. Its pre-sign refusal stays `readback_pending` and blocks the wallet, so CA-R1a and the dashboard trigger fail at the closed-status or next-step-text assertion. CA-R1b passes on it.

### Finished purchases (closure F1): `closure-acceptance-dashboard-purchases.test.mjs`

Expected results come from behaviour-contract clauses C5 and C7, and from `OVERNIGHT-UI.md` (C5 step 3 and C7) and `TESTER-DASHBOARD.md` (Start over, `earlier`). They do not come from the dashboard code. The buyer "wallet" is a synthetic extension-wallet stand-in (labelled).

| ID | Clause | What is checked |
| --- | --- | --- |
| CA-F1 | C5, C7 | Accepting controls first. A pending Prepare repeated returns the same operation. A settled purchase shows its receipt after **Refresh receipt**: payer is the buyer, the transaction is named, and independent chain readback confirms it. Then:<br>• **Prepare** after the settled purchase gives a new operation id with no receipt. The settled purchase stays in the dashboard state's `completedPurchases` with the same receipt, listed once. A pending purchase is not listed there.<br>• **Cancel** stays `cancelled` with no receipt, also after **Refresh receipt**. The next **Prepare** keeps it as `cancelled` with no receipt. Kept entries carry no idempotency key and no `#t=`.<br>• Evidence: `buyer.purchase` is the newest purchase. `buyer.completedPurchases` has the settled one with `receipt.observed: true` and its transaction hash, and the cancelled one never with an observed receipt. The file contains no `#t=`, OAuth token, `Bearer`, `idempotencyKey`, `/portal/` or any of the three idempotency keys.<br>• **Start over as a new buyer** signs out. The earlier session under `earlier.buyer` keeps both finished purchases in state and in the evidence, with the same secret checks. |

The F1 page rendering (`#purchase-history`) is not checked here; this test checks state and evidence.

### Widget (`overnight-acceptance-widget-click.browser.test.mjs`)

**OA-W1** is one bounded run of 20 ordinary mouse clicks on "Open wallet approval": 12 in one frame and 8 in freshly mounted frames. Each click has the existing 5 s limit and the same passive counters. Clicks are never retried and the limit is never extended. A pass does not resolve the open observation in `TESTING.md`, and its cause stays unknown.
