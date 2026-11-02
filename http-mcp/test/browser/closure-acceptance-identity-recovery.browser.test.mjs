// Closure acceptance, real Chromium, offline launcher, experimental embedded
// wallet (SIMULATED loopback fixtures only). Source-aware ordinary functional
// testing; NOT a security review, NOT live Demos testnet, NOT ChatGPT, NOT
// full v0.1 acceptance.
//
// User-visible recovery: when the built-in wallet refuses an identity
// request before signing, the person must be able to carry on in the same run,
// without restarting the launcher. Root cause before the repair: the wallet's
// pre-sign answer was classified as an unknown outcome, so the action stayed
// in flight (readback_pending, then outcome_unknown) and every later identity
// action for that wallet was refused with identity_operation_in_progress
// until a launcher restart. CA-R1a must fail on that behaviour.
// CA-R1b keeps the ambiguous-outcome rule: when the wallet was asked but its
// answer never reaches the server, the action stays open and blocks.
// CA-R1c: an action not yet sent to the wallet can be cancelled from the
// portal page, which frees the wallet.
// Trigger and expected results: test/helpers/closure-acceptance-identity.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupStack, launchBrowser, startLauncher, recordedContext, password, openUnlocked, approve, portalLog, step, accountWithEmbeddedWallet,
} from '../helpers/overnight-acceptance-browser.mjs';
import { ok, call, unique } from '../helpers/overnight-acceptance-flows.mjs';
import { IN_FLIGHT, FAILED_BEFORE_SEND, isClosedNotSent, portalStatus, publishProof, operationsFor, mistypedPost } from '../helpers/closure-acceptance-identity.mjs';

const root = cleanupStack();
let browser;

before(async () => {
  ({ browser } = await launchBrowser(root));
});
after(async () => root.run());

async function freshAccount(t) {
  const local = cleanupStack();
  t.after(() => local.run());
  const h = await startLauncher(local);
  const rec = await recordedContext(browser, local);
  const page = await rec.context.newPage();
  const pw = password();
  const { user, address } = await accountWithEmbeddedWallet(h, page, pw);
  return { h, rec, page, pw, user, address };
}

const web2 = async (h, user, address) => {
  const ids = await ok(h, user, 'get_identities', { walletAddress: address });
  const w = ids.wallets.find((x) => x.address === address);
  return { ids, claims: (w?.claims ?? []).filter((c) => c.kind === 'web2').map((c) => `${c.platform}:${c.handle}`).sort() };
};

// Counts approval dialogs inserted into the page from now on (passive).
const watchDialogs = (page) => page.evaluate(() => {
  window.__caDialogs = 0;
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.tagName === 'DIALOG' || n.querySelector?.('dialog'))) window.__caDialogs += 1;
  }).observe(document.documentElement, { childList: true, subtree: true });
});

// Portal steps of an add up to the proof step; returns the published proof URL.
async function addToProof(f, kind, handle) {
  const add = await ok(f.h, f.user, 'start_identity_action', { idempotencyKey: unique('ca-r1'), action: 'add', kind, walletAddress: f.address });
  await openUnlocked(f.page, add.portalUrl, f.pw, f.address);
  await f.page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await f.page.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
  await approve(f.page);
  const proofText = (await f.page.locator('#proof-text').innerText({ timeout: 10000 })).trim();
  const proofUrl = await publishProof(f.rec.context, f.h.fixtures.proofs, kind, handle, proofText);
  assert.equal(await portalStatus(f.page), 'awaiting_public_proof');
  return { add, proofUrl };
}

async function toReview(f, url) {
  await f.page.locator('#proof-url').fill(url);
  await f.page.getByRole('button', { name: 'Use this proof URL' }).click();
  await f.page.getByRole('button', { name: 'Approve in my wallet' }).waitFor({ timeout: 15000 });
  assert.equal(await portalStatus(f.page), 'review');
}

