> Historical v1 launcher procedure. Both demo launchers are retired in v2 and refuse before loading configuration. Retained recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})` for original readback; never resend or re-publish. The examples below describe the earlier v1 CLI only.

# Fixed-price Node2 demo composition

In v1 the built-in CLI held before payment because independent finality of the seller commitment is not established. A fresh key could publish the pre-payment artifacts but sent no native payment and produced no report. Resuming the same held key kept the operation held; a new key was no way around the gate. Recovery of already-issued payments used only the retained original payment hash and authorized no new payment.

This opt-in source path composes one real fixed-price DEM test run; it is absent by default. It does not derive authority from environment flags, a successful HTTP response, a copied descriptor, or a `verified` Boolean.

The application publishes a seller-signed Listing with `publishListingCore`, produces and verifies both party composites with `partyVetCore`, publishes the seller FinalityCommitmentRecord, and consumes the existing native Agreement/payment/evidence pipeline. Delivery is produced by the injected purchased-content service as `dacs-chatgpt-plugin/devnet-purchased-report`. The exact job, Listing pin, Agreement hash, fulfilment ID, purchase amount, payload hash, source pin and seller are signed into the immutable delivery CREATE. The same SDK payment permit, receipt store and fence reach `runDurableFulfilmentToDeliveryReady`. No path calls or relabels the fixture `buildReport` producer.

Every CREATE uses the packaged Demos wallet's normal exact approval, SDK sign/confirm, durable public intent, source-bound inclusion observation, native artifact readback and portable SDK receipt verification. A restart, repeat request or lost response can only reconcile the original retained hash; it never authorizes another signed CREATE or DEM payment.

An operator-held seller storage CREATE whose submission was durably classified as accepted may re-send its identical retained signed bytes once. Acceptance requires an exact hash-only response (`hash`, `txHash`, or both, each matching) or the exact reviewed validator-relay success envelope; direct storage replies with a null response remain unknown. Older records without the current strict classification profile stay held. Recovery requires fresh source-bound identity and absence reads with exact node RPC envelopes and identity-block field sets showing the hash absent and the account nonce still exactly one below the signed nonce, plus fresh confirmation of identical bytes and unchanged fees, using the exact node confirmation envelope and ValidityData field shapes, including all five success data fields with null gas_operation, plus the original wallet confirmation-shape checks with no custom charges. The attempt is persisted before dispatch and survives restart. Ambiguous submission/readback, a visible hash, a consumed nonce, changed confirmation or missing retained recovery material keeps the write held. Browser wallet transactions and native DEM transfers retain their existing no-resend rule. With `openBuyerAccess` off, this resend still runs on the seller's shared lane for an earlier job whose buyer is now outside closed access; that is the named, logged `closed-access-19-resend` exception in [SELLER-SESSION-DELEGATION.md](SELLER-SESSION-DELEGATION.md).

## Built-in operator

In v1, `scripts/devnet-demo-compose.mjs` consumed the built-in operator with `--config=/absolute/operator.json` and accepted a reviewed external `--operator-module` that implements the owned-shutdown contract below; the script is retired in v2 and exits 1. The built-in path owns:

- a fresh, explicitly reviewed single-Node2 TEST observation/admission and an endpoint-bound run fence;
- three durable SQLite journals (source transport, seller artifacts and seller wallet), the seller's party Vet store (`seller-party-vet.sqlite`, below), plus durable seller/session and signed-peer stores;
- separate mode-0600 buyer and seller throwaway custody records under a mode-0700 directory;
- seller identity/Listing creation from SDK primitives, source history lookup and immutable readback;
- an interactive exact seller CREATE approval with an OS-denominated ceiling and public approval-evidence record;
- an optional packaged buyer capability with a separate complete-debit ceiling; the buyer driver binds every one-shot signature, Agreement CREATE and native DEM approval to the exact buyer, seller, Listing, job, Agreement, network, amount, payee and displayed full debit;
- an HTTPS loopback seller listener with independently signed buyer requests, seller responses and durable no-repeat effects;
- a local read-only directory projection of the exact signed Listing; and
- a bounded purchased-content producer consumed by the existing SDK durable fulfilment and native-delivery path.

### External operator modules: owned-shutdown contract (breaking change)

On a stop signal the script now calls only `prepared.close()`, the module's own shutdown. (A stop during startup, before `attachSellerAgent()` has returned the marker, first closes the application and seller agent the script created; neither is the module's yet.) Earlier, it closed the module's listener (`running.close()`), then the application, then the seller agent, and only then called `prepared.close()`. A module written for that earlier contract would have its `prepared.close()` run while its listener, application and agent were all still open, so the script refuses it.

Contract version 1 (`src/devnet-demo/stop.mjs`):

- `attachSellerAgent()` must return the exact frozen marker `Object.freeze({ ownedShutdown: 1 })` (exported as `OWNED_SHUTDOWN`). A missing, mutable or different marker is refused.
- `prepared.close()` alone must stop everything the module was given or opened, in a safe order: refuse new requests and drain admitted ones, stop source work, wait for its own lane holders, then close the listener, the application (and its database), the seller agent, journals and stores. Repeated calls return the same promise. A rejection is reported to stderr with its code, and the script exits 1.

A module without the marker gets the fixed error `operator module must return the frozen { ownedShutdown: 1 } marker from attachSellerAgent; …` immediately after attachment, before `listen()` is called. The script then closes the application and seller agent and calls `prepared.close()`, in the earlier contract's order, and exits 1. To upgrade a module, move the caller-side closes into its `prepared.close()`, then return the marker. The built-in operator declares it.

The operator co-custodies the throwaway buyer only so the private loopback seller peer can authenticate requests as the same test buyer imported into the portal. This is a test-run architecture, not a production non-custodial wallet design. The buyer recovery phrase remains in `buyer-wallet.json`; the CLI never prints it. Inspect/import it only through a local private channel and never copy it into logs, config, chat or evidence.

Each buyer run now has two durable files under `stateDirectory/buyer-runs`. The mode-0600 private record is the only place that retains the one-time portal handoff capability and original payment hash. Its separately written mode-0600 receipt is deliberately public-safe: it contains the opaque run key, public operation/job/party/Listing/network bindings, Agreement and payment hashes, achieved-or-held stage and authenticated report readback, but no wallet secret, OAuth token, cookie or handoff token. Do not delete the private record while its operation may be in flight.

The config is exact and contains no mnemonic, key or approval flag:

```json
{
  "format": "dacs-node2-demo-operator/v1",
  "authority": "TEST-RUN-example-20261006",
  "publicOrigin": "http://127.0.0.1:8787",
  "sellerOrigin": "https://127.0.0.1:8788",
  "sellerTls": {
    "keyPath": "/private/operator/seller-key.pem",
    "certificatePath": "/private/operator/seller-cert.pem"
  },
  "directoryOrigin": "http://127.0.0.1:8789",
  "stateDirectory": "/private/operator/state",
  "custodyDirectory": "/private/operator/custody",
  "networkAdmissionPath": "/private/operator/node2-admission.json",
  "listing": {
    "listingId": "fresh-node2-report",
    "listingVersion": 1,
    "displayName": "DACS Demo Seller",
    "title": "Fresh Node2 fixed-price report",
    "description": "A newly produced report delivered after the approved DEM purchase.",
    "category": "services.market-report",
    "tags": ["report", "node2"],
    "priceDem": "1",
    "validForMs": 86400000,
    "deadlineSecAfterCommit": 3600
  },
  "sellerFeeBudget": { "maxTotalOs": "10000000000" },
  "buyerFeeBudget": { "maxTotalOs": "12000000000" },
  "content": {
    "mediaType": "text/plain; charset=utf-8",
    "text": "Purchased report bytes produced by the seller content service."
  }
}
```

The seller certificate must be valid for `sellerOrigin` and trusted by the local Node process. The app and directory listeners are deliberately loopback HTTP; external TLS/reverse-proxy deployment is not supplied or authorized by this source task.

### Party Vet store and journal capacity

The seller's Vet state for each purchase lives in `stateDirectory/seller-party-vet.sqlite`, its own file next to `seller-artifacts.sqlite`: one row per job with the job's binding, both Vets' SDK checkpoints, the write-ahead record of each Vet signature, the context the seller's Agreement step reads, or a quarantine marker. It holds no key. A missing file is created empty at start; a purchase whose Vets an earlier server version started is then refused as `legacy_party_vet_state_missing` ("this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase") and nothing is read back, signed or sent for it.

The Vet signer must be deterministic and free of side effects (the current local Ed25519 signer satisfies this). Each party Vet retains one immutable byte string. A stored signature is replayed, but a crash or store failure after signing and before its checkpoint, or concurrent providers, can invoke the signer again on those same bytes. Deterministic repeats yield the same signature value: never a second record, and at most one CREATE per party Vet. A repeat that differs from a concurrently stored signature is refused with the fixed writer code `conflict`, retaining the original signature and publishing nothing for the refused attempt. This does not bound signer calls across arbitrary retries.

A job's row is deleted once its purchase ends (settled, failed, expired, cancelled and the other final statuses) and no Vet write of it is still running in the process. A sweep at start and every 10 minutes also deletes rows of purchases that ended without a status change the process saw (an approval window that passed unread, or an end before a restart). The store therefore holds only purchases still before their end.

Measured on the fixture chain (6 planned jobs, real SQLite files):

| File | Per planned job | Cap | Planned jobs before it is full |
| --- | --- | --- | --- |
| `seller-party-vet.sqlite` | 1 row, about 25.7 KB, deleted at the purchase's end | 4,096 rows, 256 MiB | 4,096 purchases not yet ended at once (the byte cap would allow about 10,400) |
| `seller-artifacts.sqlite` (unchanged from before the party Vet store) | 2 rows, about 30.1 KB, never deleted | 4,096 rows, 32 MiB | about 1,110 in total, fewer once paid purchases add delivery rows |

`GET /health` reports the store under `dependencies.partyVetStore` (`jobs`, `bytes`, `maxJobs`, `maxTotalBytes`, `remainingJobs`, `remainingBytes`). When it is full, a new purchase's plan step fails before any Vet signature with "the party Vet store is full; nothing was written"; purchases already planned continue. The artifact journal's limit is unchanged: it keeps every CREATE intent, and nothing deletes them.

## Separately reviewed real run

1. Create the private directories as mode 0700 and save the exact config as mode 0600. Generate a fresh locally trusted seller TLS key/certificate at the named private paths.
2. Create both fresh throwaway wallets once: `node scripts/devnet-demo-operator-bootstrap.mjs wallets --config=/absolute/operator.json`. The command returns only public accounts and private paths, never phrases.
3. Observe your testnet RPC URL once: `node scripts/devnet-demo-operator-bootstrap.mjs observe --endpoint=https://testnet-rpc.invalid/ --network=demos-devnet --out=/private/operator/node2-observation.json`.
4. Independently inspect the observation, then bind that exact 64-hex identity into a fresh run admission: `node scripts/devnet-demo-operator-bootstrap.mjs admit --observation=/private/operator/node2-observation.json --authority=TEST-RUN-... --transport-authority=TEST-node2-run-... --pin-version=TEST-node2-observation-... --reviewed-chain-identity=<exact-64-hex> --out=/private/operator/node2-admission.json`. This remains a single-node TEST admission, not an independent genesis/quorum proof.
5. Fund only the two newly created public accounts from the official faucet, within the reviewed purchase/CREATE/fee budget. No source command automatically requests faucet funds.
6. Historical v1 example (the launcher is retired in v2 and exits 1): the built-in buyer path ran up to the finality hold with `node scripts/devnet-demo-purchase.mjs --config=/absolute/operator.json --idempotency-key=<fresh-run-id>`. Each seller CREATE and each buyer signature/CREATE/payment prints its exact public request and requires typing `APPROVE <approval-hash>` in the controlling TTY. `buyerFeeBudget` is only a hard ceiling; it is not approval, and there is no `approved: true` config path. In v1, `scripts/devnet-demo-compose.mjs` was used instead only when another normal app/MCP client drove the buyer.
7. In v1 the purchase command used the new named buyer custody through OAuth, MCP `prepare_purchase`/`verify_deal`/`get_purchase_status`, the normal portal Agreement and payment endpoints, the one-time browser broker, and the packaged SDK wallet. A fresh run printed public identities, scoped approval records and pre-payment transaction/readback references, then reported the hold without purchased bytes. For an already-issued payment from an earlier or separately authenticated composition, if the command lost its response after the payment hash was retained, the v1 recovery was to restart with the same config/state/custody and run `node scripts/devnet-demo-purchase.mjs --config=/absolute/operator.json --resume=<same-run-id>`. Resume authenticates the buyer again, reads the same operation, reports only the retained original hash when needed, and performs independent delivery readback. It never asks for another Agreement CREATE or payment. A run with no retained canonical payment hash stays held and must not be replaced by a retry payment.
8. For recovery of an already-issued payment, accept technical delivery only when app/MCP returns the new purchased bytes and fresh buyer-side native readback authenticates the exact seller CREATE. Human service acceptance, independent finality, DACS-5 completed copies and any deployment remain separate.

