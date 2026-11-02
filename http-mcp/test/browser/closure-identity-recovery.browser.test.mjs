// Closure (identity recovery), real Chromium + the offline launcher + the
// built-in (embedded) wallet + the trusted portal, as a tester uses them.
// Accepting controls first: GitHub and Twitter add/remove with a reload.
// Then the repaired recovery paths: an impossible GitHub handle is refused at
// the proof step and corrected in the same action; a wallet failure before
// broadcast (unpublished post) closes the action, explains it (also in a fresh
// tab, from the server's record) and a corrected fresh action for the same
// wallet succeeds without restarting anything; a pre-wallet action is
// cancelled from the keyboard. SIMULATED fixtures only; not live, not ChatGPT,
// not a security review. Browser: exactly DACS_TEST_CHROME.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserPrerequisites, cleanupStack, launchBrowser, startLauncher, recordedContext, accountWithEmbeddedWallet,
  openUnlocked, approve, password, portalLog, step, focusAndPress,
} from '../helpers/overnight-acceptance-browser.mjs';
import { ok, call, unique } from '../helpers/overnight-acceptance-flows.mjs';

const cleanups = cleanupStack();
let h;
let rec;
let page;
let pw;
let user;
let address;

before(async () => {
  const problems = browserPrerequisites();
  if (problems.length) throw new Error(`real browser required: ${problems.join('; ')}`);
  const { browser, version } = await launchBrowser(cleanups);
  process.stderr.write(`closure identity browser: ${process.env.DACS_TEST_CHROME} version ${version}\n`);
  h = await startLauncher(cleanups);
  rec = await recordedContext(browser, cleanups);
  page = await rec.context.newPage();
  pw = password();
  ({ user, address } = await accountWithEmbeddedWallet(h, page, pw));
});

after(async () => {
  await cleanups.run();
});

