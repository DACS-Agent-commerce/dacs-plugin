// Overnight ordinary functional acceptance: real-browser drivers for the
// INSTALLED user path (offline launcher + guided dashboard + trusted portal +
// experimental embedded wallet). SIMULATED fixtures only; source-aware; NOT a
// security review, NOT live Demos testnet, NOT ChatGPT.
//
// Only ordinary UI controls are used (roles/labels/visible text), plus the
// keyboard where a test says so. Passwords are typed only into the wallet UI.
// Browser: exactly DACS_TEST_CHROME (never a bare Chromium, no sandbox flags).
// Downloads: a fresh directory under DACS_TEST_DOWNLOAD_PARENT, which must be
// set and must not be under /tmp (a snap browser delivered EMPTY files there).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startOfflineTester, DEFAULT_REDIRECT_ORIGIN } from '../../bin/offline-fixtures/operator.mjs';
import { CALLBACK_ORIGIN } from './harness.mjs';
import { linkAccount } from './oauth.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { ok } from './overnight-acceptance-flows.mjs';

export const FULL_SCOPE = 'dacs.account.read dacs.agents.write dacs.purchases.write dacs.identities.write';
export const password = () => `pw-${randomBytes(18).toString('base64url')}`;

export function browserPrerequisites() {
  const chrome = process.env.DACS_TEST_CHROME;
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT;
  const problems = [];
  if (!chrome) problems.push('DACS_TEST_CHROME is not set');
  else if (!existsSync(chrome)) problems.push(`DACS_TEST_CHROME not found at ${chrome}`);
  if (!parent) problems.push('DACS_TEST_DOWNLOAD_PARENT is not set (downloads under /tmp arrived empty with a snap browser)');
  else if (/^\/tmp(\/|$)/.test(resolve(parent))) problems.push('DACS_TEST_DOWNLOAD_PARENT is under /tmp');
  return problems;
}

// Bounded LIFO cleanup; every failure is reported, nothing is swallowed.
export function cleanupStack() {
  const steps = [];
  return {
    add: (label, ms, fn) => steps.push({ label, ms, fn }),
    async run() {
      const failures = [];
      while (steps.length) {
        const { label, ms, fn } = steps.pop();
        let timer;
        try {
          const outcome = await Promise.race([Promise.resolve().then(fn).then(() => 'done'), new Promise((r) => { timer = setTimeout(() => r('timeout'), ms); })]);
          if (outcome === 'timeout') failures.push(`${label}: did not finish within ${ms}ms`);
        } catch (error) {
          failures.push(`${label}: ${String(error?.message ?? error).slice(0, 200)}`);
        } finally {
          clearTimeout(timer);
        }
      }
      if (failures.length) throw new Error(`cleanup: ${failures.join('; ')}`);
    },
  };
}

