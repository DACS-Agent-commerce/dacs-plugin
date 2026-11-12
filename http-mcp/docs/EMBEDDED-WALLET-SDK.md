# Embedded wallet: SDK seam (experimental, default-off)

Status: experimental, local key only, default-off. The external security review is on hold.
Real-Chromium suites have run against
the split runtime, but ChatGPT host, installed-wallet and live checks have not.
Nothing here is security approval, v0.1 acceptance or a version bump.

## Files

| File | Role |
| --- | --- |
| `public/portal/embedded-wallet/sdk-provider.mjs` | `createSdkWalletSession` adapter over the Demos SDK |
| `public/portal/embedded-wallet/demos-runtime.mjs` | GENERATED stable entry of the browser build of upstream `@kynesyslabs/demosdk` 4.0.16; re-exports the built entry chunk and carries the third-party notices |
| `public/portal/embedded-wallet/runtime-chunks/*.mjs` | GENERATED content-named esbuild chunks of the same build (eager and lazily imported) |
| `public/portal/embedded-wallet/runtime-manifest.json` | GENERATED public list of every graph file: bytes, SHA-256, local static/dynamic imports, SDK/esbuild identity |
| `wallet-build/package.json` | isolated build package, exactly `{"@kynesyslabs/demosdk":"4.0.16","esbuild":"0.25.12"}`, no scripts |
| `wallet-build/entry.mjs`, `shims.mjs`, `build.mjs` | build inputs and the reproducible build |
| `scripts/embedded-wallet-runtime.mjs` | shared graph-manifest helper: serializer, specifier scanner, closure check |
| `test/embedded-wallet-sdk.test.mjs` | functional tests against the installed SDK and the built runtime |
| `test/embedded-wallet-bundle.test.mjs` | built runtime export contract, import-time WebAssembly regression, eager/lazy load set |
| `test/embedded-wallet-runtime.test.mjs` | graph-manifest helper fixtures and the real shipped graph closure |

The plugin's own `package.json`/lockfile are unchanged; `wallet-build/` is a
separate package and is not part of the runtime package.

## Runtime label

`demos-runtime.mjs` is the unmodified public npm `@kynesyslabs/demosdk@4.0.16`
bundled by esbuild 0.25.12 for `platform: browser`, ESM, es2022, minified,
with code splitting (`splitting: true`). It
is NOT the V2 `kynesyslabs-demosdk-v2-runtime-4.0.16.tgz` server-only profile.
Exports: `Demos`, `Identities`, `validateMnemonic` (the SDK's own
`@scure/bip39` check with the SDK word list, exactly as `connectWallet` uses
it), `DEMOS_SDK_PACKAGE`, `DEMOS_SDK_VERSION`, `RUNTIME_LABEL`. The public path
and exports are the same as the earlier single-file build; consumers
(`main.mjs`, `embedded-wallet-bridge.mjs`, tests) import `./demos-runtime.mjs`
unchanged.

The runtime is a local module graph: the entry plus 7 chunks in
`runtime-chunks/` (1,062,439 bytes in total, against about 3.1 MB for the
earlier single file). Four chunks load when the entry is imported. Three load
only through the SDK's own `import()` calls: the tlsnotary module behind
`Demos.tlsnotary()`, and two small chunks it pulls in. Every import is a
relative path inside the graph: no bare package names, URLs or CDN. The
build refuses externals, and `runtime-manifest.json` lists every file. Unresolvable
Node builtins pulled in by unrelated SDK features (ZK `snarkjs`/`ffjavascript`,
`fastfile`, `node-seal`, `falcon-sign`, `ejs`; the SDK itself maps
`crypto`/`fs`/`path`/... to `false` in its `browser` field) are replaced by
empty modules: `constants crypto fs os path readline url`. Those features fail
if invoked; the ed25519 wallet path does not use them (proved by tests).

Licensing: the SDK declares `"license": "MIT"`, author Kynesys Labs, but ships
no LICENSE file. The entry header states this, and the build appends the
license files (or declared license) of all 34 packages esbuild read as
`THIRD-PARTY NOTICES` at the end of `demos-runtime.mjs`. Each chunk starts
with a one-line comment pointing there. `runtime-manifest.json` separates
`shippedPackages` (13 packages with code in a shipped file) from
`noticePackages` (all 34, a superset kept for complete attribution).