// Publishes proof text on the SIMULATED proof publisher (JSON form of its page).
async function publish(kind, username, proof) {
  const res = await fetch(`${h.fixtures.proofs}/api/proofs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, username, proof }) });
  assert.equal(res.status, 200, `proof publisher answered ${res.status}`);
  return (await res.json()).proofUrl;
}

async function startAction(args) {
  return ok(h, user, 'start_identity_action', { idempotencyKey: unique('cl-id'), walletAddress: address, ...args });
}

const status = async (p = page) => (await p.locator('#flow dl dd').first().innerText()).trim();
const actionLabels = (p = page) => p.evaluate(() => [...document.querySelectorAll('button[data-action]')].map((b) => b.textContent.trim()));

// Opens an identity action, unlocks, connects and confirms the wallet; for an
// add it then fetches the proof text from the wallet (one approval).
async function openAction(start, { proof = true } = {}) {
  await openUnlocked(page, start.portalUrl, pw, address);
  await page.getByRole('button', { name: 'Use my connected wallet' }).click();
  if (start.action !== 'add' || !proof) return null;
  await page.getByRole('button', { name: 'Get proof text from my wallet' }).click();
  await approve(page, ['getWeb2IdentityProofPayload']);
  return (await page.locator('#proof-text').innerText({ timeout: 10000 })).trim();
}

async function useProof(url) {
  await page.locator('#proof-url').fill(url);
  await page.getByRole('button', { name: 'Use this proof URL' }).click();
}

async function approveAndObserve(method, handle, done) {
  await page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await approve(page, [method, handle]);
  await page.getByText(done).waitFor({ timeout: 30000 });
}

const handles = async (kind) => {
  const ids = await ok(h, user, 'get_identities', { walletAddress: address });
  return (ids.wallets[0].claims ?? []).filter((c) => c.kind === 'web2' && c.platform === kind).map((c) => c.handle);
};

test('accepting control: GitHub and Twitter add then remove through the portal, with the cancel control present but unused, and a reload of a finished action', { timeout: 240_000 }, async () => {
  for (const [kind, handle, method] of [['github', 'closure-ok', 'addGithubIdentity'], ['twitter', 'closure_ok', 'addTwitterIdentity']]) {
    await step(page, `${kind} add`, async () => {
      const add = await startAction({ action: 'add', kind });
      const proof = await openAction(add);
      await useProof(await publish(kind, handle, proof));
      await page.getByRole('button', { name: 'Approve in my wallet' }).waitFor({ timeout: 15000 });
      // The new control is secondary: approval labels are unchanged.
      assert.deepEqual(await actionLabels(), ['Approve in my wallet (SIMULATED fixture)']);
      assert.equal(await page.locator('#identity-cancel[data-secondary-action]').count(), 1);
      await approveAndObserve(method, handle, 'Association observed on chain.');
      await page.reload();
      await page.getByText('Association observed on chain.').waitFor({ timeout: 15000 });
      assert.equal(await page.locator('#identity-cancel').count(), 0, 'no cancel once finished');
      assert.deepEqual(await handles(kind), [handle]);
    });
  }
  for (const [kind, handle] of [['github', 'closure-ok'], ['twitter', 'closure_ok']]) {
    await step(page, `${kind} remove`, async () => {
      const rm = await startAction({ action: 'remove', kind, username: handle });
      await openAction(rm);
      await approveAndObserve('removeWeb2Identity', handle, 'Association no longer observed on chain.');
      assert.deepEqual(await handles(kind), []);
    });
  }
});

test('invalid input: an impossible GitHub handle is refused at the proof step (nothing sent to the wallet); the corrected URL completes the same action', { timeout: 120_000 }, async () => {
  const add = await startAction({ action: 'add', kind: 'github' });
  const proof = await openAction(add);
  const bad = await publish('github', 'closure_bad', proof);
  const dialogsBefore = await page.locator('dialog').count();
  await useProof(bad);
  await page.locator('#log .bad').getByText(/“closure_bad” cannot be a GitHub username/).waitFor({ timeout: 15000 });
  assert.match(await portalLog(page), /Nothing was sent to your wallet/);
  assert.equal(await status(), 'awaiting_public_proof', 'still the proof step');
  assert.equal(await page.getByRole('button', { name: 'Use this proof URL' }).count(), 1);
  assert.equal(await page.locator('dialog').count(), dialogsBefore, 'no wallet dialog opened');

  await useProof(await publish('github', 'closure-good', proof));
  await approveAndObserve('addGithubIdentity', 'closure-good', 'Association observed on chain.');
  assert.deepEqual(await handles('github'), ['closure-good']);
  const ids = await ok(h, user, 'get_identities', { walletAddress: address });
  assert.equal(ids.operations.find((o) => o.operationId === add.operationId).status, 'association_observed');
});

test('wallet stopped before broadcast: an unpublished post closes the action as failed_before_send with an explanation (also in a fresh tab); a corrected fresh action for the same wallet succeeds without a restart', { timeout: 150_000 }, async () => {
  const first = await startAction({ action: 'add', kind: 'twitter' });
  await openAction(first, { proof: false });
  await useProof('https://x.com/closure_late/status/424242');
  await page.getByRole('button', { name: 'Approve in my wallet' }).click();
  const answer = page.locator('#wallet-answer[role="alert"]');
  await answer.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('dialog').count(), 0, 'the wallet failed before asking for approval');
  assert.equal(await answer.getAttribute('data-wallet-code'), 'upstream_unavailable');
  const text = (await answer.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /nothing was signed \(upstream_unavailable\)\. Nothing was signed or sent\./);
  assert.match(text, /This action is closed and nothing was retried/);
  assert.match(text, /start a new identity action for this wallet/);
  assert.doesNotMatch(text, /identity_operation_in_progress/);
  assert.equal(await status(), 'failed_before_send');
  assert.equal(await page.getByRole('button', { name: 'Check chain again' }).count(), 0, 'nothing left to wait for');
  assert.match(await portalLog(page), /Wallet result recorded: failed_before_send\./);

  // A fresh tab has no tab memory of which wallet answered: the explanation
  // comes from the server's record.
  const fresh = await rec.context.newPage();
  await fresh.goto(first.portalUrl);
  await fresh.locator('#wallet-answer').getByText('Nothing was signed or sent.').waitFor({ timeout: 15000 });
  assert.equal(await status(fresh), 'failed_before_send');
  await fresh.close();

  // The person publishes the post, then starts again for the SAME wallet.
  const second = await call(h, user, 'start_identity_action', { idempotencyKey: unique('cl-id'), action: 'add', kind: 'twitter', walletAddress: address });
  assert.equal(second.kind, 'ok', `a new action is allowed: ${second.code ?? ''} ${second.message ?? ''}`);
  const proof = await openAction(second.data);
  await useProof(await publish('twitter', 'closure_late', proof));
  await approveAndObserve('addTwitterIdentity', 'closure_late', 'Association observed on chain.');
  assert.deepEqual(await handles('twitter'), ['closure_late']);
});

test('cancel before the wallet is asked, from the keyboard: the action is closed, nothing reaches the wallet, and the wallet can start a new action', { timeout: 120_000 }, async () => {
  const add = await startAction({ action: 'add', kind: 'github' });
  await openAction(add, { proof: false });
  const blocked = await call(h, user, 'start_identity_action', { idempotencyKey: unique('cl-id'), action: 'add', kind: 'twitter', walletAddress: address });
  assert.equal(blocked.code, 'identity_operation_in_progress');
  assert.match(blocked.message, /cancel it on its portal page/);
  await focusAndPress(page, page.locator('#identity-cancel'));
  await page.getByText('Identity action cancelled. Nothing was sent to your wallet.').waitFor({ timeout: 15000 });
  assert.equal(await status(), 'cancelled');
  assert.match(await page.locator('#flow').innerText(), /before your wallet was asked/);
  assert.equal(await page.locator('dialog').count(), 0);
  assert.deepEqual(await actionLabels(), [], 'nothing left to do on a cancelled action');
  await page.reload();
  await page.locator('#flow dl dd').first().getByText('cancelled', { exact: true }).waitFor({ timeout: 15000 });
  const next = await call(h, user, 'start_identity_action', { idempotencyKey: unique('cl-id'), action: 'add', kind: 'twitter', walletAddress: address });
  assert.equal(next.kind, 'ok', `${next.code ?? ''} ${next.message ?? ''}`);
  assert.equal(next.data.status, 'prepared');
});

test('portal hygiene over the whole run: the only console errors are the expected 409 of the refused proof step; the wallet password never left the wallet UI', async () => {
  assert.deepEqual(rec.consoleErrors, ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
  assert.ok(!rec.requests.some((r) => r.url.includes(pw) || r.body.includes(pw)), 'password not in any request');
});
