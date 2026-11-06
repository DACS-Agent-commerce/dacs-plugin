# Feature switches

A simple feature switch is a default-off `off`/`on` enum or a `0`/`1` flag.
It may hold (refuse) one value at load time, and it has no rule that involves
another variable. Each one is a single file, `src/switches/<ENV NAME>.switch`.
`loadConfig` reads these files synchronously, in a fixed order, and returns each
value under the switch's config key. Deploy tooling (`validate-package`,
`preflight-env`, the deploy tests) merges the files into the env contract.
Both read the files with the same parser, `src/switch-files.mjs`, taken from
the package being checked. `validate-package` runs it in a confined child
process (see "What validate-package runs"); `preflight-env` and the tests load
it into their own process.
Adding a switch therefore touches no shared line in `src/config.mjs`,
`deploy/env-contract.json` or the operator env example
(deploy/dacs-chatgpt.env.example), so two such PRs merge cleanly into main
and into each other.

Anything with cross-variable logic stays in `loadConfig`. Examples are
`DACS_EMBEDDED_WALLET_WRITES`, `DACS_IDENTITY_WRITES` (its values are not
`off`/`on`, an empty value means `held`, and what it enables depends on the
configured chain), the auth settings and the chain settings.

### Static settings among the switches

Three default-off settings stay in `loadConfig` and in
`deploy/env-contract.json`, because a switch file cannot declare them:

- `DACS_COMMIT_ON_SIGNATURE`: `loadConfig` returns it as a boolean
  (`commitOnSignature`), and every consumer requires one. A switch file's enum
  returns the string itself, and a flag accepts only `1`.
- `DACS_INTENT_APPROVAL`: `on` is refused together with
  `DACS_PORTAL_AUTO_ADVANCE=on`, a rule that involves another variable. The
  rule reads the auto-advance switch's parsed value (`switches.portalAutoAdvance`).
- `DACS_SHOWCASE_REPORT_VIEW` (a `0`/`1` flag): `1` is refused together with
  `DACS_SHOWCASE_LEDGER=1`, a rule that involves another variable. The rule
  reads the ledger switch's parsed value (`switches.showcaseLedger`).

Each is checked where it was before the switch files, so with several invalid
settings the first error does not change. `DACS_COMMIT_ON_SIGNATURE` is
checked between the switches with an `order` below 27
(`COMMIT_ON_SIGNATURE_ORDER` in `src/config.mjs`) and the rest:
`parseSwitches(env, { before })` and `parseSwitches(env, { from })` are the
two runs. The report view's rule is checked right before it, after the first
run; the ledger switch has `order` 26 so that its parsed value is ready there.
`DACS_INTENT_APPROVAL` is checked after every switch.

## Add a switch

1. Add `src/switches/DACS_MY_FEATURE.switch`. It is strict JSON. The extension
   is not `.json` because the packaging checks refuse wallet-named `*.json`
   paths, and `DACS_WALLET_*` would be one.

   ```json
   {
     "env": "DACS_MY_FEATURE",
     "configKey": "myFeature",
     "kind": "enum",
     "values": ["off", "on"],
     "default": "off",
     "deployValue": "off",
     "operatorNote": "One or two sentences an operator needs: what it shows or does, and what it never does."
   }
   ```

   | Field | Meaning |
   | --- | --- |
   | `env` | The env name; must equal the file name. |
   | `configKey` | Key in the `loadConfig` result. Must be unused. |
   | `kind` | `enum`: the value is the string itself; absent means `default`; anything not in `values` (including empty) is refused with `<ENV> must be off or on` (with more values: `must be a, b or c`). `flag`: exactly `1` is `true`, anything else (absent, empty, `0`, `true`) is `false` and never refused. A flag has no `values`, and its `default` is `"0"`. |
   | `values` | Enum only: the accepted values. |
   | `default` | The value when unset. It cannot be held. |
   | `deployValue` | The only value a deployment may use (`preflight-env` refuses any other, set or defaulted, and `validate-package` refuses a listed env example line with another value). When set, it must equal `default`, because a deployment that does not list the switch runs the default. Use `null` for no restriction. |
   | `held` | Optional: `{ "on": "<exact ConfigError message>" }`. The value is accepted by name but refused when config loads. |
   | `order` | Optional number. Switches are checked after the cookie keys and before identity writes, in ascending `order`, then by env name, and switches with no `order` come last. Leave it out unless an open PR's check must keep its place between two existing ones (the existing enums use 10, 20, 25, 30, 35 and 40, and the ledger flag 26; the static `DACS_COMMIT_ON_SIGNATURE` is checked after every order below 27 and before the rest). |
   | `operatorNote` | The operator documentation. Default-off switches are not listed in the env example. |
   | `contractNote` | Optional `note` on the env contract entry. |

   A malformed file is refused, naming the file. See "What is checked where"
   below.

