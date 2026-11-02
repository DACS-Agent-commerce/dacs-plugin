// Loopback-only investigation of oidc-provider's shared CIMD fetch. The real
// plugin/authorization endpoint runs unchanged; only this provider's outbound
// transport maps the HTTPS client id to HTTP loopback and removes its SSRF
// dispatcher. The real fetch, abort signal, body reader and pending/cache code
// still run. No request is allowed to leave loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeJwt } from 'jose';
import instance from '../node_modules/oidc-provider/lib/helpers/weak_cache.js';
import { startHarness, CALLBACK_URL } from './helpers/harness.mjs';
import { completeAuthorizationInBrowser } from './helpers/oauth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

async function fixture(t, mode = 'ok') {
  const state = { mode, calls: 0, responses: [], headersReceived: 0 };
  const document = {
    client_id: CLIENT_ID,
    client_name: 'Loopback CIMD client',
    redirect_uris: [CALLBACK_URL],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  const send = (res) => res.end(JSON.stringify(document));
  const server = http.createServer((_req, res) => {
    state.calls += 1;
    state.responses.push(res);
    if (state.mode === 'headers-once') {
      state.mode = 'ok';
      return;
    }
    if (state.mode === 'headers') return;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=30' });
    if (state.mode === 'body') {
      res.flushHeaders();
      res.write('{');
      return;
    }
    if (state.mode === 'release') {
      res.flushHeaders();
      return;
    }
    send(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const h = await startHarness();
  t.after(() => h.close());
  const configuration = instance(h.app.authServer.provider).configuration;
  configuration.fetch = async (url, { dispatcher: _dispatcher, ...options }) => {
    assert.equal(String(url), CLIENT_ID, 'unexpected outbound URL refused');
    // Do not retain the original signal in the fixture after headers arrive;
    // its lifetime during body reading should match the production transport.
    assert.ok(options.signal instanceof AbortSignal);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/client.json`, options);
    state.headersReceived += 1;
    return response;
  };
  const url = new URL(`${h.origin}/oauth/auth`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: CALLBACK_URL, response_type: 'code',
    scope: 'dacs.account.read', resource: h.mcpUrl, state: 'loopback-state',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  }).toString();
  return { h, state, url, release: () => send(state.responses.at(-1)) };
}

async function authorize(f, { signal = AbortSignal.timeout(9000) } = {}) {
  const started = performance.now();
  const response = await fetch(f.url, {
    redirect: 'manual', signal,
  });
  const body = await response.text();
  return { response, body, ms: performance.now() - started };
}

async function received(f, calls = 1) {
  const deadline = performance.now() + 2000;
  while (f.state.calls < calls && performance.now() < deadline) await delay(10);
  assert.equal(f.state.calls, calls, 'loopback document request arrived');
}

function failed(t, result, label, { min = 4700, max = 7000 } = {}) {
  assert.equal(result.response.status, 400);
  assert.match(result.body, /Authorization failed: invalid_client/);
  assert.equal(result.response.headers.get('location'), null);
  assert.ok(result.ms >= min && result.ms < max, `${label}: ${result.ms} ms`);
  t.diagnostic(`${label}: HTTP 400 invalid_client in ${Math.round(result.ms)} ms`);
}

function succeeded(result) {
  assert.equal(result.response.status, 303);
  assert.match(result.response.headers.get('location'), /^\/portal\/authorize\//);
}

function noSession(f) {
  assert.equal(f.h.app.db.prepare('SELECT count(*) AS n FROM oidc_models').get().n, 0,
    'failed fresh authorization persisted no session, interaction, grant or token');
}

for (const mode of ['headers', 'body']) {
  test(`CIMD never finishes ${mode}: abort covers the wait and the next sign-in recovers`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, mode);
    failed(t, await authorize(f), mode);
    assert.equal(f.state.calls, 2, 'initial lookup plus the existing error-handler lookup');
    assert.equal(f.state.headersReceived, mode === 'body' ? 2 : 0, 'locate the stall before headers or during body reading');
    noSession(f);
    f.state.mode = 'ok';
    succeeded(await authorize(f));
    assert.equal(f.state.calls, 3, 'a new lookup replaces the failed pending request');
    succeeded(await authorize(f));
    assert.equal(f.state.calls, 3, 'successful metadata is cached');
  });
}

test('CIMD body stalls once then recovers before timeout, including a concurrent sign-in', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 'release');
  const first = authorize(f);
  await received(f);
  const second = authorize(f);
  await delay(200);
  assert.equal(f.state.calls, 1, 'both requests share the pending fetch');
  f.release();
  const results = await Promise.all([first, second]);
  results.forEach(succeeded);
  assert.equal(f.state.calls, 1);
  t.diagnostic(`released body: both sign-ins reached the portal in ${results.map((r) => Math.round(r.ms)).join(', ')} ms`);
});

test('a later sign-in shares the pending fetch deadline and recovery needs no restart', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 'body');
  const first = authorize(f);
  await received(f);
  await delay(500);
  const second = authorize(f);
  const results = await Promise.all([first, second]);
  failed(t, results[0], 'first sign-in');
  failed(t, results[1], 'later sign-in', { min: 3900, max: 6500 });
  assert.equal(f.state.calls, 2, 'both initial and error-handler lookups are shared');
  noSession(f);
  f.state.mode = 'ok';
  succeeded(await authorize(f));
  assert.equal(f.state.calls, 3);
});

test('expired CIMD cache refresh times out, clears pending, and refreshes on the next sign-in', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  succeeded(await authorize(f));
  succeeded(await authorize(f));
  assert.equal(f.state.calls, 1);
  // Date only: the real fetch/AbortSignal timers and duration clock remain real.
  const expiredNow = Date.now() + 31000;
  t.mock.method(Date, 'now', () => expiredNow);
  f.state.mode = 'body';
  failed(t, await authorize(f), 'cache refresh');
  assert.equal(f.state.calls, 3);
  f.state.mode = 'ok';
  succeeded(await authorize(f));
  succeeded(await authorize(f));
  assert.equal(f.state.calls, 4);
});

test('disconnecting an authorization request does not poison its shared metadata fetch', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 'headers');
  // The canceled request carries markers in its query (first, so the logger's
  // 200-character truncation cannot hide a leaked URL) and credential headers.
  const marker = 'PRIVATE-DISCONNECT-TEST-MARKER';
  const params = new URLSearchParams(f.url.search);
  params.delete('state');
  const canceled = new URL(f.url);
  canceled.search = `state=${marker}&${params}`;
  const controller = new AbortController();
  const first = fetch(canceled, {
    redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${marker}`, cookie: `test_cookie=${marker}` },
  });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await received(f);
  controller.abort();
  await rejected;
  const deadline = performance.now() + 1000;
  while (!f.h.logs.some((line) => JSON.parse(line).phase === 'disconnected') && performance.now() < deadline) await delay(10);
  const entries = f.h.logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'oauth_auth_request' && entry.request === 1);
  const disconnect = entries.find((entry) => entry.phase === 'disconnected');
  assert.ok(disconnect, 'a disconnected authorization is visible without a finish access log');
  assert.equal(disconnect.status, undefined, 'disconnect does not claim an HTTP response status');
  assert.deepEqual(Object.keys(disconnect).sort(), ['at', 'event', 'level', 'ms', 'phase', 'request'], 'disconnect logs only its fixed fields');
  assert.ok(Number.isFinite(disconnect.ms) && disconnect.ms >= 0, `disconnect duration: ${disconnect.ms}`);
  const arrival = entries.find((entry) => entry.phase === 'received');
  assert.deepEqual(Object.keys(arrival).sort(), ['at', 'event', 'level', 'method', 'phase', 'request'], 'arrival logs only its fixed fields');
  failed(t, await authorize(f), 'sign-in after disconnect');
  assert.equal(f.state.calls, 2);
  noSession(f);
  f.state.mode = 'ok';
  succeeded(await authorize(f));
  assert.equal(f.state.calls, 3);
  // Checked last, after the canceled request's provider lookups and error handling have settled.
  assert.equal(f.h.logs.join('\n').includes(marker), false, 'no log line copies the canceled request');
});

