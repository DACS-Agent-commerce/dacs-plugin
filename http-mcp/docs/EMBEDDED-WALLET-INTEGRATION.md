# Embedded wallet: portal integration (EXPERIMENTAL, opt-in)

Status: experimental, default-off, not security reviewed. The external security review is on hold.
Not v0.1 acceptance.

## What changed

| File | Change |
| --- | --- |
| `public/portal/embedded-wallet/main.mjs` | Standalone `sessionFactory` passes the SDK's exported `validateMnemonic` (from `demos-runtime.mjs`). Without it, `importMnemonic` and so unlock failed closed. |
| `public/portal/embedded-wallet-bridge.mjs` (new) | `sessionFactory({approve})` (same wiring as above) and `openEmbeddedWallet(root, {onPublicState, onProviderReady})`. It loads `embedded-wallet/ui.mjs` lazily and returns the UI handle `{ready, lock, getPublicState, destroy}`. Store: the origin's IndexedDB, falling back to tab memory. |
| `public/portal/index.html` | Help text is precise: with the extension, the page never asks for a phrase or key. The optional embedded wallet keeps its phrase and password in the page only. Adds the "Use the experimental embedded wallet" button and a hidden panel. There are no input fields until the person opts in. |
| `public/portal/portal.js` | `walletSource` is `extension` (default) or `embedded`. The bridge and its CSS load only after the click. Discovery that finishes after the choice is ignored. `onPublicState` with `locked` clears the provider and address and disables Connect. `onProviderReady` sets the local provider; the person still clicks Connect. Writes refuse by default. The explicitly enabled simulated-loopback profile allows native payments and GitHub/Twitter identity changes; listing publication still requires the extension path. |

The connect/sign request shape is the existing one: `request({method:'connect'})` → `data` = address string;
`request({method:'sign', params:[message]})` → `data.signature` (128 hex), which
`walletSign` already reads. Sign-in and wallet linking use the existing server
challenge and verification. Signing waits for the UI approval dialog, which
needs a trusted click. Existing auth, store and MCP workflows, CSP and COOP are
retained. The server adds the explicitly gated profile and fixture relay described below.
`window.demos` is never assigned.

## Payments and identity changes: simulated loopback profile only

By default (`DACS_EMBEDDED_WALLET_WRITES` unset/`off`) the portal answers
`/portal/api/embedded-wallet/profile` with `{writes:"off"}` and the embedded
wallet keeps refusing payments, publication and identity changes before any
request. With `DACS_EMBEDDED_WALLET_WRITES=simulated-loopback` (accepted only
with a loopback `DACS_CHAIN_RPC_URL`; identity changes also need
`DACS_IDENTITY_WRITES=simulated-fixture-only`, GitHub add a loopback
`DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN`), `portal.js` passes the profile to
`openEmbeddedWallet(..., {transactionTransport})` and the unlocked wallet can:

- approve exact purchase terms (sign), then send the server's exact fenced
  native-send payload (approve -> SDK sign -> confirm -> one broadcast);
- add a GitHub/Twitter identity from the user's public proof URL, or remove one.

The existing purchase/identity routes, durable operations, nonce fence and
server readback are unchanged; settlement and identity state come only from
server readback. An `outcome_unknown` payment is reported to the server as a
wallet error with its hash shown to the person, never retried. Publication
stays unavailable in the embedded wallet. Details: EMBEDDED-WALLET-SDK.md
"Write path". Not production/live-enabled; offline fixture evidence only.

## Not available

- Listing publication, and every write outside the simulated loopback profile.
- Durable storage across ChatGPT sessions or devices. The encrypted backup export
  is the portable recovery path.

## SDK WASM vs portal CSP: resolved by the split runtime build

`demos-runtime.mjs` is now the stable entry of a local esbuild module graph:
the entry plus `runtime-chunks/` and `runtime-manifest.json`, see
EMBEDDED-WALLET-SDK.md and EMBEDDED-WALLET-PACKAGING.md. Its public path and
exports are unchanged, so `main.mjs`, the bridge and `portal.js` are unchanged.
The split build ships no node-seal/FHE code. With the CSP unchanged, all three
real-Chromium 153 suites pass, including `consoleErrors == []`:
`embedded-wallet` 5/5, `embedded-wallet-portal` 3/3 and the legacy `portal`
13/13. The chunks are ordinary same-origin GETs from
`/portal/assets/embedded-wallet/runtime-chunks/`.

The residual is that the build relies on the SDK's own `sideEffects`
declaration (see EMBEDDED-WALLET-SDK.md). The SDK-owner change below remains
the robust fix.

History. With the earlier single-file build in real Chromium 153, the ed25519
wallet path worked under the unchanged CSP: create, import, unlock, sign,
server verification and OAuth sign-in all passed their functional assertions.
However, the SDK's import-time node-seal (FHE) initialisation was refused, and
the page logged three console errors:

```
failed to asynchronously prepare wasm: CompileError: WebAssembly.instantiate(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: "script-src 'self'".
Aborted(CompileError: ...)
Aborted(CompileError: ...). Build with -sASSERTIONS for more info.
```

The browser tests keep `consoleErrors == []` as their final assertion, so they
failed on this. The CSP was not relaxed, and the errors were not filtered.

Root cause (re-confirmed on 2026-10-03 with the unchanged suites): `Demos`
statically imports `websdk/DemosTransactions.js`. That module imports the
`encryption/index.js` barrel, whose `FHE` member starts node-seal at module
top level. In the single-file build, esbuild's lazy wrapping for the tlsnotary
`import()` evaluated that member eagerly. EMBEDDED-WALLET-SDK.md, "Import-time
WebAssembly", has the graph, the entries tried and the acceptance condition.
Remaining options for the owners (none are applied here):

1. Preferred hardening: the minimal SDK-owner change in EMBEDDED-WALLET-SDK.md.
   Either lazy node-seal start in `encryption/FHE/index.js`, or leaf imports
   instead of the encryption barrel. Then pin that exact SDK release.
2. A reviewed CSP decision for `'wasm-unsafe-eval'` on the wallet asset routes
   only. This is no longer needed for the current graph.

## Tests

- `test/embedded-wallet-contract.test.mjs`: Node, real bundle with minimal
  browser globals (the same fixture as the SDK test). This is not browser proof.
- `test/embedded-wallet-bundle.test.mjs`: Node, the runtime's exact exports, an
  import-time WebAssembly regression (passes with no `todo`; Node's own undici
  WASM is attributed before the measured import) and the eager load set. This
  is not browser or CSP proof.
- `test/embedded-wallet-runtime.test.mjs`: Node, graph-manifest rules with
  fixtures, and the real shipped graph closure.
- `test/browser/embedded-wallet.browser.test.mjs`: standalone asset, real SDK in
  the page, UI lifecycle, approval dialog, and `main.mjs` unlock.
- `test/browser/embedded-wallet-portal.browser.test.mjs`: the default extension
  path is unchanged and loads no embedded modules. Opt-in create, connect, lock
  (clears the connection), unlock and server-verified OAuth sign-in. A
  deliberate choice survives later discovery. SDK import works. Payments are
  refused without any challenge or report request.

These are source-aware functional tests. They are not a security review,
source-blind validation, ChatGPT framing or live proof.

An independent run covered the ordinary Node flow
checks and real-Chromium purchase/GitHub-add/remove checks. See
EMBEDDED-WALLET-FLOW-COVERAGE.md for the artifact-bound evidence and
OFFLINE-TESTER.md for the separately installed fixture operator. Neither result
enables live writes.
