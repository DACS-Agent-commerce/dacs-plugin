> Historical v1 publication procedure. Publication tools and signing routes are retired in v2. These seller steps require the preserved v1 release; use the v2 quickstart for buyer workflows.

# Embedded-wallet seller publication and the held testnet profile

Status: offline, SIMULATED functional work. Not a security review, not live
execution, not full v0.1 acceptance, not human approval, not v0.2. The
external security review is on hold.
Nothing here enables a live write; the testnet profile is held.

## What a seller can do now (simulated-loopback profile only)

With `DACS_EMBEDDED_WALLET_WRITES=simulated-loopback` (loopback chain
fixture only), a seller can publish from the experimental embedded wallet,
without the Demos extension, through the existing seller state machine
(`src/agents.mjs`, unchanged states):

1. `register_agent` (MCP, unchanged) prepares the listing and returns the
   portal link. Nothing is published.
2. Portal: sign the identity presentation, then the exact listing (wallet
   message signatures; the server verifies both).
3. The server fences the wallet nonce and saves the storage-program create
   payload (`buildStorageProgramCreatePayload`, unchanged). The embedded
   wallet checks it, shows one approval, signs it with the SDK, has the node
   validate it and broadcasts it exactly once.
4. The server reads the storage program back independently
   (`chain_verified`, labelled simulated for fixture evidence).
5. The seller signs the directory registration; the server submits it
   (`directory_submitted`).
6. The portal "Check directory again" (new handoff-scoped
   `POST /portal/api/publish/:id/verify`, same logic as
   `verify_agent_publication`) advances to `directory_visible` only when the
   directory serves the same content hash and anchor.

The extension route is unchanged (existing portal browser suite 13/13,
including extension seller onboarding).

### Stages shown to the seller

Every publish response carries `stages` (pure `publicationStages()` in
`src/agents.mjs`): `identity_signature`, `listing_signature`,
`storage_write`, `chain_readback`, `directory_submission`,
`directory_visibility`, each `pending | action_required | reported | waiting
| verified | unknown | failed | cancelled`. A wallet or directory report is
`reported`, never `verified`; only server readback verifies. The portal
renders them as `ol#publication-stages li[data-stage][data-stage-state]`.
The full status-to-stage mapping is the `STAGE_ROWS` table in
`src/agents.mjs` (also in the core role's interface evidence, which is not
shipped in this package).

### Embedded wallet storage write (`public/portal/embedded-wallet/sdk-provider.mjs`)

`request({method:'sendTransaction', params:[tx]})` now accepts the server's
storage-program create in addition to the native DEM send. Before approval
it requires: this wallet as `from` and as the listing's seller claim; the
exact nine payload fields; `encoding:'json'`, `acl:{mode:'public'}`,
`salt:''`, `storageLocation:'onchain'`, `amount` 0, nonce ≥ 1;
`to === storageAddress`; `programName === 'dacs1-' + base64url(logicalAddress)`;
and `storageAddress` equal to the SDK formula
`stor-` + sha256(`${wallet}:${programName}:${nonce}:${salt}`)[0..40]
(SDK `StorageProgram.deriveStorageAddress`; the tests use the SDK function as
the oracle). The approval shows wallet, storage address, program name,
listing id/version, title, price, seller, endpoint, listing bytes, storage
fee (SDK schedule, 1 DEM per 10 KB, min 1), the SDK's fixed 1 DEM gas edit,
node fees, nonce and the SIMULATED label. After `demos.sign(tx, {nonce})` it
checks the signed content and the SDK's `gcr_edits` (one storage create of
this payload at this address; balance removals of exactly the storage fee
and the gas edit) or answers `payload_mismatch` without confirming. Results
are unchanged: `broadcast_accepted`, `broadcast_rejected`,
`outcome_unknown` (with hash and nonce; never retried) or a pre-send error.

### Wording in the simulated profile

When the server's embedded-wallet profile is `simulated-loopback` (a local
SIMULATED fixture chain), the portal reads the profile once at load and then:

- the page title and top heading read "DACS wallet portal — SIMULATED offline
  fixture", and the header says "SIMULATED offline fixture — not Demos
  testnet, no real funds, not ChatGPT.";
- the sign-in, wallet-link, purchase, publication and identity page headings
  end with "(SIMULATED fixture, not Demos testnet)", and primary approval
  buttons end with "(SIMULATED fixture)";
- the purchase approval heading is "Approve simulated DEM purchase …" and the
  status heading "Simulated DEM purchase status (SIMULATED fixture, not a DEM
  testnet purchase status)". One muted line says the approval step stands in
  for "Approve DEM testnet purchase" on a real server. Existing tests outside
  this role find these pages by those phrases, so they are kept in that form.

