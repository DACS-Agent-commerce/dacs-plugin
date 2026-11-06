# Offline test replay (source checkout)

**State of this repository.** These steps describe the source tree this package was imported from. Here `npm ci` stops because the vendored SDK archive is not carried, `deploy/` is not carried, and about half of the test files fail when they load the modules that are not carried. See `PROVENANCE.md` at the repository root, "Not carried".

These instructions are for a **source checkout** of the plugin. The installed package does not include the `test/` or `deploy/` directories, so none of these commands can run from an installed tarball.

Every check here runs against SIMULATED local fixtures: chain, directory and wallet, ephemeral keys, and loopback servers only. Passing them is not ChatGPT, wallet, testnet or deployment evidence.

## Runtime

- Node 22.13 or later; the recorded runs used 22.22.0 with its bundled npm.
- Install from the lockfile, in `http-mcp/`, with lifecycle scripts disabled:
  `npm ci --ignore-scripts --no-audit --no-fund`
- Browser checks need a real local Chrome or Chromium binary. Point `DACS_TEST_CHROME` at it; the macOS default path does not exist on Linux. Use the binary that matches the installed `playwright-core`, which records its expected revision in `node_modules/playwright-core/browsers.json`. A missing browser is a BLOCKED skip, never a pass.

## Use a short TMPDIR

Run the suites with `TMPDIR` set to a fresh, short directory you own, for example `TMPDIR=$(mktemp -d /tmp/dacs-XXXXXX)`.

- **Why short:** Chromium aborts at launch (SIGTRAP, exit 133) when TMPDIR is too long. A 115-character path failed in a Linux cloud run; a 20-character path worked.
- **Why your own dir:** it keeps every test-owned fixture in one place you can inspect.

## Replay the checks (from the plugin source directory)

```sh
npm test
npm run check:package
DACS_TEST_CHROME=/path/to/chrome npm run test:browser
```

`npm run test:ci` runs the same files, browser files included, one process each ([CI.md](CI.md)). Without the browser variables the browser files report BLOCKED skips.

`test/catalog-observed-at.test.mjs` checks directory observation freshness through projection and the SDK reader. Directory `catalogObservedAt` accepts non-negative safe-integer epoch milliseconds and legacy parseable date strings of at most 64 characters (including ISO-8601), normalized to numeric epoch milliseconds in projected summaries. Future observations and observations older than 24 hours fail freshness; malformed or missing values stay missing and fail closed as stale.

### Installed offline tester package check (source tooling: Node >= 22.15)

```sh
DACS_TEST_CHROME=/path/to/chrome node scripts/check-offline-tester-package.mjs [--keep]
```

- **What it does:** packs this source with scripts off and cold-installs the
  tarball. It then starts the *installed* offline tester launcher and drives
  real Chromium through the simulated-loopback workflows. See OFFLINE-TESTER.md.
- **Node floor:** this source checker needs **Node >= 22.15**, because it
  records installed imports with `node:module.registerHooks`. It was tested on
  22.22.0.
  - On an older Node it does not fail with a link error. Its first clause fails
    with a clear message, and it exits 1 before packing anything.
  - This floor applies only to the source checker. The installed package and
    its launcher still support the documented runtime, Node >= 22.13.
- **Browser:** a missing `DACS_TEST_CHROME` browser is a failure, not a skip.
- **`--keep`:** keeps the task directory (tarball, install project) and prints
  its path.
- **Unit tests:** `test/offline-tester-package.test.mjs` covers the checker's
  pure helpers. It imports them without needing `registerHooks`.

## Fixture cleanup

- **Harness data dirs:** `startHarness()` removes the data dir it created (SQLite files included) on `close()`. `restart()` keeps it, so durable state survives until that final close. A caller-supplied `DACS_DATA_DIR` is left to the caller.
- **Failures are loud:** any removal failure fails the test file; nothing is swallowed.
- **What may remain:** after a run, TMPDIR can still hold Node's `node-compile-cache` and Chromium's own `.config`/`.pki`. Neither is a test fixture.

## Purchase mouse-click observation (still open)

On a timeout, the widget suite's mouse-click helper reports only counts, never URLs:
- clicks that reached the button;
- clicks that landed elsewhere;
- `#app` re-renders;
- whether the clicked button is still connected;
- `ui/open-link` posts seen by the host page;
- host open-links recorded.

It never retries and never extends a timeout. Passing runs do not resolve the observation.
