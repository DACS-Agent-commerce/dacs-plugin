// Overnight ORDINARY functional acceptance in real Chromium against the
// INSTALLED user path: the offline launcher (bin/offline-fixtures/operator.mjs
// with the guided dashboard), the trusted portal pages and the experimental
// embedded wallet (bundled Demos SDK signing in the page). SIMULATED loopback
// fixtures only. Source-aware; NOT a security review, NOT live Demos testnet,
// NOT ChatGPT, NOT full v0.1 acceptance.
//
// Missing DACS_TEST_CHROME or DACS_TEST_DOWNLOAD_PARENT is a FAILURE, never a
// skip. Clause map and expected results: docs/OVERNIGHT-FUNCTIONAL-TESTS.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  browserPrerequisites, cleanupStack, launchBrowser, startLauncher, recordedContext, password, createOnWalletPage, useEmbedded,
  unlock, connect, openUnlocked, approve, reject, portalLog, step, accountWithEmbeddedWallet, dashboard, dashboardSignIn, popupFrom, tabStops, focusAndPress,
} from '../helpers/overnight-acceptance-browser.mjs';
import { ok, call, unique, demToOs } from '../helpers/overnight-acceptance-flows.mjs';

const root = cleanupStack();
let browser;
let downloads;

before(async () => {
  const problems = browserPrerequisites();
  assert.deepEqual(problems, [], 'browser prerequisites');
  ({ browser, downloads } = await launchBrowser(root));
});
after(async () => root.run());

const strip0x = (s) => String(s ?? '').toLowerCase().replace(/^0x/, '');

// Fresh launcher + fresh browser context, the throwaway wallet created on the
// built-in wallet page opened from the dashboard, and the dashboard tab.
async function freshTester(t) {
  const local = cleanupStack();
  t.after(() => local.run());
  const logs = [];
  const h = await startLauncher(local, logs);
  const rec = await recordedContext(browser, local);
  const page = await rec.context.newPage();
  const d = dashboard(page);
  const res = await page.goto(h.dashboardUrl);
  assert.equal(res.status(), 200);
  await d.waitText('health-status', /^Running \(fixture chain configured, fixture directory configured\)$/);
  await page.waitForFunction(() => document.getElementById('wallet-link')?.getAttribute('href') !== '#', null, { timeout: 10000 });
  return { h, rec, d, logs, local };
}

async function createThrowawayWallet(rec, d) {
  const pw = password();
  const [w] = await Promise.all([rec.context.waitForEvent('page', { timeout: 15000 }), d.page.getByRole('link', { name: 'Open the built-in wallet page', exact: true }).click()]);
  await w.waitForLoadState('domcontentloaded');
  const address = await createOnWalletPage(w, pw);
  await w.close();
  return { pw, address };
}