test('CA-R1a [C2,C5,C6] a pre-sign wallet refusal (mistyped post URL) closes the identity action truthfully; the same wallet adds the handle in the same run without a restart', { timeout: 240_000 }, async (t) => {
  const f = await freshAccount(t);
  const handle = `ca_tw_${Math.random().toString(36).slice(2, 6)}`;
  assert.deepEqual((await web2(f.h, f.user, f.address)).claims, [], 'precondition: nothing linked');

  const { add: first, proofUrl } = await addToProof(f, 'twitter', handle);
  await toReview(f, mistypedPost(proofUrl));
  await watchDialogs(f.page);
  await f.page.getByRole('button', { name: 'Approve in my wallet' }).click();
  const answer = f.page.locator('#wallet-answer[role="alert"]');
  await step(f.page, 'pre-sign refusal shown', () => answer.waitFor({ timeout: 30000 }));
  assert.equal(await f.page.evaluate(() => window.__caDialogs), 0, 'the wallet refused before any approval dialog');
  const text = (await answer.innerText()).replace(/\s+/g, ' ');
  t.diagnostic(`wallet answer: ${text.slice(0, 400)}`);
  assert.equal(await answer.getAttribute('data-wallet-code'), 'upstream_unavailable');
  assert.match(text, /nothing was signed/, 'the wallet\'s own message is shown');
  assert.match(text, /Nothing was signed or sent\./, 'says nothing was signed or sent');

  // Truthful terminal state: closed, nothing sent, no readback wait.
  const closedStatus = await portalStatus(f.page);
  t.diagnostic(`portal status after the refusal: ${closedStatus}`);
  assert.ok(isClosedNotSent(closedStatus), `expected a closed nothing-sent status (none of ${IN_FLIGHT.join('/')}, observed or expired); got "${closedStatus}"`);
  assert.equal(closedStatus, FAILED_BEFORE_SEND);
  assert.doesNotMatch(text, /identity_operation_in_progress/, 'the next-step text does not claim the wallet is blocked');
  assert.match(text, /closed/i, 'the next-step text says the action is closed');
  assert.match(text, /new identity action/i, 'the next-step text says a new identity action can be started');
  assert.equal(await f.page.getByRole('button', { name: 'Check chain again' }).count(), 0, 'no readback wait is offered for an action that sent nothing');
  const listed = operationsFor((await web2(f.h, f.user, f.address)).ids, f.address).find((o) => o.operationId === first.operationId);
  assert.equal(listed?.status, closedStatus, 'get_identities reports the same closed status');
  assert.notEqual(listed?.walletOutcome, 'wallet_reported_success');

  // Reload: the explanation and closed state survive; the wallet is not asked again.
  await f.page.reload();
  await answer.waitFor({ timeout: 15000 });
  assert.match(await answer.innerText(), /nothing was signed/);
  assert.equal(await portalStatus(f.page), closedStatus, 'same closed status after reload');
  assert.equal(await f.page.getByRole('button', { name: 'Approve in my wallet' }).count(), 0, 'no second wallet request is offered');

  // Same wallet, same run (the first action is still listed, so no restart
  // happened): a new add starts and completes with the correct post URL.
  const next = await call(f.h, f.user, 'start_identity_action', { idempotencyKey: unique('ca-r1-next'), action: 'add', kind: 'twitter', walletAddress: f.address });
  assert.equal(next.kind, 'ok', `next identity action on the same wallet starts (got ${next.kind} ${next.code ?? ''}: ${String(next.message ?? '').slice(0, 160)})`);
  assert.notEqual(next.data.operationId, first.operationId, 'a new action, not the closed one');
  assert.equal(next.data.status, 'prepared');
  await openUnlocked(f.page, next.data.portalUrl, f.pw, f.address);
  await f.page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await toReview(f, proofUrl);
  await step(f.page, 'Twitter add with the correct post URL', async () => {
    await f.page.getByRole('button', { name: 'Approve in my wallet' }).click();
    await approve(f.page, ['addTwitterIdentity', handle, f.address]);
    await f.page.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
  });
  const after = await web2(f.h, f.user, f.address);
  assert.deepEqual(after.claims, [`twitter:${handle}`], 'independent readback: the handle is linked once, by the second action');
  const ops = operationsFor(after.ids, f.address);
  assert.equal(ops.find((o) => o.operationId === first.operationId)?.status, closedStatus, 'the refused action stays closed');
  assert.equal(ops.find((o) => o.operationId === next.data.operationId)?.status, 'association_observed');
  const off = f.rec.requests.filter((r) => !r.url.startsWith('blob:') && ![f.h.origin, f.h.fixtures.proofs].some((o) => r.url.startsWith(`${o}/`)));
  assert.deepEqual(off.map((r) => new URL(r.url).origin), [], 'every request stayed on the launched loopback origins');
});

