// Embedded wallet FLOW acceptance in a real browser: the trusted portal with the
// EXPERIMENTAL embedded wallet completes a fixed-price purchase (B1) and a
// GitHub identity add then remove (B2). Clauses: docs/EMBEDDED-WALLET-FLOW-COVERAGE.md.
//
// Evidence: browser-real (Chromium from DACS_TEST_CHROME, unchanged portal CSP,
// console errors not filtered) + sdk-real (bundled Demos SDK signs in the page)
// + server-real readback, against a SIMULATED loopback chain speaking the SDK
// 4.0.16 wire (test/helpers/embedded-wallet-flow-fixtures.mjs). Not live
// testnet, not ChatGPT framing, not a security review. Keys are fresh, RAM or
// test-context IndexedDB only.
//
// Enabling and topology follow the embedded wallet's simulated-loopback
// profile: DACS_EMBEDDED_WALLET_WRITES=simulated-loopback, the same-origin
// wallet relay, and a loopback GitHub API fixture origin
// (x-dacs-simulation: fixture).
// If the embedded wallet refuses payments and identity writes, both tests
// FAIL. With DACS_EMBEDDED_WALLET_REQUIRE=1 a missing browser or module FAILS
// (no skip).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers/harness.mjs';
import { linkedUser, tool, seedSellerListing } from '../helpers/flows.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import {
  SDK_MODULES, UI_MODULES, UI, modulePresence, chromeSkipReason, launchTestChrome, openRecordedPage, createCleanupStack,
  assertNoSecrets, freshPassword, uiCreate, uiShownPhrase, uiUnlock,
} from '../helpers/embedded-wallet-fixtures.mjs';
import { CORE_INTERFACE, PROFILE, REQUIRE, installLoopbackOnlyGuard, startSdkChainFixture, startGithubApiFixture, fetchProfile } from '../helpers/embedded-wallet-flow-fixtures.mjs';

const externalAttempts = installLoopbackOnlyGuard();
const presence = modulePresence([...SDK_MODULES, ...UI_MODULES]);
const chromeMissing = chromeSkipReason();
// Prerequisites missing: FAIL under REQUIRE, otherwise a visible skip.
const gate = REQUIRE ? {} : { skip: chromeMissing || (presence.present ? false : `missing ${presence.missing.join(', ')}`) };
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
  ({ browser } = await launchTestChrome(cleanups));
});

after(async () => {
  await cleanups.run();
});

// One context per test: the embedded vault lives in this context's IndexedDB,
// so later portal pages in the same context unlock the same wallet.
async function walletContext() {
  assert.equal((await fetchProfile(h)).writes, PROFILE, 'precondition: the simulated loopback profile is enabled');
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

async function openUnlocked(p, url, password, address) {
  await p.page.goto(url);
  await useEmbedded(p);
  assert.equal(await uiUnlock(p.wallet, password), address);
  await connect(p, address);
}

// A portal wait that fails with the portal's own log (e.g. the baseline's
// "cannot send payments ... or change identities" refusal) instead of a bare timeout.
async function step(p, label, fn) {
  try {
    return await fn();
  } catch (error) {
    const log = await p.page.locator('#log').innerText().catch(() => '(no portal log)');
    throw new Error(`${label} failed: ${error.message.split('\n')[0]} | portal log: ${log.replace(/\s+/g, ' ').slice(-400)}`);
  }
}

async function approveDialog(p, expectText = []) {
  await step(p, 'waiting for the wallet approval dialog', () => p.dialog.waitFor({ timeout: 15000 }));
  // Whole dialog: approval.mjs shows the method in the "Wallet action" row and
  // the exact terms in the content block.
  const content = await p.dialog.innerText();
  for (const t of expectText) assert.ok(content.includes(t), `approval shows the exact term ${t}`);
  await p.dialog.getByRole('button', { name: UI.approve }).click();
  await p.dialog.waitFor({ state: 'detached', timeout: 15000 });
  return content;
}

// Creates the embedded wallet on the one-time link page and links it.
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

function sameOriginOnly(p) {
  for (const r of p.requests) assert.ok(r.url.startsWith(`${h.origin}/`), `browser request stays on the portal origin: ${new URL(r.url).origin}`);
}

test('B1 [browser-real + sdk-real] portal purchase with the embedded wallet: exact-terms approval, one broadcast, simulated receipt', gate, async () => {
  const p = await walletContext();
  const buyer = await linkedUser(h);
  const { address, password, phrase } = await createAndLink(p, buyer);
  const seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId: 'flow-b1', price: '4' });
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: 'flow-b1', version: 1, seller: seller.claim, idempotencyKey: `flow-b1-${Date.now()}`, walletAddress: address });
  assert.equal(prepared.status, 'awaiting_approval');
  const before = chain.record.broadcastAttempts.length;

  await openUnlocked(p, prepared.approvalUrl, password, address);
  await p.page.getByText('Approve DEM testnet purchase').waitFor({ timeout: 10000 });
  await p.page.getByRole('button', { name: 'Approve exact terms' }).click();
  // 1) the approval challenge, 2) the transaction with the exact payee/amount/wallet.
  await approveDialog(p, ['approve-purchase', seller.address]);
  const txContent = await approveDialog(p, [seller.address, '4000000000', address]);
  assert.match(txContent, /"nonce"/);

  await p.page.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 20000 });
  assert.equal(chain.record.broadcastAttempts.length - before, 1, 'exactly one broadcast');
  const applied = chain.record.applied.at(-1);
  assert.deepEqual([applied.from, applied.to, applied.amount], [address, seller.address, '4000000000']);
  await p.page.getByText(applied.hash).first().waitFor({ timeout: 5000 });
  const status = await tool(h, buyer, 'get_purchase_status', { operationId: prepared.operationId });
  assert.equal(status.status, 'settled_verified');

  sameOriginOnly(p);
  assertNoSecrets([...p.requests, ...p.consoleAll, p.page.url()], [phrase, password], 'portal requests, console and URL');
  assertNoSecrets(h.logs, [phrase, password], 'plugin server logs');
  assert.deepEqual(p.consoleErrors, []);
  assert.deepEqual(externalAttempts, []);
  await p.context.close();
});

