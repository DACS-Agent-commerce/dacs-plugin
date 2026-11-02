// Guided tester dashboard (SIMULATED fixtures only): loopback startup, assets
// and headers, the OAuth allowlist change, public-only state, the real MCP
// listing workflow through the dashboard, export allowlist, error scrubbing,
// CLI wiring, and that normal MCP and the production binary are unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startOfflineTester, parseArgs } from '../bin/dacs-chatgpt-offline-test.mjs';
import { buildFeedbackExport, safeMessage, toolErrorMessage, githubHandles, CHECKLIST_ITEMS } from '../bin/offline-fixtures/tester-dashboard.mjs';
import { sellerData } from '../src/mcp/seller-content.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'dacs-chatgpt-offline-test.mjs');
const UI = join(root, 'bin', 'offline-fixtures', 'tester-ui');

let h;
before(async () => {
  h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
});
after(async () => {
  await h?.stop();
});

const post = (path, body, headers = { 'content-type': 'application/json', 'x-dacs-tester': '1' }) => fetch(`${h.origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const action = async (name, args) => (await post('/tester/api/action', { action: name, args })).json();

test('dashboard: served on the plugin loopback origin with self-only CSP and the SIMULATED banner', async () => {
  assert.equal(h.dashboardUrl, `${h.origin}/tester/`);
  assert.match(h.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const res = await fetch(h.dashboardUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'; script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const html = await res.text();
  assert.match(html, /SIMULATED ONLY/);
  assert.match(html, /No real funds\. Not Demos testnet\. Not ChatGPT\. Not security reviewed\./);
  assert.doesNotMatch(html, /type="password"|<input[^>]+name="(password|phrase|mnemonic|seed|backup)"/i, 'the dashboard never asks for wallet secrets');
  for (const [path, type] of [['/tester/dashboard.js', /javascript/], ['/tester/dashboard.css', /css/]]) {
    const r = await fetch(`${h.origin}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type'), type);
  }
  assert.equal((await fetch(`${h.origin}/tester`, { redirect: 'manual' })).headers.get('location'), '/tester/');
  assert.equal((await fetch(`${h.origin}/tester/nope.js`)).status, 404);
});

