# Public-content gate

Reads one commit from Git objects (never the working tree or index, never following a symlink) and reports, under a
declared scope, what the rules it runs found in it. The gate currently runs twelve rules: `R-ACCOUNT`, `R-HOST` and `R-IP`
(the address rules), `R-ENV`, `R-HOSTING` and `R-ARCHIVE` (the file rules), `R-REPORT` and `R-ISSUE` and `R-WORDING` (the text rules), `R-EVAL`
(dynamic code evaluation), `R-PRIVATE` (the private list) and `R-SECRET` (the secret scan). Exit 0 in complete scope means no rule found anything and every file
could be read; it does not show that the content may become public. Generic scope runs the rules that need no list and reports
`R-PRIVATE` and `R-WORDING` as `not-run`, so its exit 0 is never a complete pass.

```
node scripts/public-gate/gate.mjs --repo <dir> --commit <full-sha> --scope generic \
  --gitleaks <binary> --gitleaks-sha256 <hex> [--out <file>]
node scripts/public-gate/gate.mjs --repo <dir> --commit <full-sha> --scope complete \
  --gitleaks <binary> --gitleaks-sha256 <hex> \
  --private-list <file> --wording-list <file> --expected-root <full-sha> [--private-evidence <file>] [--out <file>]
```

`--gitleaks` and `--gitleaks-sha256` are required in both scopes (see Secret scan). `--out` and `--private-evidence` create a new file and never overwrite one, and must name different files (exit 2 otherwise); without `--out` the report goes to stdout.

- **Reading.** Paths come from a NUL-separated listing. Blob size, total bytes and object count are limited in
  `public-gate.config.json`; passing a limit makes the target unscannable and names the limit. Every git call has a byte
  cap and a deadline. A symlink is its link text; a submodule and a path that is not valid UTF-8 are unscannable.
- **Blobs.** A blob with a NUL byte or invalid UTF-8 is unscannable when its extension is in `textExtensions`; any other
  binary blob is unscannable unless `binaryDispositions` holds its exact path and SHA-256 with a reason. Binary blobs still
  get every rule, decoded as UTF-8 with U+FFFD for invalid bytes; UTF-16 text is not decoded.
- **Private list.** A regular file outside `--repo` (symlinks resolved; a FIFO or device is refused), at most
  `maxPrivateListBytes` bytes and `maxPrivateEntries` entries, one exact entry per line. Blank and `#` lines and one leading
  byte-order mark are ignored; a line with leading or trailing whitespace is refused. A bare label fails only when listed.
- **Wording list.** `--wording-list` (complete scope only; refused in generic scope, required in complete scope) names a second list, read
  exactly as the private list is, with its own limits (`maxWordingListBytes`, `maxWordingEntries`) and causes (`wording-list-in-repo`,
  `-unreadable`, `-malformed`, `-empty`). Its vocabulary is never in the repository: it holds the prohibited terms and the internal
  review-tool names of the operator's records. A tool name must also be on the private list, which matches everywhere, fenced code and
  source included. The report names the list by `scanner.wordingListSha256`, the digest of the bytes read, and `check-report` binds it.