test('B2 [browser-real + sdk-real] portal GitHub identity add then remove with the embedded wallet; nothing posted externally', gate, async () => {
  const p = await walletContext();
  const user = await linkedUser(h, WRITE);
  const { address, password, phrase } = await createAndLink(p, user);
  const proofUrl = 'https://gist.github.com/flow-b2/0123456789abcdef';

  const add = await tool(h, user, 'start_identity_action', { idempotencyKey: `flow-b2a-${Date.now()}`, action: 'add', kind: 'github', walletAddress: address });
  await openUnlocked(p, add.portalUrl, password, address);
  await p.page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await step(p, 'connected wallet accepted for the identity action', () => p.page.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 }));
  await approveDialog(p);
  await p.page.locator('#proof-text').getByText(/^demos:dw2p:ed25519:/).waitFor({ timeout: 8000 });
  await p.page.locator('#proof-url').fill(proofUrl);
  await p.page.getByRole('button', { name: 'Use this proof URL' }).click();
  await p.page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await approveDialog(p, ['addGithubIdentity', proofUrl, 'flow-b2', address]);
  await p.page.getByText('Association observed on chain.').waitFor({ timeout: 20000 });
  assert.deepEqual(chain.web2Handles(address, 'github'), ['flow-b2']);
  assert.deepEqual(github.requests, ['GET /users/flow-b2'], 'the handle was resolved by the loopback GitHub API fixture, once');

  const rm = await tool(h, user, 'start_identity_action', { idempotencyKey: `flow-b2r-${Date.now()}`, action: 'remove', kind: 'github', username: 'flow-b2', walletAddress: address });
  await openUnlocked(p, rm.portalUrl, password, address);
  await p.page.getByRole('button', { name: 'Use my connected wallet' }).click();
  await p.page.getByRole('button', { name: 'Approve in my wallet' }).click();
  await approveDialog(p, ['removeWeb2Identity', 'flow-b2']);
  await p.page.getByText('Association no longer observed on chain.').waitFor({ timeout: 20000 });
  assert.deepEqual(chain.web2Handles(address, 'github'), []);

  sameOriginOnly(p);
  assertNoSecrets([...p.requests, ...p.consoleAll, p.page.url()], [phrase, password], 'portal requests, console and URL');
  assertNoSecrets(h.logs, [phrase, password], 'plugin server logs');
  assert.deepEqual(p.consoleErrors, []);
  assert.deepEqual(externalAttempts, [], 'no GitHub or X host was contacted');
  await p.context.close();
});
