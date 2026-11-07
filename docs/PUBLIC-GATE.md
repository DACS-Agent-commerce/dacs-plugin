# Public-content gate

Reads one commit from Git objects (never the working tree or index, never following a symlink) and reports, under a
declared scope, what the rules it runs found in it. The gate currently runs three rules: `R-ACCOUNT` and `R-HOST` (the
address rules) and `R-PRIVATE` (the private list). Exit 0 in complete scope means no rule found anything and every file
could be read; it does not show that the content may become public. Generic scope runs the address rules and reports
`R-PRIVATE` as `not-run`, so its exit 0 is never a complete pass.

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
  A text blob is also read with its backslashes removed (line breaks kept, so the line is the blob's own), so an entry
  written with regex or string escapes is found.
- **Hosts (`R-HOST`, both scopes).** Every path and every text blob is read line by line, as written and with its
  escaped delimiters `\/`, `\@` and `\:` unescaped (`https:\/\/host\/x` is read as the URL it decodes to); a backslash ends a URL host.
  An escaped dot (`\.`) is not unescaped, because it is regex syntax in the code's own host patterns. A dotted name is a host when it is the
  host of a URL (any top-level name), a `host:port` pair, a quoted name in code (`.cjs .css .js .mjs .mts .sh .ts .tsx`), or a
  bare name in any other text and in path names; the last three count only under a top-level name listed in
  `HOST_TOP_LEVEL_NAMES`, so file names and property chains are not hosts. A host passes only on an exact, lower-case match with an
  `allowedHosts` entry (`value`, `reason`): a subdomain, or a listed name used as a label prefix of another domain, is another
  host and needs its own entry. Reserved names pass with any subdomain: the top-level names `invalid`, `test`, `example` and
  `localhost`, and `example.com`, `example.org` and `example.net`. A name with no dot (a machine label), a template placeholder
  and an IP literal are not read here; the private list covers labels, and IP literals belong to the IP rule.
- **Accounts (`R-ACCOUNT`, both scopes).** An email address passes when its domain is a reserved name or it is the SSH form
  (`git@<host>:` or `git@<host>/`) of a host in `allowedHosts`. A domain of one label (`user@<label>`) is an email too, unless a `/`
  precedes the user (`actions/checkout@v4`) or the label starts with a digit (`name@1.2.3`); a reference that ends in a word
  after `@` (a package tag or a plugin marketplace) therefore needs a `scopedAllowances` entry. In commit metadata (`refusedMetadataEmails`) an email also passes when it is
  part of an exact `publicIdentities` entry (`Name <email>`); that does not approve the identity itself, which the
  identity rule of history mode still checks. The configuration starts with `publicIdentities` holding the publication identity.
- **Allow-list entries.** A lockfile or generated bundle gets no exemption: a host or email there passes only through a
  `scopedAllowances` entry (`path`, `rule`, `value`, `context`, `reason`) for that exact path, rule, lower-case value and context
  (`url`, `host-port`, `quoted`, `bare` or `email`). `public-gate.config.json` may also hold the values its own entries name. A
  malformed section makes the run exit 2 with cause `invalid-config`. Findings carry the rule, kind (`path` or `content`),
  location and line, never the host or email.
- **Root.** Complete scope reads the history behind `--commit`; it must have exactly one root commit, `--expected-root`, or the
  run exits 2 (cause `unexpected-root`) without a report.
- **Report.** JSON with exactly `scope`, `target` (`commit`, `tree`), `scanner` (`gateRevision`, `configSha256`; complete
  scope adds `expectedRoot`), `rules` (`id`, `status`: `passed`, `findings`, `not-run`,
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

## Checking a saved report

```
node scripts/public-gate/check-report.mjs --report <file> --head <full-sha> --context <file>
```

Exit 0 only when the report is a complete passing report for exactly this head under the current review context; a saved
report is never trusted for what it says about itself. Exit 1 refuses a report; exit 2 means a file or an argument is
missing, over 1 MiB, or malformed (a report is malformed unless it has the report shape above, nested fields included). Nothing is written on exit 0; otherwise stderr holds one cause and its fixed text.

- **Review context.** A JSON file in our records with exactly `gateRevision` and `configSha256` (the current reviewed
  gate's identity) and `expectedRoot` (the root commit). Every expected value comes from it, from `--head` or from this gate's
  registered rule ids, never from the report. The report's `scanner` must equal the context's three fields exactly, so a
  field the context does not name (a later scanner policy) refuses the report until the context names it.
- **Causes.** `report-not-complete` (scope is not `complete`), `report-other-head` (target commit is not `--head`),
  `report-rules-differ` (the rule ids are not exactly the registered ones), `report-policy-differs` (the scanner identity
  differs from the context), `report-not-passing` (a finding, an unscannable entry or a rule not `passed`). The exit 2
  causes are `report-unreadable`, `report-malformed`, `context-unreadable`, `context-malformed`, `limit:maxCheckFileBytes`
  and `bad-arguments`.
- **Not bound yet.** The report carries no digest of the private list (nothing in it derives from the list), so a
  corrected list is not detected by this command; the scanner policy and exception digests arrive with the secret scan.

## History mode

```
node scripts/public-gate/history.mjs --repo <dir> --refs <ref>[,<ref>...] --private-list <file> --expected-root <full-sha> \
  [--allowed-identity 'Name <email>'] [--pr-text <file.json>] [--out <file>]
```

Walks every commit reachable from the refs (names or full object ids, comma-separated), parents first, and reports under
scope `history`. Each commit's tree gets the same reading and the same `R-PRIVATE` scan as in complete scope. Reading, limits,
exit codes and output rules are those above; `--out` never overwrites a file, and there is no `--private-evidence`.

- **Root.** The walk must have exactly one root commit, `--expected-root`; any other root exits 2.
- **Commits.** `R-PRIVATE` also scans each commit's message (kind `message`, with the line), its author and committer lines
  (kinds `author` and `committer`) and its other headers (kind `header`). A commit finding's location is `<commit>:<field>`,
  the field (`author`, `committer`, `header` or `message`) it was found in.
- **Identity.** With `--allowed-identity`, `R-IDENTITY` finds every author or committer line that is not exactly that
  identity (kind `author` or `committer`) and every time zone other than `+0000` (kind `timezone`). Without the flag the rule
  is `not-run`.
- **Pull-request text.** `--pr-text` is a JSON array of objects. `R-PRIVATE` scans every string in them, keys and values, at any
  depth, and every repeat of a key (kind `pr-text`, location `pr-<n>:<m>`: the n-th object, and the m-th string in it in
  the file's order, both from 1, with the line). Keys are never printed. Anything else in the file exits 2.
- **Report.** The same closed schema as above: fixed words, object ids, digests and positive numbers, nothing derived from
  the list. `target` is `heads` (the object ids the refs name, sorted) and `commits` (how many were read). Each finding and
  each `unscannable` item also holds its `commit`, except findings of `--pr-text`. `scanner` holds `gateRevision`,
  `configSha256` and `expectedRoot`, and adds `prTextSha256` when the file is given.