test('OA-B1 [C1,C6] keyboard-only dashboard steps, wallet input errors, Escape-declined sign-in, retained unlock, keyboard approval', { timeout: 180_000 }, async (t) => {
  const { h, rec, d } = await freshTester(t);
  const page = d.page;
  // C1: persistent simulation labels.
  const banner = await page.getByRole('banner').innerText();
  for (const label of ['SIMULATED ONLY', 'No real funds', 'Not Demos testnet', 'Not ChatGPT', 'Not security reviewed']) assert.ok(banner.includes(label), `banner shows "${label}"`);
  assert.equal(await page.locator('input[type=password]').count(), 0, 'the dashboard never asks for a password');

  // Keyboard: the first stops are the skip link, the wallet page link and Sign in;
  // steps that need sign-in are not reachable (disabled) yet.
  // Window wide enough for the steps navigation added before step 1.
  const stops = await tabStops(page, 30);
  t.diagnostic(`tab stops before sign-in: ${JSON.stringify(stops)}`);
  assert.equal(stops[0], 'Skip to steps');
  for (const name of ['Open the built-in wallet page', 'Sign in', 'Find test service']) assert.ok(stops.includes(name), `Tab reaches "${name}"`);
  assert.ok(!stops.includes('Prepare simulated purchase'), 'Prepare is not reachable before sign-in');

  // Wallet page opened with the keyboard; ordinary create-form input errors, then the accepting control.
  const [w] = await Promise.all([rec.context.waitForEvent('page', { timeout: 15000 }), focusAndPress(page, page.getByRole('link', { name: 'Open the built-in wallet page', exact: true }))]);
  await w.waitForLoadState('domcontentloaded');
  const createForm = w.locator('form').filter({ has: w.getByRole('button', { name: /^create wallet$/i }) });
  const fields = createForm.locator('input[type="password"]');
  await fields.first().waitFor({ timeout: 20000 });
  await createForm.getByRole('button', { name: /^create wallet$/i }).click();
  assert.equal(await fields.first().evaluate((el) => el.validity.valueMissing && el.validationMessage.length > 0), true, 'an empty password is refused with the browser\'s required-field message');
  await fields.nth(0).fill('abc');
  await fields.nth(1).fill('abc');
  await createForm.getByRole('button', { name: /^create wallet$/i }).click();
  await w.getByRole('alert').filter({ hasText: /Use a password of at least \d+ characters\./ }).waitFor({ timeout: 10000 });
  const pw = password();
  await fields.nth(0).fill(pw);
  await fields.nth(1).fill(`${pw}x`);
  await createForm.getByRole('button', { name: /^create wallet$/i }).click();
  await w.getByRole('alert').filter({ hasText: 'The two passwords do not match.' }).waitFor({ timeout: 10000 });
  assert.equal(await w.getByRole('heading', { name: /^wallet unlocked$/i }).count(), 0, 'no wallet was created by refused input');
  const address = await createOnWalletPage(w, pw);
  await w.close();

  // Sign in from the keyboard; unlock input errors in the portal.
  await focusAndPress(page, page.getByRole('button', { name: 'Sign in', exact: true }));
  await page.getByText('Link your DACS account').waitFor({ timeout: 20000 });
  await focusAndPress(page, page.getByRole('button', { name: 'Use the experimental embedded wallet' }));
  const unlockForm = page.locator('#embedded-wallet form').filter({ has: page.getByRole('button', { name: /^unlock$/i }) });
  await unlockForm.waitFor({ timeout: 20000 });
  await unlockForm.getByRole('button', { name: /^unlock$/i }).click();
  const emptyUnlock = await unlockForm.locator('input[type=password]').evaluate((el) => ({ empty: el.value === '', required: el.required, valueMissing: el.validity.valueMissing, message: el.validationMessage.length > 0 }));
  assert.deepEqual(emptyUnlock, { empty: true, required: true, valueMissing: true, message: true }, 'empty unlock password refused with the required-field message');
  assert.equal(await page.locator('#embedded-wallet').getByRole('heading', { name: /^wallet locked$/i }).count(), 1, 'still locked after an empty password');
  await unlockForm.locator('input[type=password]').fill(`${pw}-wrong`);
  await focusAndPress(page, unlockForm.getByRole('button', { name: /^unlock$/i }));
  await page.locator('#embedded-wallet').getByRole('alert').filter({ hasText: 'Wrong password, or the stored wallet is damaged.' }).waitFor({ timeout: 30000 });
  assert.equal(await unlock(page, pw), address, 'the accepting control unlocks the same wallet');
  await focusAndPress(page, page.getByRole('button', { name: 'Connect wallet' }));
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 15000 });

  // Decline with Escape: nothing is linked, the reason is visible, the wallet stays unlocked.
  await focusAndPress(page, page.getByRole('button', { name: 'Sign in and allow' }));
  await reject(page, { escape: true });
  await page.locator('#log .bad').first().waitFor({ timeout: 10000 });
  t.diagnostic(`portal log after Escape: ${(await portalLog(page)).slice(-160)}`);
  const declined = await d.state();
  assert.notEqual(declined.signIn.status, 'signed_in', 'an Escape-declined approval links nothing');
  assert.deepEqual(declined.signIn.wallets, []);
  assert.equal(await page.locator('#embedded-wallet').getByRole('heading', { name: /^wallet unlocked$/i }).count(), 1, 'the unlock is retained after a declined approval');

  // Retry without re-entering the password; approve from the keyboard (Tab from Reject to Approve, Enter).
  await focusAndPress(page, page.getByRole('button', { name: 'Sign in and allow' }));
  await approve(page, ['account-login', address], { keyboard: true });
  await page.waitForURL(/\/tester\//, { timeout: 20000 });
  await d.waitText('sign-in-status', new RegExp(`^Signed in\\. Linked wallet: ${address}$`));

  // Primary steps continue from the keyboard.
  await focusAndPress(page, page.getByRole('button', { name: 'Find test service', exact: true }));
  await d.waitText('v-result', /^Verified: transactable$/);
  await focusAndPress(page, page.getByRole('button', { name: 'Prepare simulated purchase', exact: true }));
  await d.waitText('p-status', /^awaiting_approval/);
  assert.ok(await d.visible('receipt-waiting'), 'waiting is shown as not complete');
  assert.equal(await d.visible('receipt'), false);
  assert.deepEqual(rec.consoleErrors, [], 'no console errors');
  assert.equal(h.chainStats().broadcastAccepted, 0, 'nothing was broadcast');
});

