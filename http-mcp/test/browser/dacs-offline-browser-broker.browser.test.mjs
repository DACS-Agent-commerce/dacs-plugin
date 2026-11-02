// Actual portal UI, Chrome trusted clicks, packaged browser signer, real
// OAuth-authenticated MCP and HTTP broker; every chain/seller remains a local
// simulated fixture. No provider/sessionFactory/signing key is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from '../dacs-loopback-fixture.test.mjs';
import { startAgreementChain } from '../helpers/offline-agreement-fixture.mjs';
import { tool, linkedUser, portal, tokenFrom } from '../helpers/flows.mjs';
import { memoryAnchorJournal } from '../helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from '../helpers/embedded-wallet-flow-fixtures.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack, freshPassword, uiCreate, uiUnlock, UI, assertNoSecrets } from '../helpers/embedded-wallet-fixtures.mjs';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';

installLoopbackOnlyGuard();

async function setup(t) {
  const cleanup = createCleanupStack(); t.after(() => cleanup.run());
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, browserAgreement: { journal } });
  cleanup.add('loopback harness', 10000, () => h.close());
  const launched = await launchTestChrome(cleanup); // Missing Chrome FAILS, never skipped acceptance.
  t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}; no injected walletFactory`);
  const rec = await openRecordedPage(launched.browser, cleanup), { page } = rec;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === h.origin ? route.continue() : route.abort());
  const user = await linkedUser(h);
  const link = await tool(h, user, 'start_wallet_link');
  await page.goto(link.linkUrl);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  const wallet = page.locator('#embedded-wallet'), password = freshPassword();
  const address = await uiCreate(wallet, password);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Sign and link/ }).click();
  await page.getByRole('dialog').getByText('purpose: link-wallet', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: UI.approve }).click();
  await page.getByRole('heading', { name: /^Wallet linked/ }).waitFor();
  const account = await tool(h, user, 'get_account_status'); assert.ok(account.wallets.some((w) => w.address === address));
  const seller = await addSeller(h, { listingId: `real-browser-${Date.now()}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, walletAddress: address,
    idempotencyKey: `real-browser-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const response = await page.goto(p.approvalUrl); assert.match(response.headers()['content-security-policy'], /frame-ancestors 'none'/);
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  assert.equal(await uiUnlock(wallet, password), address);
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor();
  const responses = [];
  page.on('response', async (r) => {
    if (r.url().includes('/browser-agreement/') && r.request().method() === 'POST') responses.push({ path: new URL(r.url()).pathname, body: await r.json().catch(() => null), http: r.status() });
  });
  return { ...rec, h, chain, journal, user, seller, p, address, password, responses,
    verify: () => tool(h, user, 'verify_deal', { operationId: p.operationId }) };
}

async function reachCreate(w) {
  await w.page.locator('#dacs-sign-agreement').click();
  const dialog = w.page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByRole('button', { name: UI.approve }).click(); // identity presentation
  await dialog.getByLabel('Exact content to approve').waitFor();
  const agreementMessage = await dialog.getByLabel('Exact content to approve').textContent();
  assert.match(agreementMessage, /^dacs-payee-bound-agreement:v1:[a-f0-9]{64}$/);
  await dialog.getByRole('button', { name: UI.approve }).click(); // Agreement bytes
  await dialog.getByText('purpose: offline-agreement-browser-session', { exact: false }).waitFor();
  const challenge = await dialog.getByLabel('Exact content to approve').textContent();
  assert.ok(challenge.includes(`operation: ${w.p.operationId}`)); assert.ok(challenge.includes(`wallet: ${w.address}`));
  assert.match(challenge, /one immutable Agreement CREATE; no payment or completion/);
  await dialog.getByRole('button', { name: UI.approve }).click(); // fresh broker authentication
  await dialog.getByLabel('Exact content to approve').waitFor();
  const shown = JSON.parse(await dialog.getByLabel('Exact content to approve').textContent());
  assert.equal(shown.kind, 'dacs-storage-anchor-create'); assert.equal(shown.artifactKind, 'Agreement');
  assert.equal(shown.wallet, w.address); assert.equal(shown.owner, `did:demos:agent:${w.address.slice(2)}`);
  assert.equal(shown.debit.totalOs, '7000000000'); assert.equal(shown.debit.sellerAmountDem, '0');
  assert.equal(shown.contentHash, contentHash(JSON.parse(shown.exactStorageBytes)));
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  return { dialog, shown };
}

test('real portal/MCP browser session authenticates exact scope; synthetic click cannot approve; trusted built-in approval anchors one unchanged Agreement', { timeout: 120000 }, async (t) => {
  const w = await setup(t), { dialog, shown } = await reachCreate(w);
  const accept = dialog.getByRole('button', { name: UI.approve });
  await accept.evaluate((b) => b.click());
  assert.equal(await dialog.isVisible(), true); assert.equal(w.chain.wire.record.confirms.length, 0);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0, 'guard witness: synthetic approval must not sign/broadcast');
  await accept.click();
  await w.page.locator('#flow').getByText(/Awaiting authenticated seller commitment and context/).waitFor({ timeout: 25000 });
  const verified = await w.verify(); assert.equal(verified.protocol.stage, 'agreement-anchored', JSON.stringify(verified));
  const tx = w.chain.wire.record.accepted[0], artifact = tx.content.data[1].data;
  assert.equal(canonicalize(artifact), shown.exactStorageBytes); assert.equal(Object.hasOwn(artifact, 'artifactType'), false);
  assert.equal(artifact.payeeBoundAgreementVersion, '1'); assert.equal(tx.content.from, w.address);
  assert.equal(verified.protocol.agreement.hash, shown.contentHash); assert.equal(verified.protocol.limits.payment, 'held');
  assert.equal(verified.protocol.limits.vet, 'not-performed'); assert.equal(verified.protocol.layers.dacsPurchase, 'not-evidenced');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.chain.wire.record.accepted.length, 1);
  const claimed = w.responses.find((r) => r.path.endsWith('/claim'))?.body;
  const opened = w.responses.find((r) => r.path.endsWith('/session'))?.body;
  assert.ok(claimed?.request && opened?.sessionToken);
  const replay = await w.page.evaluate(async ({ id, token }) => {
    const r = await fetch(`/portal/api/purchase/${id}/browser-agreement/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionToken: token }) });
    return r.json();
  }, { id: w.p.operationId, token: opened.sessionToken });
  assert.equal(replay.state, 'completed'); assert.equal(replay.request, null);
  await w.page.locator('#dacs-recheck').click(); await w.verify();
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(await w.page.locator('#flow').getByRole('button', { name: /Approve.*purchase|Pay now/ }).count(), 0);
  assert.equal((await portal(w.h, `/portal/api/purchase/${w.p.operationId}/challenge`, { token: tokenFrom(w.p.approvalUrl), address: w.address })).error, 'agreement_payment_held');
  assertNoSecrets(w.requests, [w.password], 'browser HTTP requests'); assertNoSecrets(w.h.logs, [w.password], 'server logs');
  assert.ok(w.requests.every((r) => new URL(r.url).origin === w.h.origin)); assert.deepEqual(w.consoleErrors, []);
  t.diagnostic(JSON.stringify({ profile: 'loopback-test-only', stage: verified.protocol.stage, hash: shown.contentHash, nativeAddress: verified.protocol.agreement.nativeAddress, broadcastCount: 1, trustedCreateApprovals: 1, payment: 'held', vet: 'not-performed' }));
});

test('real portal built-in wallet can explicitly deny CREATE, leaving zero broadcast and no accepting receipt', { timeout: 120000 }, async (t) => {
  const w = await setup(t), { dialog } = await reachCreate(w);
  await dialog.getByRole('button', { name: UI.reject }).click();
  await w.page.locator('#flow').getByText(/The DACS Agreement was refused/).waitFor({ timeout: 25000 });
  const out = await w.verify(); assert.equal(out.protocol.stage, 'agreement-rejected'); assert.equal(out.protocol.agreement, null);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0); assert.equal(w.chain.wire.record.confirms.length, 0);
  assert.equal(w.journal.snapshot().filter(([k]) => k.startsWith('sr2/wallet/')).length, 0);
  assertNoSecrets(w.requests, [w.password], 'denied browser requests'); assert.deepEqual(w.consoleErrors, []);
});
test('Node/browser harness never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