2. Read `config.myFeature` where the feature is wired in. Do not edit
   `src/config.mjs`, `deploy/env-contract.json` or the env example.

3. Test the switch in the feature's own test file: default off, every value,
   an invalid value, and the held refusal if there is one. Assert the contract
   entry and the name sets with `contractView()` and `runtimeNames()` from
   `test/helpers/env-contract-view.mjs`. Never assert a digest of
   `src/config.mjs`. `test/switch-registry.test.mjs` already checks every switch
   file generically: its contract entry matches its runtime parsing, and its
   deploy value is accepted. Do not add the switch to
   `test/config-equivalence.test.mjs`: that test pins only the nine switches
   converted from inline checks.

### What is checked where

All commands run from `http-mcp/`.

| Check | `loadConfig` (import, or the first call) | `validate-package` | `preflight-env` | `stage-runtime` |
| --- | --- | --- | --- | --- |
| Each file against the schema: JSON, no duplicate key, no unknown field, every required field (`env` equal to the file name, `configKey`, `kind`, `values` for an enum, `default`, `deployValue`, `operatorNote`), held and deploy values (a set `deployValue` equals `default`) | refuses (`SwitchFileError`, naming the file) | `switch-file-invalid`, with the same message | `switch-files-invalid` | — |
| Only regular `<ENV>.switch` files: no other file name, no symbolic link, no directory (dotfiles are ignored) | refuses | `switch-file-invalid` (the same messages; such an entry is never copied for the package code check) | `switch-files-invalid` | — |
| `src/switches/` exists and holds at least one file | refuses | `switch-file-invalid` | `switch-files-invalid` | — |
| Two switches share a `configKey` | refuses | `switch-file-invalid` | `switch-files-invalid` | — |
| A `configKey` that a non-switch setting already uses | refuses on the first call | `switch-file-invalid` (it runs the package's `loadConfig` once) | `runtime-config-rejected` | — |
| The package's parser or `loadConfig` cannot be run to the end: `src/switch-files.mjs` or `src/config.mjs` is not a regular file or imports anything but `node:` builtins and each other, an import or the call throws anything but a `SwitchFileError` (including a `ConfigError` for the two minimal settings), `loadConfig` is missing, the check prints nothing or anything besides its one result record, exits non-zero or takes over 60 s | — | `runtime-config-unloadable`, with the reason (for a run: the stage and the error's class and message) | — | — |
| A switch named like a static `env-contract.json` entry | `loadConfig` cannot see `deploy/` (it is not in the npm package) | `switch-listed-in-contract` | `switch-files-invalid` (the contract view refuses it) | — |
| The switch files in `src/switches/` are exactly those in the `npm pack` list | — | `switch-file-not-shipped` | — | refuses to stage |

Known limits, kept on purpose:

- Nothing can tell that a whole switch file was deleted without a central
  list, which this design avoids. A deleted file of one of the nine converted
  switches fails `test/config-equivalence.test.mjs`; any other is caught by
  its feature's own tests and by `validate-package` if the env example still
  lists it.
- `loadConfig` alone accepts a switch named like a static `env-contract.json`
  entry: `deploy/` is not in the npm package, and `loadConfig` has no list of
  its own static names to compare with (keeping one would be a second list to
  maintain). `validate-package` and `preflight-env` refuse it, and the image
  build runs `validate-package` before anything is deployed.

The env names `src/config.mjs` reads are taken from its text, outside
comments, strings and regular expressions: `env.NAME`, `env['NAME']` and
`env["NAME"]`, `process.env.NAME`, and `<anything>.env.NAME` or
`<anything>.env['NAME']` (such as `globalThis.process.env.NAME`). Code that is
never run still counts. Each of these in `src/config.mjs` is an
`env-read-unrecognized` error:

