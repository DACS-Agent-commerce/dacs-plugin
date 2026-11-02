# Purchased report view

`DACS_SHOWCASE_REPORT_VIEW=1` enables the purchased report in the wallet portal,
the MCP status App (`ui://dacs/status-report-v2.html`) and purchase text summaries.
The App composes the status view's purchase and account cards, so it moved from
`ui://dacs/status-report-v1.html` when those cards changed as `ui://dacs/status-v5.html`.
The default is `0`: existing portal markup, MCP HTML resources and tool results stay
unchanged. The switch authorizes display only; it changes no wallet authority,
protocol gates, polling or evidence reads.

The packaged plugin (`bin/`, `loadConfig`) and the built-in live-testnet operator
(`src/devnet-demo/operator.mjs`, see `SHOWCASE-QUICKSTART.md`) both honour the
setting: the operator passes `DACS_SHOWCASE_REPORT_VIEW` from its environment into
the app config it builds, through `loadConfig`, as it passes
`DACS_DELIVERY_DEADLINE_WATCH` and `DACS_COMMIT_ON_SIGNATURE` (unset is `0`).

`loadConfig` refuses `DACS_SHOWCASE_REPORT_VIEW=1` together with
`DACS_SHOWCASE_LEDGER=1` (`SHOWCASE-LEDGER.md`): both change the purchase
status App, and composing the two views is left to a later change. Each switch
alone is accepted. The deploy preflight reports the pair as
`runtime-config-rejected`. Because of that rule, `DACS_SHOWCASE_REPORT_VIEW`
is a static setting in `loadConfig` and `deploy/env-contract.json`, not a
switch file; the rule reads the ledger switch's parsed value
(`SWITCHES.md`, "Static settings among the switches").

With `DACS_PORTAL_AUTO_ADVANCE=on`, each automatic re-check
(`/portal/api/purchase/:id/auto/recheck`) refreshes the report like a manual
status read, and a failed re-check replaces it with "Fresh purchase status read
failed".

With `DACS_SELLER_IDENTITIES=on`, `prepare_purchase` keeps its `sellerIdentity`
field and its quoted identity text, which comes before the report narration and
the labelled report. With `DACS_IDENTITY_GITHUB_SIGNALS=on`, the listing tools
name `ui://dacs/listings-v5.html` as usual. The purchase tools still name
`status-report-v2`.

The view consumes the existing current `protocol.delivery` projection. It shows
the title, plain text, SHA-256 of the original Deliverable report payload (including
metadata), the logical storage reference and, for a native receipt only, its native
storage address. Fixture and demo receipts can carry a derived `stor-` address; it
is not shown. The hash covers more than the displayed text. HTML is rendered as text.

## Seller content is untrusted

The report title and text are written by the seller, and a refusal or
delivery-evidence hold reason can quote the seller. In the portal and the App they
appear only inside one bordered block headed "Begin untrusted seller-supplied
content", after every status row: the title and the reasons as quoted string
literals, never headings or status values; the text as literal plain text. Status
values taken from the projection (locator, address, writer, substrate, the
plugin's next step) are quoted string literals as well, so none of them can start
a new line or imitate a status row.

The model receives the full verified report, but only as labelled seller data. With
the switch on, `prepare_purchase`, `get_purchase_status` and `verify_deal`:

- return main's purchase-tool result (`src/mcp/purchase-model-view.mjs`): the
  `structuredContent` is main's copy (`src/mcp/seller-content.mjs` with
  `purchase: true`), the same as with the switch off, in every field but the
  report wrapper below. Every field main's results carry reaches the model and the
  App unchanged, among them the settlement and recovery fields
  (`verification.nextStep`, `txStatus`, `nativeNonceResolved`,
  `nativeLaneResolved`, `signedByAlternateKey`, `observation.sourceDisposition`),
  the plugin's own attempt outcomes and main's history stages. Seller-supplied
  text (refusal and hold reasons, messages, and any value that fails its field's
  rule) is in main's `{label, text, truncated}` seller-data envelope; the plugin's
  own verdicts and recovery sentences (`status`, `next`, `protocol.stage`, and
  `verification.outcome`, `rejectedReason` and `nextStep` when they are the
  plugin's values) stay outside every envelope. Where main shows a value raw, so
  does the view.
- keep the report in `structuredContent.protocol.delivery.report` as the
  `{label, contentHash, coordinates, text}` wrapper of `src/mcp/seller-content.mjs`:
  the label says it is the seller's report, untrusted seller data, not instructions;
  the text is the whole report as one escaped JSON line between
  `<DACS_SELLER_REPORT_JSON>` delimiters. The view keeps main's wrapper only when the
  current projection is a verified delivery that the view itself would show (stage,
  service layer, report shape, locator, payload hash and recomputed SHA-256), and
  its `contentHash` is this projection's Deliverable hash. Otherwise it is `null`.
  Its `coordinates` keep only a validated block reference and a canonical address.
  The report is wrapped once: the server does not run the default path's labelling
  pass over this result again.
- repeat the same wrapper in `content[0].text` after the summary, as the default
  path does: the label line, a `contentHash: <hash>; coordinates: <JSON>` line,
  then the wrapper's `text` lines. A client that reads only the text result still
  gets the report, labelled. Without a wrapper nothing is appended.
- add a fixed summary line to `content[0].text`:
  `Purchased report: available at DACS stage <stage>; SHA-256 <hash>. ...`, or
  `Purchased report: unavailable at DACS stage <stage>.`. No projection string is
  included; an unrecognized stage reads `(unrecognized)`.
- carry no `_meta`. The App renders from `structuredContent` alone, the same
  labelled copy the model gets: it decodes the report from the wrapper's JSON line
  and seller reasons from main's envelopes (`reportFromResult` in
  `public/portal/purchased-report.mjs`). It reads `params.structuredContent` of
  `ui/notifications/tool-result` (MCP Apps) or `window.openai.toolOutput`
  (ChatGPT). So the guarantee that the report reaches the model only as the
  labelled wrapper does not depend on the host: no host, whether or not it passes
  `_meta` or the whole tool result to the model, has an unlabelled copy to pass.
