// The portal identity flow
// must explain a wallet error visibly — the wallet's own message, whether
// anything was signed or sent, and what happens next — instead of only
// "Wallet result recorded: unknown".
//
// Closure (docs/IDENTITY-RECOVERY.md): an impossible GitHub handle never
// reaches the wallet any more. The proof step refuses it, the action stays
// correctable and the wallet is not stranded (I2). The wallet-error
// explanation for failures that do reach the wallet is covered in
// closure-identity-recovery.browser.test.mjs.
//
// Evidence: browser-real (Chromium from DACS_TEST_CHROME, unchanged portal
// CSP, console errors not filtered) + sdk-real (bundled Demos SDK in the
// page) + server-real readback, against the SIMULATED loopback chain and
// GitHub API fixtures of test/helpers/embedded-wallet-flow-fixtures.mjs
// (reused read-only). Not live, not a security review. Keys are fresh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers/harness.mjs';
import { auth } from '@modelcontextprotocol/client';
import { TestOAuthProvider } from '../helpers/oauth.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { linkedUser, tool, seedSellerListing } from '../helpers/flows.mjs';
import {
  SDK_MODULES, UI_MODULES, UI, modulePresence, chromeSkipReason, launchTestChrome, openRecordedPage, createCleanupStack,
  assertNoSecrets, freshPassword, uiCreate, uiShownPhrase, uiUnlock,
} from '../helpers/embedded-wallet-fixtures.mjs';
import { CORE_INTERFACE, REQUIRE, installLoopbackOnlyGuard, startSdkChainFixture, startGithubApiFixture } from '../helpers/embedded-wallet-flow-fixtures.mjs';

const externalAttempts = installLoopbackOnlyGuard();
const presence = modulePresence([...SDK_MODULES, ...UI_MODULES]);
const chromeMissing = chromeSkipReason();
const gate = REQUIRE ? {} : { skip: chromeMissing || (presence.present ? false : `missing ${presence.missing.join(', ')}`) };
// start_wallet_link needs a purchases or agents write scope.
const WRITE = 'dacs.account.read dacs.purchases.write dacs.identities.write';

let h;
let chain;
let github;
let browser;
const cleanups = createCleanupStack();

before(async () => {
  if (gate.skip) return;
  if (chromeMissing) throw new Error(chromeMissing);
  if (!presence.present) throw new Error(`embedded wallet modules missing: ${presence.missing.join(', ')}`);
  github = await startGithubApiFixture();
  cleanups.add('github api fixture close', 5000, () => github.close());
  chain = await startSdkChainFixture();
  h = await startHarness({ chain, env: CORE_INTERFACE.enableEnv({ githubApiOrigin: github.origin }) });
  cleanups.add('harness close', 10000, () => h.close());
  const launched = await launchTestChrome(cleanups);
  browser = launched.browser;
  process.stderr.write(`overnight-core identity browser: ${launched.executablePath} version ${launched.version}\n`);
});

after(async () => {
  await cleanups.run();
});

async function walletContext() {
  const rec = await openRecordedPage(browser, cleanups);
  return { ...rec, wallet: rec.page.locator('#embedded-wallet'), dialog: rec.page.locator('dialog') };
}

async function useEmbedded(p) {
  await p.page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  await p.wallet.getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
}

async function connect(p, address) {
  await p.page.getByRole('button', { name: 'Connect wallet' }).click();
  await p.page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
}

async function approveDialog(p) {
  await p.dialog.waitFor({ timeout: 15000 });
  await p.dialog.getByRole('button', { name: UI.approve }).click();
  await p.dialog.waitFor({ state: 'detached', timeout: 15000 });
}

async function createAndLink(p, user) {
  const password = freshPassword();
  await p.page.goto((await tool(h, user, 'start_wallet_link')).linkUrl);
  await useEmbedded(p);
  const address = await uiCreate(p.wallet, password);
  const phrase = await uiShownPhrase(p.wallet);
  await connect(p, address);
  await p.page.getByRole('button', { name: 'Sign and link' }).click();
  await approveDialog(p);
  await p.page.getByText('Wallet linked').waitFor({ timeout: 10000 });
  return { address, password, phrase };
}

