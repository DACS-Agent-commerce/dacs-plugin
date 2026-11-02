# Embedded wallet: tester instructions (EXPERIMENTAL, default-off)

The embedded wallet is an experimental, local-only extension of plugin 0.1.0.
It is **not** accepted for v0.1 and is not security reviewed. The external
security review is on hold. None of these tests prove ChatGPT
embedding, an installed Demos wallet extension, live testnet behaviour,
funded execution or OpenAI directory eligibility. These are source-aware
functional tests, not source-blind validation and not a security review.

## What each check proves

Every test name carries its evidence label. Keep them separate when reporting.

| Label | Meaning |
| --- | --- |
| `browser-real` | Real headless Chrome from `DACS_TEST_CHROME`, loading `/portal/assets/embedded-wallet/index.html` from the real plugin server on 127.0.0.1. |
| `sdk-real` | The shared `sdk-provider.mjs` seam driven by the Demos classes exported from `demos-runtime.mjs`. No SDK test doubles are used. |
| `real verifier` | Signatures are checked by `src/wallet/demos-signature.mjs` and consumed by the real challenge service (`src/wallet/challenges.mjs`, in-memory DB). |
| `loopback-simulated` | Fixture services or recorders on 127.0.0.1 only. |
| `source-aware adapter` | Test-owned memory vault store, public-state recorder, provider capture or approval callback injected through the documented seams. |

## Files

- `test/embedded-wallet-contract.test.mjs`: Node contract tests for the SDK seam (part of `npm test`).
- `test/browser/embedded-wallet.browser.test.mjs`: real-browser lifecycle tests (part of `npm run test:browser`).
- `test/helpers/embedded-wallet-fixtures.mjs`: presence gating, signature extraction (mirrors `portal.js`), the login challenge issuer, secret scans, bounded LIFO cleanups, the `DACS_TEST_CHROME` launcher, recorders and **all UI selectors** (`UI`).

## Run

From `http-mcp/`, on Node 22 with dependencies installed (`npm ci`):

```sh
# Node contract tests (whole ordinary suite):
npm test
# Only the embedded-wallet contract file:
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 ./test/embedded-wallet-contract.test.mjs
# Real browser lifecycle (needs the Chrome/Chromium executable path):
DACS_TEST_CHROME=/snap/bin/chromium node --disable-warning=ExperimentalWarning --test --test-concurrency=1 ./test/browser/embedded-wallet.browser.test.mjs
```

In the combined candidate run, set `DACS_EMBEDDED_WALLET_REQUIRE=1` so a
missing module fails instead of being recorded as BLOCKED.

The browser test never launches a default or bundled browser: without
`DACS_TEST_CHROME` (or if the path does not exist) its tests are **skipped**
with that reason. It launches Chrome only when all embedded-wallet modules are
present, and closes contexts, the browser and the harness in bounded LIFO
cleanup steps that fail the run if any step fails or times out.

## Reading the results

- `ok`: the check ran against the combined candidate and passed.
- `not ok` without `# TODO`: a real failure.
- `# TODO BLOCKED: ...`: the new modules (`public/portal/embedded-wallet/sdk-provider.mjs`,
  `demos-runtime.mjs`, `ui.mjs`, `index.html`) are absent from this checkout,
  or a seam is not yet specified. Counted under `todo`, **never** a pass.
  Report it as BLOCKED.
- `# SKIP`: browser not configured. Report it as skipped, not passed.

`demos-runtime.mjs` is the stable entry of a local module graph. Its chunks
under `runtime-chunks/` load as ordinary same-origin GETs, which the browser
suites' loopback-only request checks accept unchanged. They are listed in
`runtime-manifest.json` and checked by `test/embedded-wallet-runtime.test.mjs`
and the packaging checkers (EMBEDDED-WALLET-PACKAGING.md). A missing chunk is
a failure, never a skip.

The `loopback transactionTransport lifecycle` now exercises the real bundled
SDK through the same-origin relay and a fresh simulated chain: one approved
native send, then lock/refusal with no second broadcast. The public transport
shape and flags are documented in EMBEDDED-WALLET-SDK.md. A
159-file source build passed 209 Node tests with no skips,
TODOs or failures. This is ordinary fixture evidence, not live/security proof.
Use OFFLINE-TESTER.md for installed-package human flows; the source-only
lifecycle harness is not shipped.

## Covered behaviour

Contract (Node):
1. Exports: `createSdkWalletSession`, `Demos` (and whether `Identities` exists); a fresh session is locked.
2. `create()` / `importMnemonic()` return only `{address, publicKey, network: "unconfigured", evidenceMode: "local-key-only"}`; address is `0x` + publicKey; import of the exported phrase reproduces the account; 24 words by default, 12 for strength 128; fresh material each time.
3. `connect` returns only the address; an approved `sign` with `params: [message]` over the exact wallet-login challenge is accepted by the real verifier and challenge service; one approval request carrying the exact message.
4. No approve callback, or a declining one: no signature.
5. `lock()` removes signing and backup export.
6. `sendTransaction`, `addGithubIdentity`, `addTwitterIdentity`, `removeWeb2Identity` return explicit errors when no transport is injected.

Browser:
1. Packaged asset: 200 under the portal CSP, experimental/local wording, no address before create, an existing `window.demos` kept as-is, GET-only loopback requests, no console errors.
2. SDK in the page: create/import equivalence and a server-accepted login signature. The phrase never leaves the page; only booleans and public values return.
3. UI lifecycle: create, local backup view, password, lock/unlock, encrypted export, re-import into a fresh page/store gives the same address. Public callbacks use only contract keys. Phrase and password (plus base64/hex/URL encodings) are absent from public callbacks, vault writes, recorded requests, console, URLs, server logs and the backup itself.
4. Approval UI: a provider `sign` stays pending until a deliberate click on a dialog showing the exact message; decline gives no signature; transaction/identity writes stay default-off and send nothing.

## If a UI check fails on accessible names

The labels live in the UI module. Adjust only `UI` in
`test/helpers/embedded-wallet-fixtures.mjs` (button names, mnemonic display
pattern) and record the change. Do not weaken assertions.

## Never

Use real wallets, real seeds or funded accounts; point anything at live RPC,
testnet, faucets or ChatGPT; print a phrase or password (the secret scans
report only a label and an index); or call these results a security review.
