// Recorded evidence only; this projection has no readers or workflow callbacks.
const string = (value) => typeof value === 'string' && value.length ? value : null;
const block = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const STATES = { rejected: 'rejected', refused: 'rejected', invalid: 'rejected', held: 'held', unknown: 'unknown', indeterminate: 'unknown', unavailable: 'unknown', absent: 'missing', pending: 'pending' };
const STEP_STAGE = { 'agreement-context': 1, agreement: 2, 'commit-request': 2, commitment: 2, claim: 3, 'payment-evidence': 3, 'native-evidence': 3, delivery: 3, 'bundle-request': 4, countersign: 4, 'buyer-copy': 4, 'seller-copy': 4, 'seller-confirmation': 4 };
const REJECTED_STAGE = { 'agreement-rejected': 2, 'claim-rejected': 3, 'evidence-rejected': 3, 'delivery-rejected': 3, 'bundle-rejected': 4 };
// Every named check src/dacs/verification.mjs records for a found Listing; partial or older records stay pending.
const LISTING_CHECKS = ['directory-detail-hash-matches-summary', 'directory-coordinates-match', 'chain-anchor-present', 'chain-readback-equals-directory-detail', 'chain-anchor-owner-is-seller', 'catalog-observation-fresh', 'standard-reader-verified', 'v0.1-purchase-support'];
// src/purchases.mjs records these only after a fresh commitment gate passed.
const GATE_PASSED = ['payment_handoff', 'handoff_reissued'];
const gatePassed = (h) => GATE_PASSED.includes(h.type);
const commitmentRecovered = (h) => (h.type === 'protocol_commitment' && h.data?.outcome === 'verified') || gatePassed(h);
// Gate refusal reasons naming the Agreement check (fresh native Agreement readback, or committed terms binding).
const AGREEMENT_REFUSALS = ['agreement_unverified', 'agreement_terms_mismatch'];
const RECOVERIES = { gatePassed, commitmentRecovered, settled: (h) => h.type === 'settled_verified' };
// What makes a recorded refusal historical: a later recorded recovery for it (a RECOVERIES name). Unknown outcomes have none.
const REFUSAL_RECOVERY = { commitment_recheck_refused: (entry) => entry.data?.reason === 'commitment_unverified' ? 'commitmentRecovered' : 'gatePassed',
  handoff_refused: () => 'gatePassed', readback_refused: () => 'settled', pointer_rejected: () => 'settled' };
// Refusals of a gate or handoff check: only a later refusal for the same reason re-ran the same check.
const GATE_REFUSALS = ['commitment_recheck_refused', 'handoff_refused'];
const PAYMENT_PASSED = ['verified', 'verified-fixture-native-read'];
// Each stage lists the latest ATTEMPT_ROWS recorded attempts of each kind (protocol outcomes, refusals) after one row
// counting the older ones; every attempt stays in the operation history (get_purchase_status `history`).
const ATTEMPT_ROWS = 20;
// The count row takes the most severe omitted state; an omitted unknown outcome keeps it unknown.
const SEVERITY = ['unknown', 'rejected', 'held', 'missing', 'pending'];
// items: { row, seq, current, unknown } in recorded order.
function recentAttempts(items) {
  if (items.length <= ATTEMPT_ROWS) return items.map((item) => item.row);
  const older = items.slice(0, -ATTEMPT_ROWS), current = older.filter((item) => item.current).length, unknown = older.filter((item) => item.unknown).length;
  const [first, last] = [older[0].seq, older.at(-1).seq];
  return [proof('Earlier recorded attempts', { state: SEVERITY.find((state) => older.some((item) => item.row.state === state)) ?? older.at(-1).row.state,
    check: `${older.length} earlier recorded attempts not listed`,
    reason: `Only the latest ${ATTEMPT_ROWS} recorded attempts are listed; the earlier ones${Number.isSafeInteger(first) && Number.isSafeInteger(last) ? ` (history seq ${first}–${last})` : ''} remain in the purchase history.`,
    scope: current ? `Current: ${current} of them are still current${unknown ? `, including ${unknown} unknown outcomes that are never superseded` : ''}` : 'Historical attempts; later recorded attempts or recoveries supersede them' }),
  ...items.slice(-ATTEMPT_ROWS).map((item) => item.row)];
}

