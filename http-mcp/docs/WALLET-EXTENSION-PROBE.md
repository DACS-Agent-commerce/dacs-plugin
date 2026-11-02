# Demos Wallet extension probes (sign only)

Set `DACS_WALLET_EXTENSION_PROBE=1` and
`DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT=<existing linked account id>`, then
restart the plugin. The account service identifies wallet ownership through
`walletOwner(address)`; this plugin has no global operator role. The explicit
account setting selects the operator without granting access to every linked
account. Sign in through the existing wallet-login OAuth flow, then open
`<plugin origin>/portal/wallet-extension-probe` in the same browser session.
The built-in issuer's signed session cookie authenticates the page, its module
loads and its account reads. Resource access tokens can also authenticate
single requests with an Authorization bearer header using the existing MCP
verifier (including issuer, audience and expiry checks); an invalid bearer
never falls back to a cookie. A browser cannot load the probe that way: the
page's module and fetch subrequests never carry a bearer header.

**Built-in sign-in only.** With `DACS_AUTH_MODE=external` there is no browser
session, so the probe cannot work. In that mode the enabled switch mounts the
same empty router as switch-off, so every request gets exactly the switch-off
response: the probe paths (page, assets and account read) answer 404 with
`{"error":"not_found"}` without any authentication or chain read, for every
caller including the verified owner, and no probe content is served. Raw paths
with dot segments under `/portal/assets/` (for example
`/portal/assets/../wallet-extension-probe/assets/main.mjs`) never reach a probe
route: the existing portal asset handler refuses them with its 403, as on
`main` and with the switch off. Nothing in the portal, `/health` or the MCP
tools lists or links to the probe in either mode. To run the probes, use a
deployment with the built-in issuer. An enabled switch under an external issuer
logs `wallet_extension_probe_requires_builtin_sign_in` once at startup; requests
do not disclose the misconfiguration.

The switch defaults to `0`. Disabled probes, unset/unknown owner accounts,
anonymous requests, invalid credentials and authenticated non-owners all get
404 with `{"error":"not_found"}`, including an enabled probe under an external
issuer. The nonce read endpoint has the same owner gate. Existing portal bytes and extension purchase holds remain unchanged.
No MCP tool or purchase action enables these probes. With built-in sign-in, a
refused request also gets the switch-off headers: the session lookup can add a
`Set-Cookie` that clears a stale session cookie, and the refusal removes it.
The portal mounts the probe router under `/portal/wallet-extension-probe` in
every mode, so requests for any other path, including the dot-segment spellings
under `/portal/assets/`, never enter it and take the same route as on `main`,
with the switch on or off.

Use a fresh key created only for this probe and used nowhere else, holding at
most 10 testnet DEM (see the residual risk and the condition of use below). Create,
import and unlock it inside the extension only. The probe asks for a
transaction signature only once nonce 1 is already used, so first send one
ordinary testnet transaction from the key in the extension and wait until it is
included.
Record the installed extension version/build alongside the copied report.
Before connect or any signature request, independently establish the
extension's RPC endpoint and verify testnet identity, or route it to an
owner-controlled loopback fixture. Its signing paths may perform RPC reads.
This page cannot establish network identity or enforce the extension's routing.
If routing is unknown, stop at discovery/account reads.

| Probe | Owner action | Meaning |
| --- | --- | --- |
| P1 | Discover/read accounts with extension absent, locked, unlocked, site access enabled and disabled. Recheck after a late injection. Inspect the installed manifest separately. | `present` means an announcement was observed; `not-observed` is timing/site-access evidence, not proof of unsupported API. Account results distinguish locked (401), absent (404), readable (200), malformed or timed-out. Source 0.3.0 has an `accounts`/`account` dispatch discrepancy. |
| P2 | Connect; deny once, then approve. Repeat after reload and on a second owner-controlled origin. On that second origin, use the pre-connect sign button and deny the prompt. | Approval yields a normalized public address. A denial/error is recorded. Inspect the requesting origin and use the observation control. Connect success does not establish persistent site permissions. A pre-connect signature is always unverified because there is no connected account. |
| P3 | Connect, then sign each of the three displayed vectors separately. | `ok: true` requires local Ed25519 verification over the exact UTF-8 bytes against the connected address. The ASCII separator uses a fixed zero hash; the challenge is deliberately expired with a probe-only purpose; the third vector is Unicode. Prefix, prehash, algorithm, envelope or account mismatch fails. An unsupported browser verifier also fails closed. |
| P4 | Click the confirmation (a fresh key created only for this probe and used nowhere else, at most 10 testnet DEM) and sign the fixed one-OS self-transfer with the already-used nonce 1. The connected wallet must belong to the configured owner, have current nonce at least 1 and hold at most 10 DEM, and the extension must still report it as the active account. | Only the exact fixed probe native envelope is passed to `signTransaction`. Every field difference is reported. Verified SDK edits and fee replacements in one SDK fork format are counted separately from unexpected differences, including denomination, recipient or nonce changes. A pre-fork SDK wallet cannot represent one OS and signs amount 0; that reads as an unexpected denomination rewrite (`amountChanged`). |
| P5 | With the same explicit confirmation, sign the bounded ASCII storage CREATE. Inspect its popup alongside the hash, field diffs and verification result. | Uses current program naming, derived address, artifact hashes/metadata and source fields. The artifact is an unsigned synthetic test Agreement, not a valid purchase Agreement; network/identity are explicitly synthetic and unbound. No embedded wrapper is passed to the extension. Rejection is compatibility evidence, not a reason to use a send method. |
| P8 | Connect from its button and observe which approval window opens. Request raw `openpopup` once; record approval window, toolbar popup, nothing observed, or origin match/mismatch. Separately check ChatGPT's existing “Open wallet approval” link opens the portal. | UI observations are owner-reported, never automatically inferred. `openpopup` has no demonstrated handler in the analyzed source. This page does not test actual MCP iframe injection (P7). |

