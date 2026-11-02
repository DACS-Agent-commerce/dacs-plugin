# Public text report service v1

`src/devnet-demo/services/public-text-report.mjs` exports the synchronous, pure
`producePublicTextReport(input)` function. This module supplies a producer and a
contract only. There is no operator, composition, MCP tool or Listing wiring;
the service has no enabled runtime path and changes no config or default.

The caller must already have admitted the buyer's own **public** text. This
module cannot determine whether text is public or contains customer data.
Future request admission and purchase review must enforce that scope before
agreement or payment. The input and its extracts are intended for public
delivery, never private or customer material.

## Input and result

Input is a primitive string of 1–4096 ASCII bytes: printable characters
(`0x20`–`0x7e`), tab, CR and LF only, containing at least one ASCII word.
Non-ASCII text, other controls, empty/wordless text, coercible objects and
oversized input throw `TypeError` with code `public-text-input`. Nothing is
coerced, fetched or silently shortened. No input normalization precedes hashing.

The exact result keys, in insertion order, are `serviceId`, `serviceVersion`,
`inputHash`, `outputHash`, `mediaType`, `text`:

- `serviceId`: `dacs-public-text-report`; `serviceVersion`: `1`.
- `inputHash`: lowercase SHA-256 hex of the exact input UTF-8 bytes, including
  whitespace and line endings.
- `outputHash`: lowercase SHA-256 hex of the exact returned report UTF-8 bytes,
  including its final LF. This hashes the text, not the result object or a DACS
  Deliverable envelope. The later Deliverable still needs its own `contentHash`.
- `mediaType`: `text/plain; charset=utf-8`; `text`: the report. It includes the
  service id/version and input hash, so the current Deliverable producer can
  preserve the request identity even though it only copies `mediaType` and `text`.

## Computation

The report contains character, word and sentence counts, a rough English reading
grade, up to five frequent terms, the complete longest sentence and an extractive
summary of up to two complete sentences.

- Characters count the original bytes, including whitespace. ASCII makes byte
  count equal to JavaScript string length.
- Words match `[A-Za-z]+(?:'[A-Za-z]+)?`. Digits, hyphens, underscores and other
  punctuation separate words; one internal ASCII apostrophe stays in a word.
- Sentences end at each run of `.`, `!` or `?`, or at end of input. Wordless
  fragments are omitted. Abbreviations and decimal points get no special handling.
  In extracts, space/tab/CR/LF runs become one space and outer spaces are removed.
- Terms are lowercase ASCII words excluding this fixed list:
  `a an and are as at be been but by for from had has have he her his i in is it
  its not of on or our she that the their them they this to was we were will
  with you your`. Sort by descending count, then ascending ASCII term order.
- The rough ARI grade is `ceil(4.71 * letters / words + 0.5 * words / sentences
  - 21.43)`, clamped to 1–18. Letters exclude apostrophes; digits are not counted.
  BigInt integer fractions implement the ceiling exactly. This is a heuristic,
  not a validated reading assessment or a measure of text quality.
- Longest sentence uses normalized character length including punctuation;
  equal lengths choose the earliest sentence.
- Each sentence's summary score sums the whole-input frequency of its non-stop
  words, including repetitions. Choose the highest two scores, breaking ties by
  original sentence index, then emit those sentences in original input order.
  If all words are stop words, this selects the first two sentences.

The top-five and top-two selection are explicit report features. Selected
sentences and terms are never clipped to fit a budget.

## Storage and determinism

`JSON.stringify({mediaType,text})` must fit in **4096 UTF-8 bytes**, counting JSON
escaping and the content keys. Otherwise the function throws `TypeError` with
code `public-text-output`; it returns no partial report. An input can fit the
input limit yet produce an oversized report, especially one very long sentence.

Every returned text is ASCII and below the existing 16,384-character purchased
report bound (`src/devnet-demo/deliverable.mjs`). Its serialized content uses at
most 4 KiB of the wallet's 24 KiB ASCII storage budget
(`public/portal/embedded-wallet/sdk-provider.mjs`, `anchorJson` and
`devnetAgreementAnchorPlan`; also `src/dacs/demos-sr2-wallet-bridge.mjs`). It leaves
20 KiB for the Deliverable envelope. Future wiring must still admit the complete
envelope and its independently supplied metadata before signing; this pure
function cannot bound arbitrary job, Listing or settlement metadata.

Version 1 fixes all tokenization, stop words, ranking, rounding, line labels,
field order and LF endings. There is no locale comparison or floating-point
formatting. Same exact input produces the same text, result and hashes after
restart, independent of timezone and locale. Changing these rules or serialized
bytes requires a new service version and updated golden tests.

The module only imports SHA-256 from `node:crypto`. It never reads a clock,
uses randomness, consults a locale, fetches URLs, executes input, calls a model,
uses credentials, accesses wallets or chains, reads files or persists data.
URLs and instruction-like input are ordinary text.
