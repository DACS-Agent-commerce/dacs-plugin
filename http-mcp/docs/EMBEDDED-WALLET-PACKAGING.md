# Embedded wallet: packaging and container checks

The embedded wallet is **experimental and default-off**. These checks prove that
its files ship in the npm package and the container image byte-for-byte and are
served over HTTP with the right MIME types. They do **not** prove that the wallet
works. SDK/WASM initialisation, signing, vault behaviour and real browser behaviour
are covered by separate tests (`EMBEDDED-WALLET-SDK.md`, `EMBEDDED-WALLET-TESTER.md`),
and some of them are still open.

## What ships

`package.json` `files` includes `public/`, so these files ship and are served under
`/portal/assets/`:

| File | Served as |
| --- | --- |
| `public/portal/embedded-wallet/index.html` | `text/html` |
| `main.mjs`, `ui.mjs`, `stores.mjs`, `vault.mjs`, `approval.mjs`, `dom.mjs`, `sdk-provider.mjs`, `tx-signature.mjs` (the rule that picks a transaction's signature form from the node's network answer; the wallet loads it in the browser) | `text/javascript` |
| `demos-runtime.mjs` (generated stable entry of the code-split browser build of upstream `@kynesyslabs/demosdk` 4.0.20) | `text/javascript` |
| `runtime-chunks/*.mjs` (generated, content-named; 9 files: 8 chunks and the built entry chunk, of which 5 load on import and 4 only through the SDK's own `import()`) | `text/javascript` |
| `runtime-manifest.json` (generated, public: file list, bytes, SHA-256, local import edges, SDK/esbuild identity; no wallet state) | `application/json` |
| `embedded-wallet.css`, `../portal.css` | `text/css` |

The portal router sets `x-content-type-options: nosniff`, so a wrong MIME type stops
the module from loading. The checks therefore require the exact media type.

### Runtime module graph contract

The checkers do not rely on file size or on the absence of imports, as the old
single-file proxy did. They check the exact graph declared by
`runtime-manifest.json`, using `scripts/embedded-wallet-runtime.mjs`, in the
source, the tarball, the installed package and the HTTP downloads:
- every declared file is present, with exact bytes and SHA-256;
- `runtime-chunks/` contains no undeclared file;
- every declared path is `demos-runtime.mjs` or `runtime-chunks/<name>.mjs`;
- every module specifier is re-derived from the bytes. Static imports come from
  the module prologue, where esbuild places them, and `import("…")` calls are
  read from the whole text. Each specifier must be relative and resolve to a
  declared file. Bare names, URLs, computed `import()` and paths escaping the
  directory fail;
- the re-derived edges must equal the declared edges;
- the static+dynamic closure from `demos-runtime.mjs` must equal the declared
  set. Lazily imported chunks are therefore required too, and orphans fail;
- the manifest names `@kynesyslabs/demosdk` 4.0.20, esbuild 0.25.12 and the
  runtime label, and the entry carries the generated banner.

Any change to the wallet's `@kynesyslabs/demosdk` version must run `http-mcp/test/embedded-wallet-sign-preimage.test.mjs`, which fixes the exact bytes the SDK signs for a message.

`wallet-build/` (the esbuild 0.25.12 build tooling, its lockfile and its `node_modules`)
is **not** in `files` or in the image build context. It must never ship. The checkers
also reject `.env*` (except the root .env.example template), SQLite/state files, keys, wallet-named
JSON files (`*wallet*.json`, matched on the file name), tests, working-notes files of a source checkout (`AGENTS.md`, `STATUS.md`, `ACCEPTANCE.md`)
and any `node_modules` path that is not in npm's own `bundled` list. That list is the
vendored `@kynesyslabs/dacs` and its hoisted dependencies. The wallet-JSON rule matches the
file name, not the directory. So `embedded-wallet/runtime-manifest.json`, a public
non-secret file, is allowed, while for example `embedded-wallet/wallet.json` or
`runtime-chunks/wallet-state.json` is still refused. The source repository's image
staging, which this repository does not carry, also matches on the file name.

The legacy `npm run check:package` release gate keeps its existing broader
wallet-JSON path exclusion, with one exact exemption:
`public/portal/embedded-wallet/runtime-manifest.json`. No other wallet-directory
JSON is allowed by that exemption. The embedded-wallet checker above separately
checks that this public manifest describes the exact complete module graph.
`test/package-paths.test.mjs` retains accepting and excluded-file controls for
the legacy gate.

## Package check

    node scripts/check-embedded-wallet-package.mjs [--candidate-manifest FILE] [--keep] \
      [--overall-timeout-ms N]

1. Runs `npm pack --ignore-scripts` into a new task directory. Records the tarball
   SHA-256 and confirms npm's reported sha512 integrity matches the file.
2. Reads the tarball itself (gzip + tar, header checksums verified). The
   embedded-wallet file set and bytes must equal the source, including every
   declared runtime chunk. The packed runtime graph must satisfy the contract
   above, and none of the excluded files above may ship.
3. Installs the tarball into a new project with lifecycle scripts off, TLS
   verification on, two fresh empty npm configs and a fresh cache. `HOME` is not
   changed. Confirms the installed package's lockfile integrity is this tarball,
   that the installed files and bytes equal the tarball, and that the installed
   runtime graph is closed.
4. Starts the **installed** bin on `127.0.0.1` with fresh cookie keys, a fresh data
   directory and no directory, RPC or external-issuer configuration. It then checks:
   - `/health` reports `directory`, `chain` and `externalIssuer` all `configured: false`.
   - MCP initialize and `tools/list` over Streamable HTTP return exactly the 14 named tools.
   - Every asset above, and every declared runtime chunk (eager and lazy), returns
     200 with the exact MIME, `nosniff` and a SHA-256 equal to the packed artifact.
   - The downloaded runtime graph satisfies the contract above. Undeclared extra
     files cannot be listed over HTTP; the tarball and installed listings cover them.
5. Sends SIGTERM and requires exit 0 within 15 s. Checks that the cookie key never
   appears in server output, then removes the task directory and verifies it is gone.

Exit 0 means every check passed. Exit 1 means at least one failed or the run did not
finish within its overall deadline.

## Timeouts and output

Both checkers bound every step. Each npm run is limited to 300 s, each HTTP request to
20 s (10 s for `/health`), and each MCP request to 15 s, with `connect`, `tools/list` and
`close` also capped as a whole. Each run has an overall deadline:
`--overall-timeout-ms`, default 480 s for the package check and 240 s for the container
check. The container check also requires at least the startup wait plus 30 s. Once the
deadline passes, outstanding work is aborted, a failed `run finished within ... overall
deadline` result is recorded and the final JSON is still printed. If the run is still
stuck 30 s later, a backstop stops any server child it started, prints a final JSON with
`"status": "timeout"` and exits 1.

Each result line is printed as soon as it is known. A run stopped from outside, for
example by a caller's own timeout, therefore still leaves partial evidence. Callers
should allow more time than the checker's overall deadline. Otherwise the caller stops
first and no final JSON is written.

## Container check

    node scripts/check-embedded-wallet-container.mjs --origin http://127.0.0.1:<port> \
      --package-root <checkout>/chatgpt [--restart-cycle] [--startup-timeout-ms N] \
      [--overall-timeout-ms N]

This is an HTTP client only and makes no Docker calls. The operator, or the supplied
test helper, builds the image from `deploy/Dockerfile` and runs it. The container
should run read-only, as the image's non-root `node` user, with a fresh data volume,
on an internal network, with no restart policy and with only a `127.0.0.1` port
published. It must have no directory, RPC or external issuer configured. The script:

- accepts only `http://127.0.0.1:<port>` and waits for `/health` for a bounded time
  (default 60 s, maximum 180 s);
- requires the `--package-root` source to have every wallet asset and a closed
  runtime graph;
- runs the same health, MCP, asset and downloaded-graph checks as the package
  check, comparing bytes with that source;
- labels each result `[cold-start]`, or `[restart]` when `--restart-cycle` is given.
  The two phases are separate runs and reports. A restart pass shows that the same
  image restarts on its existing volume. It is not a clean-install or persistence-of-user-data claim.

It sends no authenticated requests and takes no wallet, account, transaction or live
network actions.

## Image file permissions

The image copies the staged runtime as `root:root` and runs it as the non-root `node`
user. `deploy/scripts/stage-runtime.mjs` therefore sets the staged tree's modes
itself instead of keeping the build context's modes. A private checkout (0600 files,
0700 directories) previously produced an image whose container exited with `EACCES`
opening `/app/bin/dacs-chatgpt-plugin.mjs`. Every staged directory is now 0755, and every
regular file is 0644, or 0755 if the input had an exec bit. Nothing is group- or
world-writable, so `node` can read the app code but cannot change it. Symlinks are kept
as they are and are still checked to stay inside `node_modules`. Special files are
refused. The inputs are not changed, and `STAGE-MANIFEST.json` content hashes do not
depend on input modes. `deploy/test/stage-runtime.test.mjs` covers this with a private-mode
fixture. The Dockerfile is unchanged.

