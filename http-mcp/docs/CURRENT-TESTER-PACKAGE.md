# Current tester package (partial v2, package 1.0.0, private, simulated fixtures)

This page explains how the current tester tarball is made and checked, what that
check proves and what it does not. This partial-v2 build has **not** been accepted. Every
live wallet/testnet check and the ChatGPT connection are still outstanding.
The external security review is on hold. Nothing here is a real plugin transaction.

## Making the artifact

- The tarball is made with `node deploy/scripts/offline-pack-normalized.mjs`
  (a source-checkout helper; it is not shipped). The helper:
  - copies only the `files` allowlist, `package.json`, `package-lock.json`, the
    vendored SDK archive and the existing `node_modules` into a fresh staging
    directory under the pack directory;
  - checks that every copied file's bytes are unchanged;
  - sets modes in that copy only: directories 0755, files 0644, and 0755 for
    the package bin and files that already had an exec bit. It never changes
    the source or its `node_modules`;
  - keeps symlinks only when they are relative and stay inside `node_modules`;
  - runs `npm pack --offline --ignore-scripts` there with fresh empty npm
    user/global configs and a fresh cache. Nothing is installed and TLS
    settings are untouched.

  The tarball is named `dacs-agent-commerce-dacs-chatgpt-plugin-1.0.0.tgz`.
  npm's JSON report (`pack.json`) and the helper's `receipt.json` sit next to
  it. The helper then re-reads the actual tar headers. It checks that every
  file is 0644/0755, that the modes agree with `pack.json`, and that every
  entry's bytes equal the source.
- The tarball contains only the isolated source it was packed from. A later
  fix (for example the F1 repair) is not in it until that source is composed
  and repacked.
- A tarball is identified **only** by its SHA-256 and the source digest it was
  packed from. An older tarball is not this artifact, even if it has the same
  file name and version.
- npm records each file's mode from the packing filesystem. The source digest
  covers bytes only. Packing straight from a private (0600/0700) copy gave an
  earlier artifact with 1038 owner-only files. The normalized staging copy
  removes that dependence on the packer's file modes.
- The package ships `bin/`, `src/`, `public/`, `skills/`, `docs/`,
  `plugin.json`, `mcp.json`, `../.env.example` (placeholders only),
  `../README.md` and `package.json`. It also bundles the DACS SDK `@kynesyslabs/dacs`
  0.1.0-alpha.0 (the exact contents of
  `vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz`, Standard pin
  `662be1d4899a2cadf327fe2d5523e93a80334e5f`) and the SDK's hoisted
  dependencies. It does **not** ship `deploy/`, `test/`, `scripts/`, `vendor/`,
  `wallet-build/`, `.env`, databases, keys, seeds or reports.

## Checking the artifact (`test/current-package-smoke.test.mjs`)

Run from a source checkout (source only; the harness is not in the package):

```sh
DACS_CURRENT_PACKAGE_TGZ=/path/to/dacs-agent-commerce-dacs-chatgpt-plugin-1.0.0.tgz \
DACS_TEST_CHROME=/path/to/chrome \
node --test --test-concurrency=1 test/current-package-smoke.test.mjs
```

`pack.json` must sit next to the tarball. If `DACS_CURRENT_PACKAGE_TGZ` is not
set, every test skips. The mode control always checks the altered 0600 entry.
It also reads the earlier unnormalized artifact from
`DACS_ORIGINAL_PACKAGE_TGZ` when that is set, and skips that comparison
otherwise; if the path is set but absent, it fails. If
`DACS_TEST_CHROME` is unset, the test uses `/usr/bin/chromium-browser` and
never launches any other browser. The test checks:

1. **Receipt:** npm's integrity, shasum, entry count and file list match the
   exact tarball bytes.
2. **Source binding:** every non-dependency entry has the same bytes as the
   checkout. The entry set equals what the `files` allowlist selects. The
   current entry points ship (both bins, `src/app.mjs`, the portal broker on
   server and browser, the built-in wallet). Nothing private ships. The wallet
   runtime graph is closed.