## Import-time WebAssembly (resolved by the split build)

The earlier single-file build compiled node-seal's inlined WASM on import.
Under the portal CSP `script-src 'self'` (no `'wasm-unsafe-eval'`), Chromium
refused it and logged three console errors, so the browser suites failed. The
split build ships no node-seal or FHE code at all: the build summary's
`wasmModulesInEagerFiles` and `wasmModulesInLazyFiles` are both `[]`. Importing
the runtime compiles no WebAssembly (Node regression test). All three browser
suites pass with `consoleErrors == []` under the unchanged CSP. Nothing is
stubbed, caught or filtered, and the SDK source is unmodified.

Cause in the single-file build, for the record (unmodified 4.0.16):

```
websdk/demosclass.js            (Demos)
  -> websdk/DemosTransactions.js        import { Cryptography } from "../encryption/index.js"
     -> encryption/index.js             export * as FHE from "./FHE/index.js"
        -> encryption/FHE/index.js      (async () => { seal = await SEAL(); })();   top level
           -> node-seal/throws_wasm_web_umd.js   WebAssembly.instantiate(...)
abstraction/Identities.js -> encryption/index.js   (same barrel, second path)
```

The package declares every file except `build/tlsnotary/worker.js` free of side
effects. That would let a bundler drop the unused `FHE` re-export. However,
`demosclass.js` also does `await import("../tlsnotary/index.js")`, and
`tlsnotary/TLSNotaryService.js` imports `DemosTransactions.js`. In a
single-file bundle, esbuild turns that dynamic import into a lazily initialised
module and propagates the wrapping to its dependencies. `DemosTransactions` and
the encryption barrel then run as init functions, which evaluate every barrel
member, including FHE. Native browser ESM would evaluate `FHE/index.js` in any
case, because ESM evaluates every imported module.

Narrow entries tried with esbuild 0.25.12 (graph from the build metafile):

| Entry | node-seal retained |
| --- | --- |
| `Demos` from `@kynesyslabs/demosdk/websdk` + `Identities` by file (shipped) | yes |
| `Demos` from `build/websdk/demosclass.js` + `Identities` | yes |
| `Demos` from `build/websdk/demosclass.js` only, no `Identities` (diagnostic) | yes, via `DemosTransactions.js` |
| shipped entry with `splitting: true` (now the shipped build) | no; tlsnotary moves to a lazy chunk |

With splitting, the tlsnotary `import()` becomes a real lazy chunk instead of
a lazily initialised wrapper. `DemosTransactions` and the encryption barrel
are then ordinary modules. Because the package declares them side-effect-free,
esbuild drops the barrel's unused `FHE` member, and with it node-seal.

Residual dependency: this relies on the SDK's `sideEffects` declaration. That
declaration is inaccurate for `FHE/index.js`, whose only side effect is the
node-seal start used by the `FHE` class. The wallet never uses `FHE`, and no
FHE code is shipped, so nothing can reach the dropped start. A future SDK pin
or build change that ships FHE code again is caught by the build summary, the
Node zero-WebAssembly regression and the browser console checks. The SDK-owner
change below is still the robust fix.

Minimal SDK-owner change (any one is sufficient; the first is preferred):

1. `encryption/FHE/index.js`: start node-seal lazily, on first FHE use. For
   example, a `static async create()` that awaits `SEAL()`, instead of the
   module-level IIFE. Today's constructor already fails if it is called before
   that IIFE resolves.
2. `websdk/DemosTransactions.js` and `abstraction/Identities.js` (and other
   barrel importers such as `keyserver/verification.js`,
   `bridge/nativeBridge.js` and `multichain/core/aptos.js`): import from
   `../encryption/Cryptography.js` and `../encryption/unifiedCrypto.js` instead of
   `../encryption/index.js`.

Acceptance condition (met by the split build, and to be kept for any SDK change):
- `node build.mjs` reports `wasmModulesInEagerFiles: []`.
- `test/embedded-wallet-bundle.test.mjs` "compiles no WebAssembly" passes
  without a `todo`.
