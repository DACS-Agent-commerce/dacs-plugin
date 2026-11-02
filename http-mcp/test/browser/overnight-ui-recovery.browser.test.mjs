// Real Chromium, SIMULATED offline launcher, built-in wallet only: what a
// tester sees, and how they recover in the same run, when the built-in
// wallet refuses an identity request before signing. The server rule itself
// is core/identity-owned (docs/OVERNIGHT-CORE.md); this file only observes it
// through public pages. Each observation is its own test.
//
// Regression: before the repair a pre-sign refusal stayed in
// flight (readback_pending, then outcome_unknown) because the wallet's
// "upstream_unavailable" answer was classified as an unknown outcome; every
// later identity action for that wallet was refused with
// identity_operation_in_progress and only a launcher restart recovered. The
// expectations below require recovery in the same run, without a restart.
// Trigger (still pre-send after the repair, which refuses underscore GitHub
// handles earlier at the proof step): a Twitter add whose pasted post URL is
// mistyped; the wallet cannot read the post and refuses before any dialog.
// The ambiguous-outcome rule (an unreported wallet request stays in flight
// and blocks) is kept in closure-acceptance-identity-recovery.browser.test.mjs
// (CA-R1b) and test/closure-acceptance-identity.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startOfflineTester } from '../../bin/dacs-chatgpt-offline-test.mjs';
import { Profile } from '../helpers/overnight-ui-browser.mjs';
import { FAILED_BEFORE_SEND, isClosedNotSent, mistypedPost } from '../helpers/closure-acceptance-identity.mjs';

const CHROME = process.env.DACS_TEST_CHROME;
const TW_HANDLE = `p7_tw_${Math.random().toString(36).slice(2, 6)}`; // Twitter allows "_"
let h;
let browserServer;
let browser;
let downloads = null;
let t = null; // tester profile (one browser profile, one built-in wallet)
let runOrigin = null;
const seen = {};

before(async () => {
  assert.ok(CHROME && existsSync(CHROME), `real Chromium required: DACS_TEST_CHROME=${CHROME ?? '(unset)'}`);
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  runOrigin = h.origin;
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT || tmpdir();
  mkdirSync(parent, { recursive: true });
  downloads = mkdtempSync(join(parent, 'overnight-ui-recovery-'));
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true, downloadsPath: downloads });
  browser = await chromium.connect(browserServer.wsEndpoint());
  t = new Profile(await browser.newContext(), h, 'tester');
});

after(async () => {
  await t?.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => browserServer.kill());
  await h?.stop();
  if (downloads) rmSync(downloads, { recursive: true, force: true });
  process.stdout.write(`# observed ${JSON.stringify(seen)}\n`);
});

// The dashboard renders "<status> (<handle>)" or "<status>: <help>".
const statusOf = async (id) => (await t.textOf(id)).trim().match(/^[a-z_]+/)?.[0] ?? '';

test('setup: built-in wallet, buyer sign-in', { timeout: 120_000 }, async () => {
  await t.open();
  await t.createWallet();
  await t.signIn('buyer');
});

