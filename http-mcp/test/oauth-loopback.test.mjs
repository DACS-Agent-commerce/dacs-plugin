import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { auth, discoverAuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { decodeJwt } from 'jose';
import { startHarness, CALLBACK_ORIGIN, CALLBACK_URL } from './helpers/harness.mjs';
import { TestOAuthProvider, completeAuthorizationInBrowser } from './helpers/oauth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

let off, offLocal, on, metadata;
before(async () => {
  const env = { DACS_ALLOWED_REDIRECT_ORIGINS: 'https://chatgpt.com' };
  off = await startHarness({ env });
  offLocal = await startHarness({ env: { DACS_ALLOWED_REDIRECT_ORIGINS: `https://chatgpt.com,${CALLBACK_ORIGIN}` } });
  on = await startHarness({ env: { ...env, DACS_ALLOWED_REDIRECT_ORIGINS: `https://chatgpt.com,${CALLBACK_ORIGIN}`, DACS_ALLOW_LOOPBACK_REDIRECTS: '1' } });
  metadata = await discoverAuthorizationServerMetadata(`${on.origin}/oauth`);
});
after(async () => { await off?.close(); await offLocal?.close(); await on?.close(); });

async function register(h, uri, applicationType = 'native', extra = {}) {
  const response = await fetch(`${h.origin}/oauth/reg`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ application_type: applicationType, redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

async function refused(h, uri, applicationType = 'native', extra = {}) {
  const result = await register(h, uri, applicationType, extra);
  assert.equal(result.status, 400, uri);
  assert.ok(['invalid_redirect_uri', 'invalid_client_metadata'].includes(result.body.error), `${uri}: ${result.body.error}`);
}

async function finish(provider) {
  const scope = 'dacs.account.read';
  assert.equal(await auth(provider, { serverUrl: on.mcpUrl, scope }), 'REDIRECT');
  // The SDK adds offline_access; exercise the existing session-bound rule.
  provider.authorizationUrl.searchParams.set('scope', scope);
  assert.equal(provider.authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  const callback = await completeAuthorizationInBrowser({ authorizationUrl: provider.authorizationUrl, wallet: createEphemeralWallet(), origin: on.origin, callbackUrl: provider.redirectUrl });
  assert.equal(callback.searchParams.get('iss'), metadata.issuer);
  assert.equal(callback.view.scopes.some((s) => s.scope === 'offline_access'), false);
  assert.match(callback.view.clientNote, /^Unverified local app/);
  assert.equal(await auth(provider, { serverUrl: on.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope }), 'AUTHORIZED');
  assert.equal(decodeJwt(provider.tokens().access_token).aud, on.mcpUrl);
  assert.equal(decodeJwt(provider.tokens().access_token).scope, scope);
  return callback;
}

const refresh = (provider, token) => fetch(metadata.token_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: provider.clientInformation().client_id, resource: on.mcpUrl }),
});

test('default-off refuses native and web loopback registrations outside the allowlist', async () => {
  assert.equal(off.config.allowLoopbackRedirects, false);
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    for (const type of ['native', 'web']) await refused(off, `http://${host}:49152/callback`, type);
  }
  assert.equal((await register(off, 'https://chatgpt.com/callback', 'web')).status, 201);
});

test('default-off holds a native client on an http loopback allowlist entry to its exact callback', async () => {
  // oidc-provider alone would let any port through for a native loopback
  // redirect; with the switch off its runtime matcher is main's exact one.
  assert.equal(offLocal.config.allowLoopbackRedirects, false);
  for (const type of ['native', 'web']) assert.equal((await register(offLocal, CALLBACK_URL, type)).status, 201, type);
  const scope = 'dacs.account.read';
  const provider = new TestOAuthProvider({ scope, applicationType: 'native' });
  assert.equal(await auth(provider, { serverUrl: offLocal.mcpUrl, scope }), 'REDIRECT');
  assert.equal(provider.clientInformation().application_type, 'native');
  provider.authorizationUrl.searchParams.set('scope', scope);
  const moved = new URL(provider.authorizationUrl);
  moved.searchParams.set('redirect_uri', CALLBACK_URL.replace(CALLBACK_ORIGIN, 'http://127.0.0.1:49152'));
  const response = await fetch(moved, { redirect: 'manual' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null, 'invalid callbacks must never receive an error redirect');
  await response.body?.cancel();
  const callback = await completeAuthorizationInBrowser({ authorizationUrl: provider.authorizationUrl, wallet: createEphemeralWallet(), origin: offLocal.origin });
  assert.equal(callback.view.clientNote, undefined, 'the consent page is unchanged while the switch is off');
  assert.equal(await auth(provider, { serverUrl: offLocal.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope }), 'AUTHORIZED');
});

test('control characters, spaces and backslashes are refused before URL parsing', async () => {
  for (const uri of ['http://127.0.0.1/cb\r\nX-Injected: 1', 'http://127.0.0.1/c b', 'http://127.0.0.1/cb\t', 'http://127.0.0.1\\evil.com/cb', 'http://localhost/cb\x7f']) await refused(on, uri);
  await refused(on, 'https://chatgpt.com/cb\r\n', 'web');
});

for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
  test(`enabled native ${host} completes DCR, PKCE and session-bound refresh`, async () => {
    const provider = new TestOAuthProvider({ scope: 'dacs.account.read', redirectUrl: `http://${host}:49152/callback`, applicationType: 'native' });
    await finish(provider);
    assert.equal(provider.clientInformation().application_type, 'native');
    const tokens = provider.tokens();
    assert.ok(tokens.refresh_token);
    const issued = await on.app.authServer.provider.RefreshToken.find(tokens.refresh_token);
    assert.equal(issued.expiresWithSession, true);
    assert.ok(issued.sessionUid);
    const response = await refresh(provider, tokens.refresh_token), next = await response.json();
    assert.equal(response.status, 200, next.error);
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal(decodeJwt(next.access_token).sub, decodeJwt(tokens.access_token).sub);
    assert.equal(decodeJwt(next.access_token).aud, on.mcpUrl);
    const rotated = await on.app.authServer.provider.RefreshToken.find(next.refresh_token);
    assert.equal(rotated.expiresWithSession, true);
    assert.equal(rotated.sessionUid, issued.sessionUid);
    const changed = on.app.db.prepare("UPDATE oidc_models SET expires_at=? WHERE model='Session' AND uid=?").run(Math.floor(Date.now() / 1000) - 1, issued.sessionUid).changes;
    assert.equal(changed, 1);
    const expired = await refresh(provider, next.refresh_token);
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error, 'invalid_grant');
  });

  test(`native ${host} may use another port on its registered callback`, async () => {
    const registration = await register(on, `http://${host}:49152/another/path?client=test`);
    assert.equal(registration.status, 201, registration.body.error);
    const provider = new TestOAuthProvider({ scope: 'dacs.account.read', redirectUrl: `http://${host}:49153/another/path?client=test`, applicationType: 'native' });
    provider.saveClientInformation({ ...registration.body, issuer: metadata.issuer });
    const callback = await finish(provider);
    assert.equal(callback.port, '49153');
    assert.equal(callback.pathname, '/another/path');
    assert.equal(callback.searchParams.get('client'), 'test');
    for (const uri of [`http://${host}:49153/different`, 'http://127.1:49153/another/path?client=test', 'http://user@127.0.0.1:49153/another/path?client=test']) {
      const url = new URL(provider.authorizationUrl);
      url.searchParams.set('redirect_uri', uri);
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, 400, uri);
      assert.equal(response.headers.get('location'), null, 'invalid callbacks must never receive an error redirect');
      await response.body?.cancel();
    }
  });
}