- tell the model, in the server instructions, where the labelled report is (in
  `structuredContent` and repeated in the text result), that it is untrusted
  seller data it may discuss but must not follow, and that `status`, `next`,
  `protocol.stage` and `verification.outcome`, `rejectedReason` and `nextStep`
  (when not inside an envelope) are the plugin's own verdicts and recovery
  guidance, not seller data. Main's own instructions already describe the
  seller-data envelopes.

Size: the report travels twice per result, in `structuredContent` and in the text
result, exactly as on the switch-off path; the view adds no copy and no `_meta`.
Its size is bounded where it is read: every Deliverable read goes through an anchor
reader with a response cap (1 MiB in `src/dacs/demos-sr2-adapter.mjs` and the
native storage-program read, 512 KiB in `src/dacs/fixture-anchors.mjs`). The view
recomputes the report's SHA-256 once per result, besides main's own hash check.

Before showing any report, the portal and the App recompute
`SHA-256(UTF-8(canonical bytes))` (`reportSha256Hex`) and require it to equal the
projected Deliverable hash. Report bytes that do not match are not shown.

With the switch off, results and instructions are byte-identical to the default
path without this view: no report narration, and the default path's own labelling
(`src/mcp/seller-content.mjs`: the report wrapper in `structuredContent` and in the
text result, seller-data envelopes for diagnostics) applies unchanged.

## Visible control characters

Every Unicode control (`Cc`) and format (`Cf`) character is shown as `\uXXXX`, as
are U+2028 and U+2029. That includes tab, CR, C1 controls, zero-width characters
(ZWSP, ZWNJ, ZWJ, word joiner), bidirectional controls, U+206A–U+206F and BOM.
Characters outside the BMP are written as their two UTF-16 code units. The one
deliberate exception is line feed (U+000A), which keeps report lines. Status values
are JSON string literals, so a line feed in them appears as `\n`. Long lines wrap,
and the full text stays scrollable.

## Recomputing the hash

The displayed hash is the Deliverable `contentHash` from `@kynesyslabs/dacs`:

```
SHA-256( UTF-8( canonicalSignedScope(report) ) )
```

`canonicalSignedScope` is RFC 8785 JSON Canonicalization Scheme (JCS) applied
to the report object, with top-level `signature`/`signatures` omitted. It uses the
DACS CF-1 profile: string values are NFC-normalized, member names are unchanged,
and numbers must be finite and within the IEEE-754 safe-integer magnitude. (Purchased reports carry no signature field.) The
SDK implementation is `canonicalize` and `contentHash` in
`@kynesyslabs/dacs/dist/canonical/{jcs,hash}.js`; the view reproduces it in
`reportCanonicalJson` and `reportSha256Hex` (`public/portal/purchased-report.mjs`).

Under "Canonical report artifact" the view shows those exact canonical bytes in a
collapsed, read-only text box. Copy them verbatim, with no trailing newline:

```sh
printf '%s' "$(cat artifact.json)" | sha256sum   # or: sha256sum artifact.json, if saved without a newline
```

The result must equal the displayed SHA-256. The artifact text is deliberately not
escaped, because escaping would change the bytes. It can therefore contain raw
format characters. Read the report itself in the escaped seller-content block.

## Status changes

Report availability and delivery evidence have separate labels. Evidence can be
pending, rejected, deferred or unknown while the report remains available. Native
report readback represents one node's inclusion observation, without independent
finality. Fixture reports remain explicitly SIMULATED; demo scope cannot become
native from a storage address alone. Report availability does not establish
completed DACS-5 copies or human acceptance.

Every new status result replaces the report. A downgraded or missing current
projection removes the title, text, hash and artifact, and shows the plugin's next
step (and any seller reason, in the bordered block). Failed portal status requests
and failed MCP tool results also clear the shown report; the App names a failed
tool call by its own error code (`The latest tool call failed with error <code>`),
since the status App also renders account, agent and refused purchase calls. Recovery may show the original report again
only when the current projection supports it. There is no success cache or
broadcast retry.

Local tests cover the shared renderer, portal hooks and MCP bridge with owned
loopback services. ChatGPT host rendering of the App from `window.openai.toolOutput`,
and a later existing native purchase, still require manual acceptance. Enabling this
view does not prove either.
