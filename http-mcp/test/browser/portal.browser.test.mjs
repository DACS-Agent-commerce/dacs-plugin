// Browser test of the trusted signing portal in real (headless) Chrome.
// SIMULATED: the Demos wallet extension is replaced by an injected provider
// backed by an ephemeral Node-side key; "sendTransaction" broadcasts into the
// fixture chain (used here only by seller publication: purchase payments from
// an extension are held). This proves the portal's provider contract and
// flows, not a real wallet extension or real testnet funds.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { auth } from '@modelcontextprotocol/client';
import { startHarness, CALLBACK_ORIGIN } from '../helpers/harness.mjs';
import { TestOAuthProvider } from '../helpers/oauth.mjs';
import { tool, seedSellerListing, linkedUser } from '../helpers/flows.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';

const CHROME = process.env.DACS_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !existsSync(CHROME) && `Chrome not found at ${CHROME}`;

let h;
let browser;
let browserServer;
let seller;
let callbackServer;
const contexts = new Set();

// Teardown must be deterministic, bounded and honest. Every step is attempted
// in order, each with a hard time limit, so a lingering socket or browser
// process cannot hold the runner open. Any rejection or timeout is collected
// and reported as a failure once all steps have been tried, so a broken
// cleanup can never pass silently.
export async function runCleanup(steps) {
  const failures = [];
  for (const { label, ms, fn } of steps) {
    const started = Date.now();
    // The timer stays referenced while it is awaited, so the step's own time
    // limit keeps the event loop alive even when no browser or server handle
    // exists (e.g. Chrome absent). It is always cleared once the race settles.
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    });
    try {
      const outcome = await Promise.race([Promise.resolve().then(fn).then(() => ({ ok: true })), limit]);
      if (outcome.timedOut) failures.push(new Error(`teardown step "${label}" did not finish within ${ms}ms`));
    } catch (error) {
      failures.push(new Error(`teardown step "${label}" failed: ${error?.message ?? error}`, { cause: error }));
    } finally {
      clearTimeout(timer);
      if (process.env.DACS_CLEANUP_TIMINGS === '1') process.stderr.write(`teardown-timing ${label} ${Date.now() - started}ms\n`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} teardown step(s) failed: ${failures.map((f) => f.message).join('; ')}`);
  }
}

// Chrome's own graceful shutdown occasionally stalls under heavy host load:
// measured here, the browser process sat idle (state Ss, 0% CPU) after its
// children exited, once for more than 120 s. The test's real
// obligation is that the browser it launched is gone, so shutdown is: bounded
// graceful close; if that stalls, a recorded notice plus termination of only
// the test-launched process; then a verified exit. A graceful close that
// errors, or a process that is still alive after termination, fails teardown.
export const teardownNotices = [];
export async function shutdownLaunchedBrowser({ graceful, kill, hasExited, graceMs, killMs, notice = (m) => teardownNotices.push(m) }) {
  const within = (fn, ms) => {
    // Referenced while awaited (see runCleanup); cleared once the race settles.
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
    });
    return Promise.race([Promise.resolve().then(fn).then(() => ({ status: 'done' }), (error) => ({ status: 'error', error })), limit]).finally(() => clearTimeout(timer));
  };
  const first = await within(graceful, graceMs);
  if (first.status === 'done' && hasExited()) return { graceful: true };
  notice(first.status === 'timeout'
    ? `graceful browser close exceeded ${graceMs}ms; terminating the test-launched browser process`
    : first.status === 'error'
      ? `graceful browser close failed (${first.error?.message ?? first.error}); terminating the test-launched browser process`
      : 'graceful browser close returned but the process is still running; terminating the test-launched browser process');
  const second = await within(kill, killMs);
  if (second.status !== 'done') throw new Error(`test-launched browser termination ${second.status === 'timeout' ? `did not finish within ${killMs}ms` : `failed: ${second.error?.message ?? second.error}`}`);
  if (!hasExited()) throw new Error('test-launched browser process is still running after termination');
  if (first.status === 'error') throw new Error(`graceful browser close failed: ${first.error?.message ?? first.error} (process was terminated)`);
  return { graceful: false };
}

before(async () => {
  if (skip) return;
  // Stands in for ChatGPT's redirect URI: just renders a page so the browser can land.
  callbackServer = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }).end('<p>callback</p>'));
  await new Promise((resolve) => callbackServer.listen(Number(new URL(CALLBACK_ORIGIN).port), '127.0.0.1', resolve));
  // Identity actions are enabled only against this simulated fixture chain.
  h = await startHarness({ env: { DACS_IDENTITY_WRITES: 'simulated-fixture-only' } });
  seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'browser-report', price: '4' });
  // launchServer gives the test a handle on exactly the process it started,
  // so teardown never needs to look for (or touch) any other Chrome.
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
});
after(async () => {
  // Browser first (it owns client sockets), then servers with their
  // connections force-closed. Chrome may hold preconnected sockets that never
  // sent a request; plain server.close() leaves those open until Node's
  // 300 s requestTimeout, which is what delayed the final TAP summary.
  const proc = browserServer?.process();
  await runCleanup([
    ...[...contexts].map((context, i) => ({ label: `context.close #${i + 1}`, ms: 5000, fn: () => context.close() })),
    { label: 'browser disconnect', ms: 5000, fn: () => browser?.close() },
    {
      label: 'launched browser shutdown',
      ms: 20000,
      fn: () => browserServer && shutdownLaunchedBrowser({
        graceful: () => browserServer.close(),
        kill: () => browserServer.kill(),
        hasExited: () => proc.exitCode !== null || proc.signalCode !== null,
        graceMs: 8000,
        killMs: 10000,
      }),
    },
    {
      label: 'callback server close',
      ms: 5000,
      fn: () => new Promise((resolve, reject) => {
        if (!callbackServer) return resolve();
        callbackServer.close((error) => (error ? reject(error) : resolve()));
        callbackServer.closeAllConnections();
      }),
    },
    { label: 'harness close', ms: 10000, fn: () => h?.close() },
  ]);
  for (const message of teardownNotices) process.stderr.write(`teardown-notice: ${message}\n`);
});