Every other profile, including the default, keeps the previous wording.

## Held testnet profile

`DACS_EMBEDDED_WALLET_WRITES=testnet-held` is the explicit, default-disabled
testnet integration profile. It needs an https, non-loopback
`DACS_CHAIN_RPC_URL` and an explicit `DACS_CHAIN_NETWORK`, and refuses the
fixture-only GitHub origin. It is HELD:

- `config.embeddedWallet` stays `{writes:'off'}`; `config.embeddedWalletTestnet`
  is `{profile:'held', executable:false, network, rpcOrigin}`.
- No wallet relay is mounted (404); nothing can reach a real node through it.
- The profile endpoint reports `{writes:'off', testnet:{profile:'held',
  executable:false, network, reason, gates}}`.
- The portal passes a `{profile:'testnet-held', network}` transport; the
  wallet labels the session and answers every write `held_for_review`
  before approval or any node call. Message signing still works.
- The portal refuses publication up front with the held message.

Un-holding requires a reviewed source change after the gates below, never a
setting. The existing simulated-loopback guards (loopback-only config,
simulation header, no retry statuses) are unchanged and separate.

## getIdentities read (investigation, read-only)

- Pinned demosdk 4.0.16 `Identities.getIdentities` calls
  `demos.rpcCall(request, demos.walletConnected)`: without a connected wallet
  the read is UNSIGNED, and `rpcCall` still sends the auth headers empty:
  `identity: "ed25519:"`, `signature: ""`, `timestamp: ""`. The bundled
  `@kynesyslabs/dacs` `DemosAdapter` connects a wallet only when given a
  secret. The previous `chain.mjs` comment ("the SDK always signs") described
  4.0.12 source.
- `src/dacs/chain.mjs` now sends exactly that unsigned shape (same body,
  same three empty headers); `test/overnight-core-identities-wire.test.mjs`
  compares it with the real SDK's request captured on a loopback recorder.
  No signing scheme was invented; the server still holds no key.
- The only permitted network read (`getNetworkInfo` at the official public
  node named in the assignment, status page label "Devnet") answered 200 with osDenomination activated
  and node 0.9.8. It says nothing about `gcr_routine getIdentities`, which
  was not called on any live node. **Live compatibility of the unsigned read
  is UNKNOWN**; the "Devnet" label is not proof of a testnet identity.

## Identity actions: explaining a wallet error, and how to recover

