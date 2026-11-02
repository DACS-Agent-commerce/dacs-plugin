// Real Chromium, simulated source launcher: retained buyer consent,
// interruption/restart, identity and evidence checks use the baseline fixture
// Listing. Seller publication belongs to the v1 tests and seller kit.
// A missing browser is a failed host precondition, never a passing check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startOfflineTester } from '../../bin/dacs-chatgpt-offline-test.mjs';
import { Profile } from '../helpers/overnight-ui-browser.mjs';
import { dashboardClient } from '../helpers/overnight-ui-actors.mjs';

const CHROME = process.env.DACS_TEST_CHROME;
let h;
let browserServer;
let browser;
let downloads = null;
const logs = [];
// Shared run state; tests run in order and later ones check what they need.
const run = { title: null, priceDem: null, amountOs: null, buyer: null, d: null, operationId: null, settled: false, twitterRemoved: false };

before(async () => {
  assert.ok(CHROME && existsSync(CHROME), `real Chromium required: DACS_TEST_CHROME=${CHROME ?? '(unset)'}`);
  h = await startOfflineTester({ dashboard: true, logLevel: 'info', logSink: (line) => logs.push(line) });
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT || tmpdir();
  mkdirSync(parent, { recursive: true });
  downloads = mkdtempSync(join(parent, 'overnight-ui-'));
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true, downloadsPath: downloads });
  browser = await chromium.connect(browserServer.wsEndpoint());
  run.d = dashboardClient(h);
  const found = await run.d.action('find-listing');
  assert.equal(found.ok, true);
  const verified = (await run.d.state()).listing.verification;
  assert.equal(verified.transactable, true);
  run.title = verified.title;
  run.priceDem = verified.amount;
  run.amountOs = verified.amountOs;
  run.buyer = new Profile(await browser.newContext({ acceptDownloads: true }), h, 'buyer');
});

after(async () => {
  await run.buyer?.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => browserServer.kill());
  await h?.stop();
  if (downloads) {
    process.stdout.write(`# download dir entries: ${readdirSync(downloads).length}\n`);
    rmSync(downloads, { recursive: true, force: true });
  }
});

// One reported unit: named checks run in order; the first failing check
// fails the test (no BLOCKED or skip outcome exists).
async function unit(fn) {
  const done = [];
  const step = async (name, body) => {
    try {
      const detail = await body();
      done.push(name);
      process.stdout.write(`ok   ${name}${detail ? ` (${detail})` : ''}\n`);
    } catch (error) {
      process.stdout.write(`FAIL ${name} (${String(error?.message ?? error).split('\n')[0].slice(0, 400)})\n`);
      throw new Error(`${name}: ${String(error?.message ?? error).split('\n')[0].slice(0, 400)}`);
    }
  };
  await fn(step);
  assert.ok(done.length > 0, 'no checks ran');
}

// Optional full-page dashboard screenshot (DACS_TEST_SCREENSHOT_DIR); the
// page must not show the wallet password or recovery phrase.
async function screenshot(profile, name) {
  const dir = process.env.DACS_TEST_SCREENSHOT_DIR;
  if (!dir) return;
  const visible = await profile.dash.locator('body').innerText();
  if (profile.secrets().some((x) => visible.includes(x)) || /access_token|refresh_token|Bearer /.test(visible)) throw new Error('page shows a secret');
  await profile.dash.screenshot({ path: join(dir, name), fullPage: true });
}