3. **File modes:** every entry must be 0644 or 0755, both in `pack.json` and
   in the actual tar headers, and the two must agree. A control proves the
   check bites: one entry altered to 0600 is reported, and, when
   `DACS_ORIGINAL_PACKAGE_TGZ` is set, the earlier
   unnormalized artifact (sha256 `26262e8d…ff30`) shows exactly 1038
   findings.
4. **Embedded SDK:** the bundled SDK is exactly the pinned vendor archive. The
   other bundled dependencies equal the locked copies.
5. **Staged tester project:** the tarball is extracted to
   `<project>/node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin`. The other
   production dependencies are **copied** from the checkout's existing
   `node_modules`, and each one is checked against `package-lock.json`. No dev
   dependency is copied, and there is no non-bundled SDK. The project is staged
   under a directory with no `node_modules` above it, because Node would
   otherwise load modules a tester's machine does not have.
6. **Normal server from the installed bin:** the same lifecycle as
   `deploy/scripts/runtime-smoke.mjs` (health, readiness, restart,
   backup/restore, SIGTERM exit 0). It runs inline because that helper sets
   HOME for its children. Every child here gets only PATH, TMPDIR and the
   documented server settings.
7. **Documented tester startup:** the installed
   `bin/dacs-chatgpt-offline-test.mjs --json` starts. It serves the packaged
   wallet/broker assets byte-for-byte, and a canary file proves it serves the
   installed copy rather than the source. It exposes the 14 MCP tools and the
   `simulated-loopback` profile. On SIGTERM it exits 0 and closes all four
   services.
8. **Installed import graph:** in-process, every module that installed code
   imports resolves inside the tester project.
9. **Built-in wallet + Agreement broker:** the source test harness is pointed
   at the installed `src/`, `public/`, `bin/` and bundled SDK. Real Chrome
   creates a built-in wallet, links it and then makes a trusted approval. The
   installed app anchors one unchanged Agreement on the simulated fixture
   chain, while payment stays `held`.

### What this does not prove

- **Not a clean-machine install.** The staging copy and the test project both
  use dependencies copied from the checkout. No `npm install` ran: that needs
  a registry or a populated npm cache, and this check uses neither. The copied
  dependencies stand in for one. A real `npm install <tarball> --ignore-scripts
  --omit=dev` on a fresh machine is still unproven.
- Linux x64 and the recorded Node runtime only.
- Everything is simulated on loopback. This is not testnet, settlement,
  Listing/Vet/revocation, finality, ChatGPT or security evidence.
- `deploy/scripts/validate-package.mjs` and `deploy/scripts/stage-runtime.mjs`
  start `npm pack --dry-run` without `--offline`, using the caller's npm
  config. They were not run for this artifact.

## Local install by a tester (separate from ChatGPT)

Follow `TESTER-QUICKSTART.md` section 2 and `OFFLINE-TESTER.md`. Installing
needs network or cache access to the npm registry for the unbundled
dependencies, and the tester does it on their own machine. Then run
`node node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin/bin/dacs-chatgpt-offline-test.mjs`.

## ChatGPT Developer-mode connection (still a human step)

A local install does **not** connect anything to ChatGPT. The connection
steps are in `CHATGPT-DEVELOPER-MODE.md`, and a human must do them with their
own account:

1. Deploy to a stable public HTTPS origin (`DEPLOYMENT-CHECKLIST.md`) with
   `DACS_PUBLIC_ORIGIN`, `DACS_ALLOWED_REDIRECT_ORIGINS=https://chatgpt.com`
   and fresh `DACS_OAUTH_COOKIE_KEYS`.
2. Turn on Developer mode, add `https://<origin>/mcp` with OAuth, and sign in
   through the portal.
3. Replace the placeholder URL in `mcp.json` only for a private package.

The loopback offline tester cannot be reached by ChatGPT. Real payments stay
held: no testnet chain identity is pinned.
