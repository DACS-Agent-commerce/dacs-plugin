# AGENTS.md

Guide for coding agents working in this repository.

## What this repo is

The DACS (Demos Agent Commerce Standards) plugin: MCP servers that let AI assistants find DACS sellers, check their listings and prepare fixed-price purchases that a person approves in their own wallet. It holds an MCP server for stdio clients and a ChatGPT app served over HTTP MCP. The repository root holds no plugin code, only checks and CI helpers.

Testnet is the default network. `http-mcp/` is testnet only. `stdio-mcp/` refuses testnet writes in this release; its only write path is an explicit mainnet opt-in (`DEMOS_ALLOW_MAINNET=1`) that has not been tried.

## Folder layout

| Path | What it is for |
| --- | --- |
| `stdio-mcp/` | The `demos-mcp` package: MCP server and Claude Code plugin over stdio. Its own `package.json`, tests and README. |
| `stdio-mcp/src/` | Server source (TypeScript). `src/dacs/` holds the DACS signing, verifier and fixed-price offer code. |
| `stdio-mcp/test/` | `unit/` (mocked SDK, no network), `integration/` (read-only testnet), `live/`, and the `thin-plugin*` tests. |
| `.claude-plugin/` | Claude Code marketplace file at the repository root; it lists the `demos` plugin from `stdio-mcp/`. |
| `stdio-mcp/.claude-plugin/`, `commands/`, `skills/`, `adapters/` | Plugin manifest, slash commands, skills and host adapters. |
| `http-mcp/` | The ChatGPT app: Streamable HTTP MCP server, account linking and wallet signing portal. Its own `package.json`, tests and README. |
| `http-mcp/src/`, `bin/`, `public/`, `docs/` | Server modules, launch scripts, browser portal files, and operator and tester notes. |
| `http-mcp/wallet-build/` | Isolated build inputs for the embedded wallet browser bundle. Not part of the runtime package. |
| `scripts/public-gate/` | The public-content gate (`gate.mjs`, `history.mjs` and their rule modules). |
| `scripts/ci/` | CI helpers: `sdk-input.mjs`, `install-gitleaks.mjs`, `test-all.mjs`, `dependency-roots.json`. |
| `scripts/lib/`, `test/` | Shared helpers and the root tests (`test/ci`, `test/lib`, `test/public-gate`). |
| `tools/lint/` | ESLint setup, kept apart from the plugins. |
| `docs/` | `PUBLIC-GATE.md`. |
| `.github/workflows/` | `public-gate.yml`, `http-mcp-tests.yml`, `stdio-mcp.yml`, `lint.yml`. |

`PROVENANCE.md` records where each imported file came from.

## Install and run the checks from source

Install from source: the packages are not on npm yet, so clone this repo and install inside each package directory. Do not look for an `npm install <name>` step. The README section "State of this repository" lists what does not install or pass yet; read it before you treat a failure as new.

Node versions used in CI: 20.19.0 and 22.23.3 for `stdio-mcp`, 22.23.3 for the root, lint and `http-mcp`.

`stdio-mcp` (the part that installs and runs today):

```sh
cd stdio-mcp
node ../scripts/ci/sdk-input.mjs --prepare stdio
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test                  # unit tests, no network
npm run build             # writes dist/ (not committed)
```

Root checks (public-content gate and CI helper tests):

```sh
node scripts/ci/sdk-input.mjs --prepare root
npm ci
npm test                  # needs the pinned gitleaks: set GITLEAKS_BIN or put it on PATH
```

The gate scans a commit, not the working tree, so commit first. `node scripts/ci/install-gitleaks.mjs --dir <folder>` places the pinned binary at `<folder>/gitleaks`. Then run the generic gate on that commit, as CI does (the flags are all required; `npm run gate:generic` alone exits 2 with `bad-arguments`):

```sh
GITLEAKS_SHA256="$(sha256sum <folder>/gitleaks | cut -d ' ' -f 1)"
npm run gate:generic -- --repo . --commit "$(git rev-parse HEAD)" --gitleaks <folder>/gitleaks --gitleaks-sha256 "$GITLEAKS_SHA256"
```

`docs/PUBLIC-GATE.md` lists every flag and the exit codes.

Lint:

```sh
npm ci --prefix tools/lint --ignore-scripts
npm ci --prefix stdio-mcp --ignore-scripts
npm run lint --prefix tools/lint
```

`http-mcp` has its own commands (`npm run test:ci`, `npm run check:package`) and a setup that needs a seeded cache for its SDK packages; follow `http-mcp/docs/CI.md`. `npm run test:all` at the root runs the whole command matrix in the README and prints one result per suite.

## Main entry points

- `stdio-mcp/src/index.ts`: starts the MCP server over stdio (built to `stdio-mcp/dist/index.js`, the `demos-mcp` bin).
- `stdio-mcp/src/server.ts`: `createServer` registers the tools.
- `stdio-mcp/src/http_transport.ts`: HTTP transport for the same server.
- `stdio-mcp/src/chain.ts`: the chain boundary; it imports the Demos SDK for every chain call. `stdio-mcp/src/index.ts` is the only other source file that imports the SDK (it uses `Demos` for `keystore create` and for the wallet factory that makes a new mnemonic and derives an address); no other file in `stdio-mcp/src/` does.
- `http-mcp/bin/dacs-chatgpt-plugin.mjs`: starts the HTTP app (`npm start` in `http-mcp`).
- `http-mcp/src/app.mjs` and `http-mcp/src/mcp/server.mjs`: the HTTP app and its MCP tool surface.
- `scripts/public-gate/gate.mjs` and `scripts/public-gate/history.mjs`: the gate on a commit and on history.

## Rules

- **Tests and examples use testnet.** Tests, examples and docs never point at a live-value network, and never use a real key or a real RPC with value. The only mainnet route is the `stdio-mcp` opt-in described above; do not add another.
- **Never commit keys.** No private keys, mnemonics, keystores, tokens or `.env` files. Use obvious placeholders in examples. `.env.example` is the only tracked env file.
- **Run the checks before a PR.** At least the commands above that cover the files you changed, plus the generic gate at the root (the full command is under "Install and run the checks from source").
- **Keep changes small.** Do what the task asks; no unrelated refactors or new files.
- **No internal notes in commits.** Reports and scratch folders (`.stack/`, `.fix-tmp/`, `BUILD-REPORT.md`, `FIX-REPORT.md`) stay out of the repo.
- **Do not weaken a test** to make a check pass.
- **Describe the packages accurately.** Neither package is a released product; say "install from source".