async function saveDownload(download) {
  const failure = await download.failure();
  if (failure) throw new Error(`download failed: ${failure}`);
  const dir = mkdtempSync(join(downloads, 'dl-'));
  try {
    const file = join(dir, download.suggestedFilename());
    await download.saveAs(file);
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('C1/C4/C5/C6 buyer: discovers the baseline listing, rejection, interruption, purchase settles only on readback', { timeout: 180_000 }, async () => {
  const { buyer: b, title, priceDem, amountOs } = run;
  const payee = h.listing.sellerAddress;
  await unit(async (step) => {
    await step('[C1] buyer: built-in wallet and normal OAuth sign-in', async () => {
      await b.open();
      await b.createWallet();
      if (b.address === payee) throw new Error('buyer wallet equals fixture seller wallet');
      await b.signIn('buyer');
    });
    await step('[C6] buyer search: empty text is explained and focus returns to the search box', async () => {
      await b.dash.locator('#search-query').fill('   ');
      await b.dash.locator('#search-query').press('Enter');
      await b.waitText('listing-error', /Type part of a service title/);
      if ((await b.activeId()) !== 'search-query') throw new Error(`focus is on #${await b.activeId()}`);
    });
    await step('[C4] buyer discovers the baseline fixture Listing by title and verifies its exact price', async () => {
      await b.dash.locator('#search-query').fill(title);
      await b.dash.locator('#search-query').press('Enter');
      await b.waitText('search-summary', /^1 result\(s\)/);
      if (await b.dash.locator('#listing-error').isVisible()) throw new Error('old search error still shown after a good search');
      const item = await b.textOf('search-results');
      if (!item.includes(title) || !item.includes(`${priceDem} DEM`)) throw new Error(`result ${item}`);
      await b.dash.getByRole('button', { name: `Verify and choose "${title}"` }).click();
      await b.waitText('v-result', /^Verified: transactable$/);
      if ((await b.textOf('v-title')) !== title) throw new Error('verified title differs');
      const price = await b.textOf('v-price');
      if (!price.startsWith(`${priceDem} DEM (${amountOs} OS`)) throw new Error(`verified price ${price}`);
      await b.waitText('p-target', /^Buying:/);
      assert.ok((await b.textOf('p-target')).startsWith(`Buying: "${title}" for ${priceDem} DEM`));
    });
    await step('[C4] buyer: Prepare simulated purchase binds the fixture Listing and price; waiting is not completion', async () => {
      await b.click('Prepare simulated purchase');
      await b.waitText('p-status', /^awaiting_approval/);
      run.operationId = await b.textOf('p-op');
      if (!(await b.textOf('p-amount')).includes(amountOs)) throw new Error('amount differs');
      if ((await b.textOf('p-payee')).toLowerCase() !== payee) throw new Error('payee is not the seller wallet');
      if (!(await b.dash.locator('#receipt-waiting').isVisible()) || await b.dash.locator('#receipt').isVisible()) throw new Error('pending shown as complete');
    });
    await step('[C5] buyer: Reject in the wallet dialog leaves the purchase awaiting approval with no receipt', async () => {
      const p = await b.popup('Open review in the portal');
      await b.portalReady(p);
      await p.getByRole('button', { name: 'Approve exact terms' }).click();
      await b.decide(p, false);
      await p.getByText(/not approved|rejected/i).first().waitFor({ timeout: 10000 });
      await p.close();
      await b.click('Refresh receipt');
      await b.waitText('p-status', /^awaiting_approval/);
      if (await b.dash.locator('#receipt').isVisible()) throw new Error('a rejected approval shows a receipt');
    });
    await step('[C5] buyer: closing the portal mid-approval, then reloading, shows the unfinished purchase; Prepare returns the SAME operation', async () => {
      const p = await b.popup('Open review in the portal');
      await b.portalReady(p);
      await p.close();
      await b.dash.reload();
      await b.dash.locator('#resume').waitFor({ state: 'visible', timeout: 10000 });
      if (!/Simulated purchase \(awaiting_approval\)/.test(await b.textOf('resume-list'))) throw new Error('resume list lacks the purchase');
      await b.click('Prepare simulated purchase');
      await b.waitText('p-status', /same pending purchase returned/);
      if ((await b.textOf('p-op')) !== run.operationId) throw new Error('a new purchase was created');
    });
    await step('[C4] buyer: explicit approval in the built-in wallet; the receipt appears only after independent readback, at the exact fixture price', async () => {
      const before = h.chainStats();
      const p = await b.popup('Open review in the portal');
      await b.portalReady(p);
      await p.getByRole('button', { name: 'Approve exact terms' }).click();
      await b.decide(p, true, ['approve-purchase', payee]);
      await b.decide(p, true, [payee, amountOs, b.address, 'SIMULATED']);
      await p.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
      await p.close();
      if (await b.dash.locator('#receipt').isVisible()) throw new Error('receipt shown before Refresh receipt');
      await b.click('Refresh receipt');
      await b.waitText('p-status', /^settled_verified$/);
      await b.dash.locator('#receipt').waitFor({ state: 'visible', timeout: 5000 });
      if (!(await b.textOf('r-amount')).includes(amountOs)) throw new Error('receipt amount');
      // Same 0x-prefixed form as the rest of the page.
      if ((await b.textOf('r-payee')).toLowerCase() !== payee) throw new Error(`receipt payee ${await b.textOf('r-payee')}`);
      if ((await b.textOf('r-payer')).toLowerCase() !== b.address) throw new Error(`receipt payer ${await b.textOf('r-payer')}`);
      if (!/simulated-fixture.*not settlement/.test(await b.textOf('r-mode'))) throw new Error('receipt label');
      const delta = h.chainStats().broadcastAccepted - before.broadcastAccepted;
      if (delta !== 1) throw new Error(`${delta} accepted broadcasts`);
      await screenshot(b, 'overnight-ui-buyer.png');
    });
    await step('[C5] buyer: after reload the settled purchase stays settled, with nothing unfinished and no review link', async () => {
      await b.dash.reload();
      await b.waitText('p-status', /^settled_verified$/);
      if (await b.dash.locator('#purchase-review').isVisible()) throw new Error('settled purchase offers the review link');
      if (await b.dash.locator('#resume').isVisible()) throw new Error('settled purchase listed as unfinished');
      run.settled = true;
    });
  });
});

test('C2 buyer: Twitter identity add then remove with the built-in wallet', { timeout: 120_000 }, async () => {
  const { buyer: b } = run;
  assert.ok(b.address, 'no signed-in buyer');
  const twitter = `tw_${randomBytes(3).toString('hex')}`;
  await unit(async (step) => {
    await step('[C2] Add test Twitter identity -> portal -> proof publisher (twitter) -> wallet approval -> readback shows the handle', async () => {
      await b.identityAdd('twitter', twitter);
      await b.click('Refresh identities');
      await b.waitText('o-twitter', new RegExp(`^${twitter}$`));
      await b.waitText('tw-add-status', /^association_observed/);
    });
    await step('[C2] Remove test Twitter identity -> wallet approval -> readback shows none', async () => {
      await b.identityRemove('twitter', twitter);
      await b.click('Refresh identities');
      await b.waitText('o-twitter', /^none observed$/);
      await b.waitText('tw-remove-status', /^removal_observed/);
      run.twitterRemoved = true;
    });
  });
});

test('C7 evidence download by keyboard reflects the actual workflow and carries no secrets', { timeout: 60_000 }, async () => {
  const { buyer: b, title, amountOs } = run;
  assert.ok(run.settled && run.twitterRemoved, 'earlier workflow steps did not complete');
  await unit(async (step) => {
    await step('[C7] nonempty JSON of the actual workflow, simulation notice, no secrets or capabilities', async () => {
      await b.dash.locator('#evidence-button').focus();
      const [download] = await Promise.all([b.dash.waitForEvent('download', { timeout: 10000 }), b.dash.keyboard.press('Enter')]);
      const body = await saveDownload(download);
      if (!body || body.length < 500) throw new Error(`evidence file is ${body.length} bytes`);
      const e = JSON.parse(body);
      if (download.suggestedFilename() !== 'dacs-offline-tester-evidence.json') throw new Error(download.suggestedFilename());
      if (e.kind !== 'dacs-offline-tester-evidence' || e.simulation.evidence !== 'simulated-fixture' || e.simulation.funded !== false || e.simulation.demosTestnet !== false) throw new Error('simulation notice');
      assert.equal(e.seller.listing, null, 'v2 created no seller publication');
      assert.equal(e.seller.wallet, null);
      assert.equal(e.baselineFixture.seller, h.listing.seller);
      if (e.buyer.target.title !== title || e.buyer.target.amountOs !== amountOs || e.buyer.target.baseline !== true) throw new Error('buyer target');
      if (e.buyer.purchase.status !== 'settled_verified' || e.buyer.purchase.receipt.observed !== true) throw new Error('purchase');
      if (e.identity.twitterRemove?.status !== 'removal_observed') throw new Error('twitter identity');
      if (!e.activity.some((a) => a.action === 'prepare-purchase')) throw new Error('activity');
      const found = [...b.secrets(), '#t=', 'access_token', 'refresh_token', 'Bearer', 'code_verifier', 'tester-buy-', 'tester-sell-'].filter((x) => body.includes(x));
      if (found.length) throw new Error(`evidence carries ${found.length} forbidden value(s)`);
      await b.waitText('evidence-status', /Evidence file created/);
    });
  });
});

test('C1 cross-cutting: loopback-only requests, no console errors, no wallet secrets in requests, console or logs', () => {
  const { buyer: b } = run;
  const pages = [...b.records];
  assert.ok(pages.length > 0, 'no pages were recorded');
  const allowed = [h.origin, h.fixtures.proofs];
  const off = pages.flatMap((p) => p.requests).filter((r) => !r.url.startsWith('blob:') && !allowed.some((o) => r.url.startsWith(`${o}/`)));
  assert.deepEqual(off.slice(0, 3).map((r) => r.url.slice(0, 80)), [], 'every browser request went to the launched loopback origins');
  const errors = pages.flatMap((p) => p.consoleErrors);
  assert.deepEqual(errors.slice(0, 3), [], 'no browser console errors (unfiltered)');
  const secrets = b.secrets();
  assert.ok(secrets.length === 2, 'the buyer wallet was created');
  const scan = [...pages.flatMap((p) => p.requests.map((r) => `${r.url} ${r.body}`)), ...pages.flatMap((p) => p.consoleAll), ...logs];
  assert.equal(scan.filter((x) => secrets.some((y) => x.includes(y))).length, 0, 'passwords and recovery phrases absent from requests, console and operator logs');
  const dashCalls = pages.flatMap((p) => p.requests).filter((r) => r.url.startsWith(`${h.origin}/tester/api/`));
  assert.ok(dashCalls.length > 0 && !dashCalls.some((r) => secrets.some((y) => r.body.includes(y) || r.url.includes(y))), 'dashboard API requests never carry a password or recovery phrase');
});

test('C5 launcher restart on the same port: the open dashboard shows the restart notice and no stale sign-in or receipt', { timeout: 60_000 }, async () => {
  const { buyer: b } = run;
  assert.ok(b.dash, 'no buyer dashboard page');
  const port = Number(new URL(h.origin).port);
  await h.stop();
  h = await startOfflineTester({ dashboard: true, port, logLevel: 'silent' });
  await b.dash.reload();
  await b.dash.locator('#restart-notice').waitFor({ state: 'visible', timeout: 10000 });
  await b.waitText('sign-in-status', /^Not signed in\.$/);
  assert.ok(await b.dash.locator('#purchase-empty').isVisible(), 'a purchase from the old run is still shown');
});
