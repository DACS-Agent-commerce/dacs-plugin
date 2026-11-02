// Real headless Chrome against the offline tester launcher's own services:
// the embedded-wallet page served by the operator-started plugin, and the
// SIMULATED proof publisher form. Loopback only; no wallet keys are created
// by the operator (the proof here is made by a throwaway test key).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chromium } from 'playwright-core';
import { startOfflineTester } from '../../bin/dacs-chatgpt-offline-test.mjs';

const CHROME = process.env.DACS_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !existsSync(CHROME) && `Chrome not found at ${CHROME}`;

let h;
let browserServer;
let browser;

async function bounded(label, ms, fn) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), limit]);
  } finally {
    clearTimeout(timer);
  }
}

before(async () => {
  h = await startOfflineTester({ logLevel: 'silent' });
  if (skip) return;
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
});

after(async () => {
  const failures = [];
  const proc = browserServer?.process();
  for (const [label, ms, fn] of [
    ['browser disconnect', 5000, () => browser?.close()],
    ['launched browser close', 10000, async () => {
      if (!browserServer) return;
      try {
        await bounded('graceful close', 8000, () => browserServer.close());
      } catch {
        await browserServer.kill();
      }
      if (proc && proc.exitCode === null && proc.signalCode === null) throw new Error('test-launched browser is still running');
    }],
    ['offline tester stop', 10000, () => h?.stop()],
  ]) {
    try {
      await bounded(label, ms, fn);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((f) => f.message).join('; '));
});

async function page() {
  const context = await browser.newContext();
  const p = await context.newPage();
  const consoleErrors = [];
  const requests = [];
  p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(String(e)));
  p.on('request', (r) => requests.push(r.url()));
  return { context, p, consoleErrors, requests };
}

test('embedded-wallet page loads from the operator-started plugin with loopback-only requests', { skip }, async () => {
  const { context, p, consoleErrors, requests } = await page();
  try {
    const res = await p.goto(h.embeddedWalletUrl);
    assert.equal(res.status(), 200);
    assert.match(res.headers()['content-security-policy'] ?? '', /script-src 'self'/);
    await p.waitForLoadState('networkidle');
    assert.match(await p.textContent('body'), /experimental/i);
    for (const url of requests) assert.ok(url.startsWith(`${h.origin}/`), `unexpected request ${url}`);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
  }
});

test('proof publisher form returns a fixture-only proof URL and refuses malformed proofs', { skip }, async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const proof = `demos:dw2p:ed25519:0x${sign(null, Buffer.from('dw2p'), privateKey).toString('hex')}`;
  const { context, p, consoleErrors, requests } = await page();
  try {
    await p.goto(`${h.fixtures.proofs}/`);
    assert.match(await p.textContent('body'), /Not GitHub, not X, not Demos testnet/);
    await p.selectOption('select[name=kind]', 'twitter');
    await p.fill('input[name=username]', 'fixture_tester');
    await p.fill('input[name=proof]', proof);
    await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
    assert.match(await p.textContent('#proof-url'), /^https:\/\/x\.com\/fixture_tester\/status\/\d{1,19}$/);

    await p.fill('input[name=username]', 'fixture_tester');
    await p.fill('input[name=proof]', 'not-a-proof');
    await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
    assert.match(await p.textContent('body'), /Not published: proof text must be/);
    for (const url of requests) assert.ok(url.startsWith(`${h.fixtures.proofs}/`), `unexpected request ${url}`);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await context.close();
  }
});
