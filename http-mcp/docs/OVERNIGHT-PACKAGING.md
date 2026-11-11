# Package and container portability checks

These checks show that the plugin package installs from its npm tarball, starts
with the documented commands, and builds and runs as a container image on one
Linux host. They use loopback-only, SIMULATED or unconfigured services. They are
**not** a security review, live or testnet execution, ChatGPT installation, v0.1
acceptance or human approval. Evidence applies only to the exact source,
tarball and image it ran against.

## Runtime floor and platforms

- `engines.node` is `^22.22.2 || ^24.15.0` in `package.json` and the lockfile root. The range
  comes from the locked production closure; every runtime dependency must
  accept its supported floors. `test/overnight-package.test.mjs` checks this with no exceptions.
  `deploy/scripts/validate-package.mjs` refuses a lower floor while `node:sqlite`
  is used, and refuses a lockfile root whose `engines` differ from `package.json`.
- This round ran Node 22.23.3 on Linux x64. Other supported Node versions, macOS and
  Windows have not been tested. The locked production dependencies have no
  native addons, install scripts or OS/CPU restrictions; that suggests the other
  platforms will work, but proves nothing. The source-checkout checkers find npm in Unix
  install locations (or start `npm.cmd` without a shell) and are not expected to
  work on Windows.
- The source-only installed-artifact checkers (`check-offline-tester-package`,
  `check-tester-dashboard-package`) need Node 22.15+ for `module.registerHooks`.
  That requirement applies to these checkers only; the shipped runtime does not
  need it.

## Checks

| Command (from `http-mcp/`) | What it shows |
| --- | --- |
| `node --test test/overnight-package.test.mjs` | Node floor consistency; `npm pack` twice gives identical bytes; clean install of the tarball; documented `npx dacs-chatgpt-plugin` cold start answers `/health` and MCP `tools/list` (14 tools); Ctrl-C shuts it down gracefully; restart through `node_modules/.bin/dacs-chatgpt-plugin` on the same data directory exits 0 on SIGTERM. |
| `npm run check:package` | Release file list (no tests, working-notes or state files), installed server boot, MCP tool list, Dockerfile install replay. |
| `node scripts/check-embedded-wallet-package.mjs` | Embedded-wallet assets and runtime graph byte-equal in tarball, install and HTTP. |
| `DACS_TEST_CHROME=<chromium> node scripts/check-offline-tester-package.mjs` | Installed offline launcher in real Chromium (SIMULATED fixtures). |
| `DACS_TEST_CHROME=<chromium> node scripts/check-tester-dashboard-package.mjs` | Installed guided dashboard in real Chromium (SIMULATED fixtures). |
| `DACS_TEST_CHROME=<chromium> node --test "deploy/test/*.test.mjs"` | Image staging and validation rules, including this source passing `validate-package --profile source`, and the MCP Apps widget suite in real Chromium. |
| `node scripts/check-embedded-wallet-container.mjs --origin http://127.0.0.1:<port> --package-root .` | HTTP-only checks of a running image, labelled `[cold-start]` or `[restart]`. |

### Network access

`test/overnight-package.test.mjs` is part of the top-level `npm test` inventory.
Its clean-install subtest fetches the locked dependencies from the public npm
registry with TLS verification on. On a runner without registry access it fails
with a message that starts `precondition: npm registry unreachable (not a product
defect)`, or `precondition: npm registry TLS verification failed` when a proxy
replaces the certificate. Do not turn TLS verification off to get past this.
The other subtests need no network.

### Keeping the tested tarball

`npm pack` output is reproducible, so the SHA-256 identifies a tarball: rebuild
it from the same source with `npm pack --ignore-scripts` and compare the
hashes. `scripts/check-tester-dashboard-package.mjs --keep` leaves its task
directory, including the exact tarball it installed. A test runner can then
store that tarball under its SHA-256 as the tested installer. For
`test/overnight-package.test.mjs`, set `DACS_PACKAGE_RETAIN_DIR=<dir>` and the
test writes the tarball and a `<file>.sha256` there.

## Deployment env values

`deploy/env-contract.json`, together with the feature switch files in
`src/switches/` ([SWITCHES.md](SWITCHES.md)), lists every value the runtime
accepts, and a `deployValue` for the settings that a deployment must not change.
`DACS_EMBEDDED_WALLET_WRITES` accepts `off`, `simulated-loopback` and
`testnet-held`, but only `off` can be deployed. Its `deployValue` is `off`.
`DACS_IDENTITY_WRITES` can only be deployed as `held`.
`node deploy/scripts/preflight-env.mjs --env-file <file>` refuses any other
value with `deploy-value`. That covers the held testnet profile, even with a valid
https chain URL and network label: it is a non-executable, writes-off display
profile, not a deployment setting.

## Stopping the server

`npx dacs-chatgpt-plugin` is for interactive use: stop it with Ctrl-C. A SIGTERM
sent to the `npx` process alone ends npx but leaves the server running. Under a
process supervisor, run `node_modules/.bin/dacs-chatgpt-plugin` directly. The
server exits 0 on SIGTERM or SIGINT. Node prints an `ExperimentalWarning` for
SQLite at startup; it is harmless.

## Container

The documented image is `deploy/Dockerfile` with its allowlist
`deploy/Dockerfile.dockerignore`, described in the deploy README of a source checkout. Its build stage runs
`validate-package --profile source` and `stage-runtime`, so a source that fails
validation does not build. The root `Dockerfile` is an older single-stage recipe.
It does not run that validation and uses `/data` instead of
`/var/lib/dacs-chatgpt`. A test of one image says nothing about the other.

Run container checks only on a task-owned, resource-limited, loopback-only
disposable container: non-root, read-only root filesystem, all capabilities
dropped, no restart policy, no privileged, host-network, Docker-socket or
production mounts, a fresh data volume and no directory, RPC or issuer
configuration. Report these three separately, since each proves something different:
- a cold start of a freshly built image;
- a restart of the same container on its volume;
- a clean tarball install.
