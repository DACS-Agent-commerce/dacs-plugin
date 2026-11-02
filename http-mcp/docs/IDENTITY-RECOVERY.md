# Identity add/remove: recovering from a failed or abandoned action

Applies to `start_identity_action` and the portal page `/portal/identity/:id`.
Identity writes stay **held** unless the server runs with
`DACS_IDENTITY_WRITES=simulated-fixture-only` against a simulated fixture chain.
Nothing here changes that gate. This is offline functional behaviour, not live
Demos testnet evidence and not a security review.

## The rule

At most one identity action per wallet can be in flight. A new action for that
wallet is refused with `identity_operation_in_progress` while another one is
in flight. Whether an action is in flight depends on what is known about the
wallet:

| Status | Wallet asked? | In flight? | How it ends |
| --- | --- | --- | --- |
| `prepared`, `awaiting_wallet`, `awaiting_public_proof`, `review` | no | yes | the user continues, **cancels**, or it **expires** after 30 minutes |
| `wallet_requested`, `readback_pending`, `outcome_unknown` | yes, outcome unknown | yes | only chain readback (`get_identities`, "Check chain again") |
| `association_observed`, `removal_observed` | yes | no | final (current chain state) |
| `rejected_before_send` | yes, the user declined | no | final |
| `failed_before_send` | yes, the embedded wallet stopped before broadcasting | no | final |
| `cancelled`, `expired` | no | no | final |

Nothing is ever retried automatically. A second wallet request for the same
action is always refused (`invalid_state`).

## What the user can do

* **The proof URL names a handle GitHub cannot have** (for example it contains
  `_`). The proof step refuses it with `invalid_proof_url`, before the wallet is
  asked. The action stays at the proof step, so the user can paste the URL of
  a gist published under their real GitHub username.
* **The user wants to stop before approving.** "Cancel this identity action"
  is shown on every page before the wallet is asked. The server also accepts
  `POST /portal/api/identity/:id/cancel` with the link token. Repeating it is
  harmless. Once the wallet has been asked, cancel is refused with
  `invalid_state`. From ChatGPT, the `identity_operation_in_progress` error
  says whether the blocking action can still be cancelled (`details.cancellable`)
  and when it expires (`details.expiresAt`).
* **The experimental embedded wallet stopped before broadcasting.** Typical
  causes: the post or gist was not published, the GitHub user does not exist,
  the proof belongs to someone else, the wallet was locked, or the node refused
  to validate the transaction. The portal reports the wallet's own answer
  together with `wallet: "embedded"`. The server closes the action as
  `failed_before_send` and shows the wallet's message. The user fixes the
  input and starts a **new** identity action for the same wallet. No server
  restart is needed.

  The codes treated this way are the ones the pinned embedded wallet
  (`public/portal/embedded-wallet/sdk-provider.mjs` and its `ui.mjs` provider
  wrapper) raises for identity methods before its single broadcast: `locked`,
  `busy`, `invalid_params`, `invalid_request`, `not_configured`, `unsupported`,
  `held_for_review`, `upstream_unavailable`, `identity_mismatch`,
  `confirm_rejected` and `payload_mismatch`.

## What stays uncertain, on purpose

These answers mean the request may have been executed. They stay `unknown`
(`readback_pending`, later `outcome_unknown`), keep that wallet's identity
actions blocked until readback shows the change, and are never called
rejected:

* the embedded wallet's `outcome_unknown` (the broadcast may have reached the
  node) and `broadcast_rejected` (it was sent and the node refused it);
* catch-all errors (`internal_error`, `wallet_error`) and any other or missing
  code, thrown provider errors, timeouts, closed windows and unrecognized
  responses;
* **every answer from a wallet extension** other than `USER_REJECTED`. The
  extension's codes do not establish whether anything was sent.

If such a write did land, the next readback reports
`association_observed`/`removal_observed`. Other wallets, purchases and
publications are never affected.

## Limits

* The server relies on the portal's report of which wallet answered and what
  it said, as it already did for `user_rejected`. This is not chain evidence.
* Actions stranded before this change were reported without the `wallet` field
  and remain `outcome_unknown`. They are not reclassified.
* The guided tester dashboard treats `failed_before_send` and `cancelled` as
  finished: they are not listed under Unfinished steps, and "Add test …
  identity" (or Remove for the same handle) starts a new action with a new
  key. If the dashboard had not been refreshed and the remembered action
  turns out closed, the same press starts the new action. The same
  idempotency key always replays the same operation, by design.

## Tests

* `test/closure-identity-recovery.test.mjs`: server and portal API state
  machine, including the clock window and restart.
* `test/closure-identity-sdk.test.mjs`: the real pinned embedded wallet
  (demosdk 4.0.16) against a recording simulated node. It shows which answers
  happen with no broadcast.
* `test/closure-identity-witness.test.mjs`: six plausible wrong repairs, each
  caught by the same contract check that the shipped module passes.
* `test/browser/closure-identity-recovery.browser.test.mjs`: real Chromium,
  offline launcher and built-in wallet. Covers add/remove controls, reload and
  fresh tab, the proof-step refusal, `failed_before_send`, and keyboard
  cancel.
* `test/closure-dashboard-recovery.test.mjs` and
  `test/closure-dashboard-witness.test.mjs`: the tester dashboard's handling
  of closed actions (new action on Add, also from a stale copy; a corrected
  action completes in the same run) and of finished purchases (kept with
  their receipts on the dashboard and in evidence).
