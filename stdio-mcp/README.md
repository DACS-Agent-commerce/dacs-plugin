# demos-mcp

An MCP server and a Claude Code plugin for the Demos Network.

- **Read** the chain: network status, balances, transactions, Cross-Context
  Identities (CCI), and public Storage Programs.
- **Verify** DACS receipts: attestation bundles, fault bundles, bundle
  bindings, agreements and settlement evidence. Signatures and hashes are
  checked against the DACS-Standard, and the referenced Demos transactions and
  anchors are checked on chain.
- **Write**, with a human approving every write *off the chat*. The server can
  send DEM, link a GitHub, X, Discord or domain identity, sign a DACS fixed-price
  offer, and accept and pay for an offer (testnet writes are refused in this
  release; see "State of this release"). Prepare builds an **unsigned** action
  and an approval card. The human approves on a local approval page (a
  single-use link sent out-of-band to the desktop, terminal or phone), or by
  typing a fallback code. Only then does the server sign and broadcast. The
  model never sees the approval link or the code.
- **Prove what happened.** Every write returns a receipt signed by this
  install's receipt key. It records how the action was approved, and labels
  which fields anyone can replay-verify on chain. A daily Merkle root over the
  receipts can be anchored.

Testnet is the default and writes are off by default. The server is built on
`@kynesyslabs/demosdk` 4.0.17 and the official `@modelcontextprotocol/sdk`.

> Status: 0.1.0, pre-release. The code has not been externally audited. Use it
> only with testnet keys until it has been.

## State of this release

As the root README says, this is for testnet only, and nothing in it has been
run against a live wallet or node.

- **Testnet writes and faucet requests are refused in this release.** The list
  of testnet hosts that may take writes is empty (`KNOWN_TESTNET_HOSTS` in
  `src/config.ts`), and the faucet address defaults to a reserved placeholder.
  In the Quick start below, the faucet, identity and test-payment steps
  therefore do not complete. The rest of the page describes the design.
- **What has been checked:** the unit tests pass (mocked SDK, no network). The
  integration tests, the type check, the build and the Claude Code plugin
  validation have not been run for this import.
- **The CI workflow is `.github/workflows/stdio-mcp.yml`.** It runs the type
  check, the unit tests and the build. The workflow-pin and workflow-settings
  unit tests skip without the workflow file. Nothing has run it yet: Actions
  jobs start once the repository is public.
- **There is no built-in RPC.** Read-only use takes `DEMOS_RPC_URL`. The
  mainnet opt-in described below exists in the code, but has not been tried.

## Quick start

