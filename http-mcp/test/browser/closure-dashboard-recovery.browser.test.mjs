// Closure (dashboard D1/F1), real Chromium + the offline launcher + the
// built-in wallet, through ordinary dashboard and portal controls only.
// F1: after a settled purchase, Prepare starts the next one and the settled
//     purchase with its receipt stays visible (also after reload) and in the
//     downloaded evidence file.
// D1: an identity action cancelled on its portal page is closed; Add starts a
//     NEW action (new portal link) even before Refresh, and that action
//     completes in the same run.
// SIMULATED fixtures only; not live, not ChatGPT, not a security review.
// Browser: exactly DACS_TEST_CHROME; a missing browser fails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startOfflineTester } from '../../bin/dacs-chatgpt-offline-test.mjs';
import { Profile } from '../helpers/overnight-ui-browser.mjs';

const CHROME = process.env.DACS_TEST_CHROME;
const TW_HANDLE = `cd_tw_${Math.random().toString(36).slice(2, 6)}`;
let h;
let browserServer;
let browser;
let downloads = null;
let t = null;
const strip0x = (s) => String(s ?? '').toLowerCase().replace(/^0x/, '');

before(async () => {
  assert.ok(CHROME && existsSync(CHROME), `real Chromium required: DACS_TEST_CHROME=${CHROME ?? '(unset)'}`);
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT || tmpdir();
  mkdirSync(parent, { recursive: true });
  downloads = mkdtempSync(join(parent, 'closure-dashboard-'));
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true, downloadsPath: downloads });
  browser = await chromium.connect(browserServer.wsEndpoint());
  t = new Profile(await browser.newContext({ acceptDownloads: true }), h, 'tester');
});

after(async () => {
  await t?.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => browserServer.kill());
  await h?.stop();
  if (downloads) rmSync(downloads, { recursive: true, force: true });
});

async function downloadEvidence() {
  const [download] = await Promise.all([t.dash.waitForEvent('download', { timeout: 15000 }), t.click('Download evidence file')]);
  assert.equal(await download.failure(), null);
  const file = join(downloads, `evidence-${Date.now()}.json`);
  await download.saveAs(file);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.length > 200, 'nonempty evidence file');
  return { text, json: JSON.parse(text) };
}

test('setup: built-in wallet and buyer sign-in', { timeout: 120_000 }, async () => {
  await t.open();
  await t.createWallet();
  await t.signIn('buyer');
});