test('OA-B2 [C4,C5,C7] interrupted purchase approval resumes without duplication; rejected/cancelled purchases never show success; export reflects actions', { timeout: 240_000 }, async (t) => {
  const { h, rec, d } = await freshTester(t);
  const { pw, address } = await createThrowawayWallet(rec, d);
  await dashboardSignIn(d, pw, address);
  await d.click('Find test service');
  await d.waitText('v-result', /^Verified: transactable$/);
  const priceOs = demToOs(h.listing.price.amount);

  // 1) Interrupt: reload the portal while the transfer approval is open.
  await d.click('Prepare simulated purchase');
  await d.waitText('p-status', /^awaiting_approval/);
  const op1 = await d.textOf('p-op');
  const reviewUrl = await d.page.locator('#purchase-review').getAttribute('href');
  const portalPage = await rec.context.newPage();
  await openUnlocked(portalPage, reviewUrl, pw, address);
  const base = h.chainStats().broadcastAccepted;
  await portalPage.getByRole('button', { name: 'Approve exact terms' }).click();
  await approve(portalPage, ['approve-purchase', h.listing.sellerAddress]);
  await portalPage.locator('dialog').waitFor({ timeout: 20000 }); // transfer approval now open
  await portalPage.reload();
  await portalPage.getByRole('heading', { name: 'DEM testnet purchase status' }).waitFor({ timeout: 20000 });
  assert.match(await portalPage.locator('#flow').innerText(), /payment_handoff/);
  assert.equal(h.chainStats().broadcastAccepted, base, 'the interrupted approval sent nothing');
  await d.click('Refresh receipt');
  await d.waitText('p-status', /^payment_handoff/);
  assert.equal(await d.visible('receipt'), false, 'an interrupted purchase shows no receipt');
  await d.page.reload();
  await d.waitText('p-status', /^payment_handoff/);
  assert.equal(await d.textOf('p-op'), op1, 'dashboard reload keeps the same operation');

  // Resume in the reloaded portal: one transfer, then the receipt.
  await useEmbedded(portalPage);
  assert.equal(await unlock(portalPage, pw), address);
  await connect(portalPage, address);
  await portalPage.getByRole('button', { name: 'Send payment from wallet' }).click();
  await approve(portalPage, [h.listing.sellerAddress, priceOs, address]);
  await portalPage.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
  assert.equal(h.chainStats().broadcastAccepted - base, 1, 'exactly one broadcast after resume');
  await portalPage.reload();
  await portalPage.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 20000 });
  assert.equal(await portalPage.getByRole('button', { name: /Approve exact terms|Send payment from wallet/ }).count(), 0, 'a settled purchase offers no further approval');
  await d.click('Refresh receipt');
  await d.waitText('p-status', /^settled_verified$/);
  assert.equal(strip0x(await d.textOf('r-payer')), strip0x(address));
  assert.equal(strip0x(await d.textOf('r-payee')), strip0x(h.listing.sellerAddress));
  assert.ok((await d.textOf('r-amount')).includes(priceOs));

  // 2) Reject the signature: still awaiting approval, no receipt, nothing sent.
  await d.click('Prepare simulated purchase');
  await d.waitText('p-status', /^awaiting_approval/);
  const op2 = await d.textOf('p-op');
  assert.notEqual(op2, op1, 'a new purchase after a settled one is a new operation');
  const review2 = await d.page.locator('#purchase-review').getAttribute('href');
  await openUnlocked(portalPage, review2, pw, address);
  await portalPage.getByRole('button', { name: 'Approve exact terms' }).click();
  await reject(portalPage);
  await portalPage.locator('#log .bad').first().waitFor({ timeout: 10000 });
  await d.click('Refresh receipt');
  await d.waitText('p-status', /^awaiting_approval/);
  assert.equal(await d.visible('receipt'), false);

  // 3) Approve the signature but reject the transfer: not completed, nothing sent.
  await portalPage.getByRole('button', { name: 'Approve exact terms' }).click();
  await approve(portalPage, ['approve-purchase']);
  await reject(portalPage);
  await portalPage.locator('#log .bad').last().waitFor({ timeout: 10000 });
  assert.equal(h.chainStats().broadcastAccepted - base, 1, 'a rejected transfer is not broadcast');
  await d.click('Refresh receipt');
  await d.waitText('p-status', /^(payment_handoff|approved)/);
  assert.equal(await d.visible('receipt'), false, 'a rejected transfer shows no receipt');

  // 4) Cancel from the dashboard; the portal then offers nothing and shows no receipt.
  await d.click('Cancel pending purchase');
  await d.waitText('p-status', /^cancelled$/);
  await portalPage.reload();
  await portalPage.getByRole('heading', { name: 'DEM testnet purchase status' }).waitFor({ timeout: 20000 });
  assert.match(await portalPage.locator('#flow').innerText(), /cancelled/);
  assert.equal(await portalPage.getByRole('button', { name: /Approve exact terms|Send payment from wallet/ }).count(), 0, 'a cancelled purchase offers no approval');
  assert.equal(await portalPage.getByRole('heading', { name: /purchase receipt/i }).count(), 0, 'a cancelled purchase shows no receipt');

  // 5) Export: non-empty JSON in the task-owned download dir, reflecting these actions.
  const note = `overnight ${unique('note')}`;
  await d.page.getByLabel(/Your note/).fill(note);
  const [download] = await Promise.all([d.page.waitForEvent('download', { timeout: 15000 }), d.click('Download feedback file')]);
  assert.equal(await download.failure(), null);
  const file = join(downloads, `export-${unique('b2')}.json`);
  await download.saveAs(file);
  const size = statSync(file).size;
  assert.ok(size > 0, 'the downloaded feedback file is not empty');
  const body = readFileSync(file, 'utf8');
  const data = JSON.parse(body);
  assert.equal(data.kind, 'dacs-offline-tester-feedback');
  assert.match(data.notice, /SIMULATED/);
  assert.equal(data.feedback, note);
  assert.deepEqual(
    { signIn: data.observed.signIn, verification: data.observed.listingVerification, purchase: data.observed.purchase, receipt: data.observed.receipt, identityAdd: data.observed.identityAdd },
    { signIn: 'signed_in', verification: 'transactable', purchase: 'cancelled', receipt: 'not_observed', identityAdd: 'not_started' },
  );
  for (const secret of [strip0x(address), pw, 'http', 'Bearer', 'access_token']) assert.ok(!body.toLowerCase().includes(secret.toLowerCase()), 'export carries no address, password, link or token');
  t.diagnostic(`export bytes ${size}; observed ${JSON.stringify(data.observed)}`);
  assert.deepEqual(rec.consoleErrors.filter((e) => !/Failed to load resource/.test(e)), [], 'no console errors other than refused HTTP requests');
});