The faucet, identity and test-payment steps in step 2 need a testnet write or a
faucet request, which this release refuses, so they do not complete (see "State
of this release"). The build in step 1 has not been run for this import.

1. **Install** (Node.js ≥ 20.19). The package is in the `stdio-mcp/` directory:
   ```bash
   git clone <this repo> && cd <repo>/stdio-mcp && npm ci && npm run build
   ```
   Then in Claude Code, add that directory as the marketplace:
   ```text
   /plugin marketplace add /absolute/path/to/<repo>/stdio-mcp
   /plugin install demos@demos-mcp
   ```
   In `/config` → demos, turn on **Enable wallet writes**. Leave the keystore empty and
   restart Claude Code.
2. **Run `/demos-onboard`.** As designed, Claude walks you through these steps one at a time:
   - **Wallet.** A link opens a local page. Choose a passphrase there. The wallet is
     generated on your computer and the 12-word recovery phrase is shown **once, on that
     page**. Write it down. The phrase never appears in the chat.
   - **Testnet DEM** from the Demos faucet. If the faucet is down, you get its link and your
     address so you can try it yourself. *Not in this release: faucet requests are refused.*
   - **Identity.** Claude gives you a proof text. You post it yourself as a public GitHub gist
     (or on X). Claude checks it, and you approve the attestation on your page.
     *Not in this release: testnet writes are refused, so the attestation cannot be sent.*
   - **Spending limit.** Pick a small daily limit on your page. The default is 5 DEM.
   - **Ready card.** It shows your wallet, balance, identity and limit. You can optionally
     send yourself 1 DEM to watch the whole approve, sign and receipt flow.
     *Not in this release: testnet writes are refused.*

Every step that writes is approved by you on the local page. Testnet is the default. Mainnet
is refused unless you configure it explicitly.

Onboarding tools:

| Tool | What it does |
|---|---|
| `demos_onboard_status` | Shows what is set up and the single next step, or the ready card when everything is done |
| `demos_onboard_create_wallet` | Generates the wallet locally. The recovery phrase appears only on the local page; the keystore is chmod 600 |
| `demos_onboard_fund` | Testnet faucet request, with a clear fallback when the faucet is down |
| `demos_onboard_check_proof` | Checks that your published gist or X post contains this wallet's exact proof text |
| `demos_onboard_set_limit` | A daily spending limit you edit and approve on the page. It can only lower the operator cap |
| `demos_onboard_test_payment` | Optional 1 DEM payment to yourself through the normal approval flow |

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `demos_network_info` | read | Shows the RPC node, last block, node version and fee parameters, plus the server's safety posture (writes on or off, cap remaining, confirmation channels) |
| `demos_balance` | read | Balance in DEM and OS (1 DEM = 10^9 OS) and the nonce |
| `demos_tx_get` | read | Inclusion state, block, type, from, to, amount and fee for a transaction |
| `demos_identity_lookup` | read | CCI identities for an address (web2, xm, ud, pqc and others), plus its DACS `key:` claim |
| `demos_dacs_receipt_verify` | read | Verifies a DACS artifact or a demos-mcp receipt and returns `accept`, `reject` or `indeterminate` |
| `demos_storage_read` | read | Reads a public Storage Program, optionally down a key path, and returns provenance and a content hash |
| `demos_tx_prepare` | write, step 1 | Prepares an **unsigned** DEM transfer: checks the cap and allow-list, quotes the fee from the node's fee parameters, and returns an approval card. Nothing is signed or sent |
| `demos_identity_proof_payload` | write helper | Returns the proof text to publish before an attestation. It moves no funds |
| `demos_identity_attest_prepare` | write, step 1 | Prepares a github, twitter, discord or domain CCI attestation |
| `demos_dacs_create_offer_prepare` | write, step 1 | Builds a DACS-3 fixed-price `AgreementDocument` and prepares to sign it |
| `demos_dacs_accept_prepare` | write, step 1 | Verifies a counterparty-signed offer and prepares the countersignature, plus the payment on the DEM rail. Offer free text is returned only under `untrusted_counterparty_text` |
| `demos_tx_submit` | write, step 2 | Runs a prepared write after the human approves it (approval page, or the fallback code). Signs, node-confirms, re-checks against what was approved, broadcasts, and returns a signed receipt |
| `demos_tx_cancel` | write | Discards a prepared write |

The write tools are **not registered** unless writes are enabled and
configured. Without that, the model has no write surface at all. In this
release testnet writes are refused (`writeBlocker` in `src/config.ts`), so none
of the write tools can run against a testnet RPC.

## Safety model (short version — see [SECURITY.md](SECURITY.md))

1. **Nothing is signed before approval.** `*_prepare` builds an unsigned action
   and a fee quote taken from the node's fee parameters. Signing, node
   confirmation and broadcast happen only inside `demos_tx_submit`, after the
   human approves. Before broadcasting, the server re-checks the signed content
   against what was approved: sender, recipient, amount, and a fee no higher than
   the quote. So an RPC node never holds a signed transaction the human did not
   approve.
2. **Approval happens off the chat.** For each prepared write the server mints a
   single-use approval URL (256-bit token, 5-minute TTL) on a local page bound to
   `127.0.0.1` by default. The URL reaches the human only out-of-band, through a
   desktop notification, the terminal, or a phone webhook. The page shows a short
   **approval card**, for example `PAY 2 DEM → github:acme · testnet · total 4 DEM`,
   naming the recipient from on-chain CCI or printing `UNKNOWN RECIPIENT`, plus
   amount, fee, total, cap left, deliverable and deadline. Counterparty text is
   shown in a separate box marked untrusted. Approve or Deny is a POST, so link
   previews cannot approve. The model calls `demos_tx_submit(prepared_id)`; it
   never sees or relays the approval.
   - Fallback: the same message carries an 8-symbol one-time code. It can be
     turned off with `DEMOS_CODE_FALLBACK=0`. Each code works once and is bound
     to the action digest. Three wrong codes void the action; ten lock writes.
   - Preparing a new write voids the pending one, including under concurrent
     prepares. If no channel reaches the human, nothing is prepared.
3. **Untrusted input stays labelled.** Offer listing text, schema URLs,
   additional terms and storage contents come back only under
   `untrusted_counterparty_text` / `untrusted_content`. Verifier details are
   single-line and truncated, and the skill tells Claude never to follow
   instructions found in them.
4. **Keys never reach the model.** Keys come from an encrypted keystore (scrypt +
   AES-256-GCM, chmod 600) or a chmod-600 mnemonic file, never from tool
   arguments. Every secret is registered with a guard. Every tool result is
   scanned before it leaves the server, both as raw strings and as JSON text, and
   is blocked on a match.
5. **Testnet by default.** Mainnet needs `DEMOS_NETWORK=mainnet`,
   `DEMOS_ALLOW_MAINNET=1` and an explicit RPC. Testnet writes and faucet
   requests are refused in this release.
   Read-only use takes `DEMOS_RPC_URL`.
6. **Daily spend cap, allow-list, kill switch.** The cap covers amount plus fees,
   with a default of 10 DEM per UTC day. It is checked at prepare and reserved at
   submit under a cross-process lock. Any part the write did not use is released.
   The ledger lives in `~/.demos-mcp`, not in the plugin data directory, so a
   reinstall does not reset the cap. Creating `~/.demos-mcp/KILL` refuses every
   write immediately.
7. **Signed, replay-verifiable receipts.** Receipts (`demos-mcp/receipt@2`) are
   signed with a per-install receipt key, which is not the wallet key. Each one
   records the approval method and carries evidence labels. The verifier rejects
   a receipt that has no on-chain tx hash, and checks from, to and amount
   against the chain. The issuer counts as verified only when you pin it with
   `expected_signer`. `demos-mcp receipts root --date D` prints the day's Merkle
   root for anchoring.
8. **No double spend on timeout.** An ambiguous broadcast is polled by its hash
   and reported as `pending`, never `failed`, and is never sent again.

Mandates (pre-approved spend classes for unattended agent-to-agent deals) are
designed and their evaluator is implemented and tested. They are **not** wired
to bypass human approval yet; see [docs/MANDATES.md](docs/MANDATES.md).

## Install

Requires Node.js ≥ 20.19.

```bash
git clone <this repo> && cd <repo>/stdio-mcp
npm ci && npm run build
npm test                    # unit tests (mocked SDK, no network)
npm run test:integration    # read-only test; needs DEMOS_RPC_URL; not run for this import
```

### Claude Code (plugin)

Claude Code loads a plugin from a marketplace added from a local path in place,
so the built `dist/` and `node_modules/` are used directly:

```text
/plugin marketplace add /absolute/path/to/<repo>/stdio-mcp
/plugin install demos@demos-mcp
```

Then fill in the plugin options in `/config`, or accept the prompt that appears
when the plugin is enabled. The options are: network, RPC URL, enable writes,
keystore path, keystore passphrase (kept in the OS credential store), daily cap,
allow-list, confirmation channels and webhook. Restart Claude Code or run
`/mcp`.

For a one-off session: `claude --plugin-dir /absolute/path/to/<repo>/stdio-mcp`.

The plugin provides:
- the `demos` MCP server, whose tools appear as `mcp__plugin_demos_demos__*`;
- slash commands `/demos-balance`, `/demos-verify-receipt`, `/demos-attest` and
  `/demos-buy`;
- the `demos-safe-flow` skill, which teaches Claude the
  prepare → card → human approves off-chat → submit flow.

**Recommended Claude Code settings when writes are on:**
- Leave `demos_tx_submit` *not* auto-allowed. Claude Code's own permission
  prompt then becomes a second human gate.
- Approve on the page, not in the chat. Use the desktop notification, or set
  `DEMOS_APPROVAL_PUBLIC_URL` and the webhook channel to approve from a phone
  over a private network.
- Use the `desktop` or `webhook` confirmation channel. Claude Code's TUI can
  repaint over `tty` output, and stderr may end up in log files.
- Deny the agent's shell access to the keystore and state directory, for
  example with permission rules `Read(~/.demos-mcp/**)` and
  `Bash(cat:*demos*keystore*)` in `deny`. A shell-capable agent running as the
  same OS user is outside what the MCP gate can control (see SECURITY.md).

### Any MCP client (Claude Desktop, Cursor, others)

```json
{
  "mcpServers": {
    "demos": {
      "command": "node",
      "args": ["/absolute/path/to/<repo>/stdio-mcp/dist/index.js"],
      "env": {
        "DEMOS_NETWORK": "testnet",
        "DEMOS_RPC_URL": "https://your-node.example"
      }
    }
  }
}
```

This is the read-only setup: no key is needed. The write settings
(`DEMOS_MCP_ENABLE_WRITES`, a keystore, confirmation channels, a daily cap) are
listed under Configuration below; testnet writes are refused in this release, so
they do nothing against a testnet RPC.

### Create a keystore

Run this in your own terminal, never through the assistant:

```bash
export DEMOS_KEYSTORE_PASSPHRASE='a long passphrase'
# new testnet wallet
node dist/index.js keystore create --out ~/.demos-mcp/wallet.keystore.json --generate
# or encrypt an existing mnemonic, read from stdin
node dist/index.js keystore create --out ~/.demos-mcp/wallet.keystore.json < mnemonic.txt
```

The command prints only the address. With `--generate`, the recovery phrase is
shown once on your terminal (`/dev/tty`), never on stdout or stderr. Write it
down offline. Funding a testnet address is outside this server: its faucet
request is refused in this release.

`stderr` is a weak confirmation channel for any client that logs server stderr
to files the agent can read. Claude Desktop does this
(`~/Library/Logs/Claude/mcp-server-*.log`), and so may Claude Code. Prefer
`desktop` or `webhook`.

`dist/` is not committed. Build it locally, or install a published npm package
once one exists.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DEMOS_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `DEMOS_RPC_URL` | none (a reserved placeholder) | Node RPC for read-only use; must be https, except for localhost |
| `DEMOS_ALLOW_MAINNET` | off | Opt-in for mainnet only; testnet writes are refused in this release |
| `DEMOS_MCP_ENABLE_WRITES` | off | Registers the write tools (not for a testnet RPC in this release) |
| `DEMOS_KEYSTORE` | — | Encrypted keystore path (chmod 600) |
| `DEMOS_KEYSTORE_PASSPHRASE` / `DEMOS_KEYSTORE_PASSPHRASE_FILE` | — | Keystore passphrase, or a chmod-600 file that holds it |
| `DEMOS_MNEMONIC_FILE` | — | Plaintext mnemonic file (chmod 600). Discouraged; use a keystore |
| `DEMOS_WALLET_MODE` | unset | `purchase-only` disables legacy key loading and signing; any other value refuses to start. A `<keystore>.purchase-only` file (beside the keystore path or its symlink target) does the same for keystore deployments; a mnemonic-file deployment is fenced only by this variable |
| `DEMOS_DAILY_CAP_DEM` | `10` | Per-UTC-day cap on amount + fees |
| `DEMOS_RECIPIENT_ALLOWLIST` | — | Comma-separated addresses |
| `DEMOS_CONFIRM_CHANNELS` | `tty,desktop` | Any of `tty`, `desktop`, `webhook`, `stderr` |
| `DEMOS_CONFIRM_WEBHOOK_URL` | — | https URL that receives codes, e.g. an ntfy topic |
| `DEMOS_CONFIRM_TTL_SEC` | `300` | Code lifetime, 30–3600 |
| `DEMOS_STATE_DIR` | `~/.demos-mcp` | Holds the spend ledger, receipts log, receipt key and the `KILL` switch |
| `DEMOS_APPROVAL_PAGE` | on | Serve the local approval page |
| `DEMOS_APPROVAL_BIND` / `DEMOS_APPROVAL_PORT` | `127.0.0.1` / random | Where the approval page listens |
| `DEMOS_APPROVAL_PUBLIC_URL` | — | Base URL to put in approval links when the page is reached another way (e.g. a private tailnet name for phone approval) |
| `DEMOS_CODE_FALLBACK` | on | Also accept the typed one-time code |

The `DEMOS_APPROVAL_*` and `DEMOS_CODE_FALLBACK` options are environment-only
for now. They are not plugin settings; set them in the environment Claude Code
is launched from.

## DACS conformance notes

- Canonical form follows CORE §B.2: RFC 8785 JCS with NFC on string values
  (CF-1), and numbers outside the safe-integer range rejected. The hash is
  lowercase-hex sha256.
- Signatures follow CORE §B.7: `domain_separator || artifact_hash_hex`, with
  ed25519 values in unpadded Base64URL (SIG-6). The decoder is strict:
  padding, the standard alphabet, hex and residual bits are all rejected.
- Key resolution is offline for `key:<hex>` and `did:demos:agent:<hex>` claims,
  where `<hex>` is the 64 lowercase hex of the ed25519 public key (the HTTP
  plugin signs Listings with the `did:demos:agent:` form). A Demos wallet's
  claim is `key:<address without 0x>`. Signatures by either form verify
  wherever a claim signs (Listings, offers, Agreements, bundles, settlement
  evidence, bundle bindings and receipts). Both forms of one key are one
  party: a document cannot list them as two parties, and one key cannot sign
  as two. An expected signer, issuer or holder you pass to a check (for
  example `expected_signer`) must use the same claim form as the document. A payee address still comes only from a `key:` claim or the offer's
  payout bindings, so a `did:demos:agent` Listing verifies without a
  `logical_address`. Any other scheme (other
  `did:` methods, `cci-xm:`, …) gives `indeterminate` and is never accepted.
- Bundles: the hash omits `signatures` and `anchoredByRole`. The verifier
  applies the required-signer rule (buyer + seller, plus a distinct
  orchestrator) and lets aborted outcomes carry a single signature. On a
  `FaultAttestationBundle`, `faultedParty` must fall in the permissible set,
  and BundleBinding is checked against BB-4/BB-5.
- On Demos, "not found" is `indeterminate`, not authoritative absence
  (DEMOS-MAPPING §A.2).
- Offers are `AgreementDocument` / `negotiate-fixed-price`. On the
  `demos-native:DEM` rail the payee is the seller's `key:` address (pay-dem
  Tier-1). `PayeeBoundAgreementDocument` offers pay the address in
  `payoutBindings`.

Not covered yet: mandate-based unattended approval (designed, see docs/MANDATES.md), MCP URL-mode elicitation as an approval channel, extended-pointer bundles (the verifier asks for the
dereferenced bundle), ecdsa-secp256k1 and sr1-aggregate signatures, DACS-2
claim resolution for schemes other than `key:` and `did:demos:agent:`, rfq and sealed-envelope offers, and
anchoring artifacts to SR-2 from the server.

## Layout

```
src/            server (TypeScript) — chain.ts is the only file that imports the Demos SDK
  dacs/         JCS, §B.7 signatures, verifier, fixed-price offers
test/unit/      mocked-SDK tests: confirmation gate, spend cap, leak fuzzing, DACS vectors
test/integration/  read-only testnet test through the real stdio server
.claude-plugin/ plugin.json + marketplace.json
.mcp.json       plugin MCP server definition
commands/       /demos-balance /demos-verify-receipt /demos-attest /demos-buy
skills/         demos-safe-flow
```

## License

MIT, matching `@kynesyslabs/demosdk` and the DACS-Standard.