test('F1 [accepting control first]: a purchase settles with a receipt; Prepare then starts a new one and the settled purchase with its receipt stays listed, after reload and in the evidence file', { timeout: 180_000 }, async () => {
  await t.click('Find test service');
  await t.waitText('v-result', /^Verified: transactable$/);
  await t.click('Prepare simulated purchase');
  await t.waitText('p-status', /^awaiting_approval/);
  const op1 = await t.textOf('p-op');
  const p = await t.popup('Open review in the portal');
  await t.portalReady(p);
  await p.getByRole('button', { name: 'Approve exact terms' }).click();
  await t.decide(p, true, ['approve-purchase']);
  await t.decide(p, true, [t.address, 'SIMULATED']);
  await p.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
  await p.close();
  await t.click('Refresh receipt');
  await t.waitText('p-status', /^settled_verified$/);
  await t.dash.locator('#receipt').waitFor({ state: 'visible', timeout: 5000 });
  const tx = await t.textOf('r-tx');
  assert.equal(await t.dash.locator('#purchase-history').isVisible(), false, 'nothing kept yet');

  // F1: Prepare after the settled purchase.
  await t.click('Prepare simulated purchase');
  await t.waitText('p-status', /^awaiting_approval$/);
  const op2 = await t.textOf('p-op');
  assert.notEqual(op2, op1, 'a new purchase');
  assert.equal(await t.dash.locator('#receipt').isVisible(), false, 'the new purchase has no receipt');
  const kept = t.dash.locator(`#purchase-history-list li[data-operation="${op1}"]`);
  await kept.waitFor({ state: 'visible', timeout: 5000 });
  const keptText = await kept.innerText();
  assert.match(keptText, /settled_verified/);
  assert.ok(keptText.includes(tx), 'the kept entry shows the receipt transaction');
  assert.ok(keptText.toLowerCase().includes(strip0x(t.address)), 'and the payer');
  assert.match(keptText, /SIMULATED receipt from the fixture chain; not settlement/);

  await t.dash.reload();
  await t.waitText('p-status', /^awaiting_approval$/);
  await t.dash.locator(`#purchase-history-list li[data-operation="${op1}"]`).waitFor({ state: 'visible', timeout: 10000 });

  const ev = await downloadEvidence();
  const e = ev.json;
  assert.equal(e.buyer.purchase.operationId, op2);
  assert.equal(e.buyer.purchase.receipt.observed, false);
  assert.deepEqual(e.buyer.completedPurchases.map((c) => [c.operationId, c.status, c.receipt.observed]), [[op1, 'settled_verified', true]]);
  assert.equal(strip0x(e.buyer.completedPurchases[0].receipt.txHash), strip0x(tx));
  assert.doesNotMatch(ev.text, /#t=|access_token|refresh_token|Bearer|tester-(buy|add)-|idempotency|password|mnemonic/i);
  for (const s of t.secrets()) assert.ok(!ev.text.includes(s), 'no wallet secret in the evidence file');

  // The new purchase is cancelled: it never shows a receipt.
  await t.click('Cancel pending purchase');
  await t.waitText('p-status', /^cancelled$/);
  assert.equal(await t.dash.locator('#receipt').isVisible(), false);
});

test('D1: an identity action cancelled on its portal page is closed; Add (before any refresh) starts a new action with a new link, which completes in the same run', { timeout: 180_000 }, async () => {
  await t.click('Add test Twitter identity');
  await t.waitText('tw-add-status', /^(prepared|awaiting_wallet)/);
  const firstLink = await t.dash.locator('#tw-add-review').getAttribute('href');
  const p = await t.popup('Open Twitter add review in the portal');
  await t.portalReady(p);
  await p.getByRole('button', { name: 'Cancel this identity action' }).click();
  await p.getByText('Identity action cancelled. Nothing was sent to your wallet.').waitFor({ timeout: 15000 });
  await p.close();

  // No "Refresh identities": the dashboard still shows the earlier status.
  await t.click('Add test Twitter identity');
  await t.dash.waitForFunction((old) => {
    const a = document.getElementById('tw-add-review');
    return a && a.getAttribute('href') && a.getAttribute('href') !== old;
  }, firstLink, { timeout: 15000 });
  await t.waitText('tw-add-status', /^(prepared|awaiting_wallet)/);
  assert.equal(await t.dash.locator('#identity-error').isVisible(), false, 'no identity_operation_in_progress refusal');

  // Complete the new action (Add again returns this same open action).
  await t.identityAdd('twitter', TW_HANDLE);
  await t.click('Refresh identities');
  await t.waitText('o-twitter', new RegExp(`^${TW_HANDLE}$`));
  await t.waitText('tw-add-status', /^association_observed/);
  await t.dash.reload();
  await t.waitText('sign-in-status', /^Signed in\./);
  assert.doesNotMatch((await t.dash.locator('#resume-list').textContent()) ?? '', /Twitter identity/, 'nothing identity-related is unfinished');
  assert.equal(await t.dash.locator('#restart-notice').isVisible(), false, 'no launcher restart happened');
});

test('hygiene: no console errors on the dashboard, wallet or portal pages, and no wallet secret in any request', () => {
  const errors = t.records.flatMap((r) => r.consoleErrors);
  assert.deepEqual(errors, []);
  const requests = t.records.flatMap((r) => r.requests.map((q) => `${q.url} ${q.body}`)).join('\n');
  for (const s of t.secrets()) assert.ok(!requests.includes(s), 'no wallet secret in a request');
});