## Unit tests

`test/embedded-wallet-package.test.mjs` tests the checker logic with labelled
synthetic fixtures (`SOURCE_FIXTURE` / `ARTIFACT_FIXTURE`, a synthetic split
runtime, synthetic tarballs). Each case starts from a passing control and changes
one thing:
- one byte of an asset;
- a missing or extra wallet file;
- a declared lazy chunk missing from the artifact, or from both source and
  artifact;
- an unlabelled entry;
- a wrong or missing MIME, including JSON for the manifest;
- missing `nosniff`;
- a configured dependency or an extra tool;
- a forbidden shipped path, plus the allowed runtime manifest beside a refused
  wallet-named JSON;
- a non-loopback origin;
- a hung request past its bound, an aborted overall deadline or an
  out-of-range timeout argument.

`test/embedded-wallet-runtime.test.mjs` covers each graph rule with hand-written
fixture manifests, which are independent of the build's serializer: a missing
lazy chunk, changed bytes, an undeclared file, bare/URL/computed/escaping
imports, an undeclared local import, declared edges that differ from the bytes,
an unreachable declared file, identity pins and a missing or unreadable
manifest. It also checks the real shipped graph. These are source-aware
functional tests, not a security review.

## Scope of the evidence

Evidence from these checks is bound to the exact source, tarball and image it ran
against. A pass for one candidate says nothing about later portal integration edits,
v0.1 acceptance or deployment readiness. Re-run the checks after any change to
shipped files.