- The browser suites pass with `consoleErrors == []` under the unchanged CSP.

## Build

```
cd wallet-build
npm ci --ignore-scripts
node build.mjs
```

`build.mjs` refuses to run unless the manifest pins and installed versions are
exact. It writes only into `public/portal/embedded-wallet/`:
`demos-runtime.mjs`, `runtime-chunks/*.mjs` and `runtime-manifest.json`. esbuild
uses `entryNames: runtime-chunks/[name]-[hash]` and `chunkNames:
runtime-chunks/chunk-[hash]`. The stable `demos-runtime.mjs` is
`export * from "./runtime-chunks/entry-<hash>.mjs"` plus the banner and notices.
Content hashes make the names deterministic: two rebuilds produced identical
files.

Before writing, the build:
- keeps only esbuild outputs reachable from the entry. esbuild still emits a
  file for a dynamic-import target whose importer was tree-shaken
  (`@cryptkeeperzk/snarkjs/main.js`). Nothing references it, so it is not
  shipped, and it is listed as `unreferencedOutputsNotShipped`;
- refuses any external, bare or out-of-graph import in esbuild's metafile;
- runs the same closure check the packaging checkers use. A failure stops the
  build before anything is written.

Stale chunks are deleted only if the previous `runtime-manifest.json` lists
them. Any other file in `runtime-chunks/` stops the build untouched.

The summary prints:
- the entry and manifest SHA-256;
- the eager and lazy file sets;
- removed stale files;
- `shippedPackages`, the notice package count and hash, and the stubbed builtins;
- `wasmModulesInEagerFiles` / `wasmModulesInLazyFiles` (node-seal or SDK FHE
  inputs with bytes in a shipped file).

## Session API (`sdk-provider.mjs`)

```js
import { Demos, Identities, validateMnemonic } from './demos-runtime.mjs';
import { createSdkWalletSession } from './sdk-provider.mjs';
const session = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, approve });
```

`validateMnemonic` is an additive option beyond the shared contract. Pass it:
`connectWallet` silently treats a string that fails the SDK check as a BIP-39
passphrase and derives a different identity, so `importMnemonic` fails closed
with `not_configured` if no validator was injected.

- `create({strength=256})` (128 or 256): `Demos.newMnemonic` +
  `connectWallet(m, {algorithm:"ed25519"})`. `importMnemonic(m)` normalizes to
  the SDK form (NFKD, lowercase, single spaces), checks it with
  `validateMnemonic`, then derives. Both return only
  `{ address, publicKey, network: "unconfigured", evidenceMode: "local-key-only" }`;
  `address` is `0x` + 64 lowercase hex and `publicKey` is the same 64 hex.
  No node is contacted (`connect(rpc)` is never called).
- `getPublicAccount()` returns that object or `null` when locked.
- `exportMnemonicForUser()` is LOCAL UI ONLY for explicit backup/encryption; it
  is not reachable through `request()`. Throws `locked` when locked.
- `lock()` calls the SDK `disconnect()` (drops the per-instance UnifiedCrypto)
  and drops the instance and phrase references. JS strings cannot be zeroized.
  `isLocked()` reports state.
- Operations are serialized; a concurrent create/import gets `busy`.

`request({method, params})` always resolves to `{success, data, error}` with
`error = {code, message}`; it never throws:

| method | behaviour |
| --- | --- |
| `connect` | `data` = the address string only |
| `sign` | `params: [message string]`; a message that is 64 hex characters in either case (with or without a `0x` or `0X` prefix) or starts with `demos-tx:v1:` is refused with `transaction_preimage_refused` before any approval, because those are transaction signing forms. The check reads the text the SDK signs, not the string passed: the SDK drops one leading U+FEFF, so `U+FEFF` + hash is refused, and so is any message that still starts with U+FEFF after that. Otherwise calls `approve({method:"sign", address, message})`, which must resolve to exactly `true`; signs the exact UTF-8 bytes with SDK `signMessage(…, {algorithm:"ed25519"})`; `data = {signature: <128 lowercase hex>, type: "ed25519", address}`. Accepted by `src/wallet/demos-signature.mjs` as hex, `0x`-hex or base64url. |
| `getWeb2IdentityProofPayload` | needs `IdentitiesCtor` and approval; SDK `Identities.createWeb2ProofPayload` signs `"dw2p"` locally; `data` = `demos:dw2p:ed25519:0x<128 hex>` |
| `sendTransaction`, `addGithubIdentity`, `addTwitterIdentity`, `removeWeb2Identity` | without a transport: `not_configured`; with a transport not matching the shape below: `unsupported` (none of its members is called); with the simulated-loopback transport: the write path below |
| `signTransaction`, `pay`, `transfer`, `broadcast`, `confirm`, `addDiscordIdentity`, `addTelegramIdentity`, `inferWeb2Identity`, `inferXmIdentity`, `removeXmIdentity` | always fail: `not_configured`, or `unsupported` when any `transactionTransport` was injected |
| anything else | `unsupported` |

Error codes: `locked`, `busy`, `invalid_params`, `invalid_mnemonic`,
`transaction_preimage_refused` (`sign` only),
`not_configured`, `user_rejected`, `unsupported`, `sdk_error`, `internal_error`
(SDK/approval exceptions are not echoed), plus for writes `wrong_wallet`,
`identity_mismatch`, `upstream_unavailable`, `payload_mismatch`,
`confirm_rejected`, `broadcast_rejected`, `outcome_unknown`. Locking or
replacing the wallet while an approval is pending yields `locked`/`busy` and
nothing is signed.

## Write path (simulated-loopback profile only)

The SDK's one public network seam is `Demos.connect(rpc_url)`: afterwards every
SDK node call (`nodeCall`, `confirm`, `broadcast`) is an axios POST to
`rpc_url`. With `transactionTransport = {profile: "simulated-loopback", rpcUrl,
network, resolveGithubUser?}` the adapter connects to `rpcUrl`, which the
portal takes from `POST /portal/api/embedded-wallet/profile`: the server's
same-origin relay `/portal/api/wallet-rpc` (`src/portal/wallet-rpc.mjs`). The
relay exists only with `DACS_EMBEDDED_WALLET_WRITES=simulated-loopback`, which
config accepts only with a loopback `DACS_CHAIN_RPC_URL`; it forwards only
`nodeCall` `getNetworkInfo`/`getNetworkParameters`/`getAddressNonce`/`getTweet`
and `execute` `confirmTx`/`broadcastTx` to that one URL, requires the fixture
simulation header (writes only after it was observed), never answers
502/503/504 (statuses the SDK's `_doPost` retries automatically) and logs no
bodies or headers. CSP stays `connect-src 'self'`; no axios or SDK change.

Upstream methods actually used, in order (all public SDK 4.0.16 API):

- payment: `connect`, `nodeCall("getNetworkParameters")`, approval of the
  complete debit, `sign(serverPayload, {nonce})`, `confirm(signed)`,
  `broadcast(validity)` once. The approval shows `debit`: seller amount, the
  SDK's fixed 1 DEM gas edit (`GCRGeneration` `gasAmount = 1` on every
  non-identity transaction), the node-reported network and rpc fees (which
  `Demos.sign` writes into `transaction_fee` as whole DEM), additional fee 0,
  and the total. A fee that is not a whole non-negative DEM number is refused
  before approval (`unsupported`). Before `confirm` the signed content must
  match the approval exactly: recipient, amount, nonce, data, `from` and
  `from_ed25519_address`, exactly the four SDK edits in order (amount debit
  from this wallet, payee credit, 1 DEM gas debit, nonce +1; each
  `{type, operation, isRollback:false, account, txhash, amount}`), the shown
  network/rpc fees, `additional_fee` 0, `rpc_address` null and no
  `custom_charges` (else `payload_mismatch`). Before `broadcast` the node's
  confirmed transaction must keep the signed hash and all of those fields and
  edits; it may only fill `transaction_fee.rpc_address` with a node key and
  project `content.amount` as an OS number (both as the pinned DACS pay-DEM
  rail accepts), a `gas_operation.fees` view must equal the shown fees, and
  custom charges are refused (else `confirm_rejected`).
