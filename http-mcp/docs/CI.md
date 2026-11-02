# Plugin test CI

**State of this repository.** The workflow described below, `deploy/` (including
`deploy/test/`) and the frozen seller reference are not carried here, and many
test files cannot load (see `PROVENANCE.md`, "Not carried"). `npm run test:ci`
stops at once with an `ENOENT` for `deploy/test` and runs no test file. The
description below is of the source repository's CI; the counts of baseline
entries and runs it once gave are removed because they do not hold here.

The `http-mcp tests` GitHub Actions workflow runs on every pull request and push
to `main` that changes `http-mcp/**` or the workflow itself. It runs on the
`ubuntu-24.04` host, with tests inside the digest-pinned Playwright 1.56.1 Noble
container declared in the workflow, Node `22.23.3` and
`npm ci --ignore-scripts --no-audit --no-fund`, in `http-mcp/` and in
`http-mcp/wallet-build/` (the pinned Demos SDK the embedded wallet's payment and
broadcast tests need), plus the frozen seller reference described below. It
installs `expect` and `tcl-expect` at `5.45.4-3`,
resolving their dependencies only from Ubuntu's signed `20251020T000000Z`
snapshot with isolated apt sources and lists. The CLI payment and recovery tests
drive the purchase CLI on a terminal through that driver. Chromium and its system
dependencies come from the pinned container. Setup runs as root; the suite runs
as the image's `pwuser` (uid/gid 1001), with supplementary groups cleared and
umask `0022`, after giving that user the checkout and npm HOME. File ownership
and mode checks therefore run with ordinary user permissions. The workflow writes the container
digest, host image version, Chromium version and `expect` version to the summary
and the artifact (`test-results.runner.txt`), together with the test uid, gid and
umask. The checkout, setup-node and
upload-artifact actions are pinned by commit SHA (the `v4` commits the first
runs resolved), with the exact tag in a comment. The seller checkout uses the
default read-only `GITHUB_TOKEN` with `persist-credentials: false`; no additional
secret is needed. No server is deployed. Runtime configuration and write protections are
unchanged. These `v4` actions target Node 20, which GitHub has deprecated: it
runs them on Node 24 instead and warns. Moving to the next majors waits for a
change whose new SHAs can be checked against the actions' repositories.

