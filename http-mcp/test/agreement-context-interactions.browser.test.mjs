// Chrome interaction: provider hold in the real portal UI, operator recovery
// plus cold app reconstruction with the same TEST provider, then the SAME tab
// re-signs, plans once and anchors one owner-bound CREATE via a trusted click;
// a further reconstruction only observes. Existing Playwright launch only
// (DACS_TEST_CHROME; missing Chrome FAILS), loopback-only routing, packaged
// embedded wallet, actual OAuth/MCP, durable broker journal reopened on each
// reconstruction, unchanged read-only Demo resolver/responder. All authority is
// ephemeral TEST simulation; payment/Vet/commitment/finality stay held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import { startAgreementChain } from './helpers/offline-agreement-fixture.mjs';
import { tool, linkedUser } from './helpers/flows.mjs';
import { startDemoContextSeller, providerSlot } from './helpers/agreement-context-integration.mjs';
import { startRestartableContextHarness } from './helpers/agreement-context-interactions.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';

installLoopbackOnlyGuard();
// The role instructions name the known Chrome; launchTestChrome never falls back.
process.env.DACS_TEST_CHROME ??= '/usr/bin/chromium-browser';

test('Chrome: held operator context, then recovery across cold reconstruction; same tab plans once and anchors one CREATE', { timeout: 150000 }, async (t) => {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const slot = providerSlot();
  const h = await startRestartableContextHarness({ chain, agreementContext: slot.config });
  cleanup.add('loopback harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup);
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}; no injected walletFactory`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort()));
  const user = await linkedUser(h);
  const link = await tool(h, user, 'start_wallet_link');
  await page.goto(link.linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  const walletUi = page.locator('#embedded-wallet'), password = freshPassword();
  const address = await uiCreate(walletUi, password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Sign and link/ }).click();
  await page.getByRole('dialog').getByText('purpose: link-wallet', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: UI.approve }).click();
  await page.getByRole('heading', { name: /^Wallet linked/ }).waitFor();
  const seller = await startDemoContextSeller(h, { listingId: `context-interactions-browser-${Date.now()}` });
  slot.install(seller);
  seller.faults.provider = async () => ({ disposition: 'indeterminate', reason: 'TEST authority unavailable' });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
    idempotencyKey: `context-interactions-browser-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  await page.goto(p.approvalUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  assert.equal(await uiUnlock(walletUi, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  const account = h.app.services.accounts.walletOwner(address);
  const op = () => h.app.services.ops.get(account, p.operationId);
  const verify = () => tool(h, user, 'verify_deal', { operationId: p.operationId });
  const dialog = page.getByRole('dialog');

  // 1. Held: identity presentation only; no Agreement bytes reach the wallet.
  await page.locator('#dacs-sign-agreement').click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click();
  await page.getByText(/operator Agreement context is indeterminate/).waitFor({ timeout: 15000 });
  assert.equal(op().state.protocol.planned, undefined);
  assert.equal(seller.providerCalls.length, 1);

  // 2. Operator recovery and cold reconstruction with the same TEST provider.
  seller.faults.provider = null;
  await h.restart(slot.config);

  // 3. Same tab, second click: plans once, both parties sign, one trusted CREATE.
  await page.locator('#dacs-sign-agreement').click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  const planned = op().state.protocol.planned, jobId = op().terms.protocol.jobId;
  assert.equal(await dialog.getByLabel('Exact content to approve').textContent(), planned.agreementMessage);
  for (const party of planned.draft.parties) assert.deepEqual(party.vetRecordRef, seller.vetRef(jobId, party.primaryClaim));
  assert.equal(seller.providerCalls.length, 2, 'one held read and one present read');
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // broker authentication on the reconstructed app
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.kind, 'dacs-storage-anchor-create'); assert.equal(shown.contentHash, planned.plan.agreementHash);
  assert.equal(shown.wallet, address);
  assert.deepEqual(seller.signed, [seller.wallet.claim]);
  assert.equal(chain.wire.record.broadcastAttempts.length, 0);
  await dialog.getByRole('button', { name: UI.approve }).click();
  await page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const verified = await verify();
  assert.equal(verified.protocol.stage, 'agreement-anchored', JSON.stringify(verified));
  const tx = chain.wire.record.accepted[0];
  assert.equal(tx.content.from, address); assert.equal(canonicalize(tx.content.data[1].data), shown.exactStorageBytes);
  assert.equal(contentHash(tx.content.data[1].data), planned.plan.agreementHash);
  assert.equal(verified.protocol.limits.payment, 'held');

  // 4. Another reconstruction only observes.
  await h.restart(slot.config);
  assert.equal((await verify()).protocol.stage, 'agreement-anchored');
  assert.equal((await h.store.journal.get(`browser-agreement/create/${p.operationId}`)).stage, 'completed');
  assert.equal(chain.wire.record.broadcastAttempts.length, 1); assert.equal(seller.progress.length, 1); assert.equal(seller.providerCalls.length, 2);
  assertNoSecrets(rec.requests, [password], 'browser HTTP requests'); assertNoSecrets(h.logs, [password], 'server logs');
  assert.ok(rec.requests.every((r) => new URL(r.url).origin === h.origin));
  // Chrome reports the one held /agreement/plan 409 as a resource-load error; nothing else.
  assert.deepEqual(rec.consoleErrors, ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
  assert.equal(rec.requests.filter((r) => r.method === 'POST' && r.url.endsWith(`/purchase/${p.operationId}/agreement/plan`)).length, 2, 'one held and one planned request');
  t.diagnostic(JSON.stringify({ restarts: h.restarts, providerCalls: seller.providerCalls.length, broadcasts: 1, hash: shown.contentHash }));
});

test('context interaction browser harness never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
