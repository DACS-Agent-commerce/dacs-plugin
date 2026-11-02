# Public-content gate

Reads one commit from Git objects (never the working tree or index, never following a symlink) and reports, under a
declared scope, what the rules it runs found in it. The gate currently runs only one rule, `R-PRIVATE` (the private
list). Exit 0 in complete scope means that rule found nothing and every file could be read; it does not show that the
content may become public. Generic scope runs no rule, so its exit 0 is never a complete pass.

```
node scripts/public-gate/gate.mjs --repo <dir> --commit <full-sha> --scope generic [--out <file>]
node scripts/public-gate/gate.mjs --repo <dir> --commit <full-sha> --scope complete \
  --private-list <file> --expected-root <full-sha> [--private-evidence <file>] [--out <file>]
```

`--out` and `--private-evidence` create a new file and never overwrite one, and must name different files (exit 2 otherwise); without `--out` the report goes to stdout.

- **Reading.** Paths come from a NUL-separated listing. Blob size, total bytes and object count are limited in
  `public-gate.config.json`; passing a limit makes the target unscannable and names the limit. Every git call has a byte
  cap and a deadline. A symlink is its link text; a submodule and a path that is not valid UTF-8 are unscannable.
- **Blobs.** A blob with a NUL byte or invalid UTF-8 is unscannable when its extension is in `textExtensions`; any other
  binary blob is unscannable unless `binaryDispositions` holds its exact path and SHA-256 with a reason. Binary blobs still
  get every rule, decoded as UTF-8 with U+FFFD for invalid bytes; UTF-16 text is not decoded.
- **Private list.** A regular file outside `--repo` (symlinks resolved; a FIFO or device is refused), at most
  `maxPrivateListBytes` bytes and `maxPrivateEntries` entries, one exact entry per line. Blank and `#` lines and one leading
  byte-order mark are ignored; a line with leading or trailing whitespace is refused. A bare label fails only when listed.
- **Matching.** `R-PRIVATE` (complete scope; `not-run` in generic scope) finds entries in paths and blobs, case-insensitive
  per code point exactly as JavaScript's `/iu`: simple case folding, no Unicode normalization (a combining accent differs
  from a precomposed letter) and no one-to-many folding (`ß` is not `ss`). CRLF, a lone CR and a lone LF each end a line.
- **Report.** JSON with exactly `scope`, `target` (`commit`, `tree`), `scanner` (`gateRevision`, `configSha256`; complete
  scope adds `expectedRoot`, recorded but not yet checked), `rules` (`id`, `status`: `passed`, `findings`, `not-run`,
  `unscannable`), `unscannable` (`location`, `cause`) and sorted `findings` (`rule`, `kind`, `location`, `line`). It holds
  only fixed words, object ids, digests and numbers; no field is derived from the list itself. Every location is
  `<commit>:<position>`, the entry's 1-based position in the commit's listing. `--private-evidence` (mode `0600`, written
  only after the report) maps each location to its exact path, or `hex:<bytes>` for a name that is not UTF-8. The two
  writes are not atomic together: a crash between them leaves a report without evidence.
- **Diagnostics.** stderr holds one line: a cause and its fixed text, never a path, a list entry or git's own output.
- **Scan limit.** The matcher reads each text once whatever the number of entries, with at most one state per code point
  of the list (so at most `maxPrivateListBytes`); at the shipped limits it scans about 25 MiB/s, so `maxTotalBlobBytes`
  takes about 10 s. `scanDeadlineMs` is a backstop: past it the run stops with `limit:scanDeadlineMs` (exit 2, no report).
  The scan does not return to the event loop, so SIGINT and SIGTERM stop the run only while git runs (exit 2, no report).
- **Exit codes.** 0 pass, 1 findings, 2 missing or malformed input, interrupt during a git call, limit or unscannable
  target.

All output leaves through `scripts/public-gate/redact.mjs` on a route listed in `DIAGNOSTIC_ROUTES`.