test('a stalled event loop delays the abort but it settles on resumption and later sign-ins recover', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 'body');
  const first = authorize(f);
  await received(f);
  // Model a suspension of JavaScript timers, not macOS sleep or a dead process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3200);
  failed(t, await first, 'stalled event loop', { min: 5500, max: 8000 });
  noSession(f);
  f.state.mode = 'ok';
  succeeded(await authorize(f));
  assert.equal(f.state.calls, 3);
});

test('one metadata lookup aborts in 2.5 seconds and a fresh lookup can recover', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 'body');
  const started = performance.now();
  await assert.rejects(f.h.app.authServer.provider.Client.find(CLIENT_ID), (error) => {
    assert.equal(error.error, 'invalid_client');
    assert.ok(['AbortError', 'TimeoutError'].includes(error.cause.name));
    return true;
  });
  const ms = performance.now() - started;
  assert.ok(ms >= 2200 && ms < 4500, `lookup: ${ms} ms`);
  t.diagnostic(`single lookup: invalid_client in ${Math.round(ms)} ms; body aborted`);
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.headersReceived, 1, 'the timeout interrupted body reading after headers');
  noSession(f);
  f.state.mode = 'ok';
  assert.ok(await f.h.app.authServer.provider.Client.find(CLIENT_ID));
  assert.equal(f.state.calls, 2);
});