- any other use of `env` (a computed key, destructuring, an alias, passing
  `env` to a function other than as `parseSwitches`'s first argument), and `process` used other
  than as `process.env` or `process.cwd()`;
- `env` as `parseSwitches`'s first argument, and `env[s.env]`, in any shape
  but the one `src/config.mjs` has: one top-level `function
  parseSwitches(env, ...)`, called directly with `env` first (not
  `x.parseSwitches(env)`, not passed around), and `env[s.env]` only inside its
  `for (const s of SWITCHES) { ... }`, where `s` is only read as `s.<field>`
  and `SWITCHES` is the one top-level `const SWITCHES = loadSwitchFiles(...)`,
  with `loadSwitchFiles` imported once, by that name, as `import { ...,
  loadSwitchFiles, ... } from './switch-files.mjs'` (no `as`, no other use
  or definition of the name). Those names are the switch files', which the
  check takes from the parser;
  `env[s.env]` with any other `s` could read any name;
- `globalThis`, `global`, `eval`, `Function`, `arguments`, `require` and
  `import()`;
- a `\u` escape outside strings and comments, and a regular expression
  naming `env`, `process` or one of those globals (the check tells a regular
  expression from division by the token before it, so it refuses what it
  might have misread);
- an import or re-export of anything but `node:path` and
  `./switch-files.mjs`, by exact name (the `CONFIG_IMPORTS` list of the
  source repository's package check, which this repository does not carry).
  Allowing another module is a reviewed edit there.

So no read in `src/config.mjs` is silently missed by mistake. The check
catches accidental drift only; it is not a security boundary. It is a lexer,
not a parser: source written to mislead it (for example a regular
expression placed where it guesses division, containing a quote, or a
function built at run time such as `(() => {}).constructor('return
process')()`) can still hide one, so `src/config.mjs` is reviewed as code too. Reads elsewhere are
outside the check. These `src/` modules read `process.env` directly, none of
the reads added by this change: `src/devnet-demo/operator.mjs`
(`DACS_SHOWCASE_WALKTHROUGH`, `DACS_DELIVERY_DEADLINE_WATCH`,
`DACS_COMMIT_ON_SIGNATURE`, `DACS_SHOWCASE_REPORT_VIEW`,
`DACS_BUYER_CHAIN_READBACK` and `DACS_FUNDING_HELP_URL`, passed on to the
devnet demo's app, and `DACS_TEST_TRACE`) and
`src/devnet-demo/operator-approval.mjs` (`DACS_TEST_TRACE`). A hosting
preflight refuses each of them in the operator's environment file; its test
derives that list from every module the hosted operator loads (a new
`process.env` read in any of them fails it, and so does a global-object alias
or reflection method this scan cannot follow. Only global-object refusals in
the generated SDK runtime are exempted, after checking its bytes against
`runtime-manifest.json`; its environment reads and other refusals still count).
`test/env-contract-defaults.test.mjs` checks that each
static entry's `default` and `values` are what `loadConfig` does.

The order of the keys in the `loadConfig` result is not part of its contract:
the switch keys come after the others. Compare config objects by key, never by
`Object.keys` order or `JSON.stringify` output.

4. Document the feature in its own doc. The `operatorNote` is the operator
   note. Do not add an env example line. If a later PR lists the switch anyway,
   `validate-package` still checks its value against the deploy value.

### What validate-package runs

`validate-package` never imports the checked package's code into its own
process. It runs that code (`src/switch-files.mjs` on `src/switches/`, then
`src/config.mjs` and one `loadConfig` call with only `DACS_PUBLIC_ORIGIN` and
`DACS_OAUTH_COOKIE_KEYS`) in one child process, on a copy:

- the copy: `validate-package` itself copies `src/switch-files.mjs`,
  `src/config.mjs` and the regular files in `src/switches/` into a fresh
  private (0700) folder under the system temporary folder. It removes the
  folder after a pass, a refusal, a timeout or a child crash, but not when
  `validate-package` itself is stopped by any signal (`SIGKILL`, and also
  `SIGTERM`, `SIGINT` or `SIGHUP`) or crashes; a folder left that way is
  0700 and holds only those package files. Each path is checked with `lstat`
  (no symbolic link on the way or at the end, no folder, device or FIFO) and
  opened without following a link. The file opened must be the one `lstat`
  saw, with a single link: a file with other hard links is refused, since one
  of them may be outside the package. That also refuses legitimate
  multi-linked files, such as a tree made with `cp -al` or deduplicated by a
  store like Nix's; the message names the cause, and a plain copy of the file
  passes. The rule relies on the filesystem reporting link counts (one that
  always reports a single link would let a hard link through), and the count
  is a snapshot (below). The file, and `src/switches/` before it is
  listed, must also be on the package root's mount (below). A refused module,
  a hard link, a file on another mount and a file that changed while it was
  copied are `runtime-config-unloadable`; another refused entry in
  `src/switches/` is `switch-file-invalid`; each has a fixed message naming
  only the package path, and none is ever read through. Nothing else is
  copied, so the two modules may import only `node:` builtins and each other;
  any other import is refused before the run;
- environment: `PATH`, and `TMPDIR` when it is set; nothing else;
- working directory: the copy; timeout: 60 s;
- Node's permission model when the running Node has one (`--permission`, or
  `--experimental-permission` on older 22.x; detected from the Node binary,
  and the child confirms it is in force): file reads only in the copy, and
  no file writes, child processes, workers or native addons. On a Node
  without it, the child still runs, and a `package-code-unconfined` warning
  says so;
- no `node:sqlite`: Node 22's permission model does not check it (it opens
  database files itself, so the child could read any SQLite database the user
  can read, and create files), so the child runs with
  `--no-experimental-sqlite`, which removes the module (`import` gives
  `ERR_UNKNOWN_BUILTIN_MODULE`). The flag is looked up in
  `process.allowedNodeEnvironmentFlags`. A Node that has `node:sqlite` but
  does not know the flag would leave the read open without a word, so the
  child does not run there, with or without a permission model:
  `runtime-config-unloadable`, with a fixed message;
- no inherited descriptors: a descriptor the validator inherited without
  close-on-exec would reach the child, and Node does not check reads through
  a descriptor. The child's stdio is its own pipes for 0 to 2 and `/dev/null`
  in every slot up to the highest descriptor the validator holds (listed from
  `/proc/self/fd`, or `/dev/fd`). If they cannot be listed (Windows, for
  example) the child does not run: `runtime-config-unloadable`, with a fixed
  message.

Node's permission model follows symbolic links, which is why the child gets a
copy that has none instead of the package: before, a link in the package
(`src/leak-link -> ../../outside`, `src/proc-link -> /proc`) let it read any
file the user can, including the validator's own environment in
`/proc/<pid>/environ`.

`validate-package` assumes no other process changes the tree while it runs.
Node has no `openat`, so the folders on a path are checked with `lstat`
before the file is opened by its full path, and a folder swapped for a link
in between would be followed. So each folder's device and inode are recorded
on that walk, and after the open the file must still be in the checked tree:
on Linux, `/proc/self/fd/<fd>` must show the package root joined with the
file's package path; where there is no `/proc`, every folder on the path is
checked with `lstat` again and must be the one recorded. Any difference is
`runtime-config-unloadable` with a fixed message. A folder swapped for a link
and put back before that second walk is refused too: the file at the path is
then not the one recorded through the link.

A mount inside the package, such as a bind mount over `src/switches`, shows
files from elsewhere at their package paths, so `/proc/self/fd` and the walk
both accept them. So `validate-package` opens the package root once and
reads its mount ID (`mnt_id` in `/proc/self/fdinfo/<fd>`), and every file it
opens, and `src/switches/` before it is listed, must have the same one; a
file or folder with another mount ID, or none, is refused with a fixed
message naming only its package path. A package that legitimately mounts
`src/switches/` (a mounted config volume, for example) is refused the same
way; copy the files in instead. Where the mount ID cannot be read (no
`/proc/self/fdinfo`, or no `mnt_id` line in it), the device (`stat().dev`)
of each opened file and of `src/switches/` must be the package root's
instead. That sees a mount from another filesystem, but not a bind mount
from the same filesystem, which keeps the device: on such a system a bind
mount inside the package is not detected. Node has no `openat2`, so the
check cannot refuse to cross a mount while it opens.

What remains:

- without `/proc`, a writer that races the second walk itself: it keeps a
  folder on the path swapped for a link and puts the real one back only
  while the second walk checks that folder, so every `lstat` there sees what
  was recorded. With `/proc` the opened file's path shows the swap;
- the single-link check is a snapshot taken at the walk's `lstat` and after
  the open. A process that can already write the package tree, and keeps
  linking and unlinking an outside file's other name around those two
  moments, can get it copied;
- a writer can always change a file's content in place, which the check then
  copies as the package's own.

What this does **not** cover, so do not treat it as a sandbox for hostile
code:

- the network and unix-domain sockets: Node 22's permission model restricts
  neither, so the package code can open connections (and reach whatever
  answers on them, loopback services included) and connect to any socket
  reachable by a file path, such as a Docker or SSH agent socket.
  `validate-package` itself opens none. What the child can send is limited to
  what it holds: the copied files and the reduced environment (`PATH`,
  `TMPDIR`), but what a socket's service does on request is not;
- `fs.realpathSync` on an outside path: under the permission model it still
  returns the canonical path, so the child can learn that a path exists
  (never its content). Known and left for a follow-up;
- the env scan (`validate-package`'s check that `src/config.mjs` reads env
  only in the forms it follows) catches accidental drift only. It is not a
  security boundary; deliberate obfuscation beats it.

Apart from these, the child can read only the copied files and its reduced
environment. The two reads that used to be open, `node:sqlite` and inherited
descriptors, are closed as described above (neither is a general claim about
Node's permission model, which Node does not call a sandbox). Run
`validate-package` on a tree you do not trust in a container with no
network, and no host sockets or secrets mounted.

The child reads a random nonce from stdin before any package code runs, and
prints one record carrying it: the parser's switches and errors, then whether
`loadConfig` returned. Anything else is `runtime-config-unloadable`. The
nonce stops accidental output (a stray `console.log`, a guessed or copied
success record) from passing as a result. It does not stop deliberate
forgery: package code that patches `process.stdout` (for example its
`_write`) can rewrite the record, nonce included.

`preflight-env` is different: it is the deployment check of the package it
belongs to, so it imports that package's `src/config.mjs` and parser into its
own process and calls `loadConfig` on the real settings.

## Prove off is unchanged

```sh
node scripts/check-off-unchanged.mjs origin/main    # from http-mcp/
```

This checks out `git merge-base HEAD origin/main` (during an uncommitted
merge, the base of HEAD and MERGE_HEAD together) as a temporary worktree
under `TMPDIR`, sharing `node_modules` by symlink (no network). It then
captures the default-env surface of that tree and of this working tree
(uncommitted and untracked files included) with the same capture script,
`scripts/off-surface.mjs`, and compares them with the runner,
`scripts/check-off-unchanged.mjs`. Both come from the oracle (below), never
from this checkout alone. What it captures:

- `loadConfig` defaults;
- MCP server version and instructions;
- the tool list with descriptions, schemas, annotations and `_meta`;
- every UI resource listing and its HTML;
- status, bytes and headers (without `date`, `etag` and the like) of every
  `public/` file in either tree, of one page per portal route family
  (`/portal/link`, `/portal/authorize/x`, `/portal/purchase/x`,
  `/portal/identity/x`), of `/health` and of the OAuth
  metadata.

What it does **not** see, so a change there exits 0:

- any HTTP route not in that list, such as a new or changed `/portal/api/...`
  route, even one that is served with every switch off;
- tool **results**: no tool is called, so changed result text or data is not
  compared;
- anything behind sign-in, a purchase, the database or a background job, such
  as a change on the purchase path with a switch off;
- any non-default static setting (external auth, a configured chain or
  directory): both trees are captured with the default env only, so a
  change that shows only under such a setting, with every switch off, is
  not compared.

Those need in-tree tests (below). The exit code is 0 when nothing differs, 1
when something does, and 2 when the check could not run. It prints every
difference; the PR description lists the intended ones. For a pure
default-off switch that list is one line, its new config key at its off value:
`DIFF $."loadConfigDefaults"."myFeature": (absent) -> "off"`. Any other line
is a switch-off change on the captured surface. Nothing runs the check
automatically: the author runs it, and runs it again after merging main.

### The oracle

An edit to the capture script or the runner could hide the PR's own change,
so this checkout's copies are never the only oracle:

- When the merge base has both files, its copies are the oracle. The runner
  you start writes the base's runner (`git show`) to a temporary file and runs
  it; that copy captures both trees with the base's `off-surface.mjs`.
- When the merge base lacks either file (main, until this change merges), or
  its runner predates being run this way, the check exits 2 unless
  `--capture-from <ref>` names a commit whose two files are used the same
  way. Until this change is on main, the reviewer passes `--capture-from`
  with the reviewed head commit of the change and checks that the two blob ids
  printed are that commit's
  (`git rev-parse <ref>:http-mcp/scripts/off-surface.mjs`, and the same for
  the runner). `--capture-from` is refused when the base has its own copies.

The output starts with the oracle and both files' blob ids. If this checkout's
copy of either file differs from the oracle's, the check exits 2. After
reviewing that edit, rerun with `--allow-surface-change`: the oracle's copies
run first (with a `NOTE`; surface the edit adds is not compared until it is on
main), then this checkout's copies, and the last line gives both exit codes.
The exit code is the worse of the two.

The runner you start is still this checkout's file, which decides to run the
oracle. To depend on nothing in the PR, run the oracle's runner yourself:

```sh
git show <oracle ref>:http-mcp/scripts/check-off-unchanged.mjs > "$TMPDIR/check-off.mjs"
node "$TMPDIR/check-off.mjs" origin/main --checkout . [--capture-from <ref>]
```

### Instead of pinned "same as main" hashes

Do not hard-code main's hashes or captured main output in tests: every later
change to main breaks them, even though the PR changed nothing there. Instead:

- In tree, compare the switch-off result with the plain one. Examples: the
  default-off render equals the render without the feature; served asset bytes
  equal the `public/` file; resources served with the switch off are exactly
  the plain `UI_RESOURCES`; the off config equals the defaults; the cache-off
  purchase path sends the legacy request bytes.
- Against main, use the script above for what it captures. It compares
  against the PR's real merge base, so it never goes stale.

An existing pin that covers something the script does not capture (tool
results, routes outside the list, a purchase or database path) stays until an
in-tree comparison covers the same thing.

## Convert an open PR that added a switch the old way

Commands run from `http-mcp/`.

1. Merge main in: `git merge origin/main`. In `src/config.mjs`,
   `deploy/env-contract.json` and the env example
   (deploy/dacs-chatgpt.env.example), resolve each conflict by taking main's
   side. If the PR changed nothing else in those files, run
   `git checkout origin/main -- src/config.mjs deploy/env-contract.json deploy/dacs-chatgpt.env.example`.
2. Delete the old-style lines if any are still there:
   - in `src/config.mjs`, the switch's `const x = env.DACS_X ...` and
     `if (...) throw` lines, and its line in the returned object;
   - in `deploy/env-contract.json`, the switch's `variables` entry and any
     `derivedFrom.sha256` change;
   - in the env example (deploy/dacs-chatgpt.env.example), the switch's
     comment and `DACS_X=` lines.
3. Add `src/switches/DACS_X.switch`. Copy into it the values from the deleted
   lines: the allowed values, the default, `deployValue` from the contract
   entry (`null` if it had none), the held value and its exact message, the
   contract entry's `note` as `contractNote` (if it had one), and the env
   example comment as `operatorNote`.

   Precedence: the switch block is checked after the cookie keys and before
   `DACS_IDENTITY_WRITES`, in `order`. An enum the PR checked somewhere else
   (for example after identity writes) now reports its error at that point
   instead, so with several invalid settings a different error can come first.
   If the old check sat between two existing switch checks and should stay
   there, add an `order` between theirs; otherwise say in the PR description
   that the first error can change.
4. In the PR's tests:
   - replace `contract.derivedFrom.sha256` assertions, and reads of
     `env-contract.json` for the switch, with `contractView()` and
     `runtimeNames()`;
   - drop `^DACS_X=` env example assertions;
   - for each pinned main hash or captured main output, write down what it
     covered. Replace it with an in-tree comparison (above) when the off check
     captures that surface or an in-tree test covers it; otherwise keep the pin.
     Removing a pin should never remove the only check on a surface.
5. Run:

   ```sh
   node --test test/switch-registry.test.mjs test/config-equivalence.test.mjs \
     deploy/test/validate-package.test.mjs deploy/test/preflight-env.test.mjs <the PR's own tests>
   node deploy/scripts/validate-package.mjs
   node scripts/check-off-unchanged.mjs origin/main
   ```

   Until this change is on main, the last command needs
   `--capture-from <the reviewed head of this change>` (see "The oracle").
