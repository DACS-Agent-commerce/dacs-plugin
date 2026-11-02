// Positive integration tests: the trusted portal with the EXPERIMENTAL,
// explicit opt-in embedded wallet (public/portal/embedded-wallet-bridge.mjs).
// Evidence labels:
//  - browser-real: headless Chrome from DACS_TEST_CHROME, the real portal page
//    and packaged assets from the real plugin server on loopback, under the
//    unchanged portal CSP.
//  - sdk-real: the bundled upstream Demos SDK (demos-runtime.mjs) creating,
//    importing, unlocking and signing in the page.
//  - server-real: the plugin's own challenge verification and OAuth flow.
//  - SIMULATED: the "extension" is an injected provider stand-in; fixture
//    chain/directory services are loopback-only.
// Not a security review, not source-blind validation, not ChatGPT framing,
// installed-wallet or live-network proof. Key material is fresh and RAM-only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { auth } from '@modelcontextprotocol/client';
import { startHarness, CALLBACK_ORIGIN } from '../helpers/harness.mjs';
import { TestOAuthProvider } from '../helpers/oauth.mjs';
import { tool, seedSellerListing, linkedUser } from '../helpers/flows.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import {
  SDK_MODULES, UI_MODULES, UI, EMBEDDED_WALLET_ASSET_PATH, modulePresence, blockedUnless, chromeSkipReason, launchTestChrome,
  openRecordedPage, createCleanupStack, assertNoSecrets, freshPassword, uiCreate, uiImport, uiShownPhrase, uiLock, uiUnlock,
} from '../helpers/embedded-wallet-fixtures.mjs';

const presence = modulePresence([...SDK_MODULES, ...UI_MODULES]);
const skip = chromeSkipReason();
const gate = { ...blockedUnless(presence), skip };
const ready = presence.present && !skip;
const EMBEDDED_ASSETS = /\/portal\/assets\/(embedded-wallet-bridge\.mjs|embedded-wallet\/)/;
const NO_WRITES = 'The experimental embedded wallet cannot send payments, publish listings or change identities.';

let h;
let browser;
const cleanups = createCleanupStack();

before(async () => {
  if (!ready) return;
  // Stands in for ChatGPT's redirect URI (Playwright routes do not intercept
  // the server's redirect to it). Loopback only.
  const callback = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }).end('<p>callback</p>'));
  await new Promise((resolve, reject) => {
    callback.once('error', reject);
    callback.listen(Number(new URL(CALLBACK_ORIGIN).port), '127.0.0.1', resolve);
  });
  cleanups.add('callback server close', 5000, () => new Promise((resolve, reject) => {
    callback.close((error) => (error ? reject(error) : resolve()));
    callback.closeAllConnections();
  }));
  h = await startHarness();
  cleanups.add('harness close', 10000, () => h.close());
  const launched = await launchTestChrome(cleanups);
  browser = launched.browser;
  process.stderr.write(`embedded-wallet portal browser: ${launched.executablePath} version ${launched.version}\n`);
});

after(async () => {
  await cleanups.run();
});

// SIMULATED extension stand-in. `announce`: 'now' answers discovery at once,
// 'later' only after window.__allowAnnounce is set, 'never' not at all.
// window.demos is a sentinel without request(), so discovery uses the events.
async function portalPage({ announce = 'never' } = {}) {
  const rec = await openRecordedPage(browser, cleanups);
  const extensionCalls = [];
  await rec.page.exposeFunction('__simExtension', async (method) => {
    extensionCalls.push(method);
    return { success: false, error: { message: 'simulated extension: not used in this test' } };
  });
  await rec.page.addInitScript((mode) => {
    window.demos = { __sentinel: 'existing-extension-stand-in' };
    if (mode === 'never') return;
    const provider = { request: ({ method }) => window.__simExtension(method) };
    window.__announced = 0;
    window.addEventListener('demosRequestProvider', () => {
      if (mode !== 'now' && !window.__allowAnnounce) return;
      window.__announced += 1;
      window.dispatchEvent(new CustomEvent('demosAnnounceProvider', { detail: { provider } }));
    });
  }, announce);
  return { ...rec, extensionCalls, wallet: rec.page.locator('#embedded-wallet'), status: rec.page.locator('#wallet-status') };
}