// Deterministic regressions for the cleanup helper itself (no browser or
// network): a rejecting step and a never-resolving step must both surface as
// failures, and later steps must still run.
test('cleanup helper: a rejecting step fails teardown after all steps run', async () => {
  const ran = [];
  await assert.rejects(
    runCleanup([
      { label: 'first', ms: 200, fn: () => ran.push('first') },
      { label: 'boom', ms: 200, fn: async () => { ran.push('boom'); throw new Error('close failed'); } },
      { label: 'last', ms: 200, fn: () => ran.push('last') },
    ]),
    (error) => error instanceof AggregateError && error.errors.length === 1 && /teardown step "boom" failed: close failed/.test(error.message),
  );
  assert.deepEqual(ran, ['first', 'boom', 'last']);
});

test('cleanup helper: an unresolved step times out, fails teardown, and later steps still run', async () => {
  const ran = [];
  const started = Date.now();
  await assert.rejects(
    runCleanup([
      { label: 'hang', ms: 50, fn: () => new Promise(() => { ran.push('hang'); }) },
      { label: 'reject', ms: 50, fn: () => Promise.reject(new Error('second failure')) },
      { label: 'after', ms: 50, fn: () => ran.push('after') },
    ]),
    (error) => error instanceof AggregateError && error.errors.length === 2
      && /teardown step "hang" did not finish within 50ms/.test(error.message)
      && /teardown step "reject" failed: second failure/.test(error.message),
  );
  assert.deepEqual(ran, ['hang', 'after']);
  assert.ok(Date.now() - started < 2000, 'the timeout bounds the hung step');
  await runCleanup([{ label: 'fine', ms: 50, fn: () => {} }]); // all-success resolves
});

// Deterministic regressions for the launched-browser shutdown helper, using
// fake handles (no browser, no processes signalled).
function fakeBrowser({ graceful = 'resolve', kill = 'exit' } = {}) {
  const state = { exited: false, killed: 0 };
  return {
    state,
    graceful: () => (graceful === 'resolve' ? Promise.resolve().then(() => { state.exited = true; })
      : graceful === 'reject' ? Promise.reject(new Error('close protocol error'))
        : graceful === 'returns-alive' ? Promise.resolve() : new Promise(() => {})),
    kill: () => {
      state.killed += 1;
      if (kill === 'exit') state.exited = true;
      return kill === 'hang' ? new Promise(() => {}) : Promise.resolve();
    },
    hasExited: () => state.exited,
  };
}

test('browser shutdown helper: graceful close with verified exit needs no termination', async () => {
  const f = fakeBrowser();
  const notes = [];
  assert.deepEqual(await shutdownLaunchedBrowser({ ...f, graceMs: 50, killMs: 50, notice: (m) => notes.push(m) }), { graceful: true });
  assert.equal(f.state.killed, 0);
  assert.deepEqual(notes, []);
});

test('browser shutdown helper: a stalled graceful close is recorded, then the launched process is terminated and verified', async () => {
  const f = fakeBrowser({ graceful: 'hang' });
  const notes = [];
  const started = Date.now();
  assert.deepEqual(await shutdownLaunchedBrowser({ ...f, graceMs: 50, killMs: 50, notice: (m) => notes.push(m) }), { graceful: false });
  assert.equal(f.state.killed, 1);
  assert.match(notes[0], /graceful browser close exceeded 50ms; terminating the test-launched browser process/);
  assert.ok(Date.now() - started < 2000);
});

