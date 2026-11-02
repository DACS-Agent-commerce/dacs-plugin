// Chrome (DACS_TEST_CHROME only; missing Chrome FAILS) portal UI with the
// built-in packaged wallet and trusted clicks: one complete fixed-price
// purchase on the opt-in complete profile. Real OAuth/MCP, portal, seller agent
// on its own loopback server, SDK-wire loopback chain fixture. SIMULATED only;
// node2 is never contacted and its identity is never pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetHarness } from './helpers/devnet-purchase-harness.mjs';
import { addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI, assertNoSecrets } from './helpers/embedded-wallet-fixtures.mjs';
import { DEVNET_PURCHASE_PROFILE, DEVNET_HELD_GATES } from '../src/dacs/devnet-purchase-consumer.mjs';

installLoopbackOnlyGuard();

test('Chrome (simulated): built-in wallet trusted approvals complete the purchase on the complete profile; achieved and held stages shown apart; one native send', { timeout: 180000 }, async (t) => {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  // As in the portal suite: plugin/seller time trails the chain fixture clock,
  // so the transfer block follows the commitment anchor time as on a live chain.
  let lag = 0;
  const clock = () => Date.now() - lag;
  const chainStart = Date.now();
  const h = await startDevnetHarness({ now: clock });
  cleanup.add('devnet harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup);
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort()));
  const walletUi = page.locator('#embedded-wallet'), dialog = page.locator('dialog');
  const approveDialog = async (expect = []) => {
    await dialog.waitFor({ timeout: 20000 });
    const label = await dialog.getAttribute('aria-labelledby');
    const content = await dialog.innerText();
    for (const s of expect) assert.ok(content.includes(s), `wallet prompt shows ${s}`);
    await dialog.getByRole('button', { name: UI.approve }).click();
    await page.waitForFunction((id) => !document.querySelector(`dialog[aria-labelledby="${id}"]`), label, { timeout: 15000 });
    return content;
  };
  const buyer = await linkedUser(h), other = await linkedUser(h);
  const password = freshPassword();
  await page.goto((await tool(h, buyer, 'start_wallet_link')).linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  await walletUi.getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
  const address = await uiCreate(walletUi, password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Sign and link' }).click();
  await approveDialog();
  await page.getByText('Wallet linked').waitFor({ timeout: 10000 });

  const seller = await addSeller(h, { listingId: 'devnet-browser-report', price: '4', now: clock, listingNow: Date.now() - 10 * 60 * 1000 });
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: 'devnet-browser-report', version: 1, seller: seller.wallet.claim, idempotencyKey: `devnet-browser-${Date.now()}`, walletAddress: address, protocol: 'dacs-pay-dem' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  assert.equal(p.protocol.profile, DEVNET_PURCHASE_PROFILE);

  await page.goto('about:blank');
  await page.goto(p.approvalUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  await walletUi.getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 15000 });
  assert.equal(await uiUnlock(walletUi, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole('heading', { name: /Review and sign the DACS Agreement/ }).waitFor({ timeout: 10000 });
  const pending = await page.locator('#dacs-devnet').innerText();
  for (const s of ['Demos Devnet', 'https://testnet-rpc.invalid', 'live execution held', 'not a trusted pin', 'Held: no trusted Demos Devnet chain identity pin']) assert.ok(pending.includes(s), `portal shows ${s}`);
  lag = Date.now() - chainStart + 30 * 1000;
  await page.getByRole('button', { name: /Sign the DACS Agreement/ }).click();
  await approveDialog(['dacs-bundle-presentation:v1:']);
  await approveDialog(['dacs-payee-bound-agreement:v1:']);
  await approveDialog(['dacs-chatgpt-plugin/fixture-sr2-write/v1:dacs3:agreement:']);
  await page.getByText(/read back independently/).first().waitFor({ timeout: 20000 });
  assert.equal(h.chain.record.broadcastAttempts.length, 0, 'signing the Agreement sends nothing');

  // Synthetic click witness, then the trusted approvals.
  await page.getByRole('button', { name: 'Approve exact terms' }).click();
  await approveDialog(['approve-purchase', 'dacs-job: ', 'dacs-agreement: ', 'dacs-commitment: ']);
  await dialog.waitFor({ timeout: 20000 });
  await dialog.getByRole('button', { name: UI.approve }).evaluate((b) => b.click());
  assert.equal(h.chain.record.broadcastAttempts.length, 0, 'guard witness: a synthetic click does not approve the native send');
  await approveDialog([seller.wallet.address, '"totalOs": "5000000000"']);
  await page.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
  assert.equal(h.chain.record.broadcastAttempts.length, 1, 'exactly one broadcast');

  await page.getByRole('button', { name: /Counter-sign completed bundle/ }).click();
  await approveDialog(['dacs-fault-bundle:v1:']);
  await approveDialog(['dacs-chatgpt-plugin/fixture-sr2-write/v1:stor-']);
  await page.locator('#dacs-layers').getByText('Both completed DACS-5 copies verified').waitFor({ timeout: 20000 });
  const ledgerText = await page.locator('#dacs-devnet').innerText();
  for (const s of ['two-party-agreement-anchored', 'dacs5-two-sided-copies', 'Achieved (SIMULATED loopback fixture only)']) assert.ok(ledgerText.includes(s), `ledger shows ${s}`);
  for (const g of DEVNET_HELD_GATES) assert.ok(ledgerText.includes(g.gate), `ledger keeps held ${g.gate}`);
  const status = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(status.protocol.stage, 'completed');
  assert.ok(status.protocol.devnet.stages.filter((s) => s.status === 'achieved-simulated').length === 6);
  assert.equal(h.chain.record.broadcastAttempts.length, 1, 'still exactly one broadcast');
  assert.equal((await tool(h, other, 'get_purchase_status', { operationId: p.operationId })).error, 'not_found');
  assertNoSecrets(rec.requests, [password], 'browser HTTP requests'); assertNoSecrets(h.logs, [password], 'server logs');
  assert.ok(rec.requests.every((r) => new URL(r.url).origin === h.origin));
  assert.deepEqual(rec.consoleErrors, []);
  t.diagnostic(JSON.stringify({ profile: DEVNET_PURCHASE_PROFILE, stage: status.protocol.stage, broadcasts: 1, held: DEVNET_HELD_GATES.length }));
});

test('Chrome devnet purchase connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
