> Historical v1 launcher procedure applies only to the `scripts/devnet-demo-*.mjs` references below; the read-only walkthrough, its switch and `start_showcase` are current. Both demo launchers are retired in v2 and refuse before loading configuration. Retained recovery uses `operator.createBuyerDriver({composition}).resume({idempotencyKey})` for original readback; never resend or re-publish. Launcher examples below describe the earlier v1 CLI only.

# Showcase quickstart: read-only walkthrough and two first-time choices

`DACS_SHOWCASE_WALKTHROUGH=off|on` defaults to `off` and parses to
`config.showcaseWalkthrough`. When it is `on`, a first-time viewer gets two
explicit choices:

1. **A read-only walkthrough.** Static pages that explain one fixed-price
   purchase stage by stage, with an illustrative receipt. They need no
   sign-in, wallet or testnet DEM, and they cannot buy anything.
2. **A live testnet purchase,** started in ChatGPT with the existing tools
   (`search_agents`, `get_listing`, `prepare_purchase`). This uses real
   Demos testnet transactions up to the commitment hold; the buyer approves each of
   their own signatures and transactions in their wallet, and the seller's
   records are written under the operator's authority. The built-in
   live-testnet operator (`src/devnet-demo/operator.mjs`) can be built
   programmatically; both source-owned CLI launchers are retired in v2. Equivalent programmatic compositions supplying the same
   reviewed capabilities can offer it too (see `start_showcase` below).

**Current payment hold:** the shipped ChatGPT composition supplies no
independent commitment-finality authority. It can write the Agreement and
seller commitment, but remains at `agreement_pending`: payment approval and
handoff are unavailable, so it cannot reach report delivery. A node's
`validation_data` does not establish independent finality. A separately
reviewed authority is needed to enable those later stages; there is no shipped
setting that bypasses this gate. There is no injectable callback that can authorize native payment. Tests that
reach delivery use a separate test policy module; it is excluded from the shipped
package and does not establish native finality.

Examples never have purchase capability, and choosing the walkthrough never
prepares a purchase or substitutes fixture data for a real one.

## What the switch turns on

| Surface | Off (default) | On |
| --- | --- | --- |
| `GET /portal/showcase/` and its pages | 404 | Served |
| MCP tool `start_showcase` | Not listed | Listed; public (`noauth`) and read-only |

Nothing else changes. The pages live in `public/showcase/`, outside
`public/portal/`, so `/portal/assets/` never serves them in either mode. A
request for anything else under `/portal/showcase/` falls through to the app's
JSON 404 (`{"error":"not_found"}`).

The built-in live-testnet operator (`src/devnet-demo/operator.mjs`, which
the retired `scripts/devnet-demo-compose.mjs` started in v1) builds its own app config and passes `DACS_SHOWCASE_WALKTHROUGH` from its
environment into it, default `off`, as it does `DACS_DELIVERY_DEADLINE_WATCH`.
It reads and checks the value first, before its first `await`, so a later
change to the environment has no effect, and before it reads its config or
opens any journal or listener, so a refused value leaves nothing open.

### Pages

| Path | Content |
| --- | --- |
| `/portal/showcase/` | The two choices, and what "verified" means here |
| `/portal/showcase/walkthrough.html` | The five stages (Identify, Vet, Negotiate, Settle, Verify) including the current commitment-finality hold and the later gated stages, the checks that stop a bad purchase, and an illustrative receipt |
| `/portal/showcase/beyond-fixed-price.html` | What the DACS Standard defines beyond a fixed price (RFQ, sealed bids, other payment rails, the Verify completion bundle), with the Standard, the SDK build and this app in separate columns, plus three labelled examples |

