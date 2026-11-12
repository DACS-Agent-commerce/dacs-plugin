# Embedded wallet flows: functional acceptance and human-test plan

Status: EXPERIMENTAL, default-off, NOT security reviewed. The external security review is on hold.
Passing the
tests below is not security approval, live Demos testnet acceptance, ChatGPT host
acceptance or v0.1 acceptance. Everything here runs against SIMULATED loopback
fixtures with fresh throwaway keys and no real funds.

Covered flows, and only these:

1. Built-in fixed-price DEM purchase: the embedded wallet signs the server-prepared
   transfer in the browser after an exact-terms approval; the server accepts it only
   from independent readback of payer, payee, amount and the pre-saved nonce.
2. GitHub and Twitter (X) identity add and remove. Other Demos identity kinds
   (Discord, Telegram, cross-chain, domain, TLSN, ...) are not offered or tested.

## Evidence tiers

| Tier | What it is | What it proves |
| --- | --- | --- |
| W, wire-shape fixture | Loopback SIMULATED chain answering the Demos SDK 4.0.16 RPC envelope | Request/response shapes |
| S, real SDK signing | The official SDK signs. The fixture only verifies (sha256 of the serialized content, ed25519 verify) | The SDK key signed exactly the approved terms |
| B, real browser | Chromium under the unchanged portal CSP, console errors not filtered | Portal and embedded wallet complete the flow |
| T, real testnet | Not covered by any automated test | Human/live step only |

A mocked wallet's success is never counted as tier S or B.

## Automated tests

| File | Runner command from the `http-mcp/` directory |
| --- | --- |
| `test/embedded-wallet-flow.test.mjs` | `DACS_EMBEDDED_WALLET_REQUIRE=1 node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/embedded-wallet-flow.test.mjs` |
| `test/browser/embedded-wallet-flow.browser.test.mjs` | `DACS_EMBEDDED_WALLET_REQUIRE=1 DACS_TEST_CHROME=/path/to/chromium node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/browser/embedded-wallet-flow.browser.test.mjs` |
| `test/helpers/embedded-wallet-flow-fixtures.mjs` | shared fixture chain, SDK loader, loopback guard |

The repository's normal globs also discover them: `npm test` (`./test/*.test.mjs`) and
`npm run test:browser` (`./test/browser/*.test.mjs`). With
`DACS_EMBEDDED_WALLET_REQUIRE=1`, missing prerequisites (SDK install, built runtime,
browser) FAIL; they are not skipped.

Clause IDs (see test names):

- F1-F3: fixture and SDK controls. These prove the harness: SDK signing over loopback,
  server readback and identity readback. They do not prove the embedded wallet.
- F4: an executed witness. The SDK's default broadcast path resends after a lost 503
  answer, so P6's no-resend assertion catches that implementation.
- P1-P6: embedded `sendTransaction`. Covers approval with the exact terms, one
  broadcast and the response hash, plus cancel, lock, not configured, definite failure,
  and outcome unknown with no automatic resend.
- I1-I3: embedded identity add (GitHub, Twitter), remove, and cancel.
- B1-B2: real-browser portal purchase, and GitHub add then remove.

- P0: default off. Without the flag, the profile reports `off` and the wallet relay
  answers 404.

Recorded result: an independent run of the combined source passed 28/28
affected Node checks (this flow suite plus the offline operator suite) and
4/4 real-Chromium checks (B1/B2 plus two operator-page checks), with no failures,
skips, TODOs or cancellations. That run was made in the source repository; its
logs are not carried here, so it is a record, not something this repository
shows. These are source-aware functional results, not security/live/host
approval and not proof of a clean installed operator's full workflow.

## Core interface used

The tests depend on the new core surface only through `CORE_INTERFACE`, `fetchProfile`
and `transportFromProfile` in the helper. The originally preliminary interface was
exercised on the combined source above:

- Enabling: `DACS_EMBEDDED_WALLET_WRITES=simulated-loopback` (default `off`; it needs a
  loopback `DACS_CHAIN_RPC_URL`). Identity actions also need
  `DACS_IDENTITY_WRITES=simulated-fixture-only`. GitHub add needs
  `DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN`, set to a loopback SIMULATED GitHub API fixture.
- Same-origin routes: `POST /portal/api/embedded-wallet/profile`,
  `GET|POST /portal/api/wallet-rpc` (the relay to the configured fixture chain; it never
  answers 502/503/504) and `POST /portal/api/wallet-rpc/github-user`.