function proof(label, { ref, receipt, key, hash, txHash, blockNumber, state = 'missing', check = null, reason = null, scope = null } = {}) {
  return { label, state, check: string(check), reason: string(reason),
    txHash: string(receipt?.transactionRef?.value) ?? string(txHash),
    block: block(receipt?.blockRef?.height) ?? block(blockNumber),
    artifactKey: string(ref?.anchor?.locator) ?? string(receipt?.logicalAddress) ?? string(key),
    artifactHash: string(ref?.contentHash) ?? string(receipt?.contentHash) ?? string(hash),
    scope: string(scope) ?? string(receipt?.substrate) };
}
// A pass superseded by a later failed check: the current row carries the failure, the retained proof is labelled historical.
const superseded = (row, state, reason) => [proof(row.label, { state, reason }), { ...row, label: `${row.label} (historical)`, scope: `Historical: passed before a later failed check${row.scope ? `; ${row.scope}` : ''}` }];

export function showcaseProgress({ operation, history = [], protocol = null, evidence = {} }) {
  const stages = ['Identify', 'Vet', 'Negotiate', 'Settle', 'Verify'].map((name) => ({ name, state: 'pending', reason: 'Required proof is missing.', evidence: [] }));
  const [identify, vet, negotiate, settle, verify] = stages;
  const prepared = operation.state?.preparedVerification;
  const checks = Array.isArray(prepared?.checks) ? prepared.checks : [];
  const listing = operation.terms?.listing;
  identify.evidence = checks.length ? checks.map((c) => proof('Listing', { ref: listing, state: c.ok === true ? 'passed' : 'rejected', check: c.name, reason: c.detail, scope: `Recorded at preparation; ${prepared.evidence?.chainMode ?? 'observation scope missing'}` })) : [proof('Listing', { ref: listing })];
  const listingBound = Boolean(string(listing?.listingId) && Number.isSafeInteger(listing?.version) && string(listing?.contentHash) && string(listing?.anchor?.locator));
  const listingComplete = listingBound && LISTING_CHECKS.every((name) => checks.some((c) => c.name === name && c.ok === true));
  identify.state = checks.some((c) => c.ok !== true) ? 'rejected' : listingComplete ? 'verified' : 'pending';
  identify.reason = identify.state === 'verified' ? 'The recorded Listing checks passed at preparation.' : identify.state === 'pending' && checks.length ? 'The recorded Listing checks are incomplete or not bound to the Listing.' : 'Listing verification proof is missing or rejected.';

  const parties = operation.state?.protocol?.agreement?.artifact?.parties ?? operation.state?.protocol?.planned?.draft?.parties;
  vet.evidence = ['buyer', 'seller'].map((role) => proof(`${role} Vet composite`, { ref: Array.isArray(parties) ? parties.find((p) => p.role === role)?.vetRecordRef : null,
    reason: 'A bound reference is not an independently verified counterparty Vet result.' }));
  vet.state = protocol?.limits?.vet ? 'held' : 'pending';
  vet.reason = string(protocol?.limits?.vet) ?? 'Per-party Vet checks, provenance and receipts are missing; identity associations do not establish Vet.';

  const events = history.filter((h) => typeof h.type === 'string' && h.type.startsWith('protocol_')).map((h) => ({ step: h.type.slice(9), ...h.data, historySeq: h.seq }));
  // lastAttempt normally repeats the final recorded protocol event.
  const final = events.at(-1), attempt = protocol?.lastAttempt;
  if (attempt && !(final?.step === attempt.step && final.outcome === attempt.outcome && (final.reason ?? null) === (attempt.reason ?? null))) events.push(attempt);
  const last = new Map(events.map((event) => [event.step, event]));
  const latestStageOutcome = new Map(events.filter((event) => event.outcome).map((event) => [STEP_STAGE[event.step], event]));
  const agreement = protocol?.agreement;
  const commitment = protocol?.commitment;
  const anchored = Boolean(agreement?.ref && last.get('agreement')?.outcome === 'anchored');
  const committed = Boolean(commitment?.ref && last.get('commitment')?.outcome === 'verified');
  // The reason of the latest gate refusal for this check, unless a later recorded recovery follows it.
  const refusedSince = (reasons, recovered) => {
    const index = history.findLastIndex((h) => h.type === 'commitment_recheck_refused' && reasons.includes(h.data?.reason));
    return index > history.findLastIndex(recovered) ? history[index].data.reason : null;
  };
  const commitmentRefused = refusedSince(['commitment_unverified'], commitmentRecovered);
  // After payment, advanceNativeEvidence re-reads the Agreement first and records the plugin's code when it does not
  // verify. A later verified native read (payment evidence or native delivery) or a passed gate re-read it.
  const nativeRefused = history.findLastIndex((h) => h.type === 'protocol_native-evidence' && h.data?.outcome === 'held' && h.data?.code === 'agreement_unverified');
  const nativeRecovered = (h) => gatePassed(h) || (h.type === 'protocol_native-evidence' && PAYMENT_PASSED.includes(h.data?.outcome)) || (h.type === 'protocol_delivery' && h.data?.outcome === 'verified');
  const agreementRefused = refusedSince(AGREEMENT_REFUSALS, gatePassed) ?? (nativeRefused > history.findLastIndex(nativeRecovered) ? 'agreement_unverified' : null);
  const agreementRow = proof('Agreement', { ref: agreement?.ref, receipt: agreement?.anchorReceipt, hash: agreement?.hash, state: anchored ? 'passed' : 'missing', check: anchored ? 'Two-party signatures, exact terms and anchor readback' : null });
  const commitmentRow = proof('Seller commitment', { ref: commitment?.ref, receipt: commitment?.anchorReceipt, key: commitment?.address, hash: commitment?.contentHash, state: committed ? 'passed' : 'missing', check: committed ? 'Independent commitment readback bound to the Agreement and payee' : null, scope: commitment?.substrate });
  negotiate.evidence = [
    ...(anchored && agreementRefused ? superseded(agreementRow, 'rejected', `A later fresh Agreement check was refused (${agreementRefused}).`) : [agreementRow]),
    ...(committed && commitmentRefused ? superseded(commitmentRow, 'rejected', 'A later fresh commitment readback was refused (commitment_unverified).') : [commitmentRow]),
  ];
  negotiate.state = anchored && committed ? 'verified' : 'pending';
  negotiate.reason = committed && anchored ? 'Recorded Agreement and commitment checks passed; consensus finality is not established.' : anchored ? 'Waiting for independent seller commitment readback.' : 'Waiting for the signed Agreement and anchor readback.';
  const refused = [agreementRefused, commitmentRefused].filter(Boolean);
  if (refused.length) { negotiate.state = 'rejected'; negotiate.reason = `A fresh readback was refused (${refused.join(', ')}); earlier verification is historical until a recorded recovery.`; }
  if (protocol?.storageGap) { negotiate.state = 'held'; negotiate.reason = string(protocol.storageGap.message) ?? 'Agreement storage proof is missing.'; }

  const receipt = evidence.receipt;
  const payment = protocol?.paymentEvidence;
  const delivery = protocol?.delivery;
  // The latest applicable attempt decides current payment evidence; a verified native delivery read also verified it.
  const paymentAttempts = events.filter((e) => e.step === 'payment-evidence' || e.step === 'native-evidence' || (e.step === 'delivery' && e.outcome === 'verified' && protocol?.nativeEvidence?.nativeReadback === 'present'));
  const paymentLatest = paymentAttempts.at(-1);
  const paymentChecked = Boolean(payment?.ref && PAYMENT_PASSED.includes(paymentLatest?.outcome));
  const paymentRecorded = Boolean(payment?.ref && paymentAttempts.some((e) => PAYMENT_PASSED.includes(e.outcome)));
  const reportChecked = Boolean(delivery?.deliverableRef && last.get('delivery')?.outcome === 'verified');
  const fixtureDelivery = !protocol?.nativePayment && ['dacs-chatgpt-plugin/fixed-price-pay-dem/v1', 'dacs-chatgpt-plugin/devnet-pay-dem-purchase/v1'].includes(protocol?.profile);
  const deliveryChecked = reportChecked && Boolean(delivery?.evidenceRef) && (fixtureDelivery || (delivery.evidencePublication === 'native-read-back' && Boolean(delivery.evidenceReceipt)));
  const paymentRow = proof('Payment evidence', { ref: payment?.ref, receipt: payment?.anchorReceipt, key: payment?.address, hash: payment?.evidenceHash, txHash: payment?.txHash, blockNumber: payment?.blockNumber,
    state: paymentRecorded ? 'passed' : 'missing', check: paymentRecorded ? 'Canonical job-bound DACS-4 payment evidence verified' : null });
  settle.evidence = [
    proof('Payment observation', { txHash: receipt?.txHash ?? evidence.reportedTxHash, blockNumber: receipt?.blockNumber, state: receipt ? 'included' : 'missing',
      check: receipt ? 'Approved payer, payee, amount and reserved nonce slot match (one RPC)' : null, scope: receipt?.chainMode }),
    ...(paymentRecorded && !paymentChecked ? superseded(paymentRow, STATES[paymentLatest.outcome] ?? 'missing', paymentLatest.reason) : [paymentRow]),
    proof('Deliverable', { ref: delivery?.deliverableRef, receipt: delivery?.anchorReceipt, hash: delivery?.payloadHash, state: reportChecked ? 'passed' : 'missing',
      check: reportChecked ? 'Seller-written report bytes, hash and job/Agreement bindings verified' : null }),
    proof('Delivery evidence', { ref: delivery?.evidenceRef, receipt: delivery?.evidenceReceipt, key: delivery?.evidenceHold?.logicalAddress,
      state: deliveryChecked ? 'passed' : STATES[delivery?.evidenceHold?.status] ?? 'missing', check: deliveryChecked ? `${fixtureDelivery ? 'Fixture' : 'Native'} delivery evidence readback bound to the verified Deliverable` : null,
      reason: delivery?.evidenceHold?.reason ?? (deliveryChecked ? null : 'Delivery evidence proof is missing.') }),
  ];
  settle.state = reportChecked && paymentChecked ? 'delivery-ready' : paymentChecked ? 'payment-evidenced' : receipt ? 'included' : 'pending';
  settle.reason = reportChecked ? 'Report available; completion audit pending.' : receipt ? `Payment included${block(receipt.blockNumber) !== null ? ` in block ${receipt.blockNumber}` : '; block proof missing'}; finality is not established. Waiting for remaining settlement evidence.` : 'Waiting for payment observation and settlement evidence.';
  if (protocol?.limits?.payment === 'held' && !receipt) { settle.state = 'held'; settle.reason = 'Payment remains held in this profile.'; }

  verify.evidence = [proof('Buyer bundle copy', { ref: protocol?.bundle?.buyerCopy }), proof('Seller bundle copy', { ref: protocol?.bundle?.sellerCopy }), proof('Independent completion audit')];
  verify.state = 'pending';
  verify.reason = 'Completion audit pending: independently verified finality, required dependencies, signatures and role-owned copies are not established by this view.';
  if (protocol?.bundle) verify.evidence.forEach((row, i) => { if (i < 2) row.reason = 'Recorded copy reference only; native completion audit proof is missing.'; });

  // Every negative attempt stays recorded; only the latest outcome per stage sets its current state.
  const attempts = stages.map(() => []);
  for (const event of events) {
    const index = STEP_STAGE[event.step], state = STATES[event.outcome];
    if (index === undefined || !state) continue;
    const current = latestStageOutcome.get(index) === event;
    attempts[index].push({ seq: event.historySeq, current, unknown: false, row: proof(event.step, { state, reason: event.reason, check: `Recorded ${event.step} outcome: ${event.outcome}`,
      scope: current ? 'Current recorded attempt' : 'Historical attempt; a later recorded outcome supersedes it' }) });
    if (current) {
      stages[index].state = state;
      stages[index].reason = string(event.reason) ?? `Recorded ${event.step} outcome: ${event.outcome}; proof is missing.`;
    }
  }
  attempts.forEach((items, index) => stages[index].evidence.push(...recentAttempts(items)));
  const rejected = REJECTED_STAGE[protocol?.stage];
  if (rejected !== undefined) { stages[rejected].state = 'rejected'; stages[rejected].reason = string(protocol.lastAttempt?.reason) ?? `${protocol.stage}: the required check did not pass; reason proof is missing.`; }
  if (protocol?.stage === 'native-payment-evidence-held' && !paymentChecked) { settle.state = 'held'; settle.reason = string(protocol.nativeEvidence?.nativeReadReason) ?? string(protocol.nativeEvidence?.reason) ?? settle.reason; }
  if (delivery?.evidenceHold) { settle.state = STATES[delivery.evidenceHold.status] ?? 'held'; settle.reason = string(delivery.evidenceHold.reason) ?? 'Delivery evidence is held; reason proof is missing.'; }

  const recordedRefusals = { commitment_recheck_refused: [2, 'rejected'], handoff_refused: [3, 'held'], readback_refused: [3, 'rejected'], pointer_rejected: [3, 'rejected'], wallet_error: [3, 'unknown'], handoff_readback_only: [3, 'unknown'] };
  // Every recorded refusal, in order. A row is historical once a later recovery for it, or a later refusal of the
  // same type (for gate refusals, the same reason), follows; unknown outcomes are never superseded. One reverse pass
  // tracks which recoveries and refusal kinds occur later.
  const refusals = stages.map(() => []), recoveredLater = new Set(), refusedLater = new Map();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (Object.hasOwn(recordedRefusals, entry.type)) {
      const [index, state] = recordedRefusals[entry.type], recovery = REFUSAL_RECOVERY[entry.type]?.(entry), reasons = refusedLater.get(entry.type);
      const refusedAgain = Boolean(reasons) && (!GATE_REFUSALS.includes(entry.type) || reasons.has(entry.data?.reason));
      const historical = Boolean(recovery) && (recoveredLater.has(recovery) || refusedAgain);
      refusals[index].push({ seq: entry.seq, current: !historical, unknown: !recovery, row: proof(entry.type, { state, reason: entry.data?.reason ?? entry.data?.message, txHash: entry.data?.txHash,
        scope: historical ? 'Historical attempt; a later recorded attempt or recovery supersedes it' : `Current recorded attempt${recovery ? '' : '; an unknown outcome is never superseded'}` }) });
      refusedLater.set(entry.type, (reasons ?? new Set()).add(entry.data?.reason));
    }
    for (const [name, recovered] of Object.entries(RECOVERIES)) if (recovered(entry)) recoveredLater.add(name);
  }
  refusals.forEach((items, index) => stages[index].evidence.push(...recentAttempts(items.reverse())));
  const status = operation.status;
  const statusState = { payment_uncertain: 'unknown', broadcast_reported: 'unknown', payment_failed: 'failed', payment_mismatch: 'rejected', cancelled: 'cancelled', expired: 'expired', superseded: 'superseded', terms_changed: 'rejected', agreement_rejected: 'rejected' }[status];
  if (statusState) {
    const target = status === 'terms_changed' ? identify : status === 'agreement_rejected' || ['cancelled', 'expired', 'superseded'].includes(status) ? negotiate : settle;
    const recorded = history.filter((h) => h.type === status).at(-1)?.data;
    if (status === 'terms_changed' && Array.isArray(recorded?.checks)) target.evidence.push(...recorded.checks.map((c) => proof('Listing recheck', { ref: listing, state: c.ok === true ? 'passed' : 'rejected', check: c.name, reason: c.detail, scope: 'Recorded pre-payment recheck' })));
    target.state = statusState;
    target.reason = string(recorded?.reason) ?? (Array.isArray(recorded?.mismatches) ? recorded.mismatches.join('; ') : null) ?? `${status}; reason proof is missing.`;
    if (statusState === 'unknown') target.reason += ' Original operation is readback-only; do not pay again.';
  }
  return { version: 1, status, profile: string(protocol?.profile) ?? string(operation.terms?.profile), substrate: string(protocol?.substrate) ?? string(evidence.listingMode), stages };
}