For P4/P5, `hashValid` checks SHA-256 of the exact returned JSON content;
`hashMatchesRequested` checks the requested content hash, including property
order. `signatureValid` checks Ed25519 over the ASCII hex returned hash against
the connected address. `ok` additionally requires no field diffs and an exact
signature/envelope shape. A valid signature over a changed transaction still
fails. The adapter allowlists the complete unsigned native/self-transfer or
fixed storage CREATE fixture, including all content/data fields, fees and
outer-envelope fields, before invoking the provider. Identity, token and
arbitrary storage requests are refused.

**An honest wallet also gets `ok: false`.** The bundled Demos SDK's `sign()`
always sets `content.gcr_edits`, adds `content.from_ed25519_address` (the
signing key) when it is absent, and replaces the `transaction_fee` values with
its node's fee quote (or, without one, its own fee from its edits). It then
serializes the whole content in one fork format: **pre-fork**, amounts and fees
are DEM numbers; **post-fork**, they are decimal OS strings, including `"0"`.
The returned hash therefore differs from the requested one too. Each P4/P5
result carries a `diffSummary` that separates these from real findings. It
checks one complete, consistent serialization profile per fork format and
reports the one that fits best as `sdkProfile`:

- Pre-fork: `network_fee` and `rpc_fee` are non-negative numbers,
  `additional_fee` is `0`, and every amount is the requested amount in whole
  DEM. P4's one OS has no pre-fork form: the SDK signs amount `0` and
  zero-amount transfer edits. That is a denomination rewrite, so pre-fork P4
  is never SDK-expected.
- Post-fork: `network_fee` and `rpc_fee` are canonical OS strings,
  `additional_fee` is `"0"`, and every amount is an OS string. P5's amount `0`
  becomes exactly `"0"`; P4's `"1"` stays `"1"`.

Every field the SDK writes (amount, the three fees, `gcr_edits` and
`from_ed25519_address`) must be in the chosen profile's form, whether or not it
differs from the request. A field left unconverted, or one profile's form mixed
with the other's, counts as unexpected. `unexpected` counts unexplained
differences plus such missing or mixed SDK fields. The fee values themselves
come from the wallet's node; they are not shown or bounded beyond the 10 DEM
balance cap.

