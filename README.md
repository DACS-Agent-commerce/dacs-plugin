# DACS plugin

Plugins that let AI assistants find DACS sellers, check their listings, and
prepare fixed-price purchases on the Demos **testnet**. A person approves every
payment in their own wallet.

| Directory | What it is |
| --- | --- |
| [`http-mcp/`](http-mcp/) | ChatGPT app, served over HTTP MCP |
| [`stdio-mcp/`](stdio-mcp/) | MCP server and Claude Code plugin, over stdio |
| `scripts/`, `test/`, [`docs/`](docs/) | Repository tooling: the public-content gate, the CI helpers and their tests |
| `.github/workflows/` | CI: `public-gate`, `http-mcp tests`, `stdio-mcp` and `lint` |

Each plugin directory is a separate Node package with its own README, setup steps and
tests. The repository root holds no plugin code.

[`PROVENANCE.md`](PROVENANCE.md) lists where every file in the first commit came
from and which ones were edited before import.

Testnet only. Neither package is a released product. The external security
review is on hold.

## Gate

`npm run gate:generic` and `npm run gate:complete` check a commit for content
that must not be published, and `npm run gate:history` checks the history. See
[`docs/PUBLIC-GATE.md`](docs/PUBLIC-GATE.md).

## Command matrix

Each row is a suite, the command that runs it, how its inputs are prepared, the
Node version it runs on and the Actions job that runs it. A suite's SDK input is
validated with `sdk-input` before any install, so one that cannot be verified
stops the job as unverifiable, not as a test failure. The last column says
whether the row is delivered or still pending.

| Suite | Command | Prepared by | Runtime | Actions job | Owner card | Stage |
|---|---|---|---|---|---|---|
| Root gate, lib and CI tests | `npm test` at the root | `sdk-input --prepare root`, `npm ci` at the root, gitleaks through the bounded installer | 22.23.3 | `public-gate.yml` | P54a3ac | delivered |
| http-mcp, browser files included | `npm run test:ci` in `http-mcp` | `sdk-input --prepare http-mcp`, then `npm ci --omit=optional` in `http-mcp` and `npm ci` in `http-mcp/wallet-build` | 22.23.3 in the pinned container | `http-mcp-tests.yml` | P54b1c | delivered |
| stdio typecheck and unit tests | `npm run typecheck`, `npm test` in `stdio-mcp` | `sdk-input --prepare stdio`, then `npm ci` in `stdio-mcp` | 20.19.0 and 22.23.3 | `stdio-mcp.yml` | P54b2 | delivered |
| Checker regression suite | `node --test test/thin-plugin.test.mjs` in `stdio-mcp`, when present | run-owned preparation: stdio's root (and the buyer root) installed and `npm run build` | 22.23.3 | `import-check.yml` | P54c2 | pending: P54c2 |
| W-6 import check, both plugins | `node scripts/ci/import-check.mjs prepare`, `check`, `finalize`, per plugin | per plugin: `sdk-input`, materialization, fresh installs and, for stdio, the build | 22.23.3 | `import-check.yml` | P54c1a, P54c1b, P54c2 | pending: P54c2 |
| Buyer execution suite | `node --test --test-concurrency=1 buyer/test/buyer/*.test.mjs` in `stdio-mcp`, when present | `sdk-input --prepare buyer`, then stdio's root and the buyer root installed and `npm run build` in stdio | 22.23.3 | `import-check.yml`, buyer job | P54c2 | pending: P54c2 |
| Buyer runtime refusal on the floor | the buyer's refusal tests only, once they exist | `sdk-input --prepare buyer`, install both stdio and buyer roots, and `npm run build` in stdio on the floor leg before refusal tests only | 20.19.0 | `import-check.yml`, buyer-floor job | P54c2 | pending: P54c2 |

A pending row is never credited. `npm run test:all` runs the matrix in order for
our own runs while the repository is private: it validates each delivered row's
SDK input, then runs its commands, and prints `test-all: <suite>: <result>` for
every row. It runs every suite with `CI=true`, as Actions does, so suites that
refuse to skip in CI do refuse. It exits 1 if any suite failed, else 2 if any row
is unverifiable, else 0. A row is unverifiable when its suite is absent, its SDK
input is unavailable, its job runs on a Node major version this run is not on
(so the stdio row is always unverifiable here: run its commands by hand on the
other Node version and record that run), or it is pending. It stops the
suite it is running when interrupted. It installs nothing: run the preparation
commands of the matrix first.

Two things come from the environment. The root tests need the pinned gitleaks:
set `GITLEAKS_BIN` to the binary the bounded installer placed, or put it on
`PATH`; without it the root row fails. The http-mcp row needs a browser: set
`DACS_TEST_CHROME` as the Actions job does, with
`export DACS_TEST_CHROME="$(cd http-mcp && node -p "require('playwright-core').chromium.executablePath()")"`;
without it the row is unverifiable.

## CI

Actions jobs start once the repository is public. Until then the same commands
run in our own runs, and a run counts only for the exact head it names. The
`stdio-mcp` workflow runs on pull requests and branch pushes that touch
`stdio-mcp/`, the workflow, `scripts/ci/`, `package.json` or `package-lock.json`.
It validates the SDK input, installs, then runs `npm run typecheck`, `npm test`
and `npm run build` on Node 20.19.0 and 22.23.3. It was written fresh for this
repository from stdio's workflow tests; no source was carried from elsewhere.

## State of this repository

Parts of this repository do not install, start or pass their tests yet, and
nothing in it has been run against a live wallet, node or ChatGPT.

- **`http-mcp/` does not start, and a plain `npm ci` fails.** Its SDK packages
  are pinned to a candidate version that is not published yet; the install checks
  use local archives (`http-mcp/docs/CI.md`). `http-mcp/src/app.mjs` and nine other
  modules import modules that are not carried here (`http-mcp/src/dacs/` and
  five related modules; see [`PROVENANCE.md`](PROVENANCE.md), "Not carried"),
  so the server stops at startup with a module-not-found error. That code is
  planned to come from the published SDK instead.
- **About half of `http-mcp/`'s tests fail.** Their files import the modules
  that are not carried. `npm run test:ci` runs every file under
  `http-mcp/test/` and reports those as failures.
- **`stdio-mcp/` is the part that has been checked.** Its unit tests pass. Its
  integration tests, type check, build and Claude Code plugin validation have
  not been run for this import.

## License

MIT, see [`LICENSE`](LICENSE). [`stdio-mcp/LICENSE`](stdio-mcp/LICENSE) keeps the
stdio package's own MIT notice.

## Focused download deadline regression

From the repository root, run the download and process-boundary tests without installing dependencies:

```sh
node --test test/lib/fetch-final-close.test.mjs test/lib/fetch-bounded.test.mjs test/lib/run-bounded.test.mjs
```

This focused command does not establish a clean full suite; the root suite has existing failures.
