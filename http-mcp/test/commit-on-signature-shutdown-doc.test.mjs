import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// docs/commit-on-signature.md scopes the owned stop's approval cut and its
// approval deadline to what operator.mjs does. If that order changes, the
// paragraph must change with it.
const flat = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const doc = flat('../docs/commit-on-signature.md'), operator = flat('../src/devnet-demo/operator.mjs');
const sellerDoc = flat('../docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md'), compose = flat('../deploy/compose.yaml');
const at = (text) => { const index = operator.indexOf(text); assert.notEqual(index, -1, `operator.mjs has ${text}`); return index; };

test('the code: the approval cut comes after the evidence-resume wait and, switch on, after admitted seller requests', () => {
  assert.ok(at('await stopEvidenceResume();') < at('await closeSourceAfterDrain();'), 'close() awaits a resume pass before the drain and the cut');
  assert.ok(at('await settled([admitted.seller]);') < at('const stopPlans=async()=>{ approvalStop.abort();'), 'switch on, the drain awaits admitted seller requests');
  assert.ok(at('await drainRequests(); await stopPlans();') > 0, 'the cut runs only after the drain');
});

test('the code: the approval deadline starts with close(), before those waits, and cuts approvals asked before it; later asks share one window', () => {
  assert.ok(at('const SHUTDOWN_APPROVAL_DEADLINE_MS=15*1000;') > 0);
  assert.ok(at('laneMs:SHUTDOWN_LANE_UNWIND_MS,approvalMs:SHUTDOWN_APPROVAL_DEADLINE_MS};') > 0, 'production uses the fixed deadline');
  assert.ok(at('const timer=setTimeout(()=>approvalDeadline.abort(),shutdownTimer.approvalMs);') > 0);
  assert.ok(at('if(approvalStop.signal.aborted||!closeStarted)return AbortSignal.any([approvalStop.signal,approvalDeadline.signal]);') > 0, 'an approval asked before close is cut at the shared deadline');
  assert.ok(at('if(!lateApprovals){ const late=lateApprovals=new AbortController();') < at('else setTimeout(()=>late.abort(),shutdownTimer.approvalMs).unref(); } return AbortSignal.any([approvalStop.signal,lateApprovals.signal]);'),
    'the first ask after close started opens the one late window; every later ask shares it');
  assert.doesNotMatch(operator, /own\.abort\(\)/, 'no ask after close started has a window of its own');
  assert.ok(at('close(){return shutdown??=(async()=>{ const cancelApprovalDeadline=startApprovalDeadline(); closed=true;') < at('await stopDeadlineWatch?.();await stopEvidenceResume();'), 'the deadline starts before close awaits anything');
  assert.ok(at('} finally { cancelApprovalDeadline();') > at('await policyApplication?.close();'), 'it is cancelled only once close has settled');
});

test('the bound is half the documented supervisor stop grace', () => {
  const grace = /stop_grace_period: (\d+)s/.exec(compose)?.[1], deadline = /const SHUTDOWN_APPROVAL_DEADLINE_MS=(\d+)\*1000;/.exec(operator)?.[1];
  assert.equal(grace, '30', 'deploy/compose.yaml stop_grace_period');
  assert.equal(Number(deadline) * 2, Number(grace), 'the approval deadline is half that grace');
  assert.match(doc, /It is half the 30-second `stop_grace_period` in `deploy\/compose\.yaml`/);
});

