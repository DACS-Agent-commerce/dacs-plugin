# Bounded browser Agreement profile (loopback tests only)

This profile exercises an authenticated portal buyer using the actual packaged
embedded wallet. It is not a ChatGPT installation, public service, on-chain
purchase, security acceptance, Vet pass or finality proof. Payment, commitment,
DACS-4/5 and completion remain held. Trusted real-chain pins remain empty.

The programmatic app option is `dacsProtocol.browserAgreement = { journal,
ttlMs? }` alongside the existing loopback seller endpoint map. There is no
environment or CLI switch. It requires literal HTTP `127.0.0.1`/`[::1]` plugin
and RPC origins, `allowInsecureLocal`, the simulated-loopback wallet relay, and
an explicitly supplied atomic journal (`get`, `put`, `entries`,
`withWalletLock`). A caller-supplied `walletFactory` is not accepted by this
option; the older injected fixture profile remains separate and unchanged.

The browser broker authenticates the already-linked wallet using a fresh
server challenge naming its account, operation, terms hash, job, exact Agreement
hash and network. Handoff possession alone is not wallet authentication. The
session token stays in the client closure, expires after 120 seconds by default
(1–300 seconds configurable), and is held server-side only by hash. Its
capacity is bounded to 1,024 active sessions. Same-origin POST requests are
required. This does not add a new OAuth account or change MCP ownership scopes.

The normal portal identity and Agreement signatures are unchanged. The server
retains the original two-party SDK artifact before making one exact CREATE
available. Claiming it atomically changes `queued` to `issued-to-browser`
**before** replying. A second claim, reload, lost response or fresh session
cannot deliver it again. The built-in wallet UI shows the immutable CREATE,
original Agreement bytes, owner, job/hash, network, nonce and complete simulated
debit. Only its existing trusted user approval can sign and send.

The browser journal relay accepts only the exact bound lane and strict public
signed CREATE/approval shapes, with signature, owner, artifact, hash, correlation
and coordinate checks. It persists the signed intent before the wallet's single
broadcast. The canonical field order and decimal wire strings of packaged SDK
4.0.16 are preserved. No recovery phrase, password, vault or signing key is
requested, transmitted, exported or stored by this broker. A failed public
journal write prevents broadcast.

The HTTP completion is correlated to that consumed request and retained signed
envelope. It is not an accepting receipt. The unmodified bridge must independently
read native storage and inclusion, authenticate the exact owner/content and
verify the portable receipt before `agreement-anchored`. Pending delivery,
absence, expiry, explicit denial and unknown outcome stay distinct. An unknown
after apply can only reconcile by readback, never resend. Expired/lost browser
sessions do not grant a new delivery. The caller owns the durability guarantee
of its supplied journal; the tests use RAM, not a production-durable claim.

## Repeatable checks

Run with a supported Node version (`^22.22.2 || ^24.15.0`) and already-offline dependencies. The earlier 22.22.0 run is historical. Do not run
`check-package.mjs`, `--prefer-offline` or dependency/network fallback.

```
node --test --test-concurrency=1 test/dacs-offline-browser-broker.test.mjs
DACS_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-concurrency=1 test/browser/dacs-offline-browser-broker.browser.test.mjs
```

The Chrome suite fails rather than skips when Chrome is absent. It creates a
fresh wallet through the existing UI, links it to an OAuth/MCP account, prepares
the Agreement through actual MCP, unlocks and connects the same UI wallet,
approves identity/Agreement/session messages, then deliberately approves the
one CREATE. It injects no provider, walletFactory or key. Requests are restricted
to the local plugin origin; fixture servers verify the SDK wire signature/debit
independently. CSP still rejects iframe embedding (`frame-ancestors 'none'`), so
this is an external trusted-portal flow, not an in-ChatGPT iframe wallet.

| Contract | Accepting control and exact guards |
| --- | --- |
| Linked account + wallet + planned scope | Real wallet challenge; wrong wallet/signature/handoff/operation/Origin and changed Agreement hash rejected |
| One exact CREATE | Signed public record accepted; wrong correlation/hash/lane/owner/content hash and success without journal rejected |
| One deliberate approval | Real Chrome trusted click sends once; synthetic click sends zero; explicit rejection sends zero |
| No replay or unknown resend | Second claim/result rejected; repeated MCP readback keeps one broadcast; unknown-after-apply reconciles only |
| Expiry/absence/persistence | Missing session/journal/public mode refused; expired session fenced; public journal failure sends zero |
| Payment held | MCP/portal result remains Agreement-only; payment challenge/handoff refused; no seller commitment/payment or coordinate reservation |

These are source-aware functional controls, not an independent security review.
The existing optional wallet-build batch remains **13 failures / 20 skips**,
with offline `ENOTCACHED` unresolved. The external security review is on hold.
Full v0.1 remains NOT_ACCEPTED.