// Closing the tab is NOT used here: the embedded wallet locks on pagehide and
// answers "locked" (a documented pre-send code), so that is not ambiguous. The
// ambiguous case is a wallet request whose answer never reaches the server:
// the portal's report call is lost in transit (controlled fault injection of
// the page's own request, nothing else changed).
test('CA-R1b [C5] ambiguous outcome retained: a wallet answer that never reaches the server keeps the action in flight; a new action is refused; the wallet is not asked again', { timeout: 180_000 }, async (t) => {
  const f = await freshAccount(t);
  const handle = `ca-amb-${Math.random().toString(36).slice(2, 6)}`;
  const { add, proofUrl } = await addToProof(f, 'github', handle);
  await toReview(f, proofUrl);
  let lost = 0;
  await f.page.route('**/portal/api/identity/*/report', (route) => {
    lost += 1;
    return route.abort('connectionfailed');
  });
  await f.page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await f.page.locator('dialog').getByRole('button', { name: /^reject$/i }).click({ timeout: 20000 });
  await f.page.locator('#log .bad').first().waitFor({ timeout: 20000 });
  assert.equal(lost, 1, 'exactly one report was attempted and lost');
  await f.page.close();

  const listed = operationsFor((await web2(f.h, f.user, f.address)).ids, f.address).find((o) => o.operationId === add.operationId);
  t.diagnostic(`status with no wallet report: ${listed?.status}`);
  assert.ok(['wallet_requested', 'readback_pending', 'outcome_unknown'].includes(listed?.status), `still in flight (got ${listed?.status})`);
  const next = await call(f.h, f.user, 'start_identity_action', { idempotencyKey: unique('ca-r1b-next'), action: 'add', kind: 'twitter', walletAddress: f.address });
  assert.equal(next.kind, 'tool_error');
  assert.equal(next.code, 'identity_operation_in_progress', 'an unreported wallet request still blocks new identity actions');

  const again = await f.rec.context.newPage();
  await again.goto(add.portalUrl);
  await again.locator('#flow dl').waitFor({ timeout: 15000 });
  const status = await portalStatus(again);
  assert.ok(['wallet_requested', 'readback_pending', 'outcome_unknown'].includes(status), `reopened portal shows in flight (got ${status})`);
  assert.equal(await again.getByRole('button', { name: 'Approve in my wallet' }).count(), 0, 'the wallet is not asked a second time');
  assert.equal(await again.locator('#identity-cancel').count(), 0, 'no cancel is offered once the wallet was asked');
  assert.ok(!/start a new identity action/i.test(await again.locator('#flow').innerText()), 'not described as closed');
  t.diagnostic(`reopened portal log: ${(await portalLog(again)).slice(-200)}`);
  assert.deepEqual((await web2(f.h, f.user, f.address)).claims, [], 'readback: nothing linked');
});

test('CA-R1c [C5,C6] an identity action not yet sent to the wallet is cancelled from the portal page; the wallet is free for a new action', { timeout: 180_000 }, async (t) => {
  const f = await freshAccount(t);
  const { add } = await addToProof(f, 'github', `ca-cx-${Math.random().toString(36).slice(2, 6)}`);
  // Accepting control: while it is open, the wallet is blocked.
  const blocked = await call(f.h, f.user, 'start_identity_action', { idempotencyKey: unique('ca-r1c-blocked'), action: 'add', kind: 'twitter', walletAddress: f.address });
  assert.equal(blocked.code, 'identity_operation_in_progress', 'an open action blocks a new one');
  const accept = (d) => d.accept();
  f.page.on('dialog', accept); // a native confirmation, if the page asks, is confirmed as a person would
  try {
    await f.page.getByRole('button', { name: 'Cancel this identity action' }).click({ timeout: 15000 });
    await f.page.waitForFunction(() => [...document.querySelectorAll('#flow dl dt')].some((dt) => dt.textContent === 'Status' && dt.nextElementSibling?.textContent === 'cancelled'), null, { timeout: 15000 });
  } finally {
    f.page.off('dialog', accept);
  }
  assert.equal(await f.page.getByRole('button', { name: 'Use this proof URL' }).count(), 0, 'the cancelled action offers no further step');
  await f.page.reload();
  await f.page.locator('#flow dl').waitFor({ timeout: 15000 });
  assert.equal(await portalStatus(f.page), 'cancelled', 'cancelled survives a reload');
  const listed = operationsFor((await web2(f.h, f.user, f.address)).ids, f.address).find((o) => o.operationId === add.operationId);
  assert.equal(listed?.status, 'cancelled');
  const next = await call(f.h, f.user, 'start_identity_action', { idempotencyKey: unique('ca-r1c-next'), action: 'add', kind: 'twitter', walletAddress: f.address });
  assert.equal(next.kind, 'ok', `the wallet starts a new identity action (got ${next.code ?? next.kind})`);
  t.diagnostic(`portal log: ${(await portalLog(f.page)).slice(-200)}`);
  assert.deepEqual((await web2(f.h, f.user, f.address)).claims, [], 'readback: nothing linked');
});