test('the doc names the waits the cut does not end, the deadline that does, the plan bound limit and the remaining unbounded stops', () => {
  assert.match(doc, /The cut comes after two waits that have no bound of their own:/);
  assert.match(doc, /\*\*A delivery-evidence resume pass\.\*\* With `sellerDeliveryEvidence` on, a pass in flight is awaited at the start of shutdown, before the grace\./);
  assert.match(doc, /\*\*Switch on: an admitted seller request\.\*\* These are awaited until they end \(above\), and that includes an approval waiting inside one\. With the switch off, the cut does end it after the grace\./);
  assert.match(doc, /So a manual seller approval already waiting when `close\(\)` starts also has an absolute deadline: \*\*15 seconds after `close\(\)` starts\*\*, whatever shutdown is then waiting for, including those two waits, a manual approval still waiting ends undecided exactly as at the cut\. The first approval asked after `close\(\)` started opens one late window of 15 seconds from that ask\. Every later ask gets only what remains of that same window, and once it has ended a new ask ends undecided at once, without being asked\. However many admitted writes ask in turn, their approvals end within 15 seconds of the first of them\./);
  assert.doesNotMatch(doc, /has 15 seconds from when it is asked instead|or 15 s after it is asked if that is later/);
  // A write that first asks after the deadline is asked only within the one late window.
  assert.match(doc, /yet an admitted write that first asks after that deadline can still be asked, within the one late window:/);
  assert.doesNotMatch(doc, /only asks after the deadline is still asked/);
  assert.match(doc, /A cut is not an operator decision: the approval ends with `operator_closing`, the seller approval evidence records nothing for it \(no `rejected` line\), nothing is signed or sent, and a later answer is ignored\./);
  assert.match(doc, /A write whose approval is cut keeps its journaled intent at stage `closing` \(no transaction hash\), never `denied`\./);
  assert.doesNotMatch(doc, /ends unapproved|refused the same way|stage `denied`, with no transaction hash/);
  assert.match(doc, /The holder then unwinds, releasing its lane locks and the seller's `seller-state\.sqlite` job lock, and shutdown goes on\. The deadline is fixed; no setting changes it\./);
  assert.match(doc, /With the switch on it falls inside the 30-second app grace; the first seller request that asks for a manual approval after it still has 15 seconds from that ask, and later ones share that window\./);
  assert.match(doc, /A plan step that ends within those 10 seconds writes nothing after the source closes\. A plan step still running when they end .* can still write its artifact-journal `issued` or error record and its attempt note after the source closes\./);
  assert.match(doc, /\| off \|[^|]*\|[^|]*\*\*50 s\*\* with a plan step still running at the grace; a delivery-evidence resume pass in flight is awaited first, up to the 15 s approval deadline while it waits for a manual approval and with no upper bound while it waits for its current holder \(below\) \|/);
  assert.match(doc, /\| on \|[^|]*\|[^|]*no upper bound while an admitted seller request waits \(for inclusion,[^|]*\) or a delivery-evidence resume pass waits for its current holder; a manual approval inside either ends at the 15 s deadline, or, if asked after `close\(\)` started, within 15 s of the first such ask \|/);
  assert.match(doc, /No finite timeout covers every case with the switch on, nor in either setting while a resume pass waits for its current holder\./);
});

test('the doc says an accepted switch-off CREATE is never re-signed but may be resent once by the resend recovery after proven absence', () => {
  assert.doesNotMatch(doc, /never re-signed or resent/);
  assert.match(doc, /A seller CREATE that Node2 already accepted is then never re-signed: the next start reads its retained hash back\. If that readback shows it pending, the seller's resend recovery may resend the identical signed bytes once, only after proving the transaction absent and the nonce unconsumed/);
});

test('the doc names the seller_locks row a kill before the deadline leaves, its lease reclaim and its explicit release', () => {
  assert.match(doc, /A kill before the approval deadline, while a manual approval waits inside a seller job \(a stop timeout under 15 seconds, a SIGKILL\), also leaves that job's row in the `seller_locks` table of `seller-state\/seller-state\.sqlite`/);
  assert.match(doc, /the next request or resume pass for that job reclaims it once the row's holder lease shows the killed process has exited on this boot, even if its PID is in use again \(for example when a container runs the operator as PID 1 again\)/);
  assert.match(doc, /that job answers `seller_state_busy`, with a notice on stderr\. Such a row is released explicitly with `releaseAbandonedLock\(\{ job, owner \}\)`, after the checks in "Abandoned seller-state locks"/);
  assert.doesNotMatch(doc, /no supported way to release it|only when no process with that PID exists/);
  assert.doesNotMatch(sellerDoc, /which the documented abandoned-lock procedure does not cover/);
  assert.match(sellerDoc, /demo launchers are retired in v2/);
  assert.match(sellerDoc, /15 seconds after `close\(\)` starts it ends undecided \(`operator_closing`\), and the pass then ends/);
  assert.match(sellerDoc, /The evidence keeps its retained intent at stage `closing`, never `denied`, so the next start's pass asks the operator again/);
  assert.match(sellerDoc, /A kill before the deadline \(a SIGKILL\) leaves that job's row in the `seller_locks` table of `seller-state\.sqlite`: the next request for that job reclaims it once the row's holder lease shows the killed process has exited, and a row nothing can prove abandoned is released with `releaseAbandonedLock\(\{ job, owner \}\)`/);
});

test('the seller policy doc: a listen after the owned stop is refused as closing, a second listen while running as already listening', () => {
  assert.ok(at("if(closed)throw closing(); if(listenStarted)throw Object.assign(new Error('operator listeners start once; create a new operator to listen again'),{code:'operator_already_listening'});") > 0, 'listen() checks closed before listenStarted');
  assert.match(sellerDoc, /An operator listens once: a second `listen`, while the first is starting or while it runs, fails with `operator_already_listening`\. A `listen` once shutdown has started, including after the owned stop, fails with `operator_closing`\. Neither opens anything\./);
  assert.doesNotMatch(sellerDoc, /after its listeners closed, fails with `operator_already_listening`/);
});

test('the doc: a cut Deliverable is asked again only on the artifact anchor\'s in-process proof of the cut', () => {
  // The resume pass re-asks held delivery evidence only; a Deliverable waits for the next seller request or verify_deal.
  assert.match(doc, /the next publish of the same artifact \(the next seller request or the next `verify_deal` for that purchase; for held delivery evidence also the operator's resume pass\) asks the operator again/);
  assert.doesNotMatch(doc, /the next start's resume pass, the next seller request/);
  assert.match(doc, /A cut Deliverable is asked again the same way, by the next seller request or `verify_deal`: the resume pass runs only for purchases at `delivery-ready` with evidence pending, so it never re-asks a Deliverable\. Its delivery runner is left ambiguous, which otherwise holds a paid purchase read-back-only\. The seller re-runs delivery only when the artifact anchor proves the cut itself: a `closing` intent exactly as the cut wrote it \(`operator_closing`, no hash\) and no signed transaction for its address retained by the source or the seller wallet\. That proof is an in-process value, never a journal field\. Every other absent, unknown, issued or broadcast Deliverable stays read-back-only, including the `intent` a crash leaves while the wallet is still asking\./);
});

test('the doc: a cut pay-dem approval is indeterminate, never rejected, and only read back', () => {
  assert.match(doc, /A payment-evidence \(`pay-dem`\) approval cut by shutdown records nothing and signs nothing, and the seller records its answer as `indeterminate` \(`operator_closing`\), never `rejected`\. It is not asked again: its handoff was issued before the wallet was asked, so, as after a crash at that point, later calls only read it back\./);
});
