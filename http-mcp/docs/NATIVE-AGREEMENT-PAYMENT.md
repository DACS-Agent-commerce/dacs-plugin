# Bounded native Agreement → payment consumer

SOURCE-only, simulated literal loopback. No real Demos transaction, consensus
finality, ChatGPT-installed plugin, Vet pass, service delivery or completion is
claimed. The existing Agreement profile is retained, not renamed.

The programmatic application option is `nativeAgreementPayment: { enabled:
true }`, alongside the existing browser/injected wallet Agreement capability,
shared public journal, fixture anchors and `sellerSr2Commitment: {
commitmentSubstrate: 'fixture', publicProjection: true }`. It requires the
existing literal `http://127.0.0.1` RPC. It has no environment or CLI switch.
The buyer must additionally prepare against a marked simulated domain.

Only NEW prepared terms carry `nativePayment:
'native-dem-once-after-public-agreement-and-fixture-commitment'`. This marker
is included in the normal immutable terms hash and wallet-signed purchase
approval. Old retained/default Agreement-only operations remain held even if
the application later enables the consumer.

## Actual progression and authority

1. Existing MCP prepare, wallet identity/Agreement signatures, authenticated
   browser broker and packaged-wallet exact CREATE/debit approval produce one
   native SR-2 Agreement. Nothing here approves payment.
2. The existing seller HTTP commitment request conveys the retained public
   signed CREATE. The seller authenticates it through fresh native/inclusion
   reads. The buyer independently reads the seller's finalized commitment on
   the existing **fixture** anchor substrate. These are mixed substrates.
3. A normal consumed wallet-signed purchase challenge binds operation, terms
   hash, buyer, payee, amount, listing, network domain, job, Agreement and
   commitment hash/signer. Approval/handoff independently recheck native
   Agreement/public bytes and fixture commitment. Caller booleans are not
   approval. Issued CREATE plans and unresolved wallet coordinates fence the
   shared wallet nonce lane.
4. Durable payment coordinates are saved before one payload leaves. Reentry
   never returns that payload again, even while the nonce is unchanged.
5. The unchanged packaged wallet also reads its shared anchor journal before
   native sends. A separate read-only `/portal/api/purchase/:id/native-payment/
   lane` consumer serves ONLY the actual retained, verified CREATE guard for
   this normally approved handoff. It requires same origin and the operation
   handoff token; it neither writes a journal record nor broadens CREATE broker
   sessions. A durable operation flag consumes this guard before its response
   leaves. A cached payload, lost guard response, denial or unknown send cannot
   receive a second guard. Server journal locks and browser wallet locking
   serialize the bounded CREATE/payment consumer. Other write-family policies
   are unchanged, not generalized or repaired here.
6. A second wallet approval shows exact native amount, payee, nonce, fixture
   network and all debit/fees. The unchanged SDK signs, confirms and broadcasts
   once. Fixture accepting control: CREATE nonce1 then transfer nonce2; seller
   amount2.5 DEM + SDK gas1 + network fee2 + RPC fee3 = total8.5 DEM.
7. The wallet hash is a pointer, including a known hash on an unknown outcome.
   Normal readback requires the exact reserved payer/nonce and payee/amount
   tuple. This explicitly marked consumer accepts canonical decimal-text nonce
   from a normalizing wire node (safe nonnegative integer only). Receipt records
   single-RPC, tuple-only, no-finality/no-fulfillment limits and survives restart.
   Job and commitment bindings remain in the separately signed approval, not
   in added transaction fields.

The native path stops at `payment-observed`. It never enters fixture-only
payment claim, DACS-4, delivery or DACS-5 exchange. Completion is explicitly
held. Unknown outcomes and even an ordinary wallet denial after the once-only
guard are conservatively readback-only; there is no automatic release/resend.
Old complete fixture purchases keep their existing supported progression.

## Repeatable functional checks

Use a supported Node version (`^22.22.2 || ^24.15.0`), copied locked dependencies and an explicitly supplied
existing Chrome executable only; no install or browser fallback:

```sh
TMPDIR=/absolute/private/task-tmp DACS_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' DACS_EMBEDDED_WALLET_REQUIRE=1 node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/native-agreement-payment.test.mjs test/native-agreement-payment.browser.test.mjs
```

Both new tests live under the existing package `test/*.test.mjs` discovery.
Node controls drive actual OAuth/MCP, portal endpoints, broker and real packaged
SDK signatures with source-aware synthetic approval callbacks. Chrome controls
use actual portal trusted approval clicks. The owned normalizing RPC verifies
native signed hashes/signatures, request auth, next shared nonce, exact debit
edits and fixture fees; it never signs or plants approval/settlement state.
Restart reopens the public journal and app database and rebuilds the durable
seller. Tests cover accepting and applied/unapplied unknown outcomes, denial,
once-only cached-payload guard, shared CREATE/payment fencing, early/missing
approval, fresh unavailable readback, old prepared hold and approval expiry.

These are ordinary functional tests, not an independent security/conformance
review. No live network
pin, provider/runtime/SDK/Standard, seller auth, journal contract or deployment
configuration changes are included.
