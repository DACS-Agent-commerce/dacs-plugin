// Real-browser walk through the guided tester dashboard (SIMULATED fixtures
// only). Drives only ordinary UI: dashboard buttons/links, the existing
// embedded-wallet page, the existing portal pages and the fixture proof
// publisher, exactly as a human tester would. The driver types the throwaway
// wallet password only into the existing wallet UI, never into the dashboard.
//
// `h` is a started offline tester handle (source or installed) with
// dashboard: true. `check(name, ok, detail)` records one result.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GITHUB_HANDLE = 'dash-tester';
const strip0x = (s) => String(s ?? '').toLowerCase().replace(/^0x/, '');

export const EXPORT_KEYS = ['app', 'createdAt', 'feedback', 'format', 'kind', 'notice', 'observed', 'testerMarked'];

export async function runDashboardFlow({ browser, h, check, screenshotPath = null, operatorLogs = [] }) {
  const password = `pw-${randomBytes(18).toString('base64url')}`;
  let phrase = null;
  let address = null;
  const pages = [];
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const track = (page) => {
      const rec = { page, requests: [], consoleErrors: [], consoleAll: [] };
      page.on('request', (r) => rec.requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? '' }));
      page.on('console', (m) => {
        rec.consoleAll.push(m.text());
        if (m.type() === 'error') rec.consoleErrors.push(`${m.text()} [${String(m.location()?.url ?? '').split(/[?#]/)[0].slice(0, 120)}]`);
      });
      page.on('pageerror', (e) => rec.consoleErrors.push(e.message));
      pages.push(rec);
      return page;
    };
    context.on('page', track);
    const dash = await context.newPage();
    const step = async (label, fn) => {
      try {
        await fn();
        return check(label, true);
      } catch (error) {
        check(label, false, String(error?.message ?? error).split('\n')[0].slice(0, 400));
        return false;
      }
    };
    const popup = async (name) => {
      const [p] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), dash.getByRole('link', { name, exact: true }).click()]);
      await p.waitForLoadState('domcontentloaded');
      return p;
    };
    const click = (name) => dash.getByRole('button', { name, exact: true }).click();
    const textOf = (id) => dash.locator(`#${id}`).innerText();
    const waitText = (id, pattern, timeout = 20000) => dash.waitForFunction(([i, src]) => new RegExp(src).test(document.getElementById(i)?.textContent ?? ''), [id, pattern.source], { timeout });
    const walletOf = (p) => p.locator('#embedded-wallet');
    const formWith = (scope, page, name) => scope.locator('form').filter({ has: page.getByRole('button', { name }) });
    const shownAddress = async (scope) => {
      await scope.getByRole('heading', { name: /^wallet unlocked$/i }).waitFor({ timeout: 30000 });
      const t = (await scope.locator('dt', { hasText: /^Address$/ }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
      if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error('unlocked view shows no Demos address');
      return t;
    };
    const useEmbedded = async (p) => {
      await p.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
      await walletOf(p).getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 20000 });
    };
    const unlock = async (p) => {
      const form = formWith(walletOf(p), p, /^unlock$/i);
      await form.locator('input[type="password"]').fill(password);
      await form.getByRole('button', { name: /^unlock$/i }).click();
      if ((await shownAddress(walletOf(p))) !== address) throw new Error('unlock showed a different address');
    };
    const connect = async (p) => {
      await p.getByRole('button', { name: 'Connect wallet' }).click();
      await p.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 10000 });
    };
    const approve = async (p, expect = []) => {
      const dialog = p.locator('dialog');
      await dialog.waitFor({ timeout: 20000 });
      const content = await dialog.innerText();
      const missing = expect.filter((t) => !content.includes(t));
      if (missing.length) throw new Error(`approval dialog does not show ${missing.join(', ')}`);
      await dialog.getByRole('button', { name: /^approve$/i }).click();
      await dialog.waitFor({ state: 'detached', timeout: 20000 });
    };

    // 1. Start page.
    const started = await step('dashboard: start page shows the SIMULATED ONLY banner and a running plugin', async () => {
      const res = await dash.goto(h.dashboardUrl);
      if (res.status() !== 200) throw new Error(`HTTP ${res.status()}`);
      if (!/script-src 'self'/.test(res.headers()['content-security-policy'] ?? '')) throw new Error('no self-only CSP');
      const banner = await dash.getByRole('banner').innerText();
      for (const t of ['SIMULATED ONLY', 'No real funds', 'Not ChatGPT', 'Not security reviewed']) if (!banner.includes(t)) throw new Error(`banner lacks "${t}"`);
      await waitText('health-status', /^Running \(fixture chain configured, fixture directory configured\)$/);
      if (await dash.locator('input[type=password]').count() !== 0) throw new Error('dashboard has a password field');
    });
    if (!started) return { ok: false, pages, password, phrase };

    // Throwaway wallet in the existing built-in wallet page.
    await step('step 1: built-in wallet page (opened from the dashboard) creates a throwaway wallet', async () => {
      const w = await popup('Open the built-in wallet page');
      const form = formWith(w, w, /^create wallet$/i);
      const fields = form.locator('input[type="password"]');
      await fields.first().waitFor({ timeout: 20000 });
      for (let i = 0; i < await fields.count(); i += 1) await fields.nth(i).fill(password);
      await form.getByRole('button', { name: /^create wallet$/i }).click();
      address = await shownAddress(w);
      const region = w.getByRole('region', { name: 'Recovery phrase' });
      await region.waitFor({ timeout: 10000 });
      phrase = (await region.locator('li').allInnerTexts()).map((x) => x.trim()).join(' ');
      await w.close();
    });
    if (!address) return { ok: false, pages, password, phrase };

    // 2. Sign in through the normal OAuth portal, in the dashboard tab.
    const signedIn = await step('step 2: Sign in -> normal OAuth portal -> embedded wallet approves account-login -> back on the dashboard', async () => {
      await click('Sign in');
      await dash.getByText('Link your DACS account').waitFor({ timeout: 20000 });
      await useEmbedded(dash);
      await unlock(dash);
      await connect(dash);
      await dash.getByRole('button', { name: 'Sign in and allow' }).click();
      await approve(dash, ['purpose: account-login', address]);
      await dash.waitForURL(`${h.dashboardUrl}**`, { timeout: 20000 });
      await waitText('sign-in-status', new RegExp(`^Signed in\\. Linked wallet: ${address}$`));
    });
    if (!signedIn) return { ok: false, pages, password, phrase };

    // 3. Discovery vs verification.
    await step('step 3: Find test service shows the directory hint and, separately, the verified simulated listing', async () => {
      await click('Find test service');
      await waitText('v-result', /^Verified: transactable$/);
      if (!/not verified/.test(await textOf('d-evidence'))) throw new Error('discovery is not labelled unverified');
      if ((await textOf('d-seller')).indexOf(h.listing.seller) === -1) throw new Error('discovery does not show the seller');
      const price = await textOf('v-price');
      if (!price.includes('1.5') || !price.includes('1500000000')) throw new Error(`price ${price}`);
      if ((await textOf('v-seller')) !== h.listing.seller) throw new Error('verified seller differs');
      if (!/simulated-fixture/.test(await textOf('v-evidence'))) throw new Error('verification not labelled simulated-fixture');
    });

    // 4. Purchase: prepare, repeat (same operation), waiting is not completion, portal approval, receipt.
    let operationId = null;
    let key = null;
    const prepared = await step('step 4: Prepare simulated purchase awaits approval; a repeat returns the same operation and key', async () => {
      await click('Prepare simulated purchase');
      await waitText('p-status', /^awaiting_approval/);
      operationId = await textOf('p-op');
      key = await textOf('p-key');
      await click('Prepare simulated purchase');
      await waitText('p-status', /same pending purchase returned/);
      if ((await textOf('p-op')) !== operationId || (await textOf('p-key')) !== key) throw new Error('repeat created a different operation or key');
      await click('Refresh receipt');
      await waitText('p-status', /^awaiting_approval/);
      if (!(await dash.locator('#receipt-waiting').isVisible()) || (await dash.locator('#receipt').isVisible())) throw new Error('waiting state is not shown as not complete');
    });
    const before = h.chainStats();
    const paid = prepared && await step('step 4: the explicit portal review link is approved in the wallet; Refresh receipt shows the exact simulated receipt', async () => {
      const p = await popup('Open review in the portal');
      await useEmbedded(p);
      await unlock(p);
      await connect(p);
      await p.getByRole('button', { name: 'Approve exact terms' }).click();
      await approve(p, ['approve-purchase', h.listing.sellerAddress]);
      await approve(p, [h.listing.sellerAddress, '1500000000', address, 'SIMULATED']);
      await p.getByRole('heading', { name: 'Simulated purchase receipt' }).waitFor({ timeout: 30000 });
      await p.close();
      // Prepare (not Refresh) while the dashboard still shows the stale
      // pending status: the same operation comes back already settled, shown
      // plainly, with no review link and no receipt until Refresh reads it.
      await waitText('p-status', /^awaiting_approval/);
      await click('Prepare simulated purchase');
      await waitText('p-status', /^settled_verified$/);
      if ((await textOf('p-op')) !== operationId || (await textOf('p-key')) !== key) throw new Error('Prepare after approval returned a different operation or key');
      if (await dash.locator('#purchase-review').isVisible()) throw new Error('a settled replay still offers the portal review link');
      if (await dash.locator('#receipt').isVisible()) throw new Error('Prepare produced a receipt without get_purchase_status');
      await click('Refresh receipt');
      await waitText('p-status', /^settled_verified$/);
      await dash.locator('#receipt').waitFor({ state: 'visible', timeout: 5000 });
      if (strip0x(await textOf('r-payer')) !== strip0x(address)) throw new Error('receipt payer');
      if (strip0x(await textOf('r-payee')) !== strip0x(h.listing.sellerAddress)) throw new Error('receipt payee');
      if (!(await textOf('r-amount')).includes('1500000000')) throw new Error('receipt amount');
      if (!/^(0x)?[0-9a-f]{64}$/.test(await textOf('r-tx'))) throw new Error('receipt tx hash');
      if (!/^offline-fixture$|fixture/.test(await textOf('r-network'))) throw new Error('receipt network');
      if (!/simulated-fixture.*not settlement/.test(await textOf('r-mode'))) throw new Error('receipt label');
    });
    if (paid) {
      const after = h.chainStats();
      check('step 4: exactly one accepted broadcast for the dashboard purchase', after.broadcastAccepted - before.broadcastAccepted === 1);
    }

    // 5. GitHub identity add and remove.
    const added = await step('step 5: Add test GitHub identity -> portal review -> local proof publisher -> wallet approval -> readback observed', async () => {
      await click('Add test GitHub identity');
      await waitText('add-status', /^(prepared|awaiting_wallet)/);
      const p = await popup('Open add review in the portal');
      await useEmbedded(p);
      await unlock(p);
      await connect(p);
      await p.getByRole('button', { name: 'Use my connected wallet' }).click();
      await p.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
      await approve(p);
      const proofText = (await p.locator('#proof-text').innerText({ timeout: 10000 })).trim();
      const pub = await popup('local proof publisher');
      await pub.selectOption('select[name=kind]', 'github');
      await pub.fill('input[name=username]', GITHUB_HANDLE);
      await pub.fill('input[name=proof]', proofText);
      await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
      const proofUrl = (await pub.locator('#proof-url').innerText({ timeout: 10000 })).trim();
      await pub.close();
      await p.locator('#proof-url').fill(proofUrl);
      await p.getByRole('button', { name: 'Use this proof URL' }).click();
      await p.getByRole('button', { name: 'Approve in my wallet' }).click();
      await approve(p, ['addGithubIdentity', GITHUB_HANDLE, address]);
      await p.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
      await p.close();
      await click('Refresh identities');
      await waitText('o-handles', new RegExp(`^${GITHUB_HANDLE}$`));
      await waitText('add-status', /^association_observed/);
      if (!/simulated-fixture; fixture chain observation, not KYC/.test(await textOf('o-status'))) throw new Error('readback label');
    });
    if (added) {
      await step('step 5: Remove test GitHub identity -> portal review -> wallet approval -> readback shows none', async () => {
        await dash.locator('#remove-handle').selectOption(GITHUB_HANDLE);
        await click('Remove test GitHub identity');
        await waitText('remove-status', /^(prepared|awaiting_wallet)/);
        const p = await popup('Open remove review in the portal');
        await useEmbedded(p);
        await unlock(p);
        await connect(p);
        await p.getByRole('button', { name: 'Use my connected wallet' }).click();
        await p.getByRole('button', { name: 'Approve in my wallet' }).click();
        await approve(p, ['removeWeb2Identity', GITHUB_HANDLE]);
        await p.getByText('Association no longer observed on chain.').waitFor({ timeout: 30000 });
        await p.close();
        await click('Refresh identities');
        await waitText('o-handles', /^none observed$/);
        await waitText('remove-status', /^removal_observed/);
      });
    }

    // Cancellation path through ordinary controls: a new attempt, then cancel.
    await step('cancellation: a new prepared purchase gets a new key and is cancelled from the dashboard before approval', async () => {
      if (!paid) throw new Error('previous purchase did not settle; a new attempt is not allowed');
      await click('Prepare simulated purchase');
      await waitText('p-status', /^awaiting_approval/);
      if ((await textOf('p-key')) === key) throw new Error('a finished purchase key was reused');
      await click('Cancel pending purchase');
      await waitText('p-status', /^cancelled$/);
      if (await dash.locator('#receipt').isVisible()) throw new Error('a cancelled purchase shows a receipt');
      if (await dash.locator('#purchase-review').isVisible()) throw new Error('a cancelled purchase still offers the portal review link');
    });

    // 6. Tester-marked checklist persists in the dashboard (not "observed").
    await step('step 6: tester-marked checklist ticks persist across a reload', async () => {
      await dash.getByLabel(/Tried declining/).check();
      await dash.waitForFunction(() => !document.querySelector('input[data-item="decline"]').disabled);
      await dash.reload();
      await dash.waitForFunction(() => document.querySelector('input[data-item="decline"]')?.checked === true, null, { timeout: 10000 });
    });

    // 7. Feedback export: allowlisted keys, the typed note, nothing sensitive.
    await step('step 7: feedback export downloads only allowlisted statuses, ticks and the typed note', async () => {
      const note = 'Dashboard steps were clear; receipt matched the portal.';
      await dash.getByLabel(/Your note/).fill(note);
      const [download] = await Promise.all([dash.waitForEvent('download', { timeout: 10000 }), click('Download feedback file')]);
      // path() is unavailable on a remotely connected browser; saveAs() copies it.
      const failure = await download.failure();
      if (failure) throw new Error(`download failed: ${failure}`);
      const dir = mkdtempSync(join(tmpdir(), 'dacs-tdexport-'));
      let body;
      try {
        const file = join(dir, download.suggestedFilename());
        await download.saveAs(file);
        body = readFileSync(file, 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (!body) throw new Error(`downloaded file "${download.suggestedFilename()}" is empty`);
      const data = JSON.parse(body);
      if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(EXPORT_KEYS)) throw new Error(`export keys ${Object.keys(data).join(',')}`);
      if (data.feedback !== note || data.testerMarked.decline !== true || data.observed.purchase !== 'cancelled' || data.observed.receipt !== 'simulated_receipt_observed' && data.observed.receipt !== 'not_observed') throw new Error('export content');
      const forbidden = [strip0x(address), password, phrase, 'http', '#t=', 'access_token', 'Bearer'].filter((s) => s && body.toLowerCase().includes(String(s).toLowerCase()));
      if (forbidden.length) throw new Error(`export carries ${forbidden.length} forbidden value(s)`);
    });

    if (screenshotPath) {
      await step('dashboard screenshot captured (no password, phrase, backup or token on the page)', async () => {
        await dash.evaluate(() => window.scrollTo(0, 0));
        const visible = await dash.locator('body').innerText();
        if ([password, phrase].some((s) => s && visible.includes(s)) || /access_token|refresh_token|Bearer /.test(visible)) throw new Error('page shows a secret');
        await dash.screenshot({ path: screenshotPath, fullPage: true });
      });
    }

    // Cross-cutting.
    const allowed = [h.origin, h.fixtures.proofs];
    const requests = pages.flatMap((p) => p.requests);
    const off = requests.filter((r) => !r.url.startsWith('blob:') && !allowed.some((o) => r.url.startsWith(`${o}/`)));
    check('every browser request went to the launched loopback origins (no CDN, fonts or external assets)', off.length === 0, off.slice(0, 3).map((r) => r.url.slice(0, 80)).join(' '));
    const errors = pages.flatMap((p) => p.consoleErrors);
    check('no browser console errors (unfiltered)', errors.length === 0, errors.slice(0, 3).join(' | '));
    const dashRequests = pages[0].requests.filter((r) => r.url.startsWith(`${h.origin}/tester/api/`));
    const leaks = dashRequests.filter((r) => [password, phrase].some((s) => s && (r.body.includes(s) || r.url.includes(s))));
    check('dashboard API requests never carry the password or phrase', leaks.length === 0 && dashRequests.length > 0, `${dashRequests.length} dashboard API requests`);
    const scan = [...requests.map((r) => `${r.url} ${r.body}`), ...pages.flatMap((p) => p.consoleAll), ...operatorLogs];
    const hits = scan.filter((s) => [password, phrase].some((x) => x && s.includes(x)));
    check('password and recovery phrase absent from requests, console and operator logs', hits.length === 0, `${hits.length} hit(s)`);
    return { ok: true, pages, password, phrase };
  } finally {
    await context.close();
  }
}
