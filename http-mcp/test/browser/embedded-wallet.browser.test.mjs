// Real-browser lifecycle tests for the EXPERIMENTAL, default-off embedded
// wallet. Evidence is labelled per test:
//  - browser-real: headless Chrome from DACS_TEST_CHROME (never another
//    browser), loading the packaged /portal/assets/embedded-wallet/index.html
//    from the real plugin server on loopback (fixture chain/directory are
//    loopback-simulated and are never contacted by these flows).
//  - sdk-real: sdk-provider.mjs + demos-runtime.mjs as served to the page.
//  - source-aware adapter: a test-owned memory vault store, public-state
//    recorder and provider capture injected through mountEmbeddedWallet().
// Not a security review, not source-blind validation, not ChatGPT embedding,
// installed-wallet or live-network proof. Key material is fresh and RAM-only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from '../helpers/harness.mjs';
import {
  SDK_MODULES, UI_MODULES, UI, EMBEDDED_WALLET_ASSET_PATH, EMBEDDED_WALLET_ASSET_BASE, PUBLIC_STATE_KEYS, ADDRESS_RE,
  modulePresence, blockedUnless, chromeSkipReason, launchTestChrome, openRecordedPage, createCleanupStack,
  createLoginChallengeIssuer, extractSignature, assertNoSecrets, freshPassword, pageInstallRecorders, pageMountWallet,
  uiCreate, uiShownPhrase, uiRevealPhrase, uiLock, uiUnlock, uiExportBackup, uiRestoreBackup,
} from '../helpers/embedded-wallet-fixtures.mjs';

const presence = modulePresence([...SDK_MODULES, ...UI_MODULES]);
const skip = chromeSkipReason();
const gate = { ...blockedUnless(presence), skip };
const ready = presence.present && !skip;
const ADDRESS_TEXT = /0x[0-9a-f]{64}/; // an address inside labelled UI text

function requireCombinedCandidate() {
  if (!presence.present) throw new Error(`BLOCKED: combined candidate absent (missing ${presence.missing.join(', ')})`);
}

let h;
let browser;
const cleanups = createCleanupStack();

before(async () => {
  if (!ready) return; // nothing is launched for BLOCKED/skipped runs
  h = await startHarness();
  cleanups.add('harness close', 10000, () => h.close());
  const launched = await launchTestChrome(cleanups);
  browser = launched.browser;
  process.stderr.write(`embedded-wallet browser: ${launched.executablePath} version ${launched.version}\n`);
});

after(async () => {
  await cleanups.run();
});

async function openAsset() {
  const rec = await openRecordedPage(browser, cleanups);
  const response = await rec.page.goto(`${h.origin}${EMBEDDED_WALLET_ASSET_PATH}`);
  return { ...rec, response };
}

function assertLoopbackOnly(requests) {
  for (const r of requests) assert.ok(r.url.startsWith(`${h.origin}/`), `request stays on the loopback plugin origin: ${r.method} ${new URL(r.url).origin}`);
}

async function publicStates(page) {
  return page.evaluate(() => window.__ewPublic ?? []);
}

async function mountSourceAware(page) {
  await page.evaluate(pageInstallRecorders);
  await page.evaluate(pageMountWallet, { base: `${h.origin}${EMBEDDED_WALLET_ASSET_BASE}` });
  await page.getByText(UI.experimental).first().waitFor({ timeout: 8000 });
}

test('packaged asset loads under the portal CSP, starts locked/uninitialised, is labelled experimental/local-only, and leaves window.demos alone [browser-real]', gate, async () => {
  requireCombinedCandidate();
  const rec = await openRecordedPage(browser, cleanups);
  // Simulated extension stand-in (labelled): an existing window.demos must survive.
  await rec.page.addInitScript(() => {
    window.demos = { __sentinel: 'existing-extension-stand-in', request: async () => ({ success: false }) };
  });
  const response = await rec.page.goto(`${h.origin}${EMBEDDED_WALLET_ASSET_PATH}`);
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-security-policy'], /default-src 'none'/);
  await rec.page.getByText(UI.experimental).first().waitFor({ timeout: 8000 });
  await rec.page.getByText(UI.localOnly).first().waitFor();
  await rec.page.getByRole('button', { name: UI.create }).waitFor();
  assert.equal(await rec.page.getByText(ADDRESS_TEXT).count(), 0, 'no wallet exists before an explicit create/import');
  assert.equal(await rec.page.evaluate(() => window.demos?.__sentinel), 'existing-extension-stand-in', 'window.demos is not overwritten');
  assert.deepEqual(rec.requests.filter((r) => r.method !== 'GET'), [], 'loading sends nothing');
  assertLoopbackOnly(rec.requests);
  assert.deepEqual(rec.consoleErrors, []);
  await rec.context.close();
});