// Start a GitHub add and drive the portal to the proof step (proof text shown).
async function toProofStep(p, user, { address, password }) {
  const add = await tool(h, user, 'start_identity_action', { idempotencyKey: `oc-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action: 'add', kind: 'github', walletAddress: address });
  assert.equal(add.status, 'prepared', JSON.stringify(add));
  await p.page.goto(add.portalUrl);
  await useEmbedded(p);
  assert.equal(await uiUnlock(p.wallet, password), address);
  await connect(p, address);
  await p.page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await p.page.getByRole('button', { name: 'Get proof text from my wallet' }).click();
  await approveDialog(p);
  await p.page.locator('#proof-text').getByText(/^demos:dw2p:ed25519:/).waitFor({ timeout: 8000 });
  return add;
}

async function useProof(p, proofUrl) {
  await p.page.locator('#proof-url').fill(proofUrl);
  await p.page.getByRole('button', { name: 'Use this proof URL' }).click();
}

// ... and on to the review step with this proof URL.
async function toReview(p, user, linked, proofUrl) {
  const add = await toProofStep(p, user, linked);
  await useProof(p, proofUrl);
  await p.page.getByRole('button', { name: 'Approve in my wallet' }).waitFor({ timeout: 8000 });
  return add;
}

test('I1 accepting control [browser-real + sdk-real]: a GitHub add with a valid handle shows no warning and no wallet error, and the association is observed', gate, async () => {
  const p = await walletContext();
  const user = await linkedUser(h, WRITE);
  const linked = await createAndLink(p, user);
  const handle = `oc-core-${Math.random().toString(36).slice(2, 8)}`;
  const add = await toReview(p, user, linked, `https://gist.github.com/${handle}/0123456789abcdef`);
  assert.equal(await p.page.locator('#identity-handle-warning').count(), 0, 'no warning for a valid GitHub username');
  // C1 wording (simulated profile): identity page headed and labelled SIMULATED.
  const seen = await p.page.evaluate(() => ({
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map((e) => e.textContent.trim()),
    flowHeading: document.querySelector('#flow h2')?.textContent.trim() ?? null,
    labels: [...document.querySelectorAll('button[data-action]')].map((b) => b.textContent.trim()),
  }));
  for (const text of [seen.title, ...seen.headings, ...seen.labels]) if (/testnet/i.test(text)) assert.match(text, /\bnot\b/i, `identity page: "${text}"`);
  assert.match(seen.title, /SIMULATED/);
  assert.equal(seen.flowHeading, 'Demos identity link (SIMULATED fixture, not Demos testnet)');
  assert.deepEqual(seen.labels, ['Approve in my wallet (SIMULATED fixture)']);
  await p.page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await approveDialog(p);
  await p.page.getByText('Association observed on chain.').waitFor({ timeout: 20000 });
  assert.equal(await p.page.locator('#wallet-answer').count(), 0, 'no wallet-error explanation after success');
  assert.deepEqual(chain.web2Handles(linked.address, 'github'), [handle]);
  assert.equal((await tool(h, user, 'get_identities')).operations.find((o) => o.operationId === add.operationId).status, 'association_observed');
  assertNoSecrets([...p.requests, ...p.consoleAll, p.page.url()], [linked.phrase, linked.password], 'portal requests, console and URL');
  assert.deepEqual(p.consoleErrors, []);
  assert.deepEqual(externalAttempts, []);
  await p.context.close();
});

test('I2 F1 [browser-real + sdk-real]: a GitHub handle the wallet cannot read is refused at the proof step with a visible explanation, before the wallet is asked; the same action takes the corrected URL and completes; nothing wrong is linked and the wallet is not stranded', gate, async () => {
  const p = await walletContext();
  const failedResponses = [];
  p.page.on('response', (r) => { if (r.status() >= 400) failedResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const user = await linkedUser(h, WRITE);
  const linked = await createAndLink(p, user);
  const handle = `oc_core_${Math.random().toString(36).slice(2, 8)}`; // "_" is not a GitHub username character
  const add = await toProofStep(p, user, linked);
  const dialogsBefore = await p.dialog.count();

  // Refused at the proof step, before anything is sent to the wallet.
  const started = Date.now();
  await useProof(p, `https://gist.github.com/${handle}/0123456789abcdef`);
  const refusal = p.page.locator('#log .bad').getByText(new RegExp(`“${handle}” cannot be a GitHub username`));
  await refusal.waitFor({ timeout: 15000 });
  assert.ok(Date.now() - started < 30000, 'visible explanation within 30 s');
  assert.match(await refusal.innerText(), /Nothing was sent to your wallet\./);
  assert.match(await refusal.innerText(), /Publish the gist under your real GitHub username and paste its URL\./);
  assert.equal(await p.dialog.count(), dialogsBefore, 'no wallet dialog was opened');
  assert.equal(await p.page.getByRole('button', { name: 'Use this proof URL' }).count(), 1, 'still the proof step: the URL can be corrected');
  assert.equal(await p.page.getByRole('button', { name: 'Approve in my wallet' }).count(), 0, 'the wallet cannot be asked with the impossible handle');

  // Server state: still correctable, never asked, nothing linked.
  const ids = await tool(h, user, 'get_identities', { walletAddress: linked.address });
  const op = ids.operations.find((o) => o.operationId === add.operationId);
  assert.equal(op.status, 'awaiting_public_proof');
  assert.equal(op.walletOutcome, null, 'the wallet was never asked');
  assert.deepEqual(chain.web2Handles(linked.address, 'github'), [], 'readback shows nothing linked');
  assert.equal(JSON.stringify(ids.wallets).includes(handle), false, 'get_identities lists no such handle');
  assert.ok(!github.requests.some((r) => r.includes(handle)), 'the GitHub stand-in was never asked for an impossible username');

  // The same action takes the corrected URL and completes.
  const good = `oc-core-${Math.random().toString(36).slice(2, 8)}`;
  await useProof(p, `https://gist.github.com/${good}/0123456789abcdef`);
  await p.page.getByRole('button', { name: 'Approve in my wallet' }).waitFor({ timeout: 8000 });
  assert.equal(await p.page.locator('#identity-handle-warning').count(), 0, 'no warning for the corrected, valid handle');
  await p.page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await approveDialog(p);
  await p.page.getByText('Association observed on chain.').waitFor({ timeout: 20000 });
  assert.deepEqual(chain.web2Handles(linked.address, 'github'), [good], 'only the corrected handle is linked');
  assert.equal((await tool(h, user, 'get_identities')).operations.find((o) => o.operationId === add.operationId).status, 'association_observed');

  // Not stranded: a new identity action for the same wallet is accepted.
  const again = await tool(h, user, 'start_identity_action', { idempotencyKey: `oc-id-again-${Date.now()}`, action: 'add', kind: 'twitter', walletAddress: linked.address });
  assert.equal(again.status, 'prepared', JSON.stringify(again));

  assertNoSecrets([...p.requests, ...p.consoleAll, p.page.url()], [linked.phrase, linked.password], 'portal requests, console and URL');
  assertNoSecrets(h.logs, [linked.phrase, linked.password], 'plugin server logs');
  // Exactly one expected failure: the proof step's 409 invalid_proof_url,
  // which Chrome itself logs as a resource-load error.
  assert.deepEqual(failedResponses, [`409 /portal/api/identity/${add.operationId}/proof`]);
  assert.deepEqual(p.consoleErrors, ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
  assert.deepEqual(externalAttempts, []);
  await p.context.close();
});

// Title, every h1-h3 and every primary action label of the current page.
async function visibleWording(page) {
  return page.evaluate(() => ({
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map((e) => e.textContent.trim()),
    flowHeading: document.querySelector('#flow h2')?.textContent.trim() ?? null,
    labels: [...document.querySelectorAll('button[data-action]')].map((b) => b.textContent.trim()),
    scope: document.getElementById('network-scope')?.textContent.trim() ?? null,
  }));
}

// C1 wording rule for the SIMULATED profile: nothing headed or labelled as
// testnet unless it says "not"; the title, page heading and every primary
// action label say SIMULATED.
function assertSimulatedWording(seen, where) {
  for (const text of [seen.title, ...seen.headings, ...seen.labels]) {
    if (/testnet/i.test(text)) assert.match(text, /\bnot\b/i, `${where}: "${text}" mentions testnet without "not"`);
  }
  assert.match(seen.title, /SIMULATED/, `${where}: title`);
  assert.match(seen.flowHeading ?? '', /simulated/i, `${where}: page heading "${seen.flowHeading}"`);
  assert.ok(seen.labels.length > 0, `${where}: has a primary action`);
  for (const label of seen.labels) assert.match(label, /SIMULATED/, `${where}: label "${label}"`);
  assert.match(seen.scope ?? '', /^SIMULATED offline fixture — not Demos testnet/, `${where}: header scope`);
}


test('P5 [browser-real, C1 wording] simulated profile: sign-in, wallet link, purchase approval and status pages are headed and labelled SIMULATED; nothing says testnet without "not"', gate, async () => {
  const p = await walletContext();
  // Sign-in (OAuth interaction page).
  const oauth = new TestOAuthProvider({ scope: WRITE });
  assert.equal(await auth(oauth, { serverUrl: h.mcpUrl, scope: WRITE }), 'REDIRECT');
  await p.page.goto(oauth.authorizationUrl.href);
  await p.page.getByText('Link your DACS account').waitFor({ timeout: 15000 });
  assertSimulatedWording(await visibleWording(p.page), 'sign-in');

  // Wallet link page.
  const user = await linkedUser(h, `${WRITE} dacs.purchases.write`);
  await p.page.goto((await tool(h, user, 'start_wallet_link')).linkUrl);
  await p.page.getByText('Link a wallet to your account').waitFor({ timeout: 15000 });
  assertSimulatedWording(await visibleWording(p.page), 'wallet link');

  // Purchase approval, then the status page of the same (cancelled) purchase.
  const seller = createEphemeralWallet();
  const listingId = `oc-wording-${Math.random().toString(36).slice(2)}`;
  seedSellerListing(h, seller, { listingId, price: '3' });
  const prepared = await tool(h, user, 'prepare_purchase', { listingId, version: 1, seller: seller.claim, idempotencyKey: `oc-wording-${Math.random().toString(36).slice(2)}` });
  assert.equal(prepared.status, 'awaiting_approval', JSON.stringify(prepared));
  await p.page.goto(prepared.approvalUrl);
  await p.page.getByRole('heading', { name: 'Approve simulated DEM purchase' }).waitFor({ timeout: 15000 });
  const approval = await visibleWording(p.page);
  assertSimulatedWording(approval, 'purchase approval');
  assert.equal(approval.flowHeading, 'Approve simulated DEM purchase (SIMULATED fixture, not Demos testnet)');
  assert.deepEqual(approval.labels, ['Approve exact terms (SIMULATED fixture)']);
  const cancelled = await tool(h, user, 'cancel_wallet_handoff', { operationId: prepared.operationId });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  await p.page.reload();
  await p.page.getByRole('heading', { name: 'Simulated DEM purchase status' }).waitFor({ timeout: 15000 });
  const status = await visibleWording(p.page);
  for (const text of [status.title, ...status.headings]) if (/testnet/i.test(text)) assert.match(text, /\bnot\b/i, `purchase status: "${text}"`);
  assert.equal(status.flowHeading, 'Simulated DEM purchase status (SIMULATED fixture, not a DEM testnet purchase status)');

  assert.deepEqual(p.consoleErrors, []);
  await p.context.close();
});

test('D1 [browser-real, accepting control] default profile: the existing wording is unchanged', gate, async () => {
  const plain = await startHarness();
  cleanups.add('default wording harness close', 10000, () => plain.close());
  const p = await walletContext();
  const user = await linkedUser(plain);
  const seller = createEphemeralWallet();
  const listingId = `oc-default-${Math.random().toString(36).slice(2)}`;
  seedSellerListing(plain, seller, { listingId, price: '3' });
  const prepared = await tool(plain, user, 'prepare_purchase', { listingId, version: 1, seller: seller.claim, idempotencyKey: `oc-default-${Math.random().toString(36).slice(2)}` });
  await p.page.goto(prepared.approvalUrl);
  await p.page.getByRole('heading', { name: 'Approve DEM testnet purchase' }).waitFor({ timeout: 15000 });
  const seen = await visibleWording(p.page);
  assert.equal(seen.title, 'DACS wallet portal');
  assert.equal(seen.headings[0], 'DACS wallet portal');
  assert.equal(seen.scope, 'Demos testnet only.');
  assert.equal(seen.flowHeading, 'Approve DEM testnet purchase');
  assert.deepEqual(seen.labels, ['Approve exact terms']);
  assert.equal(await p.page.getByText('This simulated step stands in for').count(), 0);
  // Witness: this unchanged wording (what the simulated profile showed before
  // this change) is rejected by the P5 rule.
  assert.throws(() => assertSimulatedWording(seen, 'default'), /mentions testnet without "not"/);
  assert.deepEqual(p.consoleErrors, []);
  await p.context.close();
});
