// Browser actors for the overnight UI test (SIMULATED fixtures only). One
// Profile is one Playwright browser context, i.e. one separate browser
// profile with its own built-in wallet. Drives only ordinary UI: dashboard
// controls, the existing embedded-wallet page, the portal and the fixture
// proof publisher. The throwaway password is typed only into the wallet UI.
import { randomBytes } from 'node:crypto';

export class Profile {
  constructor(context, h, label) {
    this.context = context;
    this.h = h;
    this.label = label;
    this.password = `pw-${randomBytes(18).toString('base64url')}`;
    this.address = null;
    this.phrase = null;
    this.records = [];
    context.on('page', (page) => this.track(page));
  }

  track(page) {
    const rec = { page, requests: [], consoleErrors: [], consoleAll: [] };
    page.on('request', (r) => rec.requests.push({ url: r.url(), body: r.postData() ?? '' }));
    page.on('console', (m) => {
      rec.consoleAll.push(m.text());
      if (m.type() === 'error') rec.consoleErrors.push(`${m.text()} [${String(m.location()?.url ?? '').split(/[?#]/)[0].slice(0, 120)}]`);
    });
    page.on('pageerror', (e) => rec.consoleErrors.push(e.message));
    this.records.push(rec);
    return page;
  }

  async open() {
    this.dash = await this.context.newPage();
    const res = await this.dash.goto(this.h.dashboardUrl);
    if (res.status() !== 200) throw new Error(`dashboard HTTP ${res.status()}`);
    await this.waitText('health-status', /^Running \(/);
    return this.dash;
  }

  textOf(id, page = this.dash) {
    return page.locator(`#${id}`).innerText();
  }

  waitText(id, pattern, timeout = 20000, page = this.dash) {
    return page.waitForFunction(([i, src]) => new RegExp(src).test(document.getElementById(i)?.textContent ?? ''), [id, pattern.source], { timeout });
  }

  click(name, page = this.dash) {
    return page.getByRole('button', { name, exact: true }).click();
  }

  async popup(name) {
    const [p] = await Promise.all([this.context.waitForEvent('page', { timeout: 15000 }), this.dash.getByRole('link', { name, exact: true }).click()]);
    await p.waitForLoadState('domcontentloaded');
    return p;
  }

  wallet(p) {
    return p.locator('#embedded-wallet');
  }

  form(scope, page, name) {
    return scope.locator('form').filter({ has: page.getByRole('button', { name }) });
  }

  async shownAddress(scope) {
    await scope.getByRole('heading', { name: /^wallet unlocked$/i }).waitFor({ timeout: 30000 });
    const t = (await scope.locator('dt', { hasText: /^Address$/ }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
    if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error('unlocked view shows no Demos address');
    return t;
  }

  async createWallet() {
    const w = await this.popup('Open the built-in wallet page');
    const form = this.form(w, w, /^create wallet$/i);
    const fields = form.locator('input[type="password"]');
    await fields.first().waitFor({ timeout: 20000 });
    for (let i = 0; i < await fields.count(); i += 1) await fields.nth(i).fill(this.password);
    await form.getByRole('button', { name: /^create wallet$/i }).click();
    this.address = await this.shownAddress(w);
    const region = w.getByRole('region', { name: 'Recovery phrase' });
    await region.waitFor({ timeout: 10000 });
    this.phrase = (await region.locator('li').allInnerTexts()).map((x) => x.trim()).join(' ');
    await w.close();
    return this.address;
  }

  async useEmbedded(p) {
    await p.getByRole('button', { name: 'Use the experimental embedded wallet' }).click();
    await this.wallet(p).getByRole('button', { name: /^(create wallet|unlock)$/i }).first().waitFor({ timeout: 20000 });
  }

  async unlock(p) {
    const form = this.form(this.wallet(p), p, /^unlock$/i);
    await form.locator('input[type="password"]').fill(this.password);
    await form.getByRole('button', { name: /^unlock$/i }).click();
    if ((await this.shownAddress(this.wallet(p))) !== this.address) throw new Error('unlock showed a different address');
  }

  async connect(p) {
    await p.getByRole('button', { name: 'Connect wallet' }).click();
    await p.getByText(`Connected: ${this.address} (experimental embedded wallet)`, { exact: true }).waitFor({ timeout: 10000 });
  }

  async portalReady(p) {
    await this.useEmbedded(p);
    await this.unlock(p);
    await this.connect(p);
  }

  async decide(p, approve, expect = []) {
    const dialog = p.locator('dialog');
    await dialog.waitFor({ timeout: 20000 });
    const content = await dialog.innerText();
    const missing = expect.filter((t) => !content.includes(t));
    if (missing.length) throw new Error(`approval dialog does not show ${missing.join(', ')}`);
    await dialog.getByRole('button', { name: approve ? /^approve$/i : /^reject$/i }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20000 });
  }

  // Dashboard sign-in for 'buyer' or 'seller' through the real OAuth portal.
  async signIn(role) {
    await this.click(role === 'seller' ? 'Sign in as seller' : 'Sign in');
    await this.dash.getByText('Link your DACS account').waitFor({ timeout: 20000 });
    await this.portalReady(this.dash);
    await this.dash.getByRole('button', { name: 'Sign in and allow' }).click();
    await this.decide(this.dash, true, ['purpose: account-login', this.address]);
    await this.dash.waitForURL(`${this.h.dashboardUrl}**`, { timeout: 20000 });
    const id = role === 'seller' ? 'seller-sign-in-status' : 'sign-in-status';
    await this.waitText(id, new RegExp(`^${role === 'seller' ? 'Seller signed in' : 'Signed in'}\\. Linked wallet: ${this.address}$`));
  }

  // Twitter or GitHub identity add through the portal and the proof publisher.
  async identityAdd(kind, handle) {
    const tw = kind === 'twitter';
    await this.click(tw ? 'Add test Twitter identity' : 'Add test GitHub identity');
    await this.waitText(tw ? 'tw-add-status' : 'add-status', /^(prepared|awaiting_wallet)/);
    const p = await this.popup(tw ? 'Open Twitter add review in the portal' : 'Open add review in the portal');
    await this.portalReady(p);
    await p.getByRole('button', { name: 'Use my connected wallet' }).click();
    await p.getByRole('button', { name: 'Get proof text from my wallet' }).click({ timeout: 15000 });
    await this.decide(p, true);
    const proofText = (await p.locator('#proof-text').innerText({ timeout: 10000 })).trim();
    const pub = await this.popup('local proof publisher');
    await pub.selectOption('select[name=kind]', kind);
    await pub.fill('input[name=username]', handle);
    await pub.fill('input[name=proof]', proofText);
    await Promise.all([pub.waitForNavigation(), pub.click('button[type=submit]')]);
    const proofUrl = (await pub.locator('#proof-url').innerText({ timeout: 10000 })).trim();
    await pub.close();
    await p.locator('#proof-url').fill(proofUrl);
    await p.getByRole('button', { name: 'Use this proof URL' }).click();
    await p.getByRole('button', { name: 'Approve in my wallet' }).click();
    await this.decide(p, true, [handle, this.address]);
    await p.getByText('Association observed on chain.').waitFor({ timeout: 30000 });
    await p.close();
  }

  async identityRemove(kind, handle) {
    const tw = kind === 'twitter';
    await this.dash.locator(tw ? '#tw-remove-handle' : '#remove-handle').selectOption(handle);
    await this.click(tw ? 'Remove test Twitter identity' : 'Remove test GitHub identity');
    await this.waitText(tw ? 'tw-remove-status' : 'remove-status', /^(prepared|awaiting_wallet)/);
    const p = await this.popup(tw ? 'Open Twitter remove review in the portal' : 'Open remove review in the portal');
    await this.portalReady(p);
    await p.getByRole('button', { name: 'Use my connected wallet' }).click();
    await p.getByRole('button', { name: 'Approve in my wallet' }).click();
    await this.decide(p, true, ['removeWeb2Identity', handle]);
    await p.getByText('Association no longer observed on chain.').waitFor({ timeout: 30000 });
    await p.close();
  }

  // Presses Tab until `predicate(activeElementInfo)` holds; returns presses.
  async tabTo(predicate, max = 120) {
    for (let i = 1; i <= max; i += 1) {
      await this.dash.keyboard.press('Tab');
      const info = await this.dash.evaluate(() => {
        const a = document.activeElement;
        return { id: a?.id ?? '', tag: a?.tagName ?? '', text: (a?.textContent ?? '').trim().slice(0, 80), action: a?.dataset?.action ?? '' };
      });
      if (predicate(info)) return i;
    }
    throw new Error('control not reachable with Tab');
  }

  activeId() {
    return this.dash.evaluate(() => document.activeElement?.id ?? '');
  }

  secrets() {
    return [this.password, this.phrase].filter(Boolean);
  }
}