test('SDK in the page: create/import equivalence and a login-challenge signature accepted by the server verifier [browser-real + sdk-real]', gate, async () => {
  requireCombinedCandidate();
  const { page, requests, consoleErrors, context } = await openAsset();
  const base = `${h.origin}${EMBEDDED_WALLET_ASSET_BASE}`;
  // The mnemonic stays inside the page; only public values and booleans return.
  const accounts = await page.evaluate(async ({ base: b }) => {
    const sdk = await import(`${b}/sdk-provider.mjs`);
    const runtime = await import(`${b}/demos-runtime.mjs`);
    window.__ewApprovals = [];
    const approve = async (request) => { window.__ewApprovals.push(JSON.stringify(request)); return true; };
    const make = () => sdk.createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, approve });
    const first = make();
    const created = await first.create();
    const phrase = first.exportMnemonicForUser();
    const second = make();
    const imported = await second.importMnemonic(phrase);
    window.__ewSessions = { first, second, phrase };
    return { created, imported, words: phrase.trim().split(/\s+/).length };
  }, { base });
  assert.deepEqual(accounts.imported, accounts.created);
  assert.match(accounts.created.address, ADDRESS_RE);
  assert.equal(accounts.created.address, `0x${accounts.created.publicKey}`);
  assert.equal(accounts.created.network, 'unconfigured');
  assert.equal(accounts.created.evidenceMode, 'local-key-only');
  assert.equal(accounts.words, 24);

  const issuer = createLoginChallengeIssuer({ origin: h.origin });
  try {
    const challenge = issuer.issue(accounts.created.address);
    const out = await page.evaluate(async (message) => {
      const { second, phrase } = window.__ewSessions;
      const res = await second.request({ method: 'sign', params: [message] });
      const leaked = [JSON.stringify(res), ...window.__ewApprovals].some((s) => s.includes(phrase));
      return { res, leaked, approvals: window.__ewApprovals.length };
    }, challenge.message);
    assert.equal(out.res.success, true);
    assert.equal(out.leaked, false, 'no backup phrase in the provider response or approval request');
    assert.equal(out.approvals, 1);
    const signature = extractSignature(out.res);
    assert.equal(issuer.verifyOnly({ address: accounts.created.address, message: challenge.message, signature }), true);
    assert.equal(issuer.verifyAndConsume(challenge.challengeId, signature).address, accounts.created.address);
  } finally {
    issuer.close();
    await page.evaluate(() => {
      window.__ewSessions?.first.lock();
      window.__ewSessions?.second.lock();
      delete window.__ewSessions;
    });
  }
  assertLoopbackOnly(requests);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), [], 'create/import/sign contact no node');
  assert.deepEqual(consoleErrors, []);
  await context.close();
});

test('UI lifecycle: create, local backup view, password, lock/unlock, encrypted export and re-import; no phrase/password in callbacks, storage, requests, console or logs [browser-real + sdk-real + source-aware adapter]', gate, async () => {
  requireCombinedCandidate();
  const a = await openAsset();
  await mountSourceAware(a.page);
  // The UI takes the encryption password at creation, stores the encrypted
  // vault, then shows the new phrase locally for the person to write down.
  const password = freshPassword();
  const address = await uiCreate(a.page, password);
  const phrase = await uiShownPhrase(a.page);
  assert.equal(phrase.split(' ').length, 24, 'the created phrase is shown locally (24 words)');
  await a.page.getByRole('button', { name: UI.hidePhrase }).click();
  assert.equal(await a.page.getByRole('region', { name: UI.phraseRegion }).count(), 0, 'hiding removes the phrase');
  assert.equal(await uiRevealPhrase(a.page, password), phrase, 'the password-gated local backup view shows the same phrase');

  await uiLock(a.page);
  assert.equal(await a.page.getByRole('region', { name: UI.phraseRegion }).count(), 0, 'locking hides the backup');
  assert.equal(await a.page.getByText(UI.mnemonicText).count(), 0, 'locking hides the backup');
  assert.equal(await uiUnlock(a.page, password), address, 'unlock with the password restores the same address');
  await a.page.getByRole('button', { name: UI.lock }).waitFor();

  const backup = await uiExportBackup(a.page);
  assert.ok(backup.length > 0);
  assertNoSecrets([backup], [phrase, password], 'encrypted backup (no plaintext phrase/password)');

  const statesA = await publicStates(a.page);
  assert.ok(statesA.some((s) => s?.locked === true), 'a locked public state was reported');
  assert.ok(statesA.some((s) => s?.locked === false && s?.address === address), 'an unlocked public state with the address was reported');
  for (const s of statesA) for (const key of Object.keys(s ?? {})) assert.ok(PUBLIC_STATE_KEYS.has(key), `public state key "${key}" is in the contract`);
  const vaultA = await a.page.evaluate(() => window.__ewVaultWrites);
  assert.ok(vaultA.some((w) => w.op === 'put'), 'the encrypted vault was written to the injected store');

  // Re-import into a fresh page and fresh memory store.
  const b = await openAsset();
  await mountSourceAware(b.page);
  await uiRestoreBackup(b.page, backup);
  assert.equal(await uiUnlock(b.page, password), address, 'restored backup unlocks to the same address');
  const statesB = await publicStates(b.page);
  assert.ok(statesB.some((s) => s?.locked === false && s?.address === address), 're-imported backup restores the same address');
  const vaultB = await b.page.evaluate(() => window.__ewVaultWrites);

  for (const rec of [a, b]) {
    assertLoopbackOnly(rec.requests);
    assert.ok(!rec.page.url().includes(password.slice(3)), 'password not in the URL');
  }
  assertNoSecrets([...statesA, ...statesB], [phrase, password], 'public callbacks');
  assertNoSecrets([...vaultA, ...vaultB], [phrase, password], 'vault store writes');
  assertNoSecrets([...a.requests, ...b.requests], [phrase, password], 'recorded loopback requests');
  assertNoSecrets([...a.consoleAll, ...b.consoleAll, a.page.url(), b.page.url()], [phrase, password], 'console and URLs');
  assertNoSecrets(h.logs, [phrase, password], 'plugin server logs');
  // Last, so the checks above still run: any page/console error fails the test.
  for (const rec of [a, b]) assert.deepEqual(rec.consoleErrors, []);
  await a.context.close();
  await b.context.close();
});

