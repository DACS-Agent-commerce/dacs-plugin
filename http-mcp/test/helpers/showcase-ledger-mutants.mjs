// Run only in a disposable mirror; the reviewed working tree is never mutated.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTests, killed, runNodeTest } from './node-test-child.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const projection = 'src/mcp/showcase-progress.mjs', rendering = 'public/portal/showcase-progress.mjs';
const projectionTests = 'test/showcase-progress.test.mjs', renderingTests = 'test/showcase-progress-render.test.mjs', integrationTests = 'test/showcase-ledger-integration.test.mjs';
const nativeTests = 'test/showcase-ledger-native-integration.test.mjs';
// [name, file, before, after, test file]; exported so a runner outside the repo can reuse the list.
export const mutations = [
  ['Listing check gate', projection, "checks.some((c) => c.ok !== true) ? 'rejected'", "false ? 'rejected'", projectionTests],
  ['Complete Listing check set', projection, 'LISTING_CHECKS.every((name) =>', 'LISTING_CHECKS.some((name) =>', projectionTests],
  // Each removal leaves an array hole, which every() skips: that check is no longer required.
  ...['directory-detail-hash-matches-summary', 'directory-coordinates-match', 'chain-anchor-present', 'chain-readback-equals-directory-detail', 'chain-anchor-owner-is-seller', 'catalog-observation-fresh', 'standard-reader-verified', 'v0.1-purchase-support']
    .map((name) => [`Required Listing check ${name}`, projection, `'${name}'`, '', projectionTests]),
  ['Listing binding gate', projection, 'const listingComplete = listingBound &&', 'const listingComplete =', projectionTests],
  ['Listing binding: listingId', projection, 'string(listing?.listingId) && ', '', projectionTests],
  ['Listing binding: version', projection, 'Number.isSafeInteger(listing?.version) && ', '', projectionTests],
  ['Listing binding: contentHash', projection, 'string(listing?.contentHash) && ', '', projectionTests],
  ['Listing binding: anchor locator', projection, ' && string(listing?.anchor?.locator)', '', projectionTests],
  ['Refused commitment downgrades Negotiate', projection, 'const refused = [agreementRefused, commitmentRefused]', 'const refused = [agreementRefused]', projectionTests],
  ['Refused commitment row is historical', projection, '...(committed && commitmentRefused ? superseded(', '...(false ? superseded(', projectionTests],
  ['Only commitment_unverified refusals downgrade', projection, "refusedSince(['commitment_unverified'], commitmentRecovered)", "refusedSince(['commitment_unverified', 'seller_delegation_expiring'], commitmentRecovered)", projectionTests],
  ['Recovery: later commitment verification', projection, "(h.type === 'protocol_commitment' && h.data?.outcome === 'verified') || ", '', projectionTests],
  ['Recovery: passed handoff gate', projection, "h.data?.outcome === 'verified') || gatePassed(h);", "h.data?.outcome === 'verified');", projectionTests],
  // Refused fresh Agreement checks.
  ['Refused Agreement downgrades Negotiate', projection, 'const refused = [agreementRefused, commitmentRefused]', 'const refused = [commitmentRefused]', projectionTests],
  ['Refused Agreement downgrades Negotiate (loopback)', projection, 'const refused = [agreementRefused, commitmentRefused]', 'const refused = [commitmentRefused]', nativeTests],
  ['Refused Agreement row is historical', projection, '...(anchored && agreementRefused ? superseded(', '...(false ? superseded(', projectionTests],
  ['Refused Agreement row is historical (loopback)', projection, '...(anchored && agreementRefused ? superseded(', '...(false ? superseded(', nativeTests],
  ['Agreement refusal: agreement_unverified', projection, "const AGREEMENT_REFUSALS = ['agreement_unverified', 'agreement_terms_mismatch'];", "const AGREEMENT_REFUSALS = ['agreement_terms_mismatch'];", projectionTests],
  ['Agreement refusal: agreement_terms_mismatch', projection, "const AGREEMENT_REFUSALS = ['agreement_unverified', 'agreement_terms_mismatch'];", "const AGREEMENT_REFUSALS = ['agreement_unverified'];", projectionTests],
  ['Agreement refusal: a commitment readback is not a recovery', projection, 'refusedSince(AGREEMENT_REFUSALS, gatePassed)', 'refusedSince(AGREEMENT_REFUSALS, commitmentRecovered)', projectionTests],
  ['Agreement refusal: a passed gate recovers', projection, 'refusedSince(AGREEMENT_REFUSALS, gatePassed)', 'refusedSince(AGREEMENT_REFUSALS, () => false)', projectionTests],
  ['Agreement refusal: row names the reason', projection, '`A later fresh Agreement check was refused (${agreementRefused}).`', "'A later fresh Agreement check was refused.'", projectionTests],
  ['Negotiate reason names every refusal', projection, "(${refused.join(', ')})", '(${refused[0]})', projectionTests],
  // Every recorded refusal kept in order and labelled.
  ['Every recorded refusal stays visible', projection, 'if (Object.hasOwn(recordedRefusals, entry.type)) {', 'if (Object.hasOwn(recordedRefusals, entry.type) && !refusedLater.has(entry.type)) {', projectionTests],
  ['Historical refusal label', projection, 'const historical = Boolean(recovery) &&', 'const historical = false &&', projectionTests],
  ['Refusal: a later recovery supersedes', projection, '(recoveredLater.has(recovery) || refusedAgain)', '(refusedAgain)', projectionTests],
  ['Refusal: a later refusal of the same kind supersedes', projection, '(recoveredLater.has(recovery) || refusedAgain)', '(recoveredLater.has(recovery) || false)', projectionTests],
  ['Gate refusals: only the same reason supersedes', projection, "(!GATE_REFUSALS.includes(entry.type) || reasons.has(entry.data?.reason))", 'true', projectionTests],
  ['Gate refusals: recovery follows the refused check (commitment recovery for all)', projection, "entry.data?.reason === 'commitment_unverified' ? 'commitmentRecovered' : 'gatePassed'", "'commitmentRecovered'", projectionTests],
  ['Gate refusals: recovery follows the refused check (gate only for all)', projection, "entry.data?.reason === 'commitment_unverified' ? 'commitmentRecovered' : 'gatePassed'", "'gatePassed'", projectionTests],
  ['Handoff refusal recovery', projection, "handoff_refused: () => 'gatePassed',", "handoff_refused: () => 'never',", projectionTests],
  ['Readback refusal recovery', projection, "readback_refused: () => 'settled'", "readback_refused: () => 'never'", projectionTests],
  ['Pointer rejection recovery', projection, "pointer_rejected: () => 'settled' };", "pointer_rejected: () => 'never' };", projectionTests],
  ['Unknown wallet outcomes are never superseded', projection, "handoff_refused: () => 'gatePassed',", "handoff_refused: () => 'gatePassed', wallet_error: () => 'settled',", projectionTests],
  ['Unknown readback-only outcomes are never superseded', projection, "handoff_refused: () => 'gatePassed',", "handoff_refused: () => 'gatePassed', handoff_readback_only: () => 'never',", projectionTests],
  ['Recovery: reissued handoff gate', projection, "const GATE_PASSED = ['payment_handoff', 'handoff_reissued'];", "const GATE_PASSED = ['payment_handoff'];", projectionTests],
  ['Approval is not a recovery', projection, "const GATE_PASSED = ['payment_handoff', 'handoff_reissued'];", "const GATE_PASSED = ['payment_handoff', 'handoff_reissued', 'approved'];", projectionTests],
  ['Latest payment attempt decides', projection, 'PAYMENT_PASSED.includes(paymentLatest?.outcome)', 'paymentAttempts.some((e) => PAYMENT_PASSED.includes(e.outcome))', projectionTests],
  ['Retained payment proof is historical', projection, '...(paymentRecorded && !paymentChecked ? superseded(', '...(false ? superseded(', projectionTests],
  ['Delivery failure is not a payment attempt', projection, "(e.step === 'delivery' && e.outcome === 'verified' &&", "(e.step === 'delivery' &&", projectionTests],
  ['Native delivery read verifies payment', projection, " || (e.step === 'delivery' && e.outcome === 'verified' && protocol?.nativeEvidence?.nativeReadback === 'present')", '', projectionTests],
  ['Only native delivery reads verify payment', projection, " && protocol?.nativeEvidence?.nativeReadback === 'present')", ')', projectionTests],
  ['Every negative attempt stays visible', projection, 'for (const event of events) {', 'for (const event of last.values()) {', projectionTests],
  ['Historical attempt label', projection, "current ? 'Current recorded attempt' : ", '', projectionTests],
  ['lastAttempt deduplicated', projection, 'if (attempt && !(final?.step === attempt.step', 'if (attempt && !(false && final?.step === attempt.step', projectionTests],
  ['Unrecorded lastAttempt kept', projection, 'if (attempt && !(final?.step', 'if (false && !(final?.step', projectionTests],
  ['Vet never inferred', projection, "vet.state = protocol?.limits?.vet ? 'held' : 'pending';", "vet.state = 'verified';", projectionTests],
  ['Agreement recorded check', projection, "agreement?.ref && last.get('agreement')?.outcome === 'anchored'", 'agreement?.ref', projectionTests],
  ['Commitment recorded check', projection, "commitment?.ref && last.get('commitment')?.outcome === 'verified'", 'commitment?.ref', projectionTests],
  ['Payment proof gate', projection, 'const paymentChecked = Boolean(payment?.ref &&', 'const paymentChecked = Boolean(true ||', projectionTests],
  ['Report proof gate', projection, "delivery?.deliverableRef && last.get('delivery')?.outcome === 'verified'", 'delivery?.deliverableRef', projectionTests],
  ['No finality from inclusion', projection, ": receipt ? 'included' : 'pending'", ": receipt ? 'finalized' : 'pending'", projectionTests],
  ['No completion from payment/delivery', projection, "verify.state = 'pending';", "verify.state = receipt || delivery ? 'completed' : 'pending';", projectionTests],
  ['Exact transaction evidence', projection, 'string(receipt?.transactionRef?.value) ?? string(txHash)', 'null', projectionTests],
  ['Exact block evidence', projection, 'block(receipt?.blockRef?.height) ?? block(blockNumber)', 'null', projectionTests],
  ['Exact artifact key', projection, 'string(ref?.anchor?.locator) ?? string(receipt?.logicalAddress) ?? string(key)', 'null', projectionTests],
  ['Exact artifact hash', projection, 'string(ref?.contentHash) ?? string(receipt?.contentHash) ?? string(hash)', 'null', projectionTests],
  ['Unknown attempt reason', projection, 'stages[index].reason = string(event.reason)', 'stages[index].reason = null', projectionTests],
  ['Later success clears old uncertainty', projection, 'const current = latestStageOutcome.get(index) === event;', 'const current = true;', projectionTests],
  ['Rejected stage preserved', projection, "stages[rejected].state = 'rejected';", '', projectionTests],
  ['Payment status disposition', projection, 'target.state = statusState;', '', projectionTests],
  ['Delivery hold reason', projection, 'settle.reason = string(delivery.evidenceHold.reason)', 'settle.reason = null', projectionTests],
  ['Native delivery evidence receipt gate', projection, 'Boolean(delivery.evidenceReceipt)', 'true', projectionTests],
  ['Agreement storage hold', projection, "negotiate.state = 'held';", '', projectionTests],
  ['Payment profile hold', projection, "settle.state = 'held'; settle.reason = 'Payment remains held in this profile.';", '', projectionTests],
  ['Unknown payment readback-only', projection, "if (statusState === 'unknown') target.reason += ' Original operation is readback-only; do not pay again.';", '', projectionTests],
  ['Planned Vet references', projection, ' ?? operation.state?.protocol?.planned?.draft?.parties', '', projectionTests],
  ['Recorded refusal evidence', projection, 'refusals[index].push({', 'void ({', projectionTests],
  ['Failed Listing recheck evidence', projection, "if (status === 'terms_changed' && Array.isArray(recorded?.checks))", 'if (false)', projectionTests],
  // One-pass refusal labelling, and a bounded attempt list per stage with a count of older attempts.
  ['One-pass labelling (per-refusal tail scan)', projection, 'recoveredLater.has(recovery) ||', 'history.slice(i + 1).some(RECOVERIES[recovery]) ||', projectionTests],
  ['Refusal rows listed in recorded order', projection, 'recentAttempts(items.reverse())', 'recentAttempts(items)', projectionTests],
  ['Attempt list bounded', projection, 'if (items.length <= ATTEMPT_ROWS) return', 'if (true) return', projectionTests],
  ['Refusal list bounded', projection, '...recentAttempts(items.reverse())', '...items.reverse().map((item) => item.row)', projectionTests],
  ['Protocol attempt list bounded separately', projection, 'stages[index].evidence.push(...recentAttempts(items)));', 'stages[index].evidence.push(...items.map((item) => item.row)));', projectionTests],
  ['Latest attempts listed', projection, '...items.slice(-ATTEMPT_ROWS).map(', '...items.slice(0, ATTEMPT_ROWS).map(', projectionTests],
  ['Count row counts omitted attempts', projection, 'check: `${older.length} earlier recorded attempts not listed`', 'check: `${ATTEMPT_ROWS} earlier recorded attempts not listed`', projectionTests],
  ['Count row is unknown with an omitted unknown outcome', projection, "const SEVERITY = ['unknown', 'rejected',", "const SEVERITY = ['rejected',", projectionTests],
  ['Count row counts current omitted refusals', projection, 'current: !historical,', 'current: false,', projectionTests],
  ['Count row counts omitted unknown outcomes', projection, 'unknown: !recovery,', 'unknown: false,', projectionTests],
  ['Count row names the history seq range', projection, ' ` (history seq ${first}–${last})` ', " '' ", projectionTests],
  ['Markup escaping', rendering, "child?.markup ?? escape(child)", "child?.markup ?? String(child)", renderingTests],
  ['Missing proof label', rendering, "? 'Missing proof' : String(value)", "? '' : String(value)", renderingTests],
  // portal.js mounts the ledger in two branches; each anchor's indentation picks one.
  ['Portal renderer hook: payment observed', 'public/portal/portal.js', '\n        renderShowcaseProgress(view.showcaseProgress, el),', '', renderingTests],
  ['Portal renderer hook: purchase', 'public/portal/portal.js', '\n      renderShowcaseProgress(view.showcaseProgress, el),', '', renderingTests],
  // The MCP hooks and the recorder below: the model-facing wrappers and the seller-failure branch.
  ['MCP renderer hook', 'src/mcp/ui.mjs', "+'</div>'+showcaseProgressHtmlForModel(d.showcaseProgress);purchaseAmount(", "+'</div>';purchaseAmount(", renderingTests],
  // DACS_SHOWCASE_LEDGER is src/switches/DACS_SHOWCASE_LEDGER.switch, parsed by config.mjs's shared flag code.
  ['Config default-off gate', 'src/config.mjs', "out[s.configKey] = env[s.env] === '1';", 'out[s.configKey] = true;', integrationTests],
  ['MCP projection hook', 'src/mcp/server.mjs', '      ...(config.showcaseLedger ? { showcaseProgress: showcaseProgressForModel(showcaseProgress({ operation, history: services.ops.history(operation.id), protocol: services.purchases.portalEvidence(operation).protocol, evidence: services.purchases.portalEvidence(operation) })) } : {}),', '', integrationTests],
  ['Portal projection hook', 'src/portal/routes.mjs', '    ...(config.showcaseLedger ? { showcaseProgress: showcaseProgress({ operation, history: purchases.status(operation.accountId, operation.id).history, protocol: purchases.portalEvidence(operation).protocol, evidence: purchases.portalEvidence(operation) }) } : {}),', '', integrationTests],
  // The Agreement read after payment, and handoff refusals matched on reason.
  ['Handoff refusals: only the same reason supersedes', projection, "const GATE_REFUSALS = ['commitment_recheck_refused', 'handoff_refused'];", "const GATE_REFUSALS = ['commitment_recheck_refused'];", projectionTests],
  ...[projectionTests, nativeTests].flatMap((tests) => [
    ['Native Agreement read: projector ignores the recorded code', projection, "refusedSince(AGREEMENT_REFUSALS, gatePassed) ?? (nativeRefused > history.findLastIndex(nativeRecovered) ? 'agreement_unverified' : null)", 'refusedSince(AGREEMENT_REFUSALS, gatePassed)', tests],
    ['Native Agreement read: every held read is a refusal', projection, "h.data?.outcome === 'held' && h.data?.code === 'agreement_unverified'", "h.data?.outcome === 'held'", tests],
    ['Native Agreement read: a verified native read recovers', projection, " || (h.type === 'protocol_native-evidence' && PAYMENT_PASSED.includes(h.data?.outcome))", '', tests],
  ]),
  ['Native Agreement read: a native delivery read recovers', projection, " || (h.type === 'protocol_delivery' && h.data?.outcome === 'verified');", ';', projectionTests],
  ['Native Agreement read: a passed gate recovers', projection, 'const nativeRecovered = (h) => gatePassed(h) || ', 'const nativeRecovered = (h) => ', projectionTests],
  ['Native Agreement read: recorder omits the code', 'src/dacs/protocol-purchases.mjs', 'error instanceof OperationError ? { code: error.code } : sellerFailureCause(', 'error instanceof OperationError ? undefined : sellerFailureCause(', nativeTests],
  ['Native Agreement read: recorder records seller-chosen codes', 'src/dacs/protocol-purchases.mjs', ': sellerFailureCause(error.causeCode) ? sellerFailureAttempt(error) : undefined', ': sellerFailureCause(error.causeCode) ? sellerFailureAttempt(error) : { code: error.code }', nativeTests],
  // The deadline-aware MCP protocol view and both switches' contract entries.
  // The entries now come from the switch files; a broken one is refused by validate-package.
  ['Merge keeps main\'s deadline-aware MCP protocol view', 'src/mcp/server.mjs', '{ protocol: services.purchases.portalEvidence(operation).protocol } : {}),', '{ protocol: protocolView(operation) } : {}),', 'test/delivery-deadline-watch.test.mjs'],
  ['Merge keeps DACS_DELIVERY_DEADLINE_WATCH in the env contract', 'src/switches/DACS_DELIVERY_DEADLINE_WATCH.switch', '"env": "DACS_DELIVERY_DEADLINE_WATCH"', '"env": "DACS_DELIVERY_DEADLINE_WATCH_DROPPED"', 'deploy/test/validate-package.test.mjs'],
  ['Merge keeps DACS_SHOWCASE_LEDGER in the env contract', 'src/switches/DACS_SHOWCASE_LEDGER.switch', '"env": "DACS_SHOWCASE_LEDGER"', '"env": "DACS_SHOWCASE_LEDGER_DROPPED"', 'deploy/test/validate-package.test.mjs'],
];
// A mutant that breaks loading is not a kill. Inside a test, a module SyntaxError has a loader
// frame in the failed result's own stack; a runtime SyntaxError (for example JSON.parse) can
// catch a real regression. Missing modules have their own code. Errors outside a test are on
// stderr. Assertion values, messages and a failing TODO's diagnostics do not supply these fields.
export const loadFailure = (run) => run.failures.some(({ fields, stack }) =>
  fields.includes("code: 'ERR_MODULE_NOT_FOUND'") || (fields.includes("name: 'SyntaxError'")
    && stack.some((frame) => /\bnode:internal\/modules\//.test(frame)))) || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(run.stderr);
// Classifies one child run, retrying incomplete results without ever counting them as kills.
export async function checkMutation(name, tests, options, expected) {
  if (!Array.isArray(expected) || !expected.length) throw new TypeError('expected test names are required for a mutant');
  let run, failing, attempts = 0;
  do {
    run = await runNodeTest(tests, { ...options, expected, onSpawn: (pid) => {
      console.log(`${name}: process group ${pid}`);
      options.onSpawn?.(pid);
    } });
    failing = [...run.tap.matchAll(/^not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1]);
    attempts += 1;
  } while (run.incomplete !== null && attempts < 3);
  return { name, tests, nodeVersion: run.nodeVersion, exit: run.exit, attempts, testCount: run.tests, pass: run.pass, fail: run.fail, incomplete: run.incomplete, failing,
    killed: killed(run) && !loadFailure(run) };
}

// An async function, not top-level await: require() refuses a module with top-level await.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) (async () => {
const mirror = mkdtempSync(join(tmpdir(), 'showcase-ledger-mutants-'));
const results = [];
try {
  for (const path of readdirSync(root)) if (path !== 'node_modules') cpSync(join(root, path), join(mirror, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(mirror, 'node_modules'), 'dir');
  for (const [name, path, before, after, tests] of mutations) {
    const file = join(mirror, path), source = readFileSync(file, 'utf8');
    // String.replace changes only the first match: an anchor must occur exactly once.
    const matches = source.split(before).length - 1;
    if (matches !== 1) throw new Error(`Mutation anchor ${matches ? `occurs ${matches} times` : 'missing'}: ${name}`);
    const options = { cwd: mirror, env: { ...process.env, NODE_ENV: 'test' }, timeoutMs: 900000, maxBuffer: 20_000_000 };
    // Each mutant run must report every test that the unmutated mirror's run of the file reports.
    const expected = await expectedTests(tests, { ...options,
      onSpawn: (pid) => console.log(`${name}: baseline process group ${pid}`) });
    writeFileSync(file, source.replace(before, after));
    let result;
    try { result = await checkMutation(name, tests, options, expected); }
    finally { writeFileSync(file, source); }
    results.push(result); console.log(JSON.stringify(result));
  }
} finally {
  rmSync(mirror, { recursive: true, force: true });
  if (process.argv[2]) writeFileSync(process.argv[2], results.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
if (results.some((result) => !result.killed)) process.exitCode = 1;
})();