test('browser shutdown helper: errors and surviving processes fail teardown', async () => {
  await assert.rejects(shutdownLaunchedBrowser({ ...fakeBrowser({ graceful: 'reject' }), graceMs: 50, killMs: 50, notice: () => {} }), /graceful browser close failed: close protocol error \(process was terminated\)/);
  await assert.rejects(shutdownLaunchedBrowser({ ...fakeBrowser({ graceful: 'hang', kill: 'alive' }), graceMs: 50, killMs: 50, notice: () => {} }), /still running after termination/);
  await assert.rejects(shutdownLaunchedBrowser({ ...fakeBrowser({ graceful: 'hang', kill: 'hang' }), graceMs: 50, killMs: 50, notice: () => {} }), /termination did not finish within 50ms/);
  const alive = fakeBrowser({ graceful: 'returns-alive' });
  assert.deepEqual(await shutdownLaunchedBrowser({ ...alive, graceMs: 50, killMs: 50, notice: () => {} }), { graceful: false });
  assert.equal(alive.state.killed, 1, 'a close that returns while the process lives is not trusted');
});

// Installs the simulated provider using the Community announce/request events.
async function pageWithWallet(wallet, { announce = true } = {}) {
  const context = await browser.newContext();
  contexts.add(context);
  context.on('close', () => contexts.delete(context));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  const calls = [];
  const signParams = [];
  await page.exposeFunction('__simWallet', async (method, params) => {
    calls.push(method);
    if (method === 'connect') return { success: true, data: { address: wallet.address } };
    if (method === 'sign') {
      // SIMULATED, typed like the reviewed wallet 0.5.7 sign handler: params[0]
      // is the plain message string. The obsolete {message, publicKey} object
      // is ordinary bad input and is refused, so it cannot pass any flow.
      signParams.push(params);
      if (typeof params?.[0] !== 'string') return { success: false, error: { message: 'sign expects params[0] to be the message string' } };
      return { success: true, data: { signature: wallet.signHex(params[0]) } };
    }
    if (method === 'sendTransaction') return { success: true, data: { hash: h.chain.walletBroadcast(params[0]) } };
    // SIMULATED identity methods, shaped like the reviewed wallet 0.5.7 handlers:
    // the "wallet" confirms and broadcasts, so the fixture chain records the change.
    if (method === 'getWeb2IdentityProofPayload') return { success: true, data: `demos:dw2p:ed25519:${wallet.signHex('dw2p').slice(2)}` };
    if (method === 'addGithubIdentity' || method === 'addTwitterIdentity') {
      const handle = new URL(params[0]).pathname.split('/').filter(Boolean)[0];
      h.chain.seedWeb2Identity(wallet.address, method === 'addGithubIdentity' ? 'github' : 'twitter', { username: handle, proof: params[0] });
      return { success: true, data: { result: { result: 200 }, validityData: { simulated: true } } };
    }
    if (method === 'removeWeb2Identity') {
      h.chain.removeWeb2Identity(wallet.address, params[0].context, params[0].username);
      return { success: true, data: { result: { result: 200 }, validityData: { simulated: true } } };
    }
    return { success: false, error: { message: 'unsupported' } };
  });
  if (announce) {
    await page.addInitScript(() => {
      const provider = { request: ({ method, params }) => window.__simWallet(method, params ?? []) };
      window.addEventListener('demosRequestProvider', () => window.dispatchEvent(new CustomEvent('demosAnnounceProvider', { detail: { provider } })));
    });
  }
  return { page, context, calls, signParams, consoleErrors };
}