Separately authenticated compositions that can pass the finality gate may run sequential jobs that reuse the published Listing and keep separate keys, operations, jobs, Agreements, payments and deliverables; see [DEVNET-OPERATOR-SEQUENTIAL.md](DEVNET-OPERATOR-SEQUENTIAL.md). A declined native payment is cancelled only from chain-nonce and source-journal proof that nothing was sent, so it no longer blocks the wallet's next purchase.

Source validation performed zero public RPC calls, faucet requests, public-wallet creation or live transactions. Its owned-loopback checks use ephemeral test wallets and a source-owned Node2 normalization loopback. The first real Node2 runs on 7 October 2026 completed a paid purchase, restart without resend, normal decline, own-local lost-response recovery and a distinct next job after follow-up repairs. That is single-node TEST evidence, not independent finality, security acceptance or deployment approval.

Two seller switches are off by default: `"sellerApproval": { "mode": "policy" }` lets a fixed code policy decide the purchase's seller CREATEs instead of the TTY (the Listing CREATE stays manual), and `"sellerDeliveryEvidence": { "enabled": true }` publishes the seller's delivery SettlementEvidence at `dacs4:evidence:<job>` so the buyer can reach `delivered`. Enabling delivery evidence changes the source `transportBinding`; policy mode does not. See [SELLER-POLICY-AND-DELIVERY-EVIDENCE.md](SELLER-POLICY-AND-DELIVERY-EVIDENCE.md) for the policy checks, limits, binding change and retained transaction recovery.