for (const kind of ['github', 'twitter']) {
  test(`OA-B3 [C2] ${kind}: add then remove through the portal with the embedded wallet and the local proof publisher; readback changes`, { timeout: 180_000 }, async (t) => {
    const local = cleanupStack();
    t.after(() => local.run());
    const h = await startLauncher(local);
    const rec = await recordedContext(browser, local);
    const page = await rec.context.newPage();
    const pw = password();
    const { user, address } = await accountWithEmbeddedWallet(h, page, pw);
    // Valid handle shapes per platform: GitHub allows hyphens (no underscores), X allows underscores.
    const handle = kind === 'github' ? `oa-gh-${Math.random().toString(36).slice(2, 7)}` : `oa_tw_${Math.random().toString(36).slice(2, 7)}`;
    const handlesOf = async () => {
      const ids = await ok(h, user, 'get_identities', { walletAddress: address });
      const w = ids.wallets.find((x) => x.address === address);
      return (w?.claims ?? []).filter((c) => c.kind === 'web2' && c.platform === kind).map((c) => c.handle);
    };
    assert.deepEqual(await handlesOf(), [], 'precondition: nothing linked');

    const add = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-b3a'), action: 'add', kind, walletAddress: address });
    await openUnlocked(page, add.portalUrl, pw, address);
    await page.getByRole('button', { name: 'Use my connected wallet' }).click();
    await page.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
    await approve(page);
    const proofText = (await page.locator('#proof-text').innerText({ timeout: 10000 })).trim();
    // Ordinary input error first: an empty proof URL is refused and the step stays.
    await page.getByRole('button', { name: 'Use this proof URL' }).click();
    await page.locator('#log .bad').first().waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: 'Use this proof URL' }).count(), 1, 'empty proof URL leaves the proof step open');
    const pub = await rec.context.newPage();
    await pub.goto(`${h.fixtures.proofs}/`);
    await pub.selectOption('select[name=kind]', kind);
    await pub.fill('input[name=username]', handle);
    await pub.fill('input[name=proof]', proofText);
    await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
    const proofUrl = (await pub.locator('#proof-url').innerText({ timeout: 10000 })).trim();
    await pub.close();
    await page.locator('#proof-url').fill(proofUrl);
    await page.getByRole('button', { name: 'Use this proof URL' }).click();
    await step(page, `${kind} add approval`, async () => {
      await page.getByRole('button', { name: 'Approve in my wallet' }).click();
      await approve(page, [kind === 'github' ? 'addGithubIdentity' : 'addTwitterIdentity', handle, address]);
      await page.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
    });
    assert.deepEqual(await handlesOf(), [handle], 'independent readback shows the added handle');

    const rm = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-b3r'), action: 'remove', kind, username: handle, walletAddress: address });
    await openUnlocked(page, rm.portalUrl, pw, address);
    await page.getByRole('button', { name: 'Use my connected wallet' }).click();
    // First decline (Reject): the handle stays linked and the result is not "removed".
    await page.getByRole('button', { name: 'Approve in my wallet' }).click();
    await reject(page);
    await page.locator('#flow').getByText(/rejected_before_send/).waitFor({ timeout: 20000 });
    assert.deepEqual(await handlesOf(), [handle], 'a rejected removal leaves the handle linked');
    const rm2 = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-b3r2'), action: 'remove', kind, username: handle, walletAddress: address });
    await openUnlocked(page, rm2.portalUrl, pw, address);
    await page.getByRole('button', { name: 'Use my connected wallet' }).click();
    await page.getByRole('button', { name: 'Approve in my wallet' }).click();
    await approve(page, ['removeWeb2Identity', handle]);
    await page.getByText('Association no longer observed on chain.').waitFor({ timeout: 30000 });
    assert.deepEqual(await handlesOf(), [], 'independent readback shows the handle removed');
    const off = rec.requests.filter((r) => !r.url.startsWith('blob:') && ![h.origin, h.fixtures.proofs].some((o) => r.url.startsWith(`${o}/`)));
    assert.deepEqual(off.map((r) => new URL(r.url).origin), [], 'every request stayed on the launched loopback origins');
  });
}