const sentinel = (page) => page.evaluate(() => window.demos?.__sentinel ?? null);

async function chooseEmbedded(p) {
  await p.page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  await p.wallet.getByRole('button', { name: UI.create }).waitFor({ timeout: 10000 });
}

async function expectState(p, state) {
  await p.page.waitForFunction((s) => document.getElementById('wallet-status')?.dataset.state === s, state, { timeout: 10000 });
}

test('default: extension discovery stays the default, nothing embedded loads, no key field exists, and the extension connects as before [browser-real + SIMULATED extension]', gate, async () => {
  const user = await linkedUser(h);
  const link = (await tool(h, user, 'start_wallet_link')).linkUrl;
  const added = createEphemeralWallet();
  const p = await portalPage({ announce: 'never' });
  // The simulated extension answers connect with its own address.
  await p.page.exposeFunction('__simAddress', () => added.address);
  await p.page.addInitScript(() => {
    window.addEventListener('demosRequestProvider', () => {
      const provider = { request: async ({ method }) => (method === 'connect' ? { success: true, data: { address: await window.__simAddress() } } : window.__simExtension(method)) };
      window.dispatchEvent(new CustomEvent('demosAnnounceProvider', { detail: { provider } }));
    });
  });
  const response = await p.page.goto(link);
  assert.match(response.headers()['content-security-policy'], /script-src 'self'/);
  await p.page.getByText('Wallet found. Connect to continue.').waitFor({ timeout: 8000 });
  await p.page.getByRole('button', { name: 'Use the experimental embedded wallet' }).waitFor();
  assert.equal(await p.page.locator('input, textarea').count(), 0, 'no field could take a seed or key by default');
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByText(`Connected: ${added.address}`, { exact: true }).waitFor({ timeout: 8000 });
  assert.equal(await sentinel(p.page), 'existing-extension-stand-in', 'window.demos is untouched');
  assert.deepEqual(p.requests.filter((r) => EMBEDDED_ASSETS.test(r.url)).map((r) => r.url), [], 'embedded wallet modules are not loaded without an explicit choice');
  assert.deepEqual(p.consoleErrors, []);
  await p.context.close();
});

test('opt-in: create with the real SDK, connect, lock clears the connection, unlock, then OAuth sign-in signed in the embedded wallet and verified by the server [browser-real + sdk-real + server-real]', gate, async () => {
  const scope = 'dacs.account.read';
  const oauth = new TestOAuthProvider({ scope });
  assert.equal(await auth(oauth, { serverUrl: h.mcpUrl, scope }), 'REDIRECT');
  const p = await portalPage({ announce: 'never' });
  await p.page.goto(oauth.authorizationUrl.href);
  await p.page.getByText('Link your DACS account').waitFor({ timeout: 8000 });
  await expectState(p, 'unavailable');

  await chooseEmbedded(p);
  await expectState(p, 'embedded_locked');
  assert.equal(await p.page.locator('#wallet-setup').isVisible(), false, 'extension setup help is hidden after the choice');
  const password = freshPassword();
  const address = await uiCreate(p.wallet, password);
  const phrase = await uiShownPhrase(p.wallet);
  await p.page.getByText('Experimental embedded wallet unlocked. Connect to continue.').waitFor({ timeout: 8000 });
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });

  // Locking clears the portal's provider and address.
  await uiLock(p.wallet);
  await expectState(p, 'embedded_locked');
  assert.equal(await p.page.getByRole('button', { name: 'Connect wallet' }).isDisabled(), true);
  await p.page.getByRole('button', { name: 'Sign in and allow' }).click();
  await p.page.locator('#log').getByText('connect your wallet first').waitFor({ timeout: 8000 });
  assert.equal(await p.page.locator('dialog').count(), 0, 'no approval prompt while locked');

  // Unlock (decrypt + SDK import with the exported validator), reconnect, sign in.
  assert.equal(await uiUnlock(p.wallet, password), address);
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
  await p.page.getByRole('button', { name: 'Sign in and allow' }).click();
  const dialog = p.page.locator('dialog');
  await dialog.getByText('purpose: account-login').waitFor({ timeout: 10000 });
  assert.equal(p.page.url().startsWith(CALLBACK_ORIGIN), false, 'nothing completes before the deliberate approval click');
  await dialog.getByRole('button', { name: UI.approve }).click();
  await p.page.waitForURL(`${CALLBACK_ORIGIN}/**`, { timeout: 15000 });
  const callback = new URL(p.page.url());
  assert.equal(await auth(oauth, { serverUrl: h.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope }), 'AUTHORIZED');
  const account = await tool(h, { provider: oauth }, 'get_account_status');
  assert.ok(account.wallets.some((w) => w.address === address), 'the server linked the embedded wallet address after verifying its signature');

  assert.deepEqual(p.extensionCalls, []);
  for (const r of p.requests) assert.ok(r.url.startsWith(`${h.origin}/`) || r.url.startsWith(`${CALLBACK_ORIGIN}/`), `request stays on loopback: ${new URL(r.url).origin}`);
  assertNoSecrets(p.requests, [phrase, password], 'portal requests (method/url/body)');
  assertNoSecrets([...p.consoleAll, p.page.url()], [phrase, password], 'console and URL');
  assertNoSecrets(h.logs, [phrase, password], 'plugin server logs');
  assert.deepEqual(p.consoleErrors, []);
  await p.context.close();
});