test('remote host recovers for the existing error-handler lookup; next sign-in uses its cache', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, 'headers-once');
  const result = await authorize(f);
  assert.equal(result.response.status, 303);
  const location = new URL(result.response.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK_URL);
  assert.equal(location.searchParams.get('error'), 'invalid_client');
  assert.equal(location.searchParams.has('code'), false);
  assert.ok(result.ms >= 2200 && result.ms < 4500);
  t.diagnostic(`stall once: redirect with invalid_client in ${Math.round(result.ms)} ms`);
  assert.equal(f.state.calls, 2);
  noSession(f);
  succeeded(await authorize(f));
  assert.equal(f.state.calls, 2);
});

test('normal CIMD sign-in completes wallet interaction, session, code exchange and refresh', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const callback = await completeAuthorizationInBrowser({ authorizationUrl: f.url, wallet: createEphemeralWallet(), origin: f.h.origin });
  assert.equal(callback.searchParams.get('state'), 'loopback-state');
  assert.equal(callback.searchParams.get('iss'), `${f.h.origin}/oauth`);
  const exchange = await fetch(`${f.h.origin}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'),
      client_id: CLIENT_ID, redirect_uri: CALLBACK_URL, code_verifier: VERIFIER, resource: f.h.mcpUrl }),
    signal: AbortSignal.timeout(9000),
  });
  const tokens = await exchange.json();
  assert.equal(exchange.status, 200, tokens.error);
  assert.ok(tokens.refresh_token);
  const claims = decodeJwt(tokens.access_token);
  assert.equal(claims.aud, f.h.mcpUrl);
  assert.ok(f.h.app.services.accounts.getAccount(claims.sub));
  const refreshed = await fetch(`${f.h.origin}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID, resource: f.h.mcpUrl }),
    signal: AbortSignal.timeout(9000),
  });
  const rotated = await refreshed.json();
  assert.equal(refreshed.status, 200, rotated.error);
  assert.equal(decodeJwt(rotated.access_token).sub, claims.sub);
  assert.equal(f.state.calls, 1, 'authorization, portal, resume and token lookups share the cache');
});