- `sdk-expected-only`: only verified SDK changes, all in one profile
  (`gcr_edits` added with the exact ordered native/storage edit structure for
  the requested fixture, `from_ed25519_address` added as the connected key,
  fee values replaced, and post-fork P5's `"0"` amount). Nonce, recipient and
  signer are unchanged; this is not a nonce rewrite. State edits must have the
  SDK's exact keys, operations, rollback flags and edit count/order: native
  debit and credit of the requested amount, the fixed one-DEM gas debit, and a
  nonce increment of 1; storage adds a one-DEM storage debit and the exact
  CREATE target, sender, fixture and metadata. The one-DEM storage debit is
  right only because this fixture is below the SDK's 10 KiB storage pricing
  chunk; it is not a general storage price. Every edit account, the storage
  sender and `from_ed25519_address` must be exactly the connected canonical
  address (`0x` and lowercase hex), as the SDK emits it; an alias of the same
  key counts as unexpected. Anything else in `gcr_edits` counts as unexpected.
- `nonce-recipient-or-signer-changed`: `nonceChanged`, `recipientChanged`
  (`to`, the native recipient argument or the storage address) or
  `signerChanged` (`from`, or a `from_ed25519_address` that is a different
  key) is true. Replacing or removing an ancestor of those fields also raises
  the affected flags. No honest signer does this.
- `other-unexpected-diffs`: anything else, such as a changed amount, an unknown
  added field, a malformed fee or a mix of pre-fork and post-fork forms.
  `amountChanged` is true when the amount or the native amount argument is not
  what the matched profile expects: a changed value (as in pre-fork P4, which
  signs amount 0) or the same value in a changed format (as in pre-fork P5
  signing `"0"` instead of `0`). The page explains the SDK's denomination
  rewrite only for a pre-fork P4 answer.
- `no-field-diffs`: nothing changed.

The page prints the matching sentence before the JSON result.

Every transaction request uses nonce **1**, independent of its timestamp. The
page only asks the wallet to sign once nonce 1 is already used.

These checks run **before** the provider is asked. Immediately before each
transaction signing request, the adapter reads the connected account through
the owner-only same-origin endpoint. That endpoint uses the configured chain's
existing read-only `getAddressNonce` and `getAddressInfo` (balance in OS, per
`DACS_DEM_AMOUNT_ENCODING`) clients and requires the wallet to belong to the
owner account. The adapter refuses P4/P5 unless:

- the current nonce is a safe integer of at least 1 (so the requested nonce 1
  is already used); unavailable, malformed, negative, fractional or overflowing
  results refuse signing;
- the balance is an exact OS integer of at most `PROBE_MAX_BALANCE_OS`,
  10,000,000,000 OS (10 DEM). That cap marks a throwaway account: it covers the
  fees of the transaction that used nonce 1 plus a few more;
- the extension's `accounts` read, made right after the chain read and right
  before `signTransaction`, returns code 200 with the connected address. The
  SDK's `sign()` signs as the extension's active account, so a switch since
  connect would otherwise sign with an account whose nonce and balance were
  never read. Locked, absent, malformed or failed reads also refuse.

P4 additionally sends the smallest amount (one OS) to itself. P5 derives its
storage address from the same nonce 1. Nothing reserves or consumes a nonce.
One probe runs at a time: the adapter takes its session reservation before its
first `await` and holds it through both reads, the signing request and
signature verification, so a second call is refused rather than racing to the
wallet.

Before P4 or P5 the page needs an explicit click on a confirmation stating the
condition for running them: the routing was verified independently, and the
connected account is a fresh key created only for this probe and used nowhere
else, holding at most 10 testnet DEM.

**Residual risk (not prevented).** The page cannot constrain the extension's
internals; these checks bound the damage but do not prevent it. Per click:

- **P4** risks one self-transfer plus fees: one OS moves from the probe
  account to itself.
- **P5** risks a **public** storage-program create in the `dacs3:agreement:`
  namespace plus storage fees.
- **Account switch.** A switch made after the last `accounts` read and before
  the wallet signs is a short race the page cannot detect. In that window the
  wallet could sign as an account whose nonce and balance were never checked.
  Keep only the probe key in the extension profile and don't switch accounts
  while a probe runs.
- **Deposit race.** The balance is read once, just before signing. A deposit
  landing between that read and signing is not detected, so the account could
  hold more than 10 DEM when the signature exists.

Exact verification reports any nonce, recipient or signer diff afterwards. Trace
the extension's own RPC traffic separately if you need evidence about its
internal calls.

**Condition of use.** The residual risk above is accepted on testnet, on one
condition: the probe uses a fresh key that is used nowhere else and holds at
most 10 testnet DEM. The pre-sign checks stay as described (current nonce at
least 1, balance at most 10 DEM, and the explicit confirmation). The code
cannot check that a key is fresh or used nowhere else; that is the owner's
responsibility, and the page says so next to the confirmation. The probe does
not enable extension-backed purchases.

Copy the JSON report before reloading. For transaction calls it
keeps only hashes, field-diff paths/kinds, the `diffSummary` and verification
results, plus the public `accounts` re-check (plus probe
labels/timings). Full unsigned/signed transaction bodies and transaction
signatures are never retained in page records, status output or clipboard
exports, including errors and valid signatures over mutated transactions.
Message probes retain their harmless messages and projected signature envelopes.
Unknown strings and field names are omitted; provider error text is never
copied verbatim. It stays in page memory, with no server submission, storage,
analytics or automatic signing. Clipboard copy is the only export.

A timeout never retries or cancels the extension request. It fences all later
provider calls in that page session, even if the result arrives later. Dismiss
any outstanding wallet prompt before starting a fresh manual session.

This mode exposes no generic provider request or send API. It never calls
confirm, broadcast, send, identity writes, purchase payment or P6. It creates no
keys and accepts no phrase, key, password or token. It cannot constrain a
modified/malicious extension's internals, prove durable no-resend behavior,
or authorize extension-backed purchases. Those need separate
reviewed work and browser/transport evidence.