test('opt-in: a deliberate embedded choice survives later extension discovery; real SDK import; payments stay unavailable and no live transaction is attempted [browser-real + sdk-real + SIMULATED extension]', gate, async () => {
  // A phrase from a fresh wallet created by the SDK on the standalone page.
  const source = await openRecordedPage(browser, cleanups);
  await source.page.goto(`${h.origin}${EMBEDDED_WALLET_ASSET_PATH}`);
  const created = await uiCreate(source.page, freshPassword());
  const phrase = await uiShownPhrase(source.page);
  await source.context.close();

  const seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'embedded-portal', price: '3' });
  const buyer = await linkedUser(h);
  const purchase = await tool(h, buyer, 'prepare_purchase', { listingId: 'embedded-portal', version: 1, seller: seller.claim, idempotencyKey: `embedded-portal-${Date.now()}` });
  assert.equal(purchase.status, 'awaiting_approval');

  const p = await portalPage({ announce: 'later' });
  await p.page.goto(purchase.approvalUrl);
  await expectState(p, 'searching');
  await chooseEmbedded(p);
  // Now let the extension answer the discovery retries that are still running.
  await p.page.evaluate(() => { window.__allowAnnounce = true; });
  await p.page.getByText('Approve DEM testnet purchase').waitFor({ timeout: 10000 });
  await p.page.waitForTimeout(1000);
  const announced = await p.page.evaluate(() => window.__announced);
  if (announced === 0) throw new Error('precondition: the simulated extension never answered discovery after the choice (embedded UI loaded after discovery timed out); the race was not exercised');
  assert.equal(await p.status.getAttribute('data-state'), 'embedded_locked', 'discovery did not replace the deliberate embedded choice');

  const password = freshPassword();
  assert.equal(await uiImport(p.wallet, phrase, password), created, 'SDK import reproduces the created address');
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByText(`Connected: ${created} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
  await p.page.getByRole('button', { name: 'Approve exact terms' }).click();
  await p.page.locator('#log').getByText(NO_WRITES).waitFor({ timeout: 8000 });
  assert.equal(await p.page.locator('dialog').count(), 0, 'no signature is requested for a flow that needs a transaction');
  assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: purchase.operationId })).status, 'awaiting_approval');

  assert.deepEqual(p.extensionCalls, [], 'the extension was never asked anything');
  assert.equal(await sentinel(p.page), 'existing-extension-stand-in', 'window.demos is untouched');
  assert.deepEqual(p.requests.filter((r) => /\/(challenge|approve|handoff|report)$/.test(new URL(r.url).pathname)), [], 'no purchase challenge, approval, handoff or report request');
  assertNoSecrets([...p.requests, ...p.consoleAll, p.page.url()], [phrase, password], 'portal requests, console and URL');
  assertNoSecrets(h.logs, [phrase, password], 'plugin server logs');
  assert.deepEqual(p.consoleErrors, []);
  await p.context.close();
});
