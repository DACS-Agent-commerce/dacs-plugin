# Delivery deadline watch

`DACS_DELIVERY_DEADLINE_WATCH=off|on` defaults to `off`. When enabled, the
plugin can append its own observation to a paid purchase. It does not change
`protocol.stage`, payment status, signed artifacts or normal delivery progress.

The deadline comes only from the previously verified Agreement artifact's
`terms.deadline`, in Unix milliseconds. The stored verified Agreement terms
must agree with that deadline and its seller, the seller must match the purchase,
the commitment must be verified, and the payment must be `settled_verified`
with a recorded verified transfer. Listing and request deadlines are not used.

An observation requires a fresh read of both the Deliverable and delivery
evidence, using the same reads and `verifyDelivery` as the normal delivery step.
Both lookups must be well-formed, and the Deliverable lookup itself must be a
clean not-present result: a Deliverable read back without its evidence records
nothing. Only then can the check record `overdue`, and only when it started
strictly after deadline plus
`DELIVERY_DEADLINE_GRACE_MS` (two minutes). Inclusion normally takes 5–7 seconds;
read visibility can lag. Errors, timeouts, malformed responses and rejected or
unavailable records cannot create an observation.

`state.protocol.deliveryDeadline.overdue` contains `deadline`, `checkedAt`,
`read: 'not-present'`, `disposition: 'indeterminate'`, `obligatedParty: 'seller'`,
the Agreement's seller claim and `authority: 'local-observation'`.
`obligatedParty` names who owed delivery; it is not a verdict. A transaction
re-reads the purchase and records nothing if delivery has verified or an
observation already exists. The observation is never removed or rewritten.

`verify_deal` uses the reads already performed in its normal delivery step.
Status and portal reads only project stored facts, the deadline and elapsed
time. They do not check the chain or persist a deadline observation. With no
observation after the deadline, the buyer sees: “Delivery is not confirmed yet;
verify_deal checks the chain again.” This replaces the original brief's check
on every status read, because an observation requires a fresh chain read.

The sweep starts at listen and runs every five minutes while enabled. It
considers only purchases at stage `payment-evidenced`, where the normal step
reads delivery; the delivery check refuses any other stage before reading. Its
SQL selects at most ten plausible overdue purchases per pass. It reads them one at
a time, rotates after the last selected id (including errors), never overlaps
passes, and handles each purchase's error separately with only the operation
id in the warning. It performs delivery checks only: no claim retries, seller
calls or bundle requests. Verified delivery uses the normal save path.
Shutdown prevents further saves and waits up to ten seconds for an in-flight
pass. The clock and sweep/shutdown timers are injectable. Unsupported delivery
readback configurations fail closed and can be retried on later passes. Native
payment/delivery profiles require a separate capability and seller projection;
the sweep cannot substitute a fixture lookup or call the seller to obtain that
projection. It skips those profiles, without reads or warnings, and leaves them
to their existing verification path.

Every save uses the base snapshot save, with one transactional overlay that
carries forward stored `deliveryDeadline`. After `overdue`, a verified delivery
adds `laterDelivery` once: `verifiedAt`, `deliveredAt`, `deliveredAtSource`,
`deliverableRef` and `payloadHash`. Today `deliveredAt` is the seller-recorded
`delivery SettlementEvidence.observedAt`, not a chain-authenticated delivery
time. Fixture receipts' block timestamps do not authenticate Demos time.
The buyer sees the source label whether that timestamp is within or after the
deadline. A completed-bundle request is held only for a future explicitly
chain-authenticated inclusion block timestamp after the deadline. Today's
seller-recorded timestamps allow normal base progression.

With unset/`off`, there is no timer or sweep, and no new observation. Rows without
an observation have byte-identical saves to base. Previously stored observations
remain visible, and the independent overlay still records later delivery while
off. The separately tracked legacy stale-snapshot overwrite remains unchanged;
this watch never treats such an overwrite as evidence of non-delivery.

## Standard boundary

The supplied standard at `60a1d6a` establishes these limits:

- CORE §5.1, “SR-2 read outcomes and authoritative absence,” requires a
  binding-declared absence-evidence policy for authoritative absence.
  “Indeterminate is an observation disposition, not a lifecycle state” requires
  preserving established lifecycle state.
- DEMOS-MAPPING §A.2, “Authoritative absence and current state,” declares no
  Demos absence-evidence policy. Ordinary RPC/storage not-found responses are
  indeterminate for rules requiring authoritative absence, even when an adapter
  calls the lookup result `absent`.
- DACS-4 §9.13, “Delivery non-delivery,” discusses delivery performance and
  defers recording failure to DACS-5. It does not turn an uncertain read into
  a seller verdict or promise an automatic refund.
- DACS-5 §10.3 defines phase transitions and admission; §10.4 defines signed
  bundle authority. §10.11 says absence and elapsed time alone impose no blame.

The observation therefore records what this plugin saw, with no DACS-5 fault
bundle or reputation effect. The buyer is told that Demos cannot prove absence,
that this is the plugin's observation, and: “Nothing has been refunded. Do not
pay again.” DACS-5 fault bundles and refunds are not implemented yet. There are no new
chain writes, Agreement/Listing/payment-byte changes, seller delivery actions,
amendments or inferred human acceptance in this feature.
