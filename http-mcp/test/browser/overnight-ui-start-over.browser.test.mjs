// Real Chromium, simulated launcher: a buyer who loses the embedded wallet
// continues in a fresh profile while earlier purchase operations remain
// unchanged and labelled with their last observed status.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startOfflineTester } from '../../bin/dacs-chatgpt-offline-test.mjs';
import { Profile } from '../helpers/overnight-ui-browser.mjs';
import { dashboardClient } from '../helpers/overnight-ui-actors.mjs';

const CHROME = process.env.DACS_TEST_CHROME;
let h;
let browserServer;
let browser;
let downloads = null;
let a = null; // first browser profile (its wallet is "lost" afterwards)
let b = null; // second browser profile (new wallet)
const run = { pendingOp: null, firstSettledOp: null };

before(async () => {
  assert.ok(CHROME && existsSync(CHROME), `real Chromium required: DACS_TEST_CHROME=${CHROME ?? '(unset)'}`);
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT || tmpdir();
  mkdirSync(parent, { recursive: true });
  downloads = mkdtempSync(join(parent, 'overnight-ui-start-over-'));
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true, downloadsPath: downloads });
  browser = await chromium.connect(browserServer.wsEndpoint());
  a = new Profile(await browser.newContext(), h, 'first');
  b = new Profile(await browser.newContext(), h, 'second');
});

after(async () => {
  await a?.context.close().catch(() => {});
  await b?.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => browserServer.kill());
  await h?.stop();
  if (downloads) rmSync(downloads, { recursive: true, force: true });
});

// Baseline purchase approval in the portal with profile p's built-in wallet.
async function approvePurchase(p) {
  const portal = await p.popup('Open review in the portal');
  await p.portalReady(portal);
  await portal.getByRole('button', { name: 'Approve exact terms' }).click();
  await p.decide(portal, true, ['approve-purchase']);
  await p.decide(portal, true, [p.address, 'SIMULATED']);
  await portal.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
  await portal.close();
  await p.click('Refresh receipt');
  await p.waitText('p-status', /^settled_verified$/);
  assert.equal((await p.textOf('r-payer')).toLowerCase(), p.address);
}

test('accepting control: same profile, no reset, the buyer buys the baseline listing', { timeout: 180_000 }, async () => {
  await a.open();
  await a.createWallet();
  assert.ok(await a.dash.locator('#buyer-wallet-hint').isVisible(), 'wallet guidance shown at sign-in');
  await a.signIn('buyer');
  assert.equal(await a.dash.getByRole('button', { name: 'Start over as a new buyer' }).isVisible(), true);
  await a.click('Find test service');
  await a.waitText('v-result', /^Verified: transactable$/);
  await a.click('Prepare simulated purchase');
  await a.waitText('p-status', /^awaiting_approval/);
  assert.ok(await a.dash.getByText('Approve with the same built-in wallet that signed in as buyer', { exact: false }).isVisible());
  run.firstSettledOp = await a.textOf('p-op');
  await approvePurchase(a);
  // A second purchase is left waiting for approval with this wallet.
  await a.click('Prepare simulated purchase');
  await a.waitText('p-status', /^awaiting_approval/);
  run.pendingOp = await a.textOf('p-op');
  assert.notEqual(run.pendingOp, run.firstSettledOp);
});

test('lost wallet, buyer: a new profile sees the sign-in held by the old wallet, with guidance and a keyboard-reachable Start over', { timeout: 60_000 }, async () => {
  await b.open();
  await b.waitText('sign-in-status', new RegExp(`^Signed in\\. Linked wallet: ${a.address}$`));
  assert.equal(await b.dash.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(), true);
  assert.match(await b.textOf('buyer-wallet-hint'), /stored in this browser profile.*Start over as a new buyer/s);
  await b.dash.evaluate(() => document.getElementById('sign-in').focus());
  await b.tabTo((x) => x.action === 'buyer-start-over');
  await b.dash.keyboard.press('Enter');
  await b.waitText('sign-in-status', /^Not signed in\.$/);
  await b.dash.waitForFunction(() => document.activeElement?.dataset?.action === 'sign-in', null, { timeout: 5000 });
});

test('earlier buyer operations stay shown truthfully, bound to the old wallet, and are not changed', { timeout: 30_000 }, async () => {
  const list = await b.textOf('buyer-earlier-list');
  assert.ok(list.includes(a.address.slice(0, 10)), 'the old wallet is named');
  assert.ok(list.includes(`purchase ${run.pendingOp}`), 'the pending purchase is listed');
  assert.match(list, /was awaiting_approval/);
  assert.match(list, /Last observed status, not refreshed; only that wallet can approve anything still pending\./);
  const state = await dashboardClient(h).state();
  assert.equal(state.purchase, null, 'the new session starts with no purchase');
  assert.equal(state.earlier.buyer[0].purchase.status, 'awaiting_approval', 'not cancelled or rewritten');
});

test('lost wallet, buyer: a new built-in wallet signs in and completes a baseline purchase', { timeout: 180_000 }, async () => {
  await b.createWallet();
  assert.notEqual(b.address, a.address);
  await b.signIn('buyer');
  await b.click('Find test service');
  await b.waitText('v-result', /^Verified: transactable$/);
  await b.click('Prepare simulated purchase');
  await b.waitText('p-status', /^awaiting_approval/);
  const op = await b.textOf('p-op');
  assert.ok(op !== run.pendingOp && op !== run.firstSettledOp, 'a new operation for the new wallet');
  await approvePurchase(b);
});
