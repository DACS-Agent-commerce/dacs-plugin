# DACS plugin

Plugins that let AI assistants find DACS sellers, check their listings, and
prepare fixed-price purchases on the Demos **testnet**. A person approves every
payment in their own wallet.

| Directory | What it is |
| --- | --- |
| [`http-mcp/`](http-mcp/) | ChatGPT app, served over HTTP MCP |
| [`stdio-mcp/`](stdio-mcp/) | MCP server and Claude Code plugin, over stdio |

Each directory is a separate Node package with its own README, setup steps and
tests. The repository root holds no plugin code.

[`PROVENANCE.md`](PROVENANCE.md) lists where every file in the first commit came
from and which ones were edited before import.

Testnet only. Neither package is a released product. The external security
review is on hold.

## State of this repository

Parts of this repository do not install, start or pass their tests yet, and
nothing in it has been run against a live wallet, node or ChatGPT.

- **`http-mcp/` does not install or start.** Its `package.json` depends on a
  vendored SDK archive (`vendor/`) that is not in this repository, so `npm ci`
  stops with a missing-file error. `http-mcp/src/app.mjs` and nine other
  modules import modules that are not carried here (`http-mcp/src/dacs/` and
  five related modules; see [`PROVENANCE.md`](PROVENANCE.md), "Not carried"),
  so the server stops at startup with a module-not-found error. That code is
  planned to come from the published SDK instead.
- **About half of `http-mcp/`'s tests fail.** Their files import the modules
  that are not carried. `npm run test:ci` also stops at once, because
  `deploy/test/` is not carried.
- **`stdio-mcp/` is the part that has been checked.** Its unit tests pass. Its
  integration tests, type check, build and Claude Code plugin validation have
  not been run for this import.

## License

MIT, see [`LICENSE`](LICENSE). [`stdio-mcp/LICENSE`](stdio-mcp/LICENSE) keeps the
stdio package's own MIT notice.