- **Matching.** `R-PRIVATE` (complete scope; `not-run` in generic scope) finds entries in paths and blobs, case-insensitive
  per code point exactly as JavaScript's `/iu`: simple case folding, no Unicode normalization (a combining accent differs
  from a precomposed letter) and no one-to-many folding (`ß` is not `ss`). CRLF, a lone CR and a lone LF each end a line.
  A text blob is also read with its backslashes removed (line breaks kept, so the line is the blob's own), so an entry
  written with regex or string escapes is found.
- **Reports (`R-REPORT`, both scopes).** Refuses a working-report file name (`build-rules.md` names three, any letter case, any depth), a
  working-notes directory as any path segment (`.fix-tmp`, `.stack`) and a Markdown blob whose first 20 non-blank lines hold a heading, a
  front-matter key or a bold label that is a frozen-input, canonical-snapshot or review-round marker (space, hyphen and underscore
  equal; the marker alone, or followed by a colon, a parenthesis, a number or a commit id).
- **Issue references (`R-ISSUE`, both scopes).** In every text blob, a bare number-sign reference (`PR`, `issue` and bare forms, also in fences,
  comments and string literals), an `owner/repo` reference and every GitHub issue, pull-request or discussion address passes only for a
  repository in `publicRepositories` (`owner`, `repositories`; whole segments, no case). Any address of the organisation's repositories,
  in page, clone, raw, API or escaped form, must name a listed one. Colour values, link fragments, entities, `PKCS` names and
  `<name#n>` placeholders are not references. The six upstream deprecation notices that npm copied into two lockfiles pass only through
  `lockfileDispositions` (`path`, `blob`, `field`, `line`, `valueSha256`, `reason`): all five facts of the occurrence must match, and the
  field is found by parsing the lockfile. An entry whose path the target holds only at another blob stops the run with
  `stale-lockfile-disposition` (exit 2), so a later lockfile change needs a new review; a seventh link or a wildcard needs a new owner decision.
- **Wording (`R-WORDING`, complete scope).** In every text blob that is not source code (Markdown and text as prose, HTML text and the
  `title`, `alt`, `placeholder` and `content` values, manifests by string value, other files as text), list entries are matched in paragraphs:
  wrapped lines joined, emphasis marks and invisible characters removed, white space collapsed, the entries normalised the same way. A fenced
  shell command is left as written for the vocabulary. A sentence about the review's status passes only as the approved clause (case-insensitive,
  with no reason added), or as a negative disclaimer. Clauses end at sentence ends, semicolons and parentheses; a reason after the approved
  clause, in the same sentence, fails. In history mode the list is also matched in commit and tag messages, headers and `--pr-text`, with no status check.
