# Mandates: pre-approved spend classes (design; evaluator implemented, not wired)

**Goal.** Let agent-to-agent DACS deals run inside limits the owner set ahead
of time, with no human awake for each one, and without teaching people to
rubber-stamp approvals.

## Object

```
Mandate {
  mandateVersion: "1"
  network: "testnet" | "mainnet"
  recipients: ["0x…"]            // allowed payees (exact match); later: CCI predicates
  maxPerTxOs: "…"                // amount + fee per transaction
  allowanceOs: "…"               // total, conserved
  perDayOs: "…"
  expiresAt: <unix ms>
  parent?: <mandate hash>        // delegation: the child must fit the parent's remaining allowance
  purpose?: "…"
}
mandate_hash = sha256(JCS(mandate))
```

## Rules (implemented in `src/mandates.ts`, tested in `test/unit/prism.test.ts`)

- **Conserved allowance.** For each mandate hash,
  `spent + reserved + amount + fee ≤ allowanceOs`. The allowance can only
  shrink. Editing a mandate changes its hash, so the edited mandate cannot take
  over another mandate's ledger. A delegated child must fit inside its parent's
  remaining allowance.
- **Deterministic and complete trace.** Every rule is evaluated, with no
  short-circuit. The `trace` lists each rule with pass/fail and the observed
  value, the same discipline as KyneSys `agent-allowance`.
- **Kill switch.** `<stateDir>/KILL` denies every mandate and every write. This
  part is already enforced on all write paths.
- **Fail closed.** Malformed fields, an unknown network or an expired mandate
  all deny.

## Wiring plan (next)

1. The owner issues a mandate out-of-band: CLI `demos-mcp mandate add`, signed
   with an owner key that is **not** the agent-attached wallet key. The server
   verifies the owner signature before using the mandate.
2. `*_prepare` evaluates the active mandates. When one allows the action, the
   prepared action is tagged `approval.method = "mandate"` along with its
   `mandate_hash`. Submit then runs without a page tap; otherwise the normal
   page/code flow applies.
3. Reservations go into a per-mandate ledger (spent, reserved), held under the
   same cross-process lock as the daily cap.
4. Receipts carry `mandate_hash`, so a verifier can recompute why the action
   was allowed.
5. Align the object with KyneSys `agent-allowance` and the DACS spend-authority
   proposal in dacs-sdk, so one mandate format serves both.

**Why it is not wired yet.** While the mandate store sits in a file that a
shell-capable agent running as the same OS user can rewrite, an unattended
mandate path is only as strong as that file. Wire it once the signer runs as a
separate principal (see SECURITY.md §1), or once mandates are owner-signed.
