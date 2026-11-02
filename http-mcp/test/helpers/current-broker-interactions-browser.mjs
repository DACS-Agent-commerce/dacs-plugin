// Role-owned Chrome setup for test/dacs-current-broker-interactions.test.mjs:
// the actual portal UI and packaged browser wallet (trusted clicks), actual
// OAuth/MCP and the opt-in loopback broker over the caller's reopenable SQLite
// journal. Existing Playwright launch only (DACS_TEST_CHROME), loopback-only
// routing, no injected provider/walletFactory/key. Chain/seller are simulated.
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from '../dacs-loopback-fixture.test.mjs';
import { startAgreementChain } from './offline-agreement-fixture.mjs';
import { tool, linkedUser } from './flows.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI } from './embedded-wallet-fixtures.mjs';
import { contentHash } from '@kynesyslabs/dacs';

let counter = 0;

export async function browserBrokerSetup(t, store) {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '2', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '2' }, browserAgreement: { journal: store.journal } });
  cleanup.add('loopback harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup); // Missing Chrome FAILS, never skipped acceptance.
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}; no injected walletFactory`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page, context } = rec;
  await context.route('**/*', (route) => new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort());
  // Every broker POST answer from any page in this context: observation of
  // delivery/completion, not only a UI status line.
  const broker = [];
  context.on('response', async (r) => {
    if (!r.url().includes('/browser-agreement/') || r.request().method() !== 'POST') return;
    const body = await r.json().catch(() => null);
    broker.push({ route: new URL(r.url()).pathname.split('/browser-agreement/')[1], id: new URL(r.url()).pathname.split('/')[4], http: r.status(), state: body?.state ?? null, delivered: Boolean(body?.request), error: body?.error ?? null });
  });
  const user = await linkedUser(h);
  const link = await tool(h, user, 'start_wallet_link');
  await page.goto(link.linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  const password = freshPassword();
  const address = await uiCreate(page.locator('#embedded-wallet'), password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Sign and link/ }).click();
  await page.getByRole('dialog').getByText('purpose: link-wallet', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: UI.approve }).click();
  await page.getByRole('heading', { name: /^Wallet linked/ }).waitFor();
  const prepare = async (label) => {
    const seller = await addSeller(h, { listingId: `current-browser-${label}-${++counter}` });
    const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
      idempotencyKey: `current-browser-${label}-${counter}-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    return { label, p, id: p.operationId, logicalAddress: `dacs3:agreement:${p.protocol.jobId}`, verify: () => tool(h, user, 'verify_deal', { operationId: p.operationId }) };
  };
  // Open one operation's approval page in `target`, unlock and connect the same UI wallet.
  const open = async (target, op) => {
    await target.goto(op.p.approvalUrl);
    await target.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
    assert.equal(await uiUnlock(target.locator('#embedded-wallet'), password), address);
    await target.getByRole('button', { name: 'Connect wallet' }).click();
    await target.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  };
  const newPage = async () => {
    const extra = await context.newPage();
    const errors = [];
    extra.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    extra.on('pageerror', (e) => errors.push(e.message));
    return { page: extra, errors };
  };
  return { ...rec, h, chain, user, address, password, launched, broker, prepare, open, newPage };
}

// Identity, Agreement and fresh broker-session approvals through trusted
// clicks. With `savedPlan` the purchase already has a saved Agreement plan:
// the portal continues from it, so no identity presentation is asked for.
// Returns the CREATE dialog when one is delivered, else null.
export async function signThroughSession(target, op, address, { expectCreate, savedPlan = false }) {
  await target.locator('#dacs-sign-agreement').click();
  const dialog = target.getByRole('dialog');
  await dialog.waitFor();
  if (savedPlan) assert.equal(await target.locator('#log p').filter({ hasText: 'The Agreement plan is saved; continuing from it.' }).count(), 1);
  else await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  assert.match(await dialog.getByLabel('Exact content to approve').textContent(), /^dacs-payee-bound-agreement:v1:[a-f0-9]{64}$/);
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  const challenge = await dialog.getByLabel('Exact content to approve').textContent();
  assert.ok(challenge.includes(`operation: ${op.id}`)); assert.ok(challenge.includes(`wallet: ${address}`));
  await dialog.getByRole('button', { name: UI.approve }).click(); // fresh broker authentication
  if (!expectCreate) {
    await target.locator('#log p.bad').filter({ hasText: /CREATE is absent; no replay/ }).waitFor({ timeout: 25000 });
    assert.equal(await dialog.count(), 0, 'no CREATE dialog for a fenced operation');
    return null;
  }
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.kind, 'dacs-storage-anchor-create'); assert.equal(shown.artifactKind, 'Agreement'); assert.equal(shown.wallet, address);
  assert.equal(shown.contentHash, contentHash(JSON.parse(shown.exactStorageBytes)));
  return { dialog, shown };
}