test('explicit local approval UI: a provider sign waits for a deliberate click showing the exact message; decline gives no signature; transactions/identity writes stay default-off [browser-real + sdk-real + source-aware adapter]', gate, async () => {
  requireCombinedCandidate();
  const { page, requests, consoleErrors, context } = await openAsset();
  await mountSourceAware(page);
  const address = await uiCreate(page, freshPassword());
  await page.waitForFunction(() => window.__ewProvider !== null, null, { timeout: 8000 });

  const connected = await page.evaluate(() => window.__ewProvider.request({ method: 'connect' }));
  assert.equal(connected.success, true);
  assert.equal(typeof connected.data === 'string' ? connected.data : connected.data?.address, address);

  const issuer = createLoginChallengeIssuer({ origin: h.origin });
  try {
    const challenge = issuer.issue(address);
    const nonceLine = challenge.message.split('\n').find((line) => line.startsWith('nonce: '));
    await page.evaluate((message) => {
      window.__ewSign = { done: false };
      window.__ewProvider.request({ method: 'sign', params: [message] }).then((res) => { window.__ewSign = { done: true, res }; });
    }, challenge.message);
    await page.getByText(nonceLine).first().waitFor({ timeout: 8000 });
    await page.getByText('purpose: account-login').first().waitFor();
    assert.equal(await page.evaluate(() => window.__ewSign.done), false, 'nothing is signed before the user clicks');
    await page.getByRole('button', { name: UI.approve }).click();
    await page.waitForFunction(() => window.__ewSign.done, null, { timeout: 10000 });
    const res = await page.evaluate(() => window.__ewSign.res);
    assert.equal(res.success, true);
    assert.equal(issuer.verifyAndConsume(challenge.challengeId, extractSignature(res)).address, address, 'server verifier accepts the UI-approved signature');

    await page.evaluate(() => {
      window.__ewSign = { done: false };
      window.__ewProvider.request({ method: 'sign', params: ['decline this embedded wallet request'] }).then((r) => { window.__ewSign = { done: true, res: r }; });
    });
    await page.getByText('decline this embedded wallet request').first().waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: UI.reject }).click();
    await page.waitForFunction(() => window.__ewSign.done, null, { timeout: 10000 });
    assert.equal((await page.evaluate(() => window.__ewSign.res)).success, false, 'declined: no signature');
  } finally {
    issuer.close();
  }

  for (const [method, params] of [
    ['sendTransaction', [{ simulated: 'not-a-real-transaction' }]],
    ['addGithubIdentity', ['https://gist.github.com/fixture-user/0000']],
    ['removeWeb2Identity', [{ context: 'github', username: 'fixture-user' }]],
  ]) {
    const out = await page.evaluate(({ m, p }) => window.__ewProvider.request({ method: m, params: p }), { m: method, p: params });
    assert.equal(out.success, false, `${method} is default-off without an injected loopback transport`);
  }
  assertLoopbackOnly(requests);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), [], 'no transaction or identity request left the page');
  assert.deepEqual(consoleErrors, []);
  await context.close();
});

test('standalone page (main.mjs sessionFactory with the SDK validateMnemonic): create, lock and unlock with the real SDK and origin IndexedDB store [browser-real + sdk-real]', gate, async () => {
  requireCombinedCandidate();
  const { page, requests, consoleErrors, context } = await openAsset();
  await page.getByRole('button', { name: UI.create }).waitFor({ timeout: 8000 });
  const password = freshPassword();
  const address = await uiCreate(page, password);
  const phrase = await uiShownPhrase(page);
  await uiLock(page);
  // Unlock decrypts the vault and re-derives through importMnemonic, which
  // fails closed unless main.mjs passes the SDK's validateMnemonic.
  assert.equal(await uiUnlock(page, password), address);
  assertLoopbackOnly(requests);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), [], 'create/lock/unlock send nothing');
  assertNoSecrets([...requests, page.url()], [phrase, password], 'standalone page requests and URL');
  assertNoSecrets(h.logs, [phrase, password], 'plugin server logs');
  assert.deepEqual(consoleErrors, []);
  await context.close();
});