Seller HTTPS startup and attachment require a currently valid certificate, a matching key/secure context, a SAN matching the configured seller origin, and serverAuth when extended key usage is present. The seller listener opens at attachment (`attachSellerAgent`), before `listen()`; the public application is served only after `listen()`. A client TLS handshake against that listener, using the seller client's trust and identity checks, runs twice: once at attachment and again at `listen()`. The default client uses Node's CA store, including `NODE_EXTRA_CA_CERTS`, and the probe is a TLS handshake only, with no HTTP request. An injected `fetchImpl` gets one `GET /__seller_tls_handshake__` instead (no redirects, no credentials); the operator answers that exact path in front of the seller handler, so it reaches no seller route and does not count against the seller's 120-request-per-minute budget. Either probe is bounded at 10 s. A failed handshake refuses startup with `seller TLS client handshake failed (<code>)`. The new-purchase horizon is the 30-minute approval TTL + the retained Listing’s `deadlineSecAfterCommit` + the 15-minute `SELLER_SESSION_KEY_GRACE_MS` for seller copy and buyer-copy confirmation. Admission checks this horizon after the balance read; equality is refused. A still-valid certificate inside that window starts degraded and keeps in-flight purchases and recovery available. `/health` shows live `sellerTls` readiness, both validity dates and `windowStartedAt` when unusable. A hard-invalid certificate refuses startup with the failed check or validity dates. Replace certificate files and restart to load new material.

An operator attaches its seller agent once. Attaching after `close()` is refused with `operator_closing`, while another attachment runs with `seller_attach_in_progress`, and after a successful one with `seller_already_attached`; nothing is opened for a refused call. `close()` waits for an attachment in flight. The attachment keeps its listener, transport store and timers to itself until every check (the handshake, session store validation and the first session sweep) has passed. Until then the seller listener answers only the handshake probe: any other request gets `503 {"error":"seller_not_attached"}` without reaching a seller route or the seller budget, and the operator publishes no seller endpoint, directory Listing, purchase store or evidence resume pass (`resumeHeldDeliveryEvidence()` returns `null`). If any of them fails, or the operator is closed meanwhile, it closes what it opened and the operator closes too. Create a new operator to try again.

A local TLS guard refuses before signing and dispatch. Its attempt records `dispatched: false`, stays indeterminate, and does not settle earlier unknown attempts of that step. Ops health labels the last attempt as not sent while retaining any earlier unknown-write alert. Transport failures after dispatch retain unknown outcomes and only closed, bounded cause codes.
