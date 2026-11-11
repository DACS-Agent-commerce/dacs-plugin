// Sign-in callback matching with DACS_ALLOW_LOOPBACK_REDIRECTS: only a native
// client that registered through dynamic client registration may change the
// port of a registered loopback callback. A client identified by a metadata
// document URL keeps an exact match, on a first fetch and from the cache.
//
// This drives createAuthorizationServer directly on an in-memory store, so it
// needs no app harness. The metadata document is served from a local server
// through the provider's own fetch hook; the real resolve and cache code run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import instance from '../node_modules/oidc-provider/lib/helpers/weak_cache.js';
import { createAuthorizationServer } from '../src/auth/authorization-server.mjs';
import { openDatabase } from '../src/store/database.mjs';

const CLIENT_ID = 'https://chatgpt.com/oauth/loopback-client.json';
const CALLBACK_ORIGIN = 'http://127.0.0.1:65531';
const CALLBACK_URL = `${CALLBACK_ORIGIN}/oauth/callback`;
const MOVED = CALLBACK_URL.replace(CALLBACK_ORIGIN, 'http://127.0.0.1:49152');
const CHALLENGE = createHash('sha256').update('a'.repeat(43)).digest('base64url');

// One provider on a local port. `document` is what the metadata document says;
// `state.calls` counts fetches of it.
async function start(t, { loopback, document = {} }) {
  const state = { calls: 0 };
  const documentServer = http.createServer((_req, res) => {
    state.calls += 1;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=60' });
    res.end(JSON.stringify({
      client_id: CLIENT_ID, application_type: 'native', redirect_uris: [CALLBACK_URL], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...document,
    }));
  });
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await Promise.all([documentServer, server].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
  t.after(() => Promise.all([documentServer, server].map((s) => { s.closeAllConnections(); return new Promise((resolve) => s.close(resolve)); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const authServer = await createAuthorizationServer({
    config: {
      mcpUrl: `${origin}/mcp`, builtinIssuer: origin, publicOrigin: origin, cookieKeys: ['test-cookie-key'], trustProxy: false,
      accessTokenTtlSeconds: 600, cimdAllowedHosts: ['chatgpt.com'], allowedRedirectOrigins: ['https://chatgpt.com', CALLBACK_ORIGIN],
      allowLoopbackRedirects: loopback,
    },
    db,
    accounts: { getAccount: () => undefined, listWallets: () => [] },
  });
  handler = authServer.callback;
  instance(authServer.provider).configuration.fetch = async (url, { dispatcher: _dispatcher, ...options }) => {
    assert.equal(String(url), CLIENT_ID, 'unexpected outbound URL refused');
    return fetch(`http://127.0.0.1:${documentServer.address().port}/client.json`, options);
  };
  return { origin, state, provider: authServer.provider, find: (id = CLIENT_ID) => authServer.provider.Client.find(id) };
}

async function register(f, uri, applicationType = 'native', extra = {}) {
  const response = await fetch(`${f.origin}/reg`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ application_type: applicationType, redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

async function authorizeAt(f, clientId, redirectUri) {
  const url = new URL(`${f.origin}/auth`);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
    resource: `${f.origin}/mcp`, state: 'loopback-state', code_challenge: CHALLENGE, code_challenge_method: 'S256',
  });
  const response = await fetch(url, { redirect: 'manual' });
  await response.body?.cancel();
  return { status: response.status, location: response.headers.get('location') };
}

async function logoutTo(f, clientId, uri) {
  const url = new URL(`${f.origin}/session/end`);
  url.search = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: uri });
  const response = await fetch(url, { redirect: 'manual' });
  await response.body?.cancel();
  return { status: response.status, location: response.headers.get('location') };
}

const assertRefused = (result, label) => {
  assert.equal(result.status, 400, label);
  assert.equal(result.location, null, `${label}: invalid callbacks must never receive an error redirect`);
};
const assertAccepted = (result, label) => {
  assert.equal(result.status, 303, label);
  assert.match(result.location, /^\/portal\/authorize\//, label);
};

test('enabled holds a metadata-document client that declares itself native to its registered callback port', async (t) => {
  const f = await start(t, { loopback: true });
  assertRefused(await authorizeAt(f, CLIENT_ID, MOVED), 'another port on a fresh fetch');
  assertAccepted(await authorizeAt(f, CLIENT_ID, CALLBACK_URL), 'the registered callback');
});

test('enabled keeps a metadata-document client exact after a cached re-resolve', async (t) => {
  const f = await start(t, { loopback: true });
  assertAccepted(await authorizeAt(f, CLIENT_ID, CALLBACK_URL), 'the registered callback');
  assert.equal(f.state.calls, 1);
  assertRefused(await authorizeAt(f, CLIENT_ID, MOVED), 'another port from the cache');
  const client = await f.find();
  assert.equal(f.state.calls, 1, 'both later resolves came from the cache');
  assert.equal(client.clientIdMetadataDocument, true);
  assert.equal(client.redirectUriAllowed(CALLBACK_URL), true);
  assert.equal(client.redirectUriAllowed(MOVED), false);
});

test('enabled treats a metadata-document client as the switch-off matcher does, off the origin allowlist too', async (t) => {
  const f = await start(t, { loopback: true, document: { redirect_uris: ['http://127.0.0.1:49153/cb'] } });
  const client = await f.find();
  // Exact means the registered URI on an allowlisted origin: neither its own
  // port, which is not on the allowlist, nor any other port is accepted.
  for (const uri of ['http://127.0.0.1:49153/cb', 'http://127.0.0.1:49154/cb', 'http://127.0.0.1:49152/cb', `${CALLBACK_ORIGIN}/cb`]) assert.equal(client.redirectUriAllowed(uri), false, uri);
});

test('enabled refuses a logout redirect on another port for a metadata-document client', async (t) => {
  const f = await start(t, { loopback: true, document: { post_logout_redirect_uris: [CALLBACK_URL] } });
  assertRefused(await logoutTo(f, CLIENT_ID, MOVED), 'another port');
});

test('enabled lets a dynamically registered native loopback client change only its port', async (t) => {
  const f = await start(t, { loopback: true });
  const registration = await register(f, 'http://127.0.0.1:49152/cb?x=1');
  assert.equal(registration.status, 201, registration.body.error);
  const id = registration.body.client_id;
  assertAccepted(await authorizeAt(f, id, 'http://127.0.0.1:49152/cb?x=1'), 'the registered callback');
  assertAccepted(await authorizeAt(f, id, 'http://127.0.0.1:49999/cb?x=1'), 'another port');
  for (const uri of ['http://localhost:49999/cb?x=1', 'http://127.0.0.1:49999/other?x=1', 'http://127.0.0.1:49999/cb?x=2', 'http://127.0.0.1:49999/cb']) {
    assertRefused(await authorizeAt(f, id, uri), uri);
  }
  // Every later resolve, from the provider's client cache, matches the same way.
  for (let i = 0; i < 2; i += 1) {
    const client = await f.find(id);
    assert.equal(client.clientIdMetadataDocument, undefined);
    assert.equal(client.redirectUriAllowed('http://127.0.0.1:49999/cb?x=1'), true);
    assert.equal(client.redirectUriAllowed('http://127.0.0.1:49999/cb?x=2'), false);
  }
});

test('enabled keeps a native client with no loopback callback on its exact callbacks', async (t) => {
  const f = await start(t, { loopback: true });
  const registration = await register(f, 'https://chatgpt.com/callback');
  assert.equal(registration.status, 201, registration.body.error);
  const id = registration.body.client_id;
  assertAccepted(await authorizeAt(f, id, 'https://chatgpt.com/callback'), 'the registered callback');
  assertRefused(await authorizeAt(f, id, 'http://127.0.0.1:49152/cb'), 'a loopback callback it never registered');
  assertRefused(await authorizeAt(f, id, CALLBACK_URL), 'an allowlisted loopback callback it never registered');
});

test('enabled refuses a logout redirect on another port for a dynamically registered native client', async (t) => {
  const f = await start(t, { loopback: true });
  const registration = await register(f, 'http://127.0.0.1:49152/cb', 'native', { post_logout_redirect_uris: [CALLBACK_URL] });
  assert.equal(registration.status, 201, registration.body.error);
  assertRefused(await logoutTo(f, registration.body.client_id, MOVED), 'another port');
});

test('default-off gives a metadata-document client an exact match', async (t) => {
  const f = await start(t, { loopback: false });
  assertRefused(await authorizeAt(f, CLIENT_ID, MOVED), 'another port');
  assertAccepted(await authorizeAt(f, CLIENT_ID, CALLBACK_URL), 'the registered callback');
});

test('default-off gives a dynamically registered native client an exact match', async (t) => {
  const f = await start(t, { loopback: false });
  const registration = await register(f, CALLBACK_URL);
  assert.equal(registration.status, 201, registration.body.error);
  assertAccepted(await authorizeAt(f, registration.body.client_id, CALLBACK_URL), 'the registered callback');
  assertRefused(await authorizeAt(f, registration.body.client_id, MOVED), 'another port');
});
