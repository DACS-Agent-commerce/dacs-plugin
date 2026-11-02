// Real Chromium through the guided tester dashboard served by the SOURCE
// offline launcher (SIMULATED fixtures only). A missing browser is a failure,
// not a skip. Set DACS_TEST_SCREENSHOT_DIR to keep a dashboard screenshot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startOfflineTester } from '../../bin/dacs-chatgpt-offline-test.mjs';
import { runDashboardFlow } from '../helpers/tester-dashboard-driver.mjs';

const CHROME = process.env.DACS_TEST_CHROME;
let h;
let browserServer;
let browser;
const logs = [];
// Fresh test-owned download directory under DACS_TEST_DOWNLOAD_PARENT (or the
// temp dir), passed as downloadsPath so the browser and the Playwright server
// use one explicit directory; removed after the browser shuts down.
let downloads = null;

before(async () => {
  assert.ok(CHROME && existsSync(CHROME), `real Chromium required: DACS_TEST_CHROME=${CHROME ?? '(unset)'}`);
  h = await startOfflineTester({ dashboard: true, logLevel: 'info', logSink: (line) => logs.push(line) });
  const parent = process.env.DACS_TEST_DOWNLOAD_PARENT || tmpdir();
  mkdirSync(parent, { recursive: true });
  downloads = mkdtempSync(join(parent, 'tdsrc-'));
  process.stdout.write(`# download dir ${downloads}\n`);
  browserServer = await chromium.launchServer({ executablePath: CHROME, headless: true, downloadsPath: downloads });
  browser = await chromium.connect(browserServer.wsEndpoint());
});

after(async () => {
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => browserServer.kill());
  await h?.stop();
  if (downloads) {
    process.stdout.write(`# download dir entries after browser close: ${readdirSync(downloads).length}\n`);
    rmSync(downloads, { recursive: true, force: true });
    process.stdout.write(`# download dir removed: ${!existsSync(downloads)}\n`);
  }
});

test('guided dashboard: wallet, OAuth sign-in, verified listing, purchase receipt, GitHub add/remove, cancel, checklist, export', { timeout: 240_000 }, async () => {
  const results = [];
  const dir = process.env.DACS_TEST_SCREENSHOT_DIR;
  await runDashboardFlow({
    browser,
    h,
    operatorLogs: logs,
    screenshotPath: dir ? join(dir, 'tester-dashboard-source.png') : null,
    check: (name, ok, detail) => {
      results.push({ name, ok, detail });
      return ok;
    },
  });
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`);
  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(failed, [], `${failed.length}/${results.length} dashboard checks failed`);
  assert.ok(results.length >= 15, `only ${results.length} checks ran`);
});