// C6 ordinary bad input: a GitHub handle with an underscore (not a valid
// GitHub username) published on the local proof publisher. Before the closure
// repair it reached the wallet, which refused it before signing and left the
// action stuck. Now the person must see the refusal at the proof step,
// nothing may be linked, and the same action must accept a corrected URL.
test('OA-B3b [C6] an invalid GitHub handle in the proof is refused visibly at the proof step, links nothing, and the same action completes with a corrected URL', { timeout: 150_000 }, async (t) => {
  const local = cleanupStack();
  t.after(() => local.run());
  const h = await startLauncher(local);
  const rec = await recordedContext(browser, local);
  const page = await rec.context.newPage();
  const pw = password();
  const { user, address } = await accountWithEmbeddedWallet(h, page, pw);
  const handle = `oa_bad_${Math.random().toString(36).slice(2, 6)}`;
  const add = await ok(h, user, 'start_identity_action', { idempotencyKey: unique('oa-b3b'), action: 'add', kind: 'github', walletAddress: address });
  await openUnlocked(page, add.portalUrl, pw, address);
  await page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await page.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
  await approve(page);
  const proofText = (await page.locator('#proof-text').innerText({ timeout: 10000 })).trim();
  const pub = await rec.context.newPage();
  await pub.goto(`${h.fixtures.proofs}/`);
  await pub.selectOption('select[name=kind]', 'github');
  await pub.fill('input[name=username]', handle);
  await pub.fill('input[name=proof]', proofText);
  await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
  // The local proof publisher accepts such a handle (its own handle rule allows
  // "_"). The portal must refuse it at the proof step, before the wallet is
  // asked, and the SAME action must accept the corrected URL. Each of these is
  // required, not just recorded.
  assert.equal(await pub.locator('#proof-url').count(), 1, `the proof publisher publishes "${handle}"`);
  const badUrl = (await pub.locator('#proof-url').innerText()).trim();
  await pub.close();
  const status = async () => (await page.locator('#flow dl dt', { hasText: /^Status$/ }).first().locator('xpath=following-sibling::dd[1]').innerText()).trim();
  let dialogs = 0;
  page.on('dialog', () => { dialogs += 1; });
  await page.locator('#proof-url').fill(badUrl);
  await page.getByRole('button', { name: 'Use this proof URL' }).click();
  const outcome = await Promise.race([
    page.locator('#log .bad').first().waitFor({ timeout: 30000 }).then(() => 'refused_at_proof'),
    page.getByRole('button', { name: 'Approve in my wallet' }).waitFor({ timeout: 30000 }).then(() => 'review'),
  ]).catch(() => 'no_visible_outcome');
  const explanation = await portalLog(page);
  t.diagnostic(`after "Use this proof URL" with "${handle}": ${outcome}; log: ${explanation.slice(-240)}`);
  assert.equal(outcome, 'refused_at_proof', 'C6: the proof step refuses the handle visibly within 30 s, before the wallet is asked');
  assert.match(explanation, /github|username|handle/i, 'the refusal says what is wrong');
  assert.equal(await status(), 'awaiting_public_proof', 'the action stays at the proof step');
  assert.equal(await page.getByRole('button', { name: 'Use this proof URL' }).count(), 1, 'the proof step stays usable');
  assert.equal(await page.locator('dialog').count(), 0, 'no wallet approval was opened');
  assert.equal(await page.locator('#wallet-answer').count(), 0, 'the wallet was not asked');
  const listed = (await ok(h, user, 'get_identities', { walletAddress: address })).operations.find((o) => o.operationId === add.operationId);
  assert.equal(listed?.status, 'awaiting_public_proof', 'get_identities agrees');

  // Accepting control in the same action: a GitHub-valid handle proceeds and is observed.
  const good = `oa-ok-${Math.random().toString(36).slice(2, 6)}`;
  const pub2 = await rec.context.newPage();
  await pub2.goto(`${h.fixtures.proofs}/`);
  await pub2.selectOption('select[name=kind]', 'github');
  await pub2.fill('input[name=username]', good);
  await pub2.fill('input[name=proof]', proofText);
  await Promise.all([pub2.waitForNavigation(), pub2.click('button[type=submit]')]);
  const goodUrl = (await pub2.locator('#proof-url').innerText({ timeout: 10000 })).trim();
  await pub2.close();
  await page.locator('#proof-url').fill(goodUrl);
  await page.getByRole('button', { name: 'Use this proof URL' }).click();
  await step(page, 'corrected GitHub add in the same action', async () => {
    await page.getByRole('button', { name: 'Approve in my wallet' }).click({ timeout: 15000 });
    await approve(page, ['addGithubIdentity', good, address]);
    await page.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
  });
  assert.equal(dialogs, 0, 'no native browser dialog was used');
  const ids = await ok(h, user, 'get_identities', { walletAddress: address });
  assert.deepEqual((ids.wallets.find((x) => x.address === address)?.claims ?? []).filter((c) => c.kind === 'web2').map((c) => `${c.platform}:${c.handle}`), [`github:${good}`], 'readback: only the corrected handle is linked');
  assert.equal(ids.operations.find((o) => o.operationId === add.operationId)?.status, 'association_observed', 'the same action completed');
  const next = await call(h, user, 'start_identity_action', { idempotencyKey: unique('oa-b3b-next'), action: 'add', kind: 'twitter', walletAddress: address });
  assert.equal(next.kind, 'ok', `the wallet is free for a new identity action (got ${next.code ?? next.kind})`);
});