`npm run test:ci` discovers non-browser `*.test.mjs` files under `test/` and
`deploy/test/`, excluding `*.browser.test.mjs` and `browser/`, `fixtures/` and
`helpers/` directories, and `test/dacs-loopback-fixture.test.mjs`, a shared
fixture module that registers no tests. Each file runs sequentially in a separate
Node process, with `NODE_ENV=test`, and a 600-second deadline. A deadline kills the
entire process group; so does interrupting the run (Ctrl-C or `SIGTERM`), which
also removes the run's own `TMPDIR`. Files are
not run with `--test-force-exit`: it ends the process as soon as the last test
finishes, and results still on their way to the runner can be lost, so a file
can report fewer tests than it has and still succeed (a GitHub run
dropped tests from four files that way). A file therefore must exit on
its own; one that leaves open handles behind runs into the deadline and fails as
`[timeout]`. Some files today keep handles open for minutes after their last
test: in one GitHub run the slowest file took 262 seconds and the full
run 64 minutes; the job allows 180 minutes. The suites need `TMPDIR` set to a fresh directory you own
([TESTING.md](TESTING.md)): some tests read `process.env.TMPDIR` directly, and the
wallet extension mutant probe refuses anything but a private mode-0700
`TMPDIR`. GitHub's runner sets no `TMPDIR`, so a run without one creates a
private `dacs-test-XXXXXX` directory under the system temp directory and gives
it to every file and removes it when the run ends; a `TMPDIR` that is set is used as it is and left alone. Without this, a GitHub
run failed 39 tests in three files. JSON lines are written to
`test-results.jsonl`. Failed or timed-out
files retain TAP output, including assertion diagnostics and stacks, in
`test-results.jsonl.failures/<file>.tap` (path separators become `__`). Both are
uploaded in the same artifact even if tests fail. GitHub's step summary lists
totals, new failures, stale baseline entries and known failures that now pass.
Some existing package tests skip when their required artifacts are absent; the
results record those skips. The Chrome cases in non-browser files (the one
in `dacs-current-broker-interactions`, the one in `durable-wallet-journal`,
and `current-package-smoke`'s, which skips without a package tarball) run the
Chromium build that the locked
`playwright-core` pins (1.56.1: build 1194, Chromium 141.0.7390.37): the container
includes that build and the workflow sets
`DACS_TEST_CHROME` to its path, so they do not move with the weekly image's
`/usr/bin/chromium-browser`, which they use only when `DACS_TEST_CHROME` is unset
(as in a local run). If the browser stops working the cases fail; they do not
skip. The hosted runner's kernel and Docker still roll; the test userland and
browser bytes are fixed by the container digest. Updating the image, browser or
terminal driver is an explicit workflow/lockfile change. The Ubuntu snapshot
service and container registry must be available; setup fails if either is not.
See [Ubuntu's snapshot service](https://snapshot.ubuntu.com/) and the
[Playwright 1.56.1 image source](https://github.com/microsoft/playwright/blob/v1.56.1/utils/docker/Dockerfile.noble).

The gate fails on each failure absent from `test/known-failures.json`. Entries
match the relative file path and the test's full suite path: the names of its
enclosing `describe` blocks and its own name, joined with ` > ` (a top-level
test is just its name). Same-named tests in different blocks are therefore
separate entries. A known failure in a file does not excuse other failures in
that file. An entry excuses its test only when the failure's message or cause
matches the entry's `expect` (see [The baseline](#the-baseline)), so a known
name that fails for a different reason is a new failure. It also excuses nothing when its name belongs to more
than one result in the file (two tests with one name, a suite and a test, or a
test whose own name contains ` > `). Timeouts use the explicit name `[timeout]`;
abnormal process exits use `[process failure]` (including a file-level failure
that Node names after the file, which carries the file's exit status such as
`exit code 3`), and missing or inconsistent reporter results
use `[incomplete results]`. A file whose own process did not report its summary
(it crashed, was killed or exited early) is incomplete even when an earlier test
in it failed. What happens after the tests end is a `[process failure]` too,
even in a file that already has a failing test (where Node itself reports
nothing more):

- an uncaught exception or unhandled rejection that node:test reports as
  asynchronous activity after the test ended;
- an error that kills the process after its summary, for example one thrown in
  an `exit` handler, which leaves Node's `Node.js v…` fatal-error line on the
  file's stderr (the runner starts Node with `--extra-info-on-fatal-exception`,
  so `NODE_OPTIONS` cannot turn that line off);
- a file process that ends by a signal (`killed by SIGKILL`, `killed by SIGABRT`
  for `process.abort()`), or with an exit code other than the one its own
  summary gives, 1 when it is unsuccessful and 0 when it is successful
  (`exit code 9`, for example from `process.exitCode` or `process.exit()` in an
  `exit` handler). A failed suite whose own tests all passed (for example its `after`
  hook failed) leaves that summary successful and the file exits 0; a file
  without its summary is expected to exit 1 when a test failed. Node keeps
  this status on the file's own result even when it reports no failure for it.
  A file killed before its summary gets this beside `[incomplete results]`.

A late change that leaves the status a file would have had anyway, such as
`process.exitCode = 1` in a file whose test failed, is not a crash and is not
reported. These are separate failures, so an existing failing test cannot excuse
a timeout or crash. Malformed or duplicate baseline entries fail the run.

A baseline entry that matches no test also fails the run, as a stale entry: a
file that ran to completion did not report the test (passed, failed or
skipped), or, in a discovery run, the file no longer exists. A renamed or
removed test must leave the baseline in the same change, so an old entry cannot
hide a later test of the same name. Files that time out, crash or report
incomplete results are not judged for staleness. When files are selected
explicitly, only entries for those files are checked.

A known failure that passes also fails the run until its entry is removed, so a
fixed test cannot keep an unused allowance. Skipped tests are not reported as
passing. Do not add broad file-level exceptions.

## Run locally

From `http-mcp/`, with Node 22 and installed dependencies:

```sh
npm run test:ci
```

To select files or write results somewhere else:

```sh
node scripts/run-test-files.mjs . "$TMPDIR/results.jsonl" 600 \
  --known test/known-failures.json test/unit.test.mjs test/run-test-files.test.mjs
```

The known-file path is relative to the first argument (the project directory).
The results path is relative to the calling directory; TAP files are saved in
`<results-path>.failures/`. Omitting explicit files
runs the same discovery as CI; fixture files can be selected explicitly.

A local run is not GitHub's runner: cases that need Chrome, the npm registry or
other host facilities can fail locally and report as new failures. The baseline
describes the GitHub runner only.

## The baseline

An entry has exactly this shape:

```json
{
  "file": "test/example.test.mjs",
  "test": "describe block > the exact node:test name",
  "reason": "One-line explanation of the existing failure.",
  "class": "main-defect",
  "expect": "the failure's whole message, or a stable part of a one-line message"
}
```

`expect` comes from the GitHub run's results (`failures[].error` and `.cause`).
A message of several lines (an assertion diff, a list of problems) is matched
only by an `expect` equal to all of it, newlines included, so an added or
changed line, such as a second payment in a `{ creates, payments }` diff, is a
new failure. A one-line message is matched by an `expect` it contains: use the
whole message where it is stable, and otherwise the part that names the cause,
leaving out host paths, times and counts that can vary. A multi-line message
whose text varies between runs cannot be baselined; fix the test or its cause.
For `[timeout]`, `[process failure]` and `[incomplete results]` the runner
writes the message itself (for example `exit code 1`, `killed by SIGKILL` or
`no per-file test summary`). A late exception or rejection carries node:test's
diagnostic, which names the error; an error after the summary carries only
`uncaught error after the file's summary (see the TAP stderr)`, so an entry
with that text would excuse any such crash of its file: fix it instead.

`class` is one of:

- `main-defect`: the test or the code fails on `main` itself, on any host;
- `environment`: the GitHub runner lacks something the test needs that neither
  the image, the workflow nor this repository's pinned dependencies can provide
  (an unavailable external test input). A pinned dependency or an image package
  is installed by the workflow instead;
- `browser`: a browser case inside a non-browser file that fails on the GitHub
  runner because of the browser.

Only failures that happen on the GitHub runner belong in the baseline. A case
that fails only on a developer machine or in a sandbox (no Chrome, no npm
registry) stays out, so that a real regression of it on GitHub is not hidden.
The same holds for a case that failed only under parallel load: CI runs files
one at a time. Each entry needs evidence: a failure in a GitHub run, or, for a
case GitHub has not run yet, a failure that reproduces in sequential runs on
`main` itself from a cause the GitHub runner shares (a defect in the code or
the test, or something the runner lacks too).

In the source repository the baseline came from a full no-baseline run of every
discovered file, checked against a GitHub run, and a full run had to match every
entry with none stale. That is not the case in this repository (see "State of
this repository" above). Count the discovered files with the runner's discovery
rules; in this repository the expanded test inventory now brings discovery to 254 files: 254 under `test/`
and 0 under `deploy/test/`, which is not carried:

```sh
node --input-type=module -e "import { discover } from './scripts/run-test-files.mjs'; console.log(discover('.', 'test').length + discover('.', 'deploy/test').length)"
```

Because `deploy/test/` is missing, this command and `npm run test:ci` stop at
once with `ENOENT: no such file or directory, scandir 'deploy/test'`, and no
test file is run.

`test/known-failures.json` holds one entry: the seller-disposition payment-path
case, recorded in the source repository as observing 7 CREATEs instead of 5.
It does not describe this repository. The test file needs modules that are not
carried, so it fails at load here and the entry excuses nothing. It stays
because `test/run-test-files.test.mjs` reads it. It is not a list of the
failures in this tree, which are far more numerous.

### Frozen seller reference

17 cases use the unchanged Demo seller reference: 10 in
`agreement-context-integration`, 6 in `agreement-context-interactions` and 1 in
`dacs-current-broker-interactions`. CI fetches `seller-reference-dbe07f9c` from
`${{ github.repository }}` with a second `actions/checkout`, into
`$GITHUB_WORKSPACE/seller-reference`. The approved tag points to the
frozen reference commit. Its root contains `v2/` and
`vendor/`. CI installs its locked dependencies with
`npm ci --ignore-scripts --no-audit --no-fund` in
`seller-reference/v2/seller/`, and sets the job's
`DACS_SELLER_INTEROP_REFERENCE` to the absolute checkout path.

Before importing any reference code, both loaders require exactly 17 files,
manifest SHA-256
`dbe07f9c9cff45fa2a4af106b80614ce59c5ac19b9acf5c147aa315c78a298bf`
and the pinned SDK archive hash. The manifest maps sorted relative paths to
file SHA-256 values and hashes its JSON serialization. Checkout metadata
(`.git`, `.DS_Store`) and installed `node_modules` are excluded. The digest is
the trust anchor: moving the tag to different artifact bytes fails the tests.
Missing references and changed digests have no baseline allowance; all 17 cases
must reach their substantive assertions for CI to pass.

For a local checkout of that tag, install its dependencies as above, then set
`DACS_SELLER_INTEROP_REFERENCE` to its absolute root before running the tests.
The `ci-environment` regressions check the workflow wiring and verify that both
loaders reject an absent directory and changed bytes in a 17-file git checkout.

## Rebuild the baseline after each main merge

Every run checks the baseline against the tree it runs on: an entry must fail
with its `expect`, so an entry that a merge made stale, fixed or changed fails
the run, as does any failure without an entry. What a run cannot check is the
judgement behind a new entry. So when `main` is merged into a branch that
changes the baseline, rebuild it as follows, and read the first GitHub run
after that merge:

1. Run the complete non-browser set without the baseline:

   ```sh
   node scripts/run-test-files.mjs . "$TMPDIR/baseline-candidate.jsonl" 600
   ```

   This deliberately exits non-zero if any file fails.
2. For every failure, read its `file`, `failing` names, `failures` messages and
   the retained TAP output. Decide whether it also fails on the GitHub runner:
   compare with the latest run's artifact, and run it again when it may be
   nondeterministic. Investigate new failures before adding them; record the
   specific defect or missing precondition as the reason and pick the class.
3. Keep entries that still fail, add the new ones and delete the rest. Give
   each its `expect` from the failure's message. The run with `--known` reports
   every entry that matches no test, now passes, or fails for another cause, so
   a renamed, fixed or changed test cannot be missed.
4. Run `npm run test:ci` and check that only the intended known failures
   remain, then push and read the first GitHub run: a new failure or a stale
   entry there means the baseline is still wrong.

Browser CI and fixing or quarantining existing failures are not covered yet.