- network: the session's only network is its transport. The portal sends a
  payment only from a session whose network matches the purchase's bound
  domain (`public/portal/portal.js` `needPaymentNetwork`).
- Twitter add: `nodeCall("getTweet")`, `nodeCall("getAddressNonce")`,
  approval, `Identities.inferWeb2Identity(demos, {context:"twitter", proof,
  username, userId, referralCode}, {nonce})` (sign + confirm), `broadcast`.
- GitHub add: as Twitter, but the user read SDK `addGithubIdentity` makes
  against `api.github.com` (forbidden by the CSP) comes from
  `transport.resolveGithubUser`, served by the server only from a loopback
  `DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN` in this profile.
- remove: `nodeCall("getAddressNonce")`, approval,
  `Identities.removeWeb2Identity(demos, {context, username}, {nonce})`,
  `broadcast`.

Assumptions and limits: `confirm` (node validation) is treated as executing
nothing; whether a live node charges the gas edit and the `transaction_fee`
fields separately is unknown, so the shown total is everything the signed
transaction commits to, an upper bound; the payload hash uses SDK `Hashing.sha256` (forge, binary string
encoding), identical to UTF-8 only for ASCII content; post-fork amounts are OS
strings (`getNetworkInfo` `osDenomination.activated`). After `broadcast` has
started the answer is `broadcast_accepted`, `broadcast_rejected` (node's own
4xx result) or `outcome_unknown` with `{hash, nonce}`; nothing retries. A
wallet result is never settlement or identity proof; the server decides from
its own readback. Verified only against the loopback fixture in
`test/helpers/embedded-wallet-transaction-chain.mjs`; never against a real
Demos node, the live testnet or `api.github.com`. Production/live enabling is
held for the live gates. The external security review is on hold.

## Tests

```
node --test test/embedded-wallet-sdk.test.mjs test/embedded-wallet-bundle.test.mjs test/embedded-wallet-runtime.test.mjs
```

All three files are discovered by the plugin's `npm test` glob `./test/*.test.mjs`.

`embedded-wallet-bundle.test.mjs` records every `WebAssembly`
compile/instantiate entry point, with its call site, by wrapping each one and
delegating to the original. The tests run in this order:
1. A control proves the record sees `Module`, `compile` and `instantiate`.
2. A second control imports a fixture module whose top-level async IIFE
   instantiates WebAssembly (node-seal's shape). It proves that the
   import-and-wait measurement catches such a call.
3. Node's own WebAssembly use is triggered and attributed before the
   measurement. Node compiles undici's llhttp parser the first time code reads
   `Headers`/`Request`/`Response`/`FormData`. That is host plumbing absent in
   browsers. Every recorded call site must be in
   `node:internal/deps/undici/`. Nothing is filtered from the measurement
   itself.
4. The runtime's exact exports are checked.
5. The import-time regression asserts no WebAssembly call at all.
6. A loader resolve hook asserts that importing the entry loads exactly the
   manifest's eager files, and none of the lazy chunks.

Before the split build, this regression ran as `# TODO` and recorded
`["compile","instantiate","instantiate"]`. With the split graph and the
unchanged test, it still recorded `["compile","instantiate"]`. The call sites
showed undici's `lazyllhttp`, not SDK code. Hence step 3.

The published 4.0.16 build is not loadable by plain Node ESM
(`ERR_UNSUPPORTED_DIR_IMPORT` for `build/demoswork/operations/` from
`baseoperation.js`). The test registers a resolve hook, scoped to importers
inside the installed SDK, that applies bundler resolution (`dir/` →
`dir/index.js`, `./x` → `./x.js`); SDK bytes are unmodified. The bundle test
provides a minimal browser-global fixture (`window`, `document.baseURI`,
`location`) so its browser branches run in Node. All sockets, `fetch` and
`WebSocket` are trapped for the whole file, and unhandled rejections are
recorded and must be empty. If `wallet-build` is not installed or the runtime not
built, the affected tests are skipped with a `BLOCKED:` reason, never passed.

These are source-aware functional tests, not source-blind validation, not a security
review and not real-browser proof.