- Session transport: a plain object
  `{profile:'simulated-loopback', rpcUrl, network, resolveGithubUser}`. The tests build it
  from the server profile, so the Node tests also go through the real relay.
- SDK wire: nodeCall `getNetworkInfo`, `getNetworkParameters`, `getAddressNonce` and
  `getTweet`, then `execute` with `confirmTx` and `broadcastTx`. Every fixture response
  carries `x-dacs-simulation: fixture`.
- Error codes: `user_rejected`, `locked`, `not_configured`, `confirm_rejected`,
  `broadcast_rejected`, `outcome_unknown` (which carries the hash; never retried).

Expected outcomes stay independent of core: exactly one broadcast, readback-only
settlement, no resend after an unknown outcome, no external host, and no console
errors. P0 checks that the default stays off.

## Human test plan (isolated, simulated, no real funds)

Prerequisites: a private machine, the packaged plugin, Node `^22.22.2 || ^24.15.0` and a Chromium-based
browser. Do not use a wallet that holds real funds. Do not reuse any phrase from this
test elsewhere.

### 1. Safe isolated fixture startup

- Run the shipped installed `bin/dacs-chatgpt-offline-test.mjs` operator as
  described in OFFLINE-TESTER.md. It creates fresh loopback-only services and
  sets the simulated profile itself. The developer test harness is not shipped
  and is not the human startup command.
- Check that every portal page shows the yellow SIMULATED banner and that the evidence
  reads "SIMULATED fixture (not live Demos testnet)". If it does not, stop: you are
  pointed at a real node.
- Never set `DACS_CHAIN_RPC_URL` to a live Demos node for this test.

### 2. Key creation, backup and restore

- In the portal, choose "Use the experimental embedded wallet", then create a wallet
  with a strong new password.
- Write the recovery phrase on paper. Do not screenshot it, paste it into chat or send
  it anywhere.
- Lock the wallet, then unlock it with the password. The address must be unchanged.
- Export the encrypted backup, clear the site data (or use a new profile), restore the
  backup and unlock. Same address.
- Import the paper phrase in a fresh profile. Same address. A mistyped phrase must be
  refused, not turned into a different wallet.

### 3. Purchase: amount, approval, receipt

- Link the embedded wallet to your test account (the wallet-link page asks for one
  signature; it moves no funds).
- Ask for a fixed-price purchase of a SIMULATED listing. Open the approval link.
- On the purchase page, check the listing, seller payee, amount (DEM and OS), network
  and your wallet. Click "Approve exact terms", then approve the sign request in the
  wallet dialog.
- The wallet then shows a second dialog for the transaction. Before you approve, its
  exact content must show the same payee (`to`), the same amount and your wallet
  (`from`). If anything differs, reject.
- Reject once first. Nothing may be sent, and the purchase must stay unpaid.
- Then approve. The page must show "Simulated purchase receipt" with the transaction
  hash, block, amount, payee and your wallet. `get_purchase_status` must say
  `settled_verified` with simulated evidence.
- If the page reports an unknown outcome, do NOT retry. Retry is blocked by design.
  Use `verify_deal` with the hash from the wallet's history.

### 4. Identity actions: limits

- Only GitHub and Twitter/X link and unlink are offered.
- For "add", the wallet produces proof text. Do NOT publish it on GitHub or X.
  Paste it into the operator's printed LOCAL proof publisher with the selected
  kind and handle, then use the fixture URL it returns. The shipped operator
  requires this local publication; an arbitrary invented URL is not enough.
- Approve the wallet dialog only if it shows the exact handle, the proof URL and your
  wallet address. The page should then report "Association observed on chain"
  (SIMULATED).
- Remove the same handle. The dialog must show the context and the handle. The page
  should then report "Association no longer observed". Removal does not delete any
  post, gist or history.
- Observed state is current fixture state. It does not prove which transaction caused
  it, and it is not KYC or proof of personhood.

### 5. Cleanup

- Lock the wallet, then clear the site data for the test origin.
- Stop the plugin and fixture processes. Delete the temporary data directory.
- Destroy the paper phrase. The test keys hold nothing and must never receive real
  funds.

## Not covered (explicit)

Real Demos testnet broadcast or finality, installed-extension parity, ChatGPT framing,
faucets, real GitHub/X proof publication and verification, other identity kinds,
security properties, and adversarial or negative-protocol behaviour.