When the wallet answers an identity request with an error (for example the
embedded wallet's `upstream_unavailable` "the GitHub user could not be read;
nothing was signed", which it returns before any approval dialog), the
portal now shows `#wallet-answer` (`role="alert"`, `data-wallet-code`) with:

- the wallet's own message and code, from the server's persisted record of
  the reported outcome (so a reload shows it again);
- "Nothing was signed or sent." only when the embedded wallet answered (the
  server records which wallet answered, so a reload or another tab shows the
  same) and the code is one its contract defines as failing before signing or
  broadcast; `outcome_unknown` says it may have reached the node, and any
  other wallet answer says the wallet did not say whether anything was sent;
- what happens next (below).

Recovery, as the identity action service implements it after the closure
repair (full rules in `IDENTITY-RECOVERY.md`):

1. **Impossible GitHub handle.** A proof URL whose handle has characters
   GitHub never allows (anything outside letters, digits and hyphens, for
   example `_`) is refused at the proof step with `invalid_proof_url`
   ("“<handle>” cannot be a GitHub username … Nothing was sent to your
   wallet."). The action stays at the proof step, so the corrected URL can be
   pasted in the same action. Handles that break only GitHub's hyphen rules
   still reach the review step, which warns before the wallet is asked
   (`#identity-handle-warning`) and offers **Cancel this identity action**.
2. **Stopped before broadcast.** When the experimental embedded wallet stops
   before its one broadcast, with one of its documented codes
   (`upstream_unavailable`, `identity_mismatch`, `confirm_rejected`,
   `locked`, …), the portal reports `wallet: "embedded"`. The action closes
   as `failed_before_send`: nothing is retried, it is not called a
   rejection, and the wallet can start a new identity action at once, in the
   same run.
3. **Cancel before the wallet is asked.** Every portal page before approval
   offers **Cancel this identity action** (`POST
   /portal/api/identity/:id/cancel`); the action becomes `cancelled`.
   Once the wallet has been asked, cancel is refused.
4. **Possibly sent: unchanged.** Any other answer (the embedded wallet's
   `outcome_unknown` or `broadcast_rejected`, catch-all errors, timeouts,
   closed windows, and every wallet-extension code except `USER_REJECTED`)
   moves the action to `readback_pending`, then after the 10-minute readback
   window to `outcome_unknown`. Both still count as in flight, so a new
   identity action for that wallet is refused with
   `identity_operation_in_progress` (`details.cancellable: false`) until
   readback shows the change. Nothing is retried. Expiry (30 minutes) applies
   only before the wallet is asked.
5. Other linked wallets, purchases and publications are never blocked.

The guided tester dashboard treats `failed_before_send` and `cancelled` as
finished. **Add test … identity** then starts a new action, even if the
dashboard had not been refreshed. The step 5 note no longer advises a
launcher restart.

Residual: an action stranded before this repair carries no wallet marker and
stays `outcome_unknown`; it is not reclassified. The server relies on the
portal's report of which wallet answered, as it does for `user_rejected`.

## SDK reuse and unsupported items

Reused unchanged: `@kynesyslabs/dacs` 0.1.0-alpha.0 (listing build/verify,
`contentHash`, `listingAddress`, CCI bounds, pay-DEM observer), demosdk
4.0.16 browser runtime (`Demos.connect/nodeCall/sign/confirm/broadcast` for
the storage create, as already for native sends; `GCRGeneration` storage
edits). No dependency, lockfile, runtime bundle or Standard pin changed.

Not used, with reason:

- `demos.storagePrograms.sign(payload, {nonce})`: it rebuilds a fresh
  transaction; the wallet must sign the server's saved, nonce-fenced
  payload as-is, which `demos.sign` does.
- `StorageProgram` is not exported by the browser runtime entry; the wallet
  mirrors its one-line derivation with WebCrypto instead of rebuilding the
  bundle. Tests cross-check against the SDK function.
- `broadcastAndWait`: polls and is not needed; exactly one broadcast, then
  server readback.
- Program naming: the app keeps the Community `dacs1-<base64url>` name with
  salt `""`. The dacs `DemosAdapter` uses `logicalToStorageProgramName`
  (colon → `%3A`) with salt `""`; its source states the name is an
  implementation-defined opaque write input (DACS-1 §6.3.4). No protocol
  change was made. The app does not publish a separate logical→native
  binding record (§6.3.5); discovery uses the directory registration anchor.
- Live fees: SDK 4.0.16 builds a 1 DEM/10 KB burn plus a fixed 1 DEM gas edit
  and notes node-side constant alignment as pending; real node charging is
  unverified.

## Live-test checklist (NOT executed; all held)

Before any live/testnet seller publication from the embedded wallet:

1. The external security review is on hold.
2. Human approval naming the exact build, network and action.
3. Establish the real network identity of the target RPC (not the "Devnet"
   status label alone) and an explicit `DACS_CHAIN_NETWORK`.
4. Confirm a live node accepts the unsigned `getIdentities` read shape above
   (read-only) or record its exact refusal.
5. Confirm the live node's storage-program create validation: address
   derivation, `to`, salt, ACL, fee burn and gas edits, post-fork wire
   amounts, and the nonce rule, against one authorised test write.
6. Confirm `GET /storage-program/<stor-…>` readback shape (`success`, `data`,
   `owner`, `programName`) on that node.
7. Confirm the Community directory's registration and indexing behaviour for
   the anchor, and that `findSummary` sees the same content hash.
8. Replace the held branch by a reviewed code change (no env-only enable),
   keeping the simulated guards, then re-run all suites below.
9. Funded test wallet handling, faucet use and any broadcast need their own
   explicit authorisation; none is granted here.

## Tests

- `test/overnight-core-seller.test.mjs`: stage table, held/default/simulated
  profiles, pre-fork publication, lost-before-apply recovery, malformed CREATE
  payloads and SDK signed-content mutation refusal. Primary onboarding and
  publication flows remain in `test/seller.test.mjs` and the browser suite.
- `test/overnight-core-identities-wire.test.mjs`: unsigned read wire against
  the real SDK.
- `test/browser/overnight-core-publication.browser.test.mjs`: real Chromium:
  publication end to end with stage display, reload during the open
  approval plus rejection plus single write, default-off refusal, held
  profile refusal.
- `test/helpers/overnight-core-fixtures.mjs`: SIMULATED chain (validates SDK
  hash/signature/nonce/storage address; stores programs) and directory
  (indexes a registered anchor on request). It was the reference for the
  offline tester fixtures, which have since added storage-program
  creates and directory indexing there.
- `test/browser/overnight-core-identity.browser.test.mjs`: real Chromium:
  GitHub identity add accepting control, and the wallet-error explanation
  below (warning before the wallet is asked, wallet message, "nothing was
  signed or sent", recovery facts, reload, nothing linked).