test('dashboard assets reference no external origin, CDN or font, and render text without innerHTML', () => {
  for (const name of readdirSync(UI)) {
    const body = readFileSync(join(UI, name), 'utf8');
    assert.doesNotMatch(body, /https?:\/\/(?!127\.0\.0\.1)|\/\/fonts|@import|url\(\s*['"]?https?:/i, name);
    if (name.endsWith('.js')) assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, name);
  }
});

test('OAuth allowlist: the dashboard origin is added and the tester origins are kept', async () => {
  assert.deepEqual(h.redirectOrigins, ['http://localhost:6274', h.origin]);
  const plain = await startOfflineTester({ logLevel: 'silent', redirectOrigins: ['http://localhost:7000'] });
  try {
    assert.equal(plain.dashboardUrl, null);
    assert.deepEqual(plain.redirectOrigins, ['http://localhost:7000']);
    assert.equal((await fetch(`${plain.origin}/tester/`)).status, 404, 'without dashboard: true the app has no /tester/ route');
  } finally {
    await plain.stop();
  }
});

test('normal MCP still works next to the dashboard (listing workflow, OAuth refusal)', async () => {
  const client = new Client({ name: 'tester-dashboard-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
  try {
    const search = await client.callTool({ name: 'search_agents', arguments: { query: 'offline fixture' } });
    assert.equal(search.structuredContent.evidenceMode, 'simulated-fixture');
    const status = await client.callTool({ name: 'get_account_status', arguments: {} });
    assert.equal(status.isError, true);
  } finally {
    await client.close();
  }
});

test('dashboard API: public state only, same-origin JSON required, real MCP discovery then verification', async () => {
  const state = await (await fetch(`${h.origin}/tester/api/state`)).json();
  assert.equal(state.signIn.status, 'signed_out');
  assert.equal(state.evidence, 'simulated-fixture');
  assert.equal(state.purchase, null);
  assert.doesNotMatch(JSON.stringify(state), /access_token|refresh_token|code_verifier|cookie|privateKey|mnemonic/i);

  assert.equal((await post('/tester/api/action', { action: 'find-listing' }, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await post('/tester/api/action', { action: 'find-listing' }, { 'content-type': 'application/json', 'x-dacs-tester': '1', origin: 'http://localhost:9999' })).status, 403);

  const found = await action('find-listing');
  assert.equal(found.ok, true, found.error);
  const { discovery, verification } = found.state.listing;
  assert.equal(discovery.found, true);
  assert.equal(discovery.verified, false, 'discovery stays an unverified hint');
  assert.equal(discovery.evidenceMode, 'simulated-fixture');
  assert.equal(verification.transactable, true);
  assert.equal(verification.amountOs, '1500000000');
  assert.equal(verification.seller, h.listing.seller);
  assert.equal(verification.chainMode, 'simulated-fixture');

  const early = await action('prepare-purchase');
  assert.equal(early.ok, false);
  assert.match(early.error, /Sign in first/);
  assert.equal((await action('no-such-action')).ok, false);
});

test('dashboard sign-in starts the normal OAuth authorization-code + PKCE flow on the same origin', async () => {
  const out = await action('sign-in');
  assert.equal(out.ok, true, out.error);
  assert.equal(out.state.signIn.status, 'redirected');
  const url = new URL(out.state.signIn.authorizationUrl);
  assert.equal(url.origin, h.origin);
  assert.equal(url.searchParams.get('redirect_uri'), `${h.origin}/tester/oauth/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  const again = await action('sign-in');
  assert.equal(again.state.signIn.authorizationUrl, out.state.signIn.authorizationUrl, 'a repeat keeps the pending sign-in');
  // A declined portal returns an error to the callback: nothing is linked.
  const cb = await fetch(`${h.origin}/tester/oauth/callback?error=access_denied`, { redirect: 'manual' });
  assert.equal(cb.status, 303);
  const after = await (await fetch(`${h.origin}/tester/api/state`)).json();
  assert.equal(after.signIn.status, 'declined');
  assert.deepEqual(after.signIn.wallets, []);
});

test('checklist marks are tester-marked only and validated', async () => {
  assert.equal((await action('checklist', { item: 'backup', done: true })).state.checklist.backup, true);
  assert.equal((await action('checklist', { item: 'vault', done: true })).ok, false);
});

test('feedback export carries only allowlisted statuses, ticks and the typed note', () => {
  const state = {
    signIn: { status: 'signed_in', wallets: [`0x${'a'.repeat(64)}`], authorizationUrl: 'http://127.0.0.1:1/oauth?code=SECRETCODE' },
    listing: { discovery: { found: true }, verification: { transactable: true } },
    purchase: { status: 'settled_verified', approvalUrl: 'http://127.0.0.1:1/portal/p#t=HANDOFF', idempotencyKey: 'tester-buy-KEY', receipt: { txHash: 'f'.repeat(64), payer: `0x${'a'.repeat(64)}` } },
    identity: { add: { status: 'association_observed', portalUrl: 'http://x/#t=ID' }, remove: null, observed: { status: 'observed', githubHandles: ['someone'] } },
    checklist: Object.fromEntries(CHECKLIST_ITEMS.map((k) => [k, k === 'lock'])),
  };
  const out = buildFeedbackExport(state, { feedback: 'x'.repeat(3000), app: { name: 'pkg', version: '0.1.0' } });
  assert.deepEqual(Object.keys(out).sort(), ['app', 'createdAt', 'feedback', 'format', 'kind', 'notice', 'observed', 'testerMarked']);
  assert.equal(out.feedback.length, 2000);
  assert.equal(out.observed.purchase, 'settled_verified');
  assert.equal(out.observed.receipt, 'simulated_receipt_observed');
  assert.equal(out.testerMarked.lock, true);
  assert.equal(out.app.evidence, 'simulated-fixture');
  assert.doesNotMatch(JSON.stringify(out), /SECRETCODE|HANDOFF|tester-buy-KEY|aaaaaaaa|ffffffff|someone|http/);
});

test('error text is bounded and elides portal capabilities, codes and bearer values', () => {
  const m = safeMessage(new Error('failed at http://127.0.0.1:1/portal/x#t=abc.def?code=XYZ&state=S Bearer eyJ.secret\nstack'));
  assert.doesNotMatch(m, /abc\.def|XYZ|eyJ|stack/);
  assert.ok(safeMessage('y'.repeat(1000)).length <= 300);
});

test('a tool error shows its code and decoded reason inside the bounded error text', () => {
  const reason = 'a purchase is already open for this listing; finish or cancel it first';
  const result = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'purchase_start_limit', message: sellerData(reason) }) }] };
  assert.equal(toolErrorMessage(result), `purchase_start_limit: ${reason}`);
  assert.equal(safeMessage(new Error(`get_account_status: ${toolErrorMessage(result)}`)).includes(reason), true);
  const incomplete = { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'x', message: { label: 'l', text: 'cut', truncated: true } }) }] };
  assert.equal(toolErrorMessage(incomplete), incomplete.content[0].text);
  assert.equal(toolErrorMessage({ isError: true, content: [{ type: 'text', text: 'plain failure' }] }), 'plain failure');
});

test('GitHub handles are read from the bounded raw node answer only', () => {
  const raw = { json: JSON.stringify({ response: { web2: { github: [{ username: 'dash-tester' }, { username: '<bad>' }] } } }) };
  assert.deepEqual(githubHandles({ raw }), ['dash-tester']);
  assert.deepEqual(githubHandles({ raw: { json: '{' } }), []);
  assert.deepEqual(githubHandles(null), []);
});

test('CLI: dashboard on by default and printed; --no-dashboard turns it off; parseArgs keeps the tester origins', async () => {
  assert.equal(parseArgs([]).dashboard, true);
  assert.equal(parseArgs(['--no-dashboard']).dashboard, false);
  assert.deepEqual(parseArgs([]).redirectOrigins, ['http://localhost:6274']);
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    const deadline = Date.now() + 20_000;
    const poll = async () => {
      while (!/Press Ctrl-C|\}\n/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const result = { out };
      child.kill('SIGTERM');
      result.code = await exited;
      result.err = err;
      return result;
    };
    poll().then(resolve, reject);
  });
  const text = await run([]);
  const line = text.out.split('\n').find((l) => l.startsWith('Tester dashboard:'));
  assert.match(line ?? '', /^Tester dashboard:\s+http:\/\/127\.0\.0\.1:\d+\/tester\/ /);
  assert.equal(text.code, 0, text.err);
  assert.doesNotMatch(text.out + text.err, /cookie|secret|private|mnemonic/i);
  const json = JSON.parse((await run(['--json', '--no-dashboard'])).out.split('\n')[0]);
  assert.equal(json.dashboard, undefined);
  assert.equal(JSON.parse((await run(['--json'])).out.split('\n')[0]).dashboard.endsWith('/tester/'), true);
});

test('the production app never references the dashboard', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  for (const file of [...walk(join(root, 'src')), join(root, 'bin', 'dacs-chatgpt-plugin.mjs')]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /tester-dashboard|\/tester\//, file);
  }
});

test('retired seller actions and callback cannot start an OAuth flow', async () => {
  const before = await (await fetch(`${h.origin}/tester/api/state`)).json();
  for (const name of ['seller-sign-in', 'seller-restart-sign-in', 'seller-refresh-account', 'seller-start-over']) {
    const response = await post('/tester/api/action', { action: name });
    assert.equal(response.status, 400, name);
    assert.match((await response.json()).error, /unknown action|retired/);
  }
  assert.equal((await fetch(`${h.origin}/tester/oauth/seller-callback?code=TEST`, { redirect: 'manual' })).status, 404);
  const after = await (await fetch(`${h.origin}/tester/api/state`)).json();
  assert.deepEqual(after.seller, before.seller);
  const html = await (await fetch(h.dashboardUrl)).text();
  assert.doesNotMatch(html, /id="seller"|data-action="seller-/);
});

test('no browser test drives the retired seller dashboard controls', () => {
  const dir = join(root, 'test', 'browser');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    assert.doesNotMatch(readFileSync(join(dir, name), 'utf8'), /role: 'seller'|#seller-|Open publication approval in the portal/, name);
  }
});