test('OAuth account linking through the portal with a simulated wallet', { skip }, async () => {
  const wallet = createEphemeralWallet();
  const provider = new TestOAuthProvider({ scope: 'dacs.account.read dacs.purchases.write' });
  assert.equal(await auth(provider, { serverUrl: h.mcpUrl, scope: 'dacs.account.read dacs.purchases.write' }), 'REDIRECT');
  const { page, context, calls, signParams, consoleErrors } = await pageWithWallet(wallet);
  const response = await page.goto(provider.authorizationUrl.href);
  assert.match(response.headers()['content-security-policy'], /default-src 'none'/);
  await page.getByText('Link your DACS account').waitFor();
  await page.getByText('Prepare fixed-price DEM testnet purchases').waitFor();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${wallet.address}`).waitFor();
  await page.getByRole('button', { name: 'Sign in and allow' }).click();
  await page.waitForURL(`${CALLBACK_ORIGIN}/**`, { timeout: 10000 }).catch(async (error) => {
    throw new Error(`${error.message}; portal log: ${await page.locator('#log').innerText().catch(() => '?')}; url ${page.url()}; console ${consoleErrors.join(' | ')}`);
  });
  const callback = new URL(page.url());
  assert.equal(callback.searchParams.get('iss'), `${h.origin}/oauth`);
  assert.equal(await auth(provider, { serverUrl: h.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope: 'dacs.account.read dacs.purchases.write' }), 'AUTHORIZED');
  assert.deepEqual(calls, ['connect', 'sign']);
  assert.equal(signParams.length, 1);
  assert.equal(signParams[0].length, 1, 'sign gets exactly one parameter');
  assert.equal(typeof signParams[0][0], 'string', 'the plain message string, not an object');
  assert.match(signParams[0][0], /DACS/, 'the server challenge text itself');
  assert.deepEqual(consoleErrors, []);
  await context.close();

  // Then try to approve a purchase with the installed-extension stand-in. The
  // portal cannot verify which network an extension would send on, so the
  // payment is held: no approval signature and no send. The embedded-wallet browser flow carries the accepting control.
  const user = { provider };
  const p = await tool(h, user, 'prepare_purchase', { listingId: 'browser-report', version: 1, seller: seller.claim, idempotencyKey: `browser-${Date.now()}` });
  assert.equal(p.status, 'awaiting_approval');
  const b = await pageWithWallet(wallet);
  await b.page.goto(p.approvalUrl);
  await b.page.getByText('Approve DEM testnet purchase').waitFor();
  await b.page.getByText('4 DEM (4000000000 OS)').waitFor();
  assert.ok(!b.page.url().includes('#t='), 'handoff token removed from the address bar');
  // F1: the review labels the recorded listing evidence as simulated.
  await b.page.getByText('SIMULATED: this evidence comes from local fixture services').waitFor();
  await b.page.getByText('SIMULATED fixture (not live Demos testnet)').first().waitFor();
  // The bound network identity and the approval-only commitment show before any signature.
  await b.page.getByText('SIMULATED fixture (no real chain identity)', { exact: true }).waitFor();
  await b.page.getByText(/signed in your approval only; a DEM transfer cannot carry it/).waitFor();
  await b.page.getByRole('button', { name: 'Connect wallet' }).click();
  // F6: a double click must not prompt the wallet twice (here: not at all).
  await b.page.getByRole('button', { name: 'Approve exact terms' }).dblclick();
  await b.page.locator('#log').getByText(/Payments from an installed wallet extension are held/).first().waitFor();
  assert.deepEqual(b.calls, ['connect'], 'no approval signature and no sendTransaction from an extension wallet');
  const status = await tool(h, user, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(status.status, 'awaiting_approval');
  assert.equal(status.approval, null);
  assert.equal(status.reportedTxHash, null);
  assert.equal(h.chain.nonceOf(wallet.address), 0, 'nothing was broadcast');
  assert.equal(await b.page.getByRole('heading', { name: /receipt/i }).count(), 0);
  assert.deepEqual(b.consoleErrors, []);
  await b.context.close();
});

test('used wallet link renders a truthful state after reload (F3)', { skip }, async () => {
  const user = await linkedUser(h);
  const link = (await tool(h, user, 'start_wallet_link')).linkUrl;
  const extra = createEphemeralWallet();
  const { page, context, calls } = await pageWithWallet(extra);
  await page.goto(link);
  await page.getByRole('heading', { name: 'Link a wallet to your account' }).waitFor();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: 'Sign and link' }).click();
  await page.getByRole('heading', { name: 'Wallet linked' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Wallet link already used' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign and link' }).count(), 0, 'no action on a used link');
  assert.equal(await page.getByText('1970').count(), 0, 'no bogus epoch expiry');
  assert.deepEqual(calls, ['connect', 'sign']);
  // A fresh tab without the fragment or stored link explains instead of offering an action.
  const blank = await pageWithWallet(extra);
  await blank.page.goto(`${h.origin}/portal/link`);
  await blank.page.getByRole('heading', { name: 'Wallet link unavailable' }).waitFor();
  assert.equal(await blank.page.getByRole('button', { name: 'Sign and link' }).count(), 0);
  await blank.context.close();
  await context.close();
});

test('changed listing terms surface before any signature is requested (F9)', { skip }, async () => {
  const buyer = await linkedUser(h);
  const { listing, locator } = seedSellerListing(h, seller, { listingId: 'browser-volatile', price: '2' });
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: 'browser-volatile', version: 1, seller: seller.claim, idempotencyKey: `browser-volatile-${Date.now()}` });
  h.chain.faults.alterStorage.set(locator, { ...listing, pricing: { kind: 'fixed', price: { amount: '9', currency: 'DEM' } } });
  try {
    const { page, context, calls } = await pageWithWallet(buyer.wallet);
    await page.goto(p.approvalUrl);
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('button', { name: 'Approve exact terms' }).click();
    await page.getByRole('heading', { name: 'DEM testnet purchase status' }).waitFor();
    await page.getByText('terms_changed', { exact: true }).waitFor();
    assert.deepEqual(calls, ['connect'], 'no signature was requested on stale terms');
    assert.equal(await page.getByRole('button', { name: 'Approve exact terms' }).count(), 0);
    await context.close();
  } finally {
    h.chain.faults.alterStorage.delete(locator);
  }
});

test('portal without a wallet extension explains what is missing and offers no action', { skip }, async () => {
  const { page, context } = await pageWithWallet(createEphemeralWallet(), { announce: false });
  await page.goto(`${h.origin}/portal/link#a=acct_x&e=1&n=${'B'.repeat(22)}&t=bad`);
  await page.getByText('No Demos wallet extension found').waitFor({ timeout: 8000 });
  assert.equal(await page.getByRole('button', { name: 'Connect wallet' }).isDisabled(), true);
  await context.close();
});

test('guided wallet setup: Create/Import happen in the user\'s wallet, then the portal returns to public-address linking', { skip }, async () => {
  const user = await linkedUser(h);
  const link = (await tool(h, user, 'start_wallet_link')).linkUrl;
  const added = createEphemeralWallet();
  const { page, context, calls, consoleErrors } = await pageWithWallet(added, { announce: false });
  await page.goto(link);
  const status = page.locator('#wallet-status');
  await page.getByText('No Demos wallet extension found').waitFor({ timeout: 8000 });
  assert.equal(await status.getAttribute('data-state'), 'unavailable');
  const setup = page.locator('#wallet-setup');
  assert.equal(await setup.isVisible(), true);
  const guidance = await setup.innerText();
  assert.match(guidance, /Create/);
  assert.match(guidance, /Import/);
  assert.match(guidance, /only inside your wallet/);
  assert.match(guidance, /never asks for your recovery phrase or private key/);
  assert.match(guidance, /cannot see which network your wallet uses/);
  assert.equal(await page.locator('input, textarea').count(), 0, 'no field could take a seed or key');
  assert.deepEqual(calls, [], 'no wallet request before a wallet exists');

  // The user sets up their wallet elsewhere; the extension now answers discovery.
  await page.evaluate(() => {
    const provider = { request: ({ method, params }) => window.__simWallet(method, params ?? []) };
    window.addEventListener('demosRequestProvider', () => window.dispatchEvent(new CustomEvent('demosAnnounceProvider', { detail: { provider } })));
  });
  await page.getByRole('button', { name: 'Check for wallet again' }).click();
  await page.getByText('Wallet found. Connect to continue.').waitFor({ timeout: 8000 });
  assert.equal(await status.getAttribute('data-state'), 'awaiting_wallet');
  assert.equal(await setup.isVisible(), false);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${added.address}`).waitFor({ timeout: 8000 });
  assert.equal(await status.getAttribute('data-state'), 'connected');

  // Back on the existing linking flow: one explicit signature links the public address.
  await page.getByRole('button', { name: 'Sign and link' }).click();
  await page.getByText('Wallet linked', { exact: true }).waitFor({ timeout: 8000 });
  assert.deepEqual(calls, ['connect', 'sign']);
  const accountStatus = await tool(h, user, 'get_account_status');
  assert.ok(accountStatus.wallets.some((w) => w.address === added.address), 'the new wallet is linked to the same account');
  assert.ok(accountStatus.wallets.some((w) => w.address === user.wallet.address), 'the original wallet stays linked');
  assert.deepEqual(consoleErrors, []);
  await context.close();
});

test('identity add in the portal: wallet proof text, user-published URL, one wallet request, readback (simulated)', { skip }, async () => {
  const user = await linkedUser(h, 'dacs.account.read dacs.identities.write');
  const start = await tool(h, user, 'start_identity_action', { idempotencyKey: `browser-id-${Date.now()}`, action: 'add', kind: 'github' });
  assert.equal(start.status, 'prepared');
  const { page, context, calls, consoleErrors } = await pageWithWallet(user.wallet);
  await page.goto(start.portalUrl);
  await page.getByText('Demos identity link').waitFor({ timeout: 8000 });
  await page.getByText('SIMULATED: this evidence comes from local fixture services').waitFor({ timeout: 8000 });
  await page.getByText("this page cannot see your wallet's network").waitFor();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${user.wallet.address}`).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await page.getByRole('button', { name: 'Get proof text from my wallet' }).click();
  await page.getByText('demos:dw2p:ed25519:').waitFor({ timeout: 8000 });
  await page.getByText('Publishing is public and permanent').waitFor();
  // The user publishes the proof themselves (simulated) and pastes its URL.
  await page.getByLabel('Public proof URL').fill('https://gist.github.com/browser-octo/feedbeef');
  await page.getByRole('button', { name: 'Use this proof URL' }).click();
  await page.getByText('Add the github handle browser-octo').waitFor({ timeout: 8000 });
  await page.getByText('No points or rewards are promised').waitFor();
  await page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await page.getByText('Association observed on chain.').waitFor({ timeout: 8000 });
  assert.deepEqual(calls, ['connect', 'getWeb2IdentityProofPayload', 'addGithubIdentity'], 'exactly one identity request');
  const ids = await tool(h, user, 'get_identities');
  assert.equal(ids.operations.find((o) => o.operationId === start.operationId).status, 'association_observed');
  assert.deepEqual(consoleErrors, []);
  await context.close();
});

// Default profile: the embedded wallet has no writes and extension payments are
// held, so the payment refusal must not send the person to the extension.
test('embedded wallet without writes: the payment refusal does not point to an installed extension, which cannot pay either', { skip }, async () => {
  const buyer = await linkedUser(h);
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: 'browser-report', version: 1, seller: seller.claim, idempotencyKey: `browser-nowrites-${Date.now()}` });
  assert.equal(p.status, 'awaiting_approval');
  const b = await pageWithWallet(buyer.wallet);
  await b.page.goto(p.approvalUrl);
  await b.page.getByText('Approve DEM testnet purchase').waitFor();
  await b.page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  await b.page.locator('#embedded-wallet').getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
  await b.page.getByRole('button', { name: 'Approve exact terms' }).click();
  const refusal = b.page.locator('#log').getByText(/The experimental embedded wallet cannot send payments/).first();
  await refusal.waitFor({ timeout: 8000 });
  const text = await refusal.innerText();
  assert.match(text, /Payments from an installed wallet extension are held as well/);
  assert.doesNotMatch(text, /Use the Demos wallet extension/);
  assert.deepEqual(b.calls, [], 'no wallet was asked for anything');
  assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId })).status, 'awaiting_approval');
  assert.deepEqual(b.consoleErrors, []);
  await b.context.close();
});

// Network identity, complete debit and tuple-only observation in the browser
// with the embedded wallet (real bundled SDK)
// against the SIMULATED SDK-wire chain. A wallet session whose network is not
// the purchase's bound network gets no approval prompt and sends nothing; with
// the matching session the approval shows the complete debit and the receipt
// states what the observation is not.
test('embedded wallet payment: another-network session sends nothing; the approval shows the full debit and the receipt its limits', { skip }, async () => {
  const { startSdkChainFixture } = await import('../helpers/embedded-wallet-flow-fixtures.mjs');
  const { freshPassword, uiCreate, uiUnlock, UI } = await import('../helpers/embedded-wallet-fixtures.mjs');
  const sdkChain = await startSdkChainFixture();
  const eh = await startHarness({ chain: sdkChain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  const context = await browser.newContext();
  contexts.add(context);
  context.on('close', () => contexts.delete(context));
  try {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    const walletUi = page.locator('#embedded-wallet');
    const dialog = page.locator('dialog');
    const approveDialog = async (expect = []) => {
      await dialog.waitFor({ timeout: 15000 });
      const content = await dialog.innerText();
      for (const t of expect) assert.ok(content.includes(t), `approval shows ${t}`);
      await dialog.getByRole('button', { name: UI.approve }).click();
      await dialog.waitFor({ state: 'detached', timeout: 15000 });
      return content;
    };
    const useEmbedded = async () => {
      await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
      await walletUi.getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
    };
    const connect = async (address) => {
      await page.getByRole('button', { name: 'Connect wallet' }).click();
      await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
    };

    // Create and link the embedded wallet.
    const buyer = await linkedUser(eh);
    const password = freshPassword();
    await page.goto((await tool(eh, buyer, 'start_wallet_link')).linkUrl);
    await useEmbedded();
    const address = await uiCreate(walletUi, password);
    await connect(address);
    await page.getByRole('button', { name: 'Sign and link' }).click();
    await approveDialog();
    await page.getByText('Wallet linked').waitFor({ timeout: 10000 });

    const embeddedSeller = createEphemeralWallet();
    seedSellerListing(eh, embeddedSeller, { listingId: 'embedded-report', price: '4' });
    const p = await tool(eh, buyer, 'prepare_purchase', { listingId: 'embedded-report', version: 1, seller: embeddedSeller.claim, idempotencyKey: `embedded-${Date.now()}`, walletAddress: address });
    assert.equal(p.status, 'awaiting_approval');
    const broadcasts = sdkChain.record.broadcastAttempts.length;

    // Wrong wallet network: this page's wallet session is told another network.
    const profileRoute = '**/portal/api/embedded-wallet/profile';
    await page.route(profileRoute, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), network: 'another-network' } });
    });
    await page.goto(p.approvalUrl);
    await useEmbedded();
    assert.equal(await uiUnlock(walletUi, password), address);
    await connect(address);
    await page.getByRole('button', { name: 'Approve exact terms' }).click();
    await page.locator('#log').getByText(/wallet session's network \(another-network\) is not the network this purchase is bound to \(demos-testnet\)/).waitFor({ timeout: 10000 });
    assert.equal(await dialog.count(), 0, 'no approval prompt');
    assert.equal(sdkChain.record.broadcastAttempts.length, broadcasts, 'nothing was broadcast');
    const held = await tool(eh, buyer, 'get_purchase_status', { operationId: p.operationId });
    assert.equal(held.status, 'awaiting_approval');
    assert.equal(held.approval, null);
    await page.unroute(profileRoute);

    // Accepting control: the matching session approves and pays once. (Leave
    // first: the same path with only a new fragment would not reload.)
    await page.goto('about:blank');
    await page.goto(p.approvalUrl);
    await useEmbedded();
    assert.equal(await uiUnlock(walletUi, password), address);
    await connect(address);
    await page.getByRole('button', { name: 'Approve exact terms' }).click();
    await approveDialog(['approve-purchase', 'network-identity: SIMULATED fixture (no real chain identity)', 'commitment: ']);
    // Price 4 DEM + the SDK's 1 DEM gas; this fixture reports no node fees.
    await approveDialog([embeddedSeller.address, '"sdkGasDem": "1"', '"networkFeeDem": "0"', '"totalDem": "5"', '"totalOs": "5000000000"']);
    await page.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 20000 });
    const limits = await page.locator('#payment-observation-limits').innerText();
    for (const t of ['one RPC node', 'not finality', 'not a purchase-specific receipt', 'does not start or confirm delivery']) assert.ok(limits.includes(t), `receipt says ${t}`);
    assert.equal(sdkChain.record.broadcastAttempts.length - broadcasts, 1, 'exactly one broadcast');
    assert.equal((await tool(eh, buyer, 'get_purchase_status', { operationId: p.operationId })).status, 'settled_verified');
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await eh.close();
  }
});

