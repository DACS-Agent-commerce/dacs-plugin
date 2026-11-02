// Overnight BOUNDED discovery of the open purchase-widget mouse-click
// observation (docs/TESTING.md "Purchase mouse-click observation"): one run,
// a fixed number of ordinary mouse clicks on the status view's "Open wallet
// approval" button, each with the existing 5 s limit and the same passive
// counters, never retried or extended. A pass does NOT resolve the
// observation; a failure records counts only (never URLs). The cause stays
// unknown unless these counters show it.
//
// FIXTURE MCP Apps host (deploy/test/mcp-apps-host.mjs, official ext-apps
// AppBridge); NOT ChatGPT's renderer. SIMULATED fixture chain/directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { buildImportMap, startHostServer } from '../../deploy/test/mcp-apps-host.mjs';
import { startHarness } from '../helpers/harness.mjs';
import { linkedUser, toolRaw, seedSellerListing } from '../helpers/flows.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { browserPrerequisites, cleanupStack, launchBrowser } from '../helpers/overnight-acceptance-browser.mjs';
import { unique } from '../helpers/overnight-acceptance-flows.mjs';

const NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules');
const SAME_FRAME_ATTEMPTS = 12;
const FRESH_FRAME_ATTEMPTS = 8;
const DOM_TIMEOUT_MS = 5_000; // the existing widget suite's limit, unchanged
const root = cleanupStack();
let h;
let host;
let page;
let html;
let csp;
let buyer;
let seller;
const listingId = 'oa-widget-click';

before(async () => {
  assert.deepEqual(browserPrerequisites(), [], 'browser prerequisites');
  h = await startHarness();
  root.add('harness close', 15000, () => h.close());
  seller = createEphemeralWallet();
  seedSellerListing(h, seller, { listingId, price: '1.75', title: 'Widget click fixture' });
  buyer = await linkedUser(h);
  const client = new Client({ name: 'oa-widget-click', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  try {
    const { tools } = await client.listTools();
    const uri = getToolUiResourceUri(tools.find((x) => x.name === 'prepare_purchase'));
    const { contents } = await client.readResource({ uri });
    html = contents[0].text;
    csp = contents[0]._meta?.ui?.csp;
  } finally {
    await client.close();
  }
  host = await startHostServer({ nodeModules: NODE_MODULES, importMap: buildImportMap(NODE_MODULES, '@modelcontextprotocol/ext-apps/app-bridge') });
  root.add('host server close', 10000, () => host.close());
  const { browser } = await launchBrowser(root);
  const context = await browser.newContext();
  root.add('context close', 10000, () => context.close());
  page = await context.newPage();
  await page.goto(host.hostUrl);
  await page.waitForFunction(() => window.__hostReady === true, null, { timeout: 10_000 });
});
after(async () => root.run());

async function mount() {
  const url = host.registerFrame(html, csp);
  await page.evaluate(([u, ms]) => window.__host.mount(u, ms), [url, 10_000]);
  const frame = page.frames().find((f) => f.url() === url);
  await frame.evaluate(() => {
    window.__oaClicks = 0;
    window.__oaOther = 0;
    window.__oaRenders = 0;
    window.addEventListener('click', (e) => {
      if (e.target.closest?.('button[data-link]')) window.__oaClicks += 1;
      else window.__oaOther += 1;
    }, true);
    const app = document.getElementById('app');
    if (app) new MutationObserver(() => { window.__oaRenders += 1; }).observe(app, { childList: true });
  });
  return frame;
}

async function attempt(frame) {
  const prepared = await toolRaw(h, buyer, 'prepare_purchase', { listingId, version: 1, seller: seller.claim, idempotencyKey: unique('oa-wc') });
  assert.notEqual(prepared.isError, true);
  await page.evaluate((r) => window.__host.sendToolResult(r), prepared);
  await frame.waitForFunction((m) => document.getElementById('app')?.innerText.includes(m), `Purchase ${prepared.structuredContent.operationId}`, { timeout: DOM_TIMEOUT_MS });
  const counters = async () => ({
    ...(await frame.evaluate(() => ({ clicks: window.__oaClicks, other: window.__oaOther, renders: window.__oaRenders }))),
    openLinks: await page.evaluate(() => window.__host.openLinks.length),
  });
  const start = await counters();
  const button = frame.locator('button[data-link]').filter({ hasText: 'Open wallet approval' });
  const handle = await button.elementHandle();
  await button.click();
  let outcome = 'open_link';
  try {
    await page.waitForFunction((n) => window.__host.openLinks.length === n + 1, start.openLinks, { timeout: DOM_TIMEOUT_MS });
  } catch {
    outcome = 'timeout';
  }
  const end = await counters();
  const connected = await handle.evaluate((b) => b.isConnected).catch(() => 'unknown');
  await handle.dispose();
  const exact = outcome === 'open_link' && (await page.evaluate(() => window.__host.openLinks.at(-1))) === prepared.structuredContent.approvalUrl;
  return { outcome, exact, clicks: end.clicks - start.clicks, other: end.other - start.other, renders: end.renders - start.renders, openLinks: end.openLinks - start.openLinks, connected };
}

test(`OA-W1 bounded discovery: ${SAME_FRAME_ATTEMPTS + FRESH_FRAME_ATTEMPTS} mouse clicks on "Open wallet approval" each send exactly one ui/open-link with the returned URL`, { timeout: 300_000 }, async (t) => {
  const results = [];
  const same = await mount();
  for (let i = 0; i < SAME_FRAME_ATTEMPTS; i += 1) results.push({ frame: 'same', ...(await attempt(same)) });
  for (let i = 0; i < FRESH_FRAME_ATTEMPTS; i += 1) results.push({ frame: 'fresh', ...(await attempt(await mount())) });
  const timeouts = results.filter((r) => r.outcome === 'timeout');
  t.diagnostic(`attempts ${results.length}; open-link ${results.length - timeouts.length}; timeouts ${timeouts.length}`);
  for (const [i, r] of results.entries()) if (r.outcome !== 'open_link' || !r.exact || r.clicks !== 1) t.diagnostic(`attempt ${i} (${r.frame} frame): ${JSON.stringify(r)}`);
  assert.deepEqual(timeouts, [], 'REPRODUCED: a mouse click produced no ui/open-link within 5 s (counts above; cause unknown)');
  assert.ok(results.every((r) => r.exact && r.clicks === 1 && r.openLinks === 1), 'every click reached the button once and opened exactly the returned approval URL');
});