test('trigger: the built-in wallet refuses a Twitter add (mistyped post URL) before signing; the portal explains it and closes the action', { timeout: 120_000 }, async () => {
  await t.click('Add test Twitter identity');
  await t.waitText('tw-add-status', /^(prepared|awaiting_wallet)/);
  const p = await t.popup('Open Twitter add review in the portal');
  await t.portalReady(p);
  await p.getByRole('button', { name: 'Use my connected wallet' }).click();
  await p.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
  await t.decide(p, true);
  const proofText = (await p.locator('#proof-text').innerText({ timeout: 10000 })).trim();
  const pub = await t.popup('local proof publisher');
  await pub.selectOption('select[name=kind]', 'twitter');
  await pub.fill('input[name=username]', TW_HANDLE);
  await pub.fill('input[name=proof]', proofText);
  await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
  const proofUrl = (await pub.locator('#proof-url').innerText({ timeout: 10000 })).trim();
  await pub.close();
  await p.locator('#proof-url').fill(mistypedPost(proofUrl));
  await p.getByRole('button', { name: 'Use this proof URL' }).click();
  await p.getByRole('button', { name: 'Approve in my wallet' }).click({ timeout: 15000 });
  const answer = p.locator('#wallet-answer');
  await answer.waitFor({ timeout: 20000 });
  assert.equal(await p.locator('dialog').count(), 0, 'no approval dialog was opened');
  seen.walletCode = await answer.getAttribute('data-wallet-code');
  seen.walletAnswer = (await answer.innerText()).split('\n')[0];
  seen.walletNext = (await answer.innerText()).split('\n').slice(1).join(' ').trim();
  assert.equal(seen.walletCode, 'upstream_unavailable');
  assert.match(seen.walletAnswer, /Nothing was signed or sent\./);
  assert.doesNotMatch(seen.walletNext, /identity_operation_in_progress/, 'the next-step text does not claim the wallet is blocked');
  assert.match(seen.walletNext, /closed/i, 'the next-step text says the action is closed');
  assert.match(seen.walletNext, /new identity action/i, 'the next-step text says a new identity action can be started');
  await p.close();
  // Before the refresh the dashboard still shows the status from when the add
  // was started; wait until the refreshed status (any status after the wallet
  // was asked) is rendered, then assert it.
  await t.click('Refresh identities');
  await t.dash.waitForFunction(() => /^(?!prepared|awaiting_wallet|awaiting_public_proof|review\b)[a-z_]+/.test(document.getElementById('tw-add-status')?.textContent ?? ''), null, { timeout: 20000 });
  seen.dashboardAddStatus = await statusOf('tw-add-status');
  assert.ok(isClosedNotSent(seen.dashboardAddStatus), `dashboard shows the refused add as closed and not sent (got "${seen.dashboardAddStatus}")`);
  assert.equal(seen.dashboardAddStatus, FAILED_BEFORE_SEND);
  assert.equal((await t.dash.locator('#o-twitter').textContent()).includes(TW_HANDLE), false, 'the refused handle is not shown as linked');
  // A closed action is not an unfinished step.
  await t.dash.reload();
  await t.waitText('sign-in-status', /^Signed in\./);
  seen.resumeAfterRefusal = ((await t.dash.locator('#resume-list').textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300);
  assert.doesNotMatch(seen.resumeAfterRefusal, /Twitter identity/, 'the closed Twitter add is not listed under Unfinished steps');
});

test('same wallet, same run, no restart: Add starts a NEW Twitter action and the handle is linked with the correct post URL', { timeout: 180_000 }, async () => {
  assert.equal(t.h.origin, runOrigin, 'still the same launcher run');
  assert.equal(await statusOf('tw-add-status'), FAILED_BEFORE_SEND, 'precondition: the refused add is shown closed');
  const closedLink = await t.dash.locator('#tw-add-review').getAttribute('href');
  await t.click('Add test Twitter identity');
  try {
    await t.waitText('tw-add-status', /^(prepared|awaiting_wallet)/);
  } catch {
    throw new Error(`dashboard "Add test Twitter identity" did not start a new action after a closed one; tw-add-status: "${await t.textOf('tw-add-status')}"; identity-error: "${await t.textOf('identity-error')}"`);
  }
  assert.notEqual(await t.dash.locator('#tw-add-review').getAttribute('href'), closedLink, 'a NEW action (new portal link), not the closed one replayed');
  await t.identityAdd('twitter', TW_HANDLE);
  assert.equal(await t.dash.locator('#identity-error').isVisible(), false, 'no identity_operation_in_progress refusal');
  await t.click('Refresh identities');
  await t.waitText('o-twitter', new RegExp(`^${TW_HANDLE}$`));
  await t.waitText('tw-add-status', /^association_observed/);
  assert.equal(await t.dash.locator('#restart-notice').isVisible(), false, 'no launcher restart happened');
  seen.sameRunRecovery = 'works: same wallet, same run, no restart, Twitter add observed';
});

test('same wallet, same run: purchases are not blocked', { timeout: 60_000 }, async () => {
  await t.click('Find test service');
  await t.waitText('v-result', /^Verified: transactable$/);
  await t.click('Prepare simulated purchase');
  await t.waitText('p-status', /^awaiting_approval/);
  await t.click('Cancel pending purchase');
  await t.waitText('p-status', /^cancelled$/);
  seen.purchaseUnaffected = true;
});

test('same run: Sign in stays disabled; the only way to another buyer wallet in this run is Start over as a new buyer', async () => {
  assert.equal(await t.dash.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(), true);
  assert.equal(await t.dash.getByRole('button', { name: 'Start sign-in again', exact: true }).isVisible(), false);
  assert.equal(await t.dash.getByRole('button', { name: 'Start over as a new buyer', exact: true }).isVisible(), true);
  seen.secondWalletInSameRun = 'Sign in disabled; Start over as a new buyer offered';
});
