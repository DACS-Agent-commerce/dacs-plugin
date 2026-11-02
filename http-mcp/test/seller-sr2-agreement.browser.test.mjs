// Chrome (DACS_TEST_CHROME only; missing Chrome FAILS): portal UI, packaged
// embedded wallet with trusted clicks, OAuth/MCP, loopback broker; the actual
// seller agent behind the existing seller HTTP handler reads the buyer's native
// SR-2 Agreement CREATE through the existing SR-2 adapter on the IDEALIZED
// seller-only RPC view (see test/helpers/seller-sr2-agreement-harness.mjs) and
// commits on the SIMULATED fixture substrate. Payment stays held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { startSr2Harness, startSr2Seller } from './helpers/seller-sr2-agreement-harness.mjs';
import { tool, linkedUser, tokenFrom } from './helpers/flows.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';

installLoopbackOnlyGuard();

test('Chrome (idealized seller view, simulated): trusted approvals CREATE the Agreement once; the seller commits from the native read; the portal stops at seller-committed with payment held', { timeout: 150000 }, async (t) => {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startSr2Harness({ journal, exactContentNode: true });
  cleanup.add('seller sr2 harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup);
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort()));
  const user = await linkedUser(h), other = await linkedUser(h);
  await page.goto((await tool(h, user, 'start_wallet_link')).linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  const walletUi = page.locator('#embedded-wallet'), password = freshPassword();
  const address = await uiCreate(walletUi, password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Sign and link/ }).click();
  await page.getByRole('dialog').getByText('purpose: link-wallet', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: UI.approve }).click();
  await page.getByRole('heading', { name: /^Wallet linked/ }).waitFor();
  const seller = await startSr2Seller(h, { listingId: 'seller-sr2-browser' });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
    idempotencyKey: `seller-sr2-browser-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  await page.goto(p.approvalUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  assert.equal(await uiUnlock(walletUi, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();

  await page.locator('#dacs-sign-agreement').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // broker authentication
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.kind, 'dacs-storage-anchor-create'); assert.equal(shown.artifactKind, 'Agreement');
  assert.equal(h.chain.wire.record.broadcastAttempts.length, 0);
  await dialog.getByRole('button', { name: UI.approve }).click(); // trusted CREATE approval
  await page.locator('#flow').getByText(/seller verified your native SR-2 Agreement CREATE/).waitFor({ timeout: 30000 });
  const status = await tool(h, user, 'verify_deal', { operationId: p.operationId });
  assert.equal(status.protocol.stage, 'seller-committed', JSON.stringify(status.protocol.lastAttempt));
  assert.equal(status.status, 'agreement_pending'); assert.equal(status.protocol.limits.payment, 'held');
  assert.equal(status.protocol.commitment.signer, seller.wallet.claim);
  const tx = h.chain.wire.record.accepted[0];
  assert.equal(canonicalize(tx.content.data[1].data), shown.exactStorageBytes);
  assert.equal(h.chain.wire.record.broadcastAttempts.length, 1); assert.equal(h.chain.wire.record.accepted.length, 1);
  assert.ok(seller.requests.includes('/dacs/v1/commitments')); assert.ok(!seller.requests.includes('/dacs/v1/payments'));
  assert.equal(await page.locator('#flow').getByRole('button', { name: /Approve.*purchase|Pay now|Approve exact terms/ }).count(), 0);
  const held = await fetch(`${h.origin}/portal/api/purchase/${p.operationId}/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tokenFrom(p.approvalUrl), address }) }).then((r) => r.json());
  assert.equal(held.error, 'agreement_payment_held');
  assert.equal((await tool(h, other, 'get_purchase_status', { operationId: p.operationId })).error, 'not_found');
  assertNoSecrets(rec.requests, [password], 'browser HTTP requests'); assertNoSecrets(h.logs, [password], 'server logs');
  assert.ok(rec.requests.every((r) => new URL(r.url).origin === h.origin)); assert.deepEqual(rec.consoleErrors, []);
  t.diagnostic(JSON.stringify({ stage: status.protocol.stage, commitment: status.protocol.commitment.contentHash, broadcasts: 1, payment: 'held', node: 'idealized seller view' }));
});

test('Chrome seller SR-2 connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