- **Dynamic evaluation (`R-EVAL`, both scopes).** Parses, with the TypeScript compiler (nothing is run), every `.js .mjs .cjs .jsx .ts .mts .cts .tsx`
  file (`.d.ts`, `.d.mts` and `.d.cts` included), in a child
  process (`rules-eval-child.mjs`) under `run-bounded`. It flags the global `eval` and `Function` in these forms: called, with `new`, as a
  value or alias, through `globalThis`, `window`, `self` or `global` by member, bracket (literal key), optional or comma-expression access, and
  through destructuring of those objects (declared, assigned, as a parameter default, in `for…of` or nested); and a string (literal, template or `+` with a string)
  passed to the global `setTimeout` or `setInterval`. A function callback passes; strings, comments, regular expressions, template text and types never count.
  Inline code in `.html` and `.htm` files (scripts and event-handler attributes) is not read yet.
  A computed member, a computed destructuring key or a rest element of a global object makes the file unscannable (`eval-computed-member`). Other causes: `eval-parse-error`
  (the file has a syntax error), `eval-too-deep` (the file nests so deep that parsing it overflows the child's stack; the other files are still judged), `eval-parse-timeout` (the child passed `evalDeadlineMs` and was killed) and `limit:maxEvalUnitBytes`;
  units go to the child in batches of at most `maxEvalBatchBytes`, its output is capped at `maxEvalOutputBytes`, and a reply that breaks the
  protocol stops the run with `eval-parser-failed` (exit 2). The only exceptions are the exact files of `evalGeneratedFiles` (`path`, `sha256`, `reason`):
  the same bytes at another path are another occurrence and fail, and an entry whose path the target holds only at other bytes stops the
  run with `stale-eval-exception`. Limits of the detection: only a plain `setTimeout` or `setInterval` call (or a member of a global object) is read for
  string arguments written beside it (not a string or timer held in a variable), a name shadowed by a local variable is still read as the global, a global object is read only as written beside the member or pattern (not through a variable, an argument or `this`), and `constructor` chains and `Reflect` are not followed.
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
  A URL host is normalised the way a URL parser resolves it before it is matched: percent escapes decoded once (`host%2eexample%2ecom` is
  `host.example.com`), lower-cased, and a trailing dot dropped. A URL host whose escapes are not valid UTF-8, or that decodes to anything
  but a name or a bracketed IPv6 literal (`host%252eexample`, `host%2fx`), is a finding, not a pass. The IP rule and the commit-metadata
  checks read the decoded host too, so `http://127%2e0%2e0%2e1/` is judged as `http://127.0.0.1/`.
- **Accounts (`R-ACCOUNT`, both scopes).** An email address passes when its domain is a reserved name or it is the SSH form
  (`git@<host>:` or `git@<host>/`) of a host in `allowedHosts`. A domain of one label (`user@<label>`) is an email too, unless a `/`
  precedes the user (`actions/checkout@v4`) or the label starts with a digit (`name@1.2.3`); a reference that ends in a word
  after `@` (a package tag or a plugin marketplace) therefore needs a `scopedAllowances` entry. In commit metadata (`refusedMetadataEmails`) an email also passes when it is
  part of an exact `publicIdentities` entry (`Name <email>`); that does not approve the identity itself, which the
  identity rule of history mode still checks. The configuration starts with `publicIdentities` holding the publication identity.
- **IP literals (`R-IP`, both scopes).** Every dotted IPv4 literal (four numbers up to 255) and every IPv6 literal (eight groups,
  or `::` for a run of zero groups, the last two groups perhaps as a dotted IPv4 tail) in a path name or text blob is refused:
  public, private, shared, link-local and unique-local alike. The passing classes are read as written: IPv4 `127.*`, `0.0.0.0` and
  the RFC 5737 documentation ranges (`192.0.2.*`, `198.51.100.*`, `203.0.113.*`), IPv6 `::1`, `::` and `2001:db8::/32`. An expanded
  form (the loopback address with all eight groups written out) and every IPv4-mapped form (the `ffff` group after the zero run, then an
  IPv4 address or two hex groups), loopback ones included, are not those classes. A dotted name of five or more numbers (an object identifier) or one with a number above 255 is not an address.
  Text next to a literal does not hide it: a `label:` before an IPv6 literal (`ip:<literal>`), an underscore, a dot after a name, a
  `\n`, `\r` or `\t` escape and a letter or underscore after an IPv4 literal all leave it refused. Only a letter or digit before an IPv4
  literal (a version tag such as `v1.2.3.4`) and a longer dotted number around it keep it from being read as one.
- **IP dispositions.** Any other literal passes only through an `ipDispositions` entry (`path`, `blob`, `line`, `context`,
  `sha256`, `reason`) that matches the occurrence on all of: the file's path, its blob id, its 1-based line, the three characters on
  each side of the literal with `<ip>` in its place (fewer at a line edge), and the SHA-256 of the literal as written (lower case).
  A path name never matches one. Editing a file changes its blob id, so its entries stop applying until they are reviewed again.
  The shipped entries are the 55 object-identifier tokens on line 5 of `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-7OGVXGZV.mjs`
  and the three loopback notations on line 161 of `http-mcp/test/oauth-loopback.test.mjs`.
- **Allow-list entries.** A lockfile or generated bundle gets no exemption: a host or email there passes only through a
  `scopedAllowances` entry (`path`, `rule`, `value`, `context`, `reason`) for that exact path, rule, lower-case value and context
  (`url`, `host-port`, `quoted`, `bare` or `email`). `public-gate.config.json` may also hold the values its own entries name. A
  malformed section, `ipDispositions` included, makes the run exit 2 with cause `invalid-config`. Findings carry the rule, kind (`path` or `content`),
  location and line, never the host or email.
- **File names (`R-ENV`, `R-HOSTING`).** A name is lower-cased and split on `.`; one trailing `example`, `sample` or `template`
  segment marks a template and is taken off, and the rest gets the same tests whether it was a template or not.
- **Env templates (`R-ENV`, both scopes).** Runs over every template with an `env` segment (`.env.example`,
  `.env.production.sample`, `prod.env.template`), line by line, each line trimmed. A template that is not readable
  text is refused whole. A commented assignment is read like any other, in every form (`#KEY=v`, `## KEY = v`, `# export KEY=v`,
  `#KEY: v`); other comments are prose and pass. Any other line that is not blank or `[export ]KEY=value` is refused. One pair of
  quotes around a value is taken off. Each public setting of `http-mcp/.env.example` may hold only its typed value, as
  `http-mcp/src/config.mjs` accepts it: a flag (`0`, `1`), one of its fixed choices, a whole number in its range
  (`DACS_ACCESS_TOKEN_TTL_SECONDS` 60 to 3600), an `http(s)` origin with no credentials, path or query (a `<label>` port
  counts), a comma-separated list of origins or host names, an absolute path or a label. Every other key, whatever its name
  (`DACS_OAUTH_COOKIE_KEYS` included), may only be empty or a placeholder: `REPLACE_ME`, `CHANGE_ME`, a run of `x`, `${NAME}`,
  `<label>` or `your-<label>-here`, where a label is lower-case letters and dashes.
- **Hosting files (`R-HOSTING`, both scopes).** Refuses by path, in any letter case: everything under a `deploy` directory, a
  Caddyfile (`caddyfile` as any name segment: `Caddyfile`, `Caddyfile.prod`, `Caddyfile.example`), a systemd unit (a `service`
  segment after the first, unless the name ends in a source extension such as `.mjs`: `dacs.service`, `dacs.service.bak`) and a
  real env file (an `env` segment after the first in a name that is not a template: `.env`, `.env.production`, `prod.env`, and on
  purpose `config.env.json`). Templates of hosting files are refused too; only env templates are left to `R-ENV`.
- **Archives (`R-ARCHIVE`, both scopes).** The gate must be able to read every blob. Refuses, whatever its name, a blob that is not
  readable text (a NUL byte or invalid UTF-8), even when a `binaryDispositions` entry lets the other rules read it; text holding a
  zip signature (`PK` with `01 02`, `03 04`, `05 06` or `07 08`) anywhere; and text with a tar header in any 512-byte block (its
  checksum field holds the block's sum), with or without `ustar`. Refuses any path under a `vendor` directory, in any letter case.
  It does not find an archive written in an encoding, such as base64, or one a script builds.
- **Root.** Both scopes read the history behind `--commit`, which must have exactly one root commit; a second root exits 2 (cause
  `unexpected-root`) without a report. Complete scope also requires that root to be `--expected-root`. A shallow clone is refused
  (cause `shallow-history`), because its cut-off history would hide a second root and part of the history.
- **Report.** JSON with exactly `scope`, `target` (`commit`, `tree`), `scanner` (`gateRevision`, `configSha256`,
  `scannerVersion`, `scannerPolicySha256`, `secretExceptionsSha256`; complete scope adds `expectedRoot` and `wordingListSha256`), `rules` (`id`, `status`: `passed`, `findings`, `not-run`,
  `unscannable`), `unscannable` (`location`, `cause`) and sorted `findings` (`rule`, `kind`, `location`, `line`). It holds
  only fixed words, object ids, digests and numbers; no field is derived from the private list, and the one wording-list field is a digest. Every location is
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

## Secret scan

`R-SECRET` runs the pinned gitleaks (`scanner.version` in the config, 8.30.1, the SDK's version) over the commit's exact blobs, in both scopes.

- **The binary.** `--gitleaks` names it and `--gitleaks-sha256` the SHA-256 of its bytes, which the install step records
  after `install-gitleaks.mjs` (the pin holds only the archive's SHA-256). The gate copies the binary into a private
  folder, checks the copy's SHA-256 and that it reports the pinned version, and runs only that copy, so a replacement after the
  check changes nothing. A missing file, another checksum or another version fails before anything is written
  (`scanner-missing`, `scanner-checksum-mismatch`, `scanner-version-mismatch`; exit 2).
- **Input.** The gate first lists, in memory, one neutral name for each entry whose bytes it read: `o<position>` (the
  entry's position in the listing), plus one suffix when its path matches one of the default rules that also test the
  path: `.php` for `freemius-secret-key`, `.tf` for `hashicorp-tf-password` (`.tf`, `.hcl`), `.yaml` for
  `kubernetes-secret-yaml` (`.yaml`, `.yml`), `.nuget.config` for `nuget-config-password` and `.p12` for `pkcs12-file`
  (`*.p12`, `*.pfx`, which tests the path alone and reports no line). Those path patterns never match the same path, the
  suffix is the only part of a path the scanner sees, and no default path skip matches a neutral name, so the scanner's
  path skips (lockfiles, `.gitleaks.toml` names, `node_modules`, images) cannot hide an entry and no file in the target is
  read as policy. In a fresh private folder each distinct blob is then written once, from the object reader (a symlink
  is its link text), and each name is a hard link to it in the scanned folder.
  The scanner also skips a file whose first read looks like an application type (PDF, bzip2, PostScript, ELF, tar at offset 257,
  ISO at offset 32769 and others), so every blob is written behind a one-line text header: 262 bytes, or 32774 for a blob
  that can reach offset 32769. No byte the target controls sits at a fixed offset the check reads. Lines are counted from the
  blob's own first line (the scanner's line minus the header's one).
- **Scanner run.** `gitleaks dir` with `--redact=100`, `--ignore-gitleaks-allow`, `--config .gitleaks.toml` (the default
  rules, never a target file) and a run-owned ignore file, under `secretScanDeadlineMs` and `secretScanOutputBytes`
  (`subprocess-timeout`, `subprocess-output-limit`; the process group is killed). Status 0 means no finding, 3 means findings, any
  other status is `scanner-failed`. The report file is at most `maxScanReportBytes` and `maxReportEntries` items, and must agree
  with the status (`scanner-report-malformed`, `limit:maxScanReportBytes`, `limit:maxReportEntries`).
- **Findings.** Each scanner result names one neutral name, so it maps to exactly one occurrence; the report names a
  location, rule and line only. A result for a name the scan did not write, a path rule on a name without its suffix, a
  line on the header, or line 0 from any rule but `pkcs12-file` is `scanner-report-malformed`. Results on one line of one
  occurrence (repeated, or from several rules) are one finding, so `R-SECRET` never has more findings than
  `maxReportEntries`.
- **Baseline.** `secretBaseline` holds the ten reviewed non-secret rulings of the imported tree (path, blob id, rule, line,
  reason). Each ruling, and each exception, is one exact line of the run-owned ignore, `<neutral name>:<rule>:<line + 1>`,
  for the one occurrence at its path and blob, so the scanner drops exactly that result; the same bytes at another path, a
  changed blob or a shifted line are not covered, and a `.gitleaksignore` in the target is never read. A ruling's line is at
  least 1, so no ruling covers a `pkcs12-file` result. The imported `.gitleaksignore` stays in the tree as the record of these rulings.
- **Exceptions.** `secretExceptions` is empty. An entry has exactly `path`, `blob`, `rule` (a scanner rule id), `line` and
  `reason` and exempts only that occurrence: the same value at another path, in another blob or on another line still fails.
  An entry naming a path and blob the target does not hold is stale and fails the run (`stale-secret-exception`, exit 2)
  before the scanner starts. Scanner fingerprints are never exception keys.
- **Identity.** `scannerPolicySha256` is the SHA-256 of `.gitleaks.toml`; `secretExceptionsSha256` is the SHA-256 of
  `JSON.stringify({ baseline: secretBaseline, exceptions: secretExceptions })` of the config.
- **History mode** runs the same scan over the whole history, see History mode below.

## Checking a saved report

```
node scripts/public-gate/check-report.mjs --report <file> --head <full-sha> --context <file> [--repo <dir> --refs <ref>[,<ref>...]]
```

Exit 0 only when the report is a complete passing report for exactly this head under the current review context (or a
passing history report, below); a saved
report is never trusted for what it says about itself. Exit 1 refuses a report; exit 2 means a file or an argument is
missing, over 1 MiB, or malformed (a report is malformed unless it has the report shape above, nested fields included). Nothing is written on exit 0; otherwise stderr holds one cause and its fixed text.

- **Review context.** A JSON file in our records with exactly `gateRevision` and `configSha256` (the current reviewed
  gate's identity), `scannerVersion`, `scannerPolicySha256` and `secretExceptionsSha256` (the scanner pin, the SHA-256 of
  `.gitleaks.toml` and the SHA-256 of the baseline and exception entries, see Secret scan), `expectedRoot` (the root
  commit) and `wordingListSha256` (the SHA-256 of the wording list). Every expected value comes from it, from `--head` or from this gate's registered rule ids, never from the
  report. The report's `scanner` must equal the context's seven fields exactly, so a field the context does not name
  refuses the report until the context names it.
- **History reports.** A report of scope `history` also needs `--repo` and `--refs`, the run being checked: the refs are
  resolved now, as history mode resolves them, and the report must name exactly those refs (full ref names, object ids, tag
  objects and peeled commits, see History mode), so a ref moved or an annotated tag made again since the scan refuses the
  report. The report's `heads` must be exactly the distinct, sorted commits of those refs, and `--head` one of them; every rule including `R-IDENTITY` must be `passed` (so the scan ran with
  `--allowed-identity`), and the report's `scanner` must equal the context's seven fields, so a report made with `--pr-text` is
  refused. A tag ref whose name differs from its tag object's is refused with exit 2 as in history mode.
- **Causes.** `report-not-complete` (scope is neither `complete` nor `history`), `report-other-head` (target commit is not `--head`; for a
  history report, `--head` is not among its heads), `report-refs-differ` (a history report's refs or heads are not those of the run being
  checked), `report-rules-differ` (the rule ids are not exactly the registered ones, `R-IDENTITY` added for a history report),
  `report-policy-differs` (the scanner identity
  differs from the context), `report-not-passing` (a finding, an unscannable entry or a rule not `passed`). The exit 2
  causes are `report-unreadable`, `report-malformed`, `context-unreadable`, `context-malformed`, `limit:maxCheckFileBytes`
  `bad-arguments`, and, for a history report, `bad-ref` (a `--refs` item that is neither a ref name nor a full object id)
  and the other causes of History mode.
- **Not bound yet.** The report carries no digest of the private list (nothing in it derives from that list), so a
  corrected private list is not detected by this command. A report made under another wording list is refused as `report-policy-differs`.

## History mode

```
node scripts/public-gate/history.mjs --repo <dir> --refs <ref>[,<ref>...] --private-list <file> --wording-list <file> --expected-root <full-sha> \
  --gitleaks <file> --gitleaks-sha256 <hex> [--allowed-identity 'Name <email>'] [--pr-text <file.json>] [--out <file>]
```

Walks every commit reachable from the refs (names or full object ids, comma-separated; any other revision expression, such
as `main^{commit}` or an abbreviated id, exits 2 as `bad-ref`), parents first, and reports under
scope `history`. Each commit's tree gets the same reading and the same eleven rules as in complete scope (`R-ACCOUNT`,
`R-ARCHIVE`, `R-ENV`, `R-EVAL`, `R-HOST`, `R-HOSTING`, `R-IP`, `R-ISSUE`, `R-PRIVATE`, `R-REPORT` and `R-WORDING`), each occurrence judged by its own path,
and once over the union of its trees the stale checks for `lockfileDispositions` and `evalGeneratedFiles`, so a file, address or archive that an earlier commit
held and a later one removed is found. Reading, limits, exit codes and output rules are those above; `--out` never
overwrites a file, and there is no `--private-evidence`.

- **Root.** The walk must have exactly one root commit, `--expected-root`; any other root exits 2.
- **Commits.** `R-PRIVATE` also scans each commit's message (kind `message`, with the line), its author and committer lines
  (kinds `author` and `committer`) and its other headers (kind `header`). A commit finding's location is `<commit>:<field>`,
  the field (`author`, `committer`, `header` or `message`) it was found in. `R-ACCOUNT` scans the same fields for an email
  that `refusedMetadataEmails` refuses, `R-HOST` for a host that `refusedMetadataHosts` refuses (read as in non-code text) and
  `R-IP` for an IP literal that `refusedMetadataIps` refuses (kinds `author`, `committer`, `header` and `message`, the last with
  the line). Metadata has no path or blob, so only `allowedHosts` and the permitted address classes pass there: no
  `scopedAllowances` or `ipDispositions` entry applies.
- **Tags.** A ref that names an annotated tag is read through its tag object, and through the tag objects it names in turn (at
  most 16 in a chain, then exit 2 with `limit:maxTagChain`), down to the commit. Each tag object gets the checks of a commit
  object: its tag name and other headers (kind `header`), tagger line (kind `tagger`) and message (kind `message`, with the line)
  are scanned by `R-PRIVATE`, `R-ACCOUNT`, `R-HOST` and `R-IP`, and the finding's location is `<tag object>:<field>`, the
  tag object's id in the place of a commit's. `target.commits` counts commits only.
- **Ref names.** Every selected ref's name is public content: as written in `--refs` and in full (`refs/heads/...`, `refs/tags/...`),
  it is read by `R-PRIVATE` with the matcher used for content, and a match is a finding of kind `ref` located at `ref-<n>`, the
  ref's 1-based place in `target.refs`. A selected `refs/tags/<name>` that names an annotated tag whose own `tag` header is not
  `<name>` exits 2 with `tag-name-mismatch`: the name under which the tag would be published must be the one that was read.
- **Identity.** With `--allowed-identity`, `R-IDENTITY` finds every author or committer line that is not exactly that
  identity or an exact `publicIdentities` entry (kind `author` or `committer`), every tagger line of a tag object that is not
  one of them or is missing (kind `tagger`), every `Co-authored-by:` or `Signed-off-by:` trailer whose `Name <email>` is not one
  of them (kind `message`, with the line) and every time zone other than `+0000` (kind `timezone`). A trailer is read the way git
  and a code host read it: any case, blanks before the token and before the colon, and a CR, VT, FF, NEL, U+2028 or U+2029 ends
  its identity as a line break does, so a CRLF message keeps its trailers checked. Without the flag the rule is
  `not-run`. A contributor's identity is added to `publicIdentities` in their first pull request.
- **Secret scan.** `R-SECRET` runs the pinned gitleaks as in Secret scan, once over the whole history, with `--gitleaks` and
  `--gitleaks-sha256` as in the gate. Every distinct (path, mode, blob) of every commit's tree is one occurrence, written once under a
  neutral name `o<number>` (the blob's bytes are stored once), so a file `entry` and a later `entry/child.txt` never share a path and no
  occurrence is dropped or overwritten. Each commit object and tag object is one more neutral file. A finding in a tree is located at the
  first commit that holds the occurrence, by its position in that commit's listing, with the line; a finding in an object is located
  by `<commit>:<field>` (`author`, `committer`, `tagger`, `header` or `message`, the last with its line). Exceptions and the baseline
  apply per occurrence, by path and blob as in Secret scan. `maxHistoryOccurrences` bounds the distinct occurrences and
  `maxTotalBlobBytes` the bytes of the distinct blobs; past either the run exits 2 naming the limit.
- **Pull-request text.** `--pr-text` is a JSON array of objects. `R-PRIVATE` scans every string in them, keys and values, at any
  depth, and every repeat of a key (kind `pr-text`, location `pr-<n>:<m>`: the n-th object, and the m-th string in it in
  the file's order, both from 1, with the line). Keys are never printed. Anything else in the file exits 2.
- **Report.** The same closed schema as above: fixed words, object ids, digests and positive numbers, nothing derived from
  the list. `target` is `heads` (the object ids of the commits the refs name, sorted), `refs` and `commits` (how many were read). `refs` has one
  `{ ref, object, commit }` for each distinct selection, sorted: the full ref name (`null` when the item was an object id,
  and `withheld` for a name that holds a list entry), the object id the ref points to (the tag object for an annotated tag, not
  the commit) and the commit it peels to, so two tags on one commit give two different reports. Each finding and
  each `unscannable` item also holds its `commit`, except findings of `--pr-text`. `scanner` holds `gateRevision`,
  `configSha256`, the scanner identity of Secret scan (`scannerVersion`, `scannerPolicySha256`, `secretExceptionsSha256`) and
  `expectedRoot`, and adds `prTextSha256` when the file is given.

## Bounded downloads, subprocesses and the gitleaks installer

Library code and an installer. The secret scan runs the scanner through `run-bounded.mjs`; the gate workflow below runs the installer.

- **`fetch-bounded.mjs`.** Downloads one https address to a new file and checks its SHA-256. The byte cap and the total deadline
  (redirects included) are enforced while the body streams, before the checksum; a `Content-Length` over the cap is refused first.
  Redirects are followed by hand, https only, at most 5. A reply that arrives after the download ended is discarded and released.
  Every failure after the file exists removes it, with its own cause (`download-too-large`, `-timeout`, `-http-failure`, `-truncated`,
  `-checksum-mismatch`, `-redirect-refused`, `-too-many-redirects`, `-destination-exists`, `-failed`, or `interrupted`).
- **`run-bounded.mjs`.** Runs a command in its own process group under a deadline and an output cap. Past either, or on an abort, it
  stops collecting output, sends SIGTERM to the group and SIGKILL after 2 s, and rejects once with `subprocess-timeout`,
  `subprocess-output-limit` or `interrupted` after the child has exited. A child that exits on its own resolves with its status.
- **`install-gitleaks.mjs --dir <folder>`.** Installs gitleaks 8.30.1 (linux x64, URL and SHA-256 in `GITLEAKS_PIN`) as
  `<folder>/gitleaks`: only a matching archive is extracted, only its `gitleaks` file, which must be a regular file reporting the
  pinned version. An existing binary is refused (`install-exists`), never trusted. Exit 0 installed, 2 refused with one cause line.

## The gate workflow

`.github/workflows/public-gate.yml` defines one job, `public-gate`, on every pull request and push (no path or branch filter).
It has read-only `contents`, reads no secret, never uses `pull_request_target`, and pins every action by commit SHA. It checks
out the pull request's head commit (the pushed commit on a push) with full history and no stored credentials, then runs in
order, a failed step failing the job and skipping the rest:

1. `npm ci` at the root;
2. `install-gitleaks.mjs` into the run's temporary folder;
3. `npm run gate:generic` on the head commit, with the installed binary and its SHA-256 computed on the runner, writing the report to `gate-report/report.json`;
4. `npm test`, with `GITLEAKS_BIN` naming the installed binary so the real-scanner tests run;
5. the upload of that report as the artifact `public-gate-report`, which runs even when an earlier step failed and replaces
   the report of an earlier attempt when the job is re-run.

The job runs the generic scope, so `R-PRIVATE` is `not-run` and its pass is never a complete pass. Actions runs it only once the
repository is public; until then the same commands are run by hand.