// Offline DACS purchase in the browser: the embedded wallet (real bundled SDK)
// signs the identity presentation, the Agreement and its anchor
// authorization, approves and pays once, then counter-signs the completed
// bundle; the seller agent runs on loopback with its own ephemeral key and
// anchors live in the SIMULATED fixture substrate. The page keeps transfer,
// DACS purchase, service, completed copies and human acceptance apart.
test('DACS purchase in the portal: Agreement, commitment-gated payment, evidence, delivery and counter-signature with the embedded wallet', { skip }, async () => {
  const { startSdkChainFixture } = await import('../helpers/embedded-wallet-flow-fixtures.mjs');
  const { freshPassword, uiCreate, uiUnlock, UI } = await import('../helpers/embedded-wallet-fixtures.mjs');
  const { startProtocolHarness, addSeller } = await import('../dacs-loopback-fixture.test.mjs');
  // The SDK-wire chain fixture's block clock starts at fixture start and moves
  // 5 s per block, so it lags real time during a slow browser flow. The
  // plugin, seller and SR-2 fixture clocks are set back to it before the
  // Agreement (and the Listing is valid from earlier), so the transfer's block
  // time follows the commitment's anchor time as on a live chain.
  let lag = 0;
  const clock = () => Date.now() - lag;
  const chainStart = Date.now();
  const sdkChain = await startSdkChainFixture();
  const dh = await startProtocolHarness({ chain: sdkChain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, now: clock });
  const context = await browser.newContext();
  contexts.add(context);
  context.on('close', () => contexts.delete(context));
  try {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    const walletUi = page.locator('#embedded-wallet');
    const dialog = page.locator('dialog');
    // Consecutive wallet prompts can replace one another without a gap, so
    // wait for this prompt instance (its label id) to go, not for no dialog.
    const approveDialog = async (expect = []) => {
      try {
        await dialog.waitFor({ timeout: 20000 });
      } catch (error) {
        throw new Error(`no wallet prompt; portal log: ${await page.locator('#log').innerText().catch(() => '(unavailable)')}`, { cause: error });
      }
      const label = await dialog.getAttribute('aria-labelledby');
      const content = await dialog.innerText();
      for (const t of expect) assert.ok(content.includes(t), `wallet prompt shows ${t}`);
      await dialog.getByRole('button', { name: UI.approve }).click();
      await page.waitForFunction((id) => !document.querySelector(`dialog[aria-labelledby="${id}"]`), label, { timeout: 15000 });
      return content;
    };
    const open = async (url, address, password) => {
      await page.goto('about:blank');
      await page.goto(url);
      await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
      await walletUi.getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
      assert.equal(await uiUnlock(walletUi, password), address);
      await page.getByRole('button', { name: 'Connect wallet' }).click();
      await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
    };

    const buyer = await linkedUser(dh);
    const password = freshPassword();
    await page.goto((await tool(dh, buyer, 'start_wallet_link')).linkUrl);
    await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
    await walletUi.getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
    const address = await uiCreate(walletUi, password);
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: 'Sign and link' }).click();
    await approveDialog();
    await page.getByText('Wallet linked').waitFor({ timeout: 10000 });

    const seller = await addSeller(dh, { listingId: 'browser-dacs-report', price: '4', now: clock, listingNow: Date.now() - 10 * 60 * 1000 });
    const p = await tool(dh, buyer, 'prepare_purchase', { listingId: 'browser-dacs-report', version: 1, seller: seller.wallet.claim, idempotencyKey: `browser-dacs-${Date.now()}`, walletAddress: address, protocol: 'dacs-pay-dem' });
    assert.equal(p.status, 'agreement_pending');
    const broadcasts = sdkChain.record.broadcastAttempts.length;

    await open(p.approvalUrl, address, password);
    await page.getByRole('heading', { name: /Review and sign the DACS Agreement/ }).waitFor({ timeout: 10000 });
    lag = Date.now() - chainStart + 30 * 1000;
    const pending = await page.locator('#flow').innerText();
    for (const t of [seller.wallet.address, '4 DEM (4000000000 OS)', 'Total debit', 'SIMULATED fixture substrate', 'Human acceptance']) assert.ok(pending.includes(t), `agreement page shows ${t}`);
    await page.getByRole('button', { name: /Sign the DACS Agreement/ }).click();
    await approveDialog(['dacs-bundle-presentation:v1:']);
    await approveDialog(['dacs-payee-bound-agreement:v1:']);
    await approveDialog(['dacs-chatgpt-plugin/fixture-sr2-write/v1:dacs3:agreement:']);
    await page.getByText(/read back independently/).first().waitFor({ timeout: 20000 });
    assert.equal(sdkChain.record.broadcastAttempts.length, broadcasts, 'signing the Agreement sends nothing');

    await page.getByRole('button', { name: 'Approve exact terms' }).click();
    await approveDialog(['approve-purchase', 'dacs-job: ', 'dacs-agreement: ', 'dacs-commitment: ']);
    await approveDialog([seller.wallet.address, '"totalOs": "5000000000"']);
    await page.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
    let layers = await page.locator('#dacs-layers').innerText();
    for (const t of ['Observed by one RPC node', 'Evidenced: seller-signed DACS-4 payment evidence verified', 'Delivered: the test report', 'Not exchanged yet', 'Not recorded']) assert.ok(layers.includes(t), `layers show ${t}`);
    assert.equal(sdkChain.record.broadcastAttempts.length - broadcasts, 1, 'exactly one broadcast');

    await page.getByRole('button', { name: /Counter-sign completed bundle/ }).click();
    await approveDialog(['dacs-fault-bundle:v1:']);
    await approveDialog(['dacs-chatgpt-plugin/fixture-sr2-write/v1:stor-']);
    await page.locator('#dacs-layers').getByText('Both completed DACS-5 copies verified').waitFor({ timeout: 20000 });
    layers = await page.locator('#dacs-layers').innerText();
    assert.ok(layers.includes('Not recorded: your counter-signature records protocol completion, not satisfaction'));
    const limits = await page.locator('#dacs-limits').innerText();
    for (const t of ['SIMULATED substrate', 'vetting is not performed', 'finality is not independently established']) assert.ok(limits.includes(t), `limits say ${t}`);
    const status = await tool(dh, buyer, 'get_purchase_status', { operationId: p.operationId });
    assert.equal(status.protocol.stage, 'completed');
    assert.equal(status.protocol.layers.humanAcceptance, 'not-recorded');
    assert.equal(sdkChain.record.broadcastAttempts.length - broadcasts, 1, 'still exactly one broadcast');
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
    await dh.close();
  }
});

test('identity remove in the portal states what removal does not do (simulated)', { skip }, async () => {
  const user = await linkedUser(h, 'dacs.account.read dacs.identities.write');
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: 'browser_bird', proof: 'https://x.com/browser_bird/status/9' });
  const start = await tool(h, user, 'start_identity_action', { idempotencyKey: `browser-rm-${Date.now()}`, action: 'remove', kind: 'twitter', username: 'browser_bird' });
  const { page, context, calls, consoleErrors } = await pageWithWallet(user.wallet);
  await page.goto(start.portalUrl);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${user.wallet.address}`).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await page.getByText('It does not delete your public post or gist or past transactions').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await page.getByText('Association no longer observed on chain.').waitFor({ timeout: 8000 });
  assert.deepEqual(calls, ['connect', 'removeWeb2Identity']);
  assert.deepEqual(consoleErrors, []);
  await context.close();
});