export async function launchBrowser(cleanups) {
  const problems = browserPrerequisites();
  if (problems.length) throw new Error(problems.join('; '));
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT;
  mkdirSync(parent, { recursive: true });
  const downloads = mkdtempSync(join(parent, 'oa-dl-'));
  cleanups.add('download dir removal', 5000, () => rmSync(downloads, { recursive: true, force: true }));
  const server = await chromium.launchServer({ executablePath: process.env.DACS_TEST_CHROME, headless: true, downloadsPath: downloads });
  const proc = server.process();
  cleanups.add('browser shutdown', 20000, async () => {
    try {
      await Promise.race([server.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout')), 8000))]);
    } catch {
      await server.kill();
    }
    if (proc.exitCode === null && proc.signalCode === null) throw new Error('test-launched browser still running');
  });
  const browser = await chromium.connect(server.wsEndpoint());
  cleanups.add('browser disconnect', 5000, () => browser.close());
  return { browser, downloads, version: browser.version() };
}

export async function startLauncher(cleanups, logs = []) {
  const h = await startOfflineTester({ dashboard: true, redirectOrigins: [DEFAULT_REDIRECT_ORIGIN, CALLBACK_ORIGIN], logLevel: 'info', logSink: (l) => logs.push(l) });
  cleanups.add('offline launcher stop', 15000, () => h.stop());
  return h;
}

// A fresh context whose pages record requests, console errors and page errors.
export async function recordedContext(browser, cleanups) {
  const context = await browser.newContext({ acceptDownloads: true });
  cleanups.add('context close', 10000, () => context.close());
  const rec = { context, requests: [], consoleErrors: [], consoleAll: [] };
  const track = (page) => {
    page.on('request', (r) => rec.requests.push({ url: r.url(), body: r.postData() ?? '' }));
    page.on('console', (m) => {
      rec.consoleAll.push(m.text());
      if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => rec.consoleErrors.push(String(e.message).slice(0, 200)));
  };
  context.on('page', track);
  return rec;
}

// ---- embedded wallet (existing UI; accessible names from ui.mjs/approval.mjs)
const walletRoot = (page) => page.locator('#embedded-wallet');
const formWith = (scope, page, name) => scope.locator('form').filter({ has: page.getByRole('button', { name }) });

export async function shownAddress(scope) {
  await scope.getByRole('heading', { name: /^wallet unlocked$/i }).waitFor({ timeout: 30000 });
  const t = (await scope.locator('dt', { hasText: /^Address$/ }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
  if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error('unlocked view shows no Demos address');
  return t;
}

// On the standalone wallet page the wallet is the page itself.
export async function createOnWalletPage(page, pw) {
  const form = formWith(page, page, /^create wallet$/i);
  const fields = form.locator('input[type="password"]');
  await fields.first().waitFor({ timeout: 20000 });
  for (let i = 0; i < await fields.count(); i += 1) await fields.nth(i).fill(pw);
  await form.getByRole('button', { name: /^create wallet$/i }).click();
  return shownAddress(page);
}

export async function useEmbedded(page) {
  await page.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
  await walletRoot(page).getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 20000 });
}

export async function unlock(page, pw) {
  const form = formWith(walletRoot(page), page, /^unlock$/i);
  await form.locator('input[type="password"]').fill(pw);
  await form.getByRole('button', { name: /^unlock$/i }).click();
  return shownAddress(walletRoot(page));
}

export async function createInPortal(page, pw) {
  const form = formWith(walletRoot(page), page, /^create wallet$/i);
  const fields = form.locator('input[type="password"]');
  await fields.first().waitFor({ timeout: 20000 });
  for (let i = 0; i < await fields.count(); i += 1) await fields.nth(i).fill(pw);
  await form.getByRole('button', { name: /^create wallet$/i }).click();
  return shownAddress(walletRoot(page));
}

export async function connect(page, address) {
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByText(`Connected: ${address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 15000 });
}

export async function openUnlocked(page, url, pw, address) {
  await page.goto(url);
  await useEmbedded(page);
  if ((await unlock(page, pw)) !== address) throw new Error('unlock showed a different address');
  await connect(page, address);
}

// Approval dialog: checks the exact content, then approves (mouse or keyboard).
export async function approve(page, expect = [], { keyboard = false } = {}) {
  const dialog = page.locator('dialog');
  await dialog.waitFor({ timeout: 20000 });
  const content = await dialog.innerText();
  const missing = expect.filter((t) => !content.includes(t));
  if (missing.length) throw new Error(`approval dialog does not show ${missing.join(', ')}`);
  if (keyboard) {
    // Reject has focus first; Tab moves to Approve; Enter activates it.
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (focused !== 'Reject') throw new Error(`dialog opened with focus on "${focused}", expected Reject`);
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (next !== 'Approve') throw new Error(`Tab from Reject focused "${next}", expected Approve`);
    await page.keyboard.press('Enter');
  } else {
    await dialog.getByRole('button', { name: /^approve$/i }).click();
  }
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  return content;
}

export async function reject(page, { escape = false } = {}) {
  const dialog = page.locator('dialog');
  await dialog.waitFor({ timeout: 20000 });
  const content = await dialog.innerText();
  if (escape) await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: /^reject$/i }).click();
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  return content;
}

export const portalLog = async (page) => (await page.locator('#log').innerText().catch(() => '')).replace(/\s+/g, ' ');

// Runs one user step; on failure the error carries the visible portal status
// and log (public text only) instead of a bare timeout.
export async function step(page, label, fn) {
  try {
    return await fn();
  } catch (error) {
    const flow = (await page.locator('#flow').innerText().catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`${label} failed: ${String(error.message).split('\n')[0]} | portal status: ${flow.slice(0, 300)} | portal log: ${(await portalLog(page)).slice(-300)}`);
  }
}

// Links the embedded wallet created in `page` to the MCP account through the
// documented one-time wallet link page. Returns the embedded address.
export async function linkEmbeddedWallet(h, page, user, pw) {
  const { linkUrl } = await ok(h, user, 'start_wallet_link');
  await page.goto(linkUrl);
  await useEmbedded(page);
  const hasUnlock = await walletRoot(page).getByRole('button', { name: /^unlock$/i }).count();
  const address = hasUnlock ? await unlock(page, pw) : await createInPortal(page, pw);
  await connect(page, address);
  await page.getByRole('button', { name: 'Sign and link' }).click();
  await approve(page, [address]);
  await page.getByText('Wallet linked').waitFor({ timeout: 15000 });
  return address;
}

// An MCP account (the "ChatGPT side") against the launcher, signed in with a
// throwaway key, then a browser embedded wallet linked to it.
export async function accountWithEmbeddedWallet(h, page, pw, scope = FULL_SCOPE) {
  const key = createEphemeralWallet();
  const { provider } = await linkAccount({ harness: { mcpUrl: h.mcpUrl, origin: h.origin }, wallet: key, scope });
  const user = { wallet: key, provider };
  const address = await linkEmbeddedWallet(h, page, user, pw);
  return { user, address };
}

// ---- dashboard
export function dashboard(page) {
  const waitText = (id, pattern, timeout = 20000) => page.waitForFunction(([i, src, flags]) => new RegExp(src, flags).test(document.getElementById(i)?.textContent ?? ''), [id, pattern.source, pattern.flags], { timeout });
  return {
    page,
    click: (name) => page.getByRole('button', { name, exact: true }).click(),
    textOf: (id) => page.locator(`#${id}`).innerText(),
    visible: (id) => page.locator(`#${id}`).isVisible(),
    waitText,
    state: () => page.evaluate(async () => (await fetch('/tester/api/state')).json()),
  };
}

// Dashboard sign-in through the normal OAuth portal with the embedded wallet.
// role 'seller' uses step S1 ("Sign in as seller"), as the tester guide says.
export async function dashboardSignIn(d, pw, address, { role = 'buyer' } = {}) {
  await d.click(role === 'seller' ? 'Sign in as seller' : 'Sign in');
  await d.page.getByText('Link your DACS account').waitFor({ timeout: 20000 });
  await useEmbedded(d.page);
  if ((await unlock(d.page, pw)) !== address) throw new Error('unlock showed a different address');
  await connect(d.page, address);
  await d.page.getByRole('button', { name: 'Sign in and allow' }).click();
  await approve(d.page, ['account-login', address]);
  await d.page.waitForURL(/\/tester\//, { timeout: 20000 });
  if (role === 'seller') await d.waitText('seller-sign-in-status', new RegExp(`^Seller signed in\\. Linked wallet: ${address}$`));
  else await d.waitText('sign-in-status', new RegExp(`^Signed in\\. Linked wallet: ${address}$`));
}

// Opens a dashboard link that targets a new tab and returns that page.
export async function popupFrom(d, name) {
  const [p] = await Promise.all([d.page.context().waitForEvent('page', { timeout: 15000 }), d.page.getByRole('link', { name, exact: true }).click()]);
  await p.waitForLoadState('domcontentloaded');
  return p;
}

// Collects the accessible names that receive focus over `count` Tab presses.
export async function tabStops(page, count) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab');
    names.push(await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return '(body)';
      return (a.getAttribute('aria-label') || a.textContent || a.id || a.tagName).trim().replace(/\s+/g, ' ').slice(0, 80);
    }));
  }
  return names;
}

export async function focusAndPress(page, locator, key = 'Enter') {
  await locator.focus();
  const focused = await locator.evaluate((el) => el === document.activeElement);
  if (!focused) throw new Error('control did not take keyboard focus');
  await page.keyboard.press(key);
}