// The tester guide's C2 steps on the dashboard itself (buyer profile):
// Twitter, then GitHub, add and remove with the visible handle list changing.
test('OA-B5 [C2] dashboard identities exactly as the guide describes: Twitter then GitHub add and remove; the visible handle rows change each time', { timeout: 240_000 }, async (t) => {
  const { h, rec, d } = await freshTester(t);
  const { pw, address } = await createThrowawayWallet(rec, d);
  await dashboardSignIn(d, pw, address);
  const kinds = [
    { kind: 'twitter', name: 'Twitter', handle: `oa_tw_${Math.random().toString(36).slice(2, 7)}`, add: 'Add test Twitter identity', addReview: 'Open Twitter add review in the portal', addStatus: 'tw-add-status', rows: 'o-twitter', select: '#tw-remove-handle', remove: 'Remove test Twitter identity', removeReview: 'Open Twitter remove review in the portal', removeStatus: 'tw-remove-status', method: 'addTwitterIdentity' },
    { kind: 'github', name: 'GitHub', handle: `oa-gh-${Math.random().toString(36).slice(2, 7)}`, add: 'Add test GitHub identity', addReview: 'Open add review in the portal', addStatus: 'add-status', rows: 'o-handles', select: '#remove-handle', remove: 'Remove test GitHub identity', removeReview: 'Open remove review in the portal', removeStatus: 'remove-status', method: 'addGithubIdentity' },
  ];
  for (const k of kinds) {
    await step(d.page, `${k.name}: ${k.add}`, async () => {
      await d.click(k.add);
      await d.waitText(k.addStatus, /^(prepared|awaiting_wallet)/);
    });
    const p = await popupFrom(d, k.addReview);
    await useEmbedded(p);
    assert.equal(await unlock(p, pw), address);
    await connect(p, address);
    await p.getByRole('button', { name: 'Use my connected wallet' }).click();
    await p.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
    await approve(p);
    const proofText = (await p.locator('#proof-text').innerText({ timeout: 10000 })).trim();
    const pub = await popupFrom(d, 'local proof publisher');
    await pub.selectOption('select[name=kind]', k.kind);
    await pub.fill('input[name=username]', k.handle);
    await pub.fill('input[name=proof]', proofText);
    await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
    const proofUrl = (await pub.locator('#proof-url').innerText({ timeout: 10000 })).trim();
    assert.match(proofUrl, k.kind === 'twitter' ? /^https:\/\/x\.com\/[^/]+\/status\/\d+$/ : /^https:\/\/gist\.github\.com\/[^/]+\/[^/]+$/, 'the publisher returns the documented URL shape');
    await pub.close();
    await step(p, `${k.name} add approval`, async () => {
      await p.locator('#proof-url').fill(proofUrl);
      await p.getByRole('button', { name: 'Use this proof URL' }).click();
      await p.getByRole('button', { name: 'Approve in my wallet' }).click();
      await approve(p, [k.method, k.handle, address]);
      await p.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
    });
    await p.close();
    await d.click('Refresh identities');
    await d.waitText(k.rows, new RegExp(`^${k.handle}$`));
    await d.waitText(k.addStatus, /^association_observed/);

    await d.page.locator(k.select).selectOption(k.handle);
    await d.click(k.remove);
    await d.waitText(k.removeStatus, /^(prepared|awaiting_wallet)/);
    const r = await popupFrom(d, k.removeReview);
    await useEmbedded(r);
    assert.equal(await unlock(r, pw), address);
    await connect(r, address);
    await r.getByRole('button', { name: 'Use my connected wallet' }).click();
    await r.getByRole('button', { name: 'Approve in my wallet' }).click();
    await approve(r, ['removeWeb2Identity', k.handle]);
    await r.getByText('Association no longer observed on chain.').waitFor({ timeout: 30000 });
    await r.close();
    await d.click('Refresh identities');
    await d.waitText(k.rows, /^none observed$/);
    await d.waitText(k.removeStatus, /^removal_observed/);
  }
  assert.equal(h.chainStats().broadcastAccepted, 4, 'exactly four identity writes (two adds, two removes)');
  assert.deepEqual(rec.consoleErrors, []);
});