The pages are plain HTML and one stylesheet. They contain no scripts, forms
or inline styles, so the portal's CSP (`default-src 'none'; script-src 'self';
style-src 'self'`, applied to every portal response) holds without change;
they get exactly the same security headers as `/portal/assets/`.
They make no requests to the purchase, wallet, account or MCP endpoints, link
only to each other, and load no external fonts or images. Every page carries
the same scope banner, and every example block is labelled "Illustrative
example". Example references are placeholders such as `EXAMPLE-AGREEMENT`;
no page contains a transaction-like hash value, address, DID, storage
locator or operation ID, so nothing on them can be mistaken for a real
transaction.

The pages support keyboard use (a skip link, visible focus, and focusable,
labelled scrolling table regions) and small screens (fluid layout, scrolling
tables), and follow the viewer's light or dark preference (`color-scheme:
light dark`).

### `start_showcase`

Takes no input and returns
`{ livePurchaseComposed, choices: [walkthrough, live-testnet-purchase] }`.
`livePurchaseComposed` is one value for the whole server. Each choice has
`id`, `title`, `realTransactions`, `url`, `startWith`, `needs` and `note`.

`livePurchaseComposed` is true only when the app is built for the live
testnet purchase (`showcaseLivePurchase` in `src/app.mjs`): the Agreement
transport, the native seller commitment and native DEM delivery are present
(`devnetLivePurchase`), and the purchase protocol can prepare that purchase
(`protocol.supportsMode('dacs-sr2-wallet-agreement')`, which needs the seller
endpoint resolver). Both demo launchers are retired and refuse startup. Equivalent programmatic
compositions can supply these capabilities. The packaged entry point
`bin/dacs-chatgpt-plugin.mjs` never does. The extra
protocol check applies to this tool only: the MCP server instructions and
`prepare_purchase` still follow `devnetLivePurchase` as before.

- **walkthrough:** `realTransactions: false`, `url` is
  `<DACS_PUBLIC_ORIGIN>/portal/showcase/`.
- **live-testnet-purchase:** `url: null`, `realTransactions` equals
  `livePurchaseComposed`. When it is true, `startWith` names the three
  purchase tools, `needs` lists sign-in, a portal wallet and testnet DEM, and
  `note` says that the operator controls
  whether its seller is running and which accounts may buy, may admit only
  its own test accounts, that a purchase can wait for the seller's approval,
  and that the tool cannot tell whether this user can buy. Otherwise the note
  says live purchases are not set up on this server.

`livePurchaseComposed` says what the app was built with, nothing more. It
does not show that the seller is running or that the caller's account is
admitted; the tool is public (`noauth`) and cannot know either. In the
built-in operator the app is only served after the seller is attached and the
operator is listening, but another composition could serve it earlier.

The tool reads only `config.publicOrigin` and that composition flag. It needs
no account, prepares, signs and sends nothing, and leaves the database
unchanged. Its module imports only `zod`.

## What the pages claim, and what they don't

- The walkthrough describes the current fixed-price DEM flow on the Demos
  testnet. The seller's side of the app creates, checks and reads back both
  Vet records; the buyer's side only binds their references into the
  Agreement and does not read them back itself, so the example receipt leaves
  Vet pending. The shipped live testnet flow holds before payment until independent
  commitment finality is established. Verify (DACS-5) is also unimplemented
  in this profile: if an independently authenticated composition reaches
  delivery, it shows "Report available; completion audit pending". (The app's simulated `dacs-pay-dem` profile does produce DACS-5
  completion copies; the pages don't describe it.)
- The built-in operator's report is configured demonstration content plus a
  purchase-specific settlement reference.
- The checks that stop a bad purchase stop the payment transaction before it
  is handed to the wallet, or refuse to count a transaction that doesn't
  match. The final Listing recheck runs after the buyer's approval signature
  but before that handoff. None of them stops earlier writes: the seller's
  Vet records, the signed Agreement and its testnet record, and the seller's
  commitment are already on the testnet by then and are not undone.
- The start page and the support table say that live purchases need a server
  set up for them, rather than claiming this server runs them, and that the
  starter tool reports the setup, not whether an account may buy.
- "Verified" means what one testnet node reports: not a finality proof, an
  independent audit, business identity or service quality.
- The live choice says that the operator decides which accounts may buy. It
  does not promise what happens to an account that isn't admitted.
- The RFQ example is bilateral (one buyer, one seller), as in v0.1; a buyer
  comparing agents runs a separate exchange with each. Multi-quote RFQ is
  deferred to v0.2 (DACS-3 §8.8).
- The support table reflects the Standard's draft chapters DACS-3, DACS-4 and
  DACS-5 (the cited sections are the same on its `main` branch and on the
  newer drafts) and the vendored SDK `@kynesyslabs/dacs` 0.1.0-alpha.0, as of
  2026-10-08. Update it when either changes.

## Checking it

```bash
node --test --test-concurrency=1 test/showcase-walkthrough.test.mjs
node --test --test-concurrency=1 test/showcase-live-operator.test.mjs
```

`showcase-walkthrough` covers the switch and env contract, the static rules
above for every page (every attribute of every tag, whatever its quoting, is
from a fixed list and double-quoted), the two choices, the five stages and
receipt, the support table, both switch states over HTTP and MCP, the
security headers against `/portal/assets/`, the JSON 404 with no
redirect for every miss (unknown files, traversal and encoded variants,
dotfiles, double slashes, malformed encoding and methods other than GET and
HEAD), the focusable table regions and `color-scheme`, the starter module's
imports, that a `start_showcase` call leaves every row of
every table and the connection's change counter unchanged, and the key
capability statements of this quickstart (which entry points make
`livePurchaseComposed` true, and Verify in the live flow).

`showcase-live-operator` runs the built-in operator against the loopback Node2
fixture: the switch reaches its app config (default `off`; an empty or
differently spelled value is refused before the state directory or the public
origin opens), the public origin serves nothing of the app before the seller
is attached and the operator listens, and afterwards it serves the pages and
reports the live purchase setup. The same composition with only the seller
endpoint resolver, or only native DEM delivery, removed reports
`livePurchaseComposed: false`. The switch is read before the operator's first
`await`. At the MCP server factory, `prepare_purchase`'s live default protocol
follows `devnetLivePurchase` alone. It buys nothing.

Neither shows how ChatGPT presents the tool's choices: that needs a manual
pass in ChatGPT.
