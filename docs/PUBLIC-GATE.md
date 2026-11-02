# Public-content gate

Reads one commit from Git objects (never the working tree or index, never following a symlink) and reports, under a
declared scope, what the rules it runs found in it. The gate currently runs only one rule, `R-PRIVATE` (the private
list). A passing report therefore means that rule found nothing and every file could be read; it does not show that the
content may become public.

```
node scripts/public-gate/gate.mjs --repo <dir> --commit <full-sha> --scope generic [--out <file>]
node scripts/public-gate/gate.mjs --repo <dir> --commit <full-sha> --scope complete \
  --private-list <file> --expected-root <full-sha> [--private-evidence <file>] [--out <file>]
```

`--out` and `--private-evidence` create a new file and never overwrite one, and must name different files (exit 2 otherwise); without `--out` the report goes to stdout.

- **Reading.** Paths come from a NUL-separated listing. Blob size, total bytes and object count are limited in
  `public-gate.config.json`; passing a limit makes the target unscannable and names the limit. Every git call has a byte
  cap and a deadline. A symlink is its link text, a submodule is unscannable, and a path that is not valid UTF-8 is
  unscannable and named only `<commit>:invalid-path-<position>`.
- **Blobs.** A blob with a NUL byte or invalid UTF-8 is unscannable when its extension is in `textExtensions`; any other
  binary blob is unscannable unless `binaryDispositions` holds its exact path and SHA-256 with a reason. Binary blobs still
  get every rule.
- **Rules.** `R-PRIVATE` (complete scope) finds entries of the private list, a file outside the repository with one exact
  entry per line (case-insensitive substring; blank and `#` lines and one leading byte-order mark ignored; a line with
  leading or trailing whitespace is refused), in paths and blobs. A bare label fails only when the list names it. `generic` holds no list: the rule is `not-run` and the report is never a complete pass.
- **Report.** JSON: `scope`, `target` (`commit`, `tree`), `scanner` (`gateRevision`, `configSha256`; complete scope adds
  `privateListSha256`, `expectedRoot`), `rules` (`id`, `status`: `passed`, `findings`, `not-run`, `unscannable`),
  `unscannable` and sorted `findings` (`rule`, `kind`, `location`, `line`). Findings never hold the value found; a path
  holding entry n is `<commit>:entry-<n>`. Fields are cut at 4,096 characters with a `…[truncated]` marker.
  `--private-evidence` maps each opaque location to its exact paths and is the only output that holds them.
- **Scan limit.** The scan matches text in windows of 1,024 characters and stops with `limit:scanDeadlineMs` (exit 2, no
  report) once it has run longer than `scanDeadlineMs`. The scan does not return to the event loop, so an interrupt cannot
  stop it: SIGINT and SIGTERM stop the run only while git runs (exit 2, no report); once the scan has started they do not change
  the run's outcome.
- **Exit codes.** 0 pass, 1 findings, 2 missing or malformed input, interrupt during a git call, limit or unscannable
  target.

All output leaves through `scripts/public-gate/redact.mjs` on a route listed in `DIAGNOSTIC_ROUTES`.