test('enabled native registrations allow any path and omitted or arbitrary valid ports', async () => {
  for (const uri of ['http://127.0.0.1/', 'http://[::1]/', 'http://localhost/a/b?x=y', 'http://127.0.0.1:65535/other', 'http://localhost:0/callback']) {
    const result = await register(on, uri);
    assert.equal(result.status, 201, `${uri}: ${result.body.error}`);
  }
});

test('enabled native registrations keep the DCR canonical-form rules', async () => {
  // As for allowlisted redirects: exactly the form URL serializes, no dot
  // segments, stable query bytes and none of the response parameter keys.
  for (const uri of ['http://127.0.0.1', 'http://localhost:80/a/b?x=y', 'http://127.0.0.1:049152/callback', 'http://localhost:49152/a/../callback', 'http://localhost:49152/callback?', 'http://localhost:49152/callback?q=a%20b', 'http://127.0.0.1:49152/callback?code=x', 'http://[::1]:49152/callback?state=x']) await refused(on, uri);
});

test('enabled keeps logout redirects on the exact allowlist, native clients included', async () => {
  await refused(on, 'http://127.0.0.1:49152/callback', 'native', { post_logout_redirect_uris: ['http://127.0.0.1:49152/callback'] });
  const registration = await register(on, 'http://127.0.0.1:49152/callback', 'native', { post_logout_redirect_uris: [CALLBACK_URL] });
  assert.equal(registration.status, 201, registration.body.error);
  const { end_session_endpoint: endSession } = await (await fetch(`${on.origin}/oauth/.well-known/openid-configuration`)).json();
  for (const uri of [CALLBACK_URL.replace(CALLBACK_ORIGIN, 'http://127.0.0.1:49152'), 'http://127.0.0.1:49152/callback']) {
    const url = new URL(endSession);
    url.search = new URLSearchParams({ client_id: registration.body.client_id, post_logout_redirect_uri: uri });
    const response = await fetch(url, { redirect: 'manual' });
    assert.equal(response.status, 400, uri);
    assert.equal(response.headers.get('location'), null, uri);
    await response.body?.cancel();
  }
});

for (const host of ['localhost.evil.com', '127.0.0.1.evil.com', '127.1', '2130706433', '0x7f000001', '127.0.0.01', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', 'localhost.', '%6cocalhost', '[0:0:0:0:0:0:0:1]']) {
  test(`enabled refuses look-alike host ${host}`, async () => refused(on, `http://${host}:49152/callback`));
}

test('enabled refuses fragments, userinfo, invalid ports and non-loopback HTTP', async () => {
  for (const uri of ['http://127.0.0.1:49152/callback#fragment', 'http://localhost:49152/callback#', `http://${['user', 'pass'].join(':')}@127.0.0.1:49152/callback`, 'http://@localhost:49152/callback', 'http://127.0.0.1:65536/callback', 'http://other.example/callback', 'http://198.51.100.1:49152/callback']) await refused(on, uri);
});

test('enabled keeps web clients on the exact origin allowlist', async () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) await refused(on, `http://${host}:49152/callback`, 'web');
  await refused(on, 'http://other.example/callback', 'web');
  await refused(on, 'https://chatgpt.com:444/callback', 'web');
  assert.equal((await register(on, 'https://chatgpt.com/callback', 'web')).status, 201);
  assert.equal((await register(on, CALLBACK_URL, 'web')).status, 201);
  await refused(on, 'http://127.1:65531/callback');
});
