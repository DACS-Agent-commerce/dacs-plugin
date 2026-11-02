// OAuth 2.1 account linking against the built-in authorization server, driven
// by the official MCP client SDK. Credentials are ephemeral fixtures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, auth, refreshAuthorization, discoverAuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { SignJWT, importJWK, decodeJwt, decodeProtectedHeader } from 'jose';
import { startHarness, CALLBACK_URL } from './helpers/harness.mjs';
import { linkAccount, TestOAuthProvider, completeAuthorizationInBrowser } from './helpers/oauth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => h.close());

async function mcpWith(provider) {
  const client = new Client({ name: 'oauth-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl), { authProvider: provider }));
  return client;
}

async function rawCall(token, name, args = {}) {
  const res = await fetch(h.mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = text.startsWith('event:') ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5)) : text ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, data };
}

async function serverKey() {
  const row = h.app.db.prepare('SELECT value FROM secrets WHERE name = ?').get('oauth-signing-jwk');
  const jwk = JSON.parse(row.value);
  return { key: await importJWK(jwk, 'ES256'), kid: jwk.kid };
}

test('full DCR + PKCE S256 + resource indicator flow issues an audience-bound JWT', async () => {
  const wallet = createEphemeralWallet();
  const { provider, callback, iss } = await linkAccount({ harness: h, wallet }).catch((error) => {
    console.error(h.logs.filter((l) => l.includes('oauth_interaction')).join('\n'));
    throw error;
  });
  assert.equal(iss, `${h.origin}/oauth`, 'RFC 9207 iss returned on the authorization response');
  const authUrl = provider.authorizationUrl;
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('resource'), h.mcpUrl);
  assert.ok(callback.view.scopes.some((s) => s.scope === 'dacs.purchases.write'));
  assert.equal(callback.view.clientNote, undefined);
  assert.match(callback.challenge.message, /purpose: account-login/);
  assert.match(callback.challenge.message, new RegExp(`origin: ${h.origin.replace(/[.]/g, '\\.')}`));
  const token = provider.tokens().access_token;
  assert.equal(decodeProtectedHeader(token).typ, 'at+jwt');
  const claims = decodeJwt(token);
  assert.equal(claims.aud, h.mcpUrl);
  assert.equal(claims.iss, `${h.origin}/oauth`);
  assert.match(claims.sub, /^acct_/);
  assert.deepEqual(claims.scope.split(' ').sort(), ['dacs.account.read', 'dacs.agents.write', 'dacs.purchases.write']);
  assert.ok(claims.exp - claims.iat <= 900);

  const client = await mcpWith(provider);
  const profile = await client.callTool({ name: 'get_profile', arguments: {} });
  assert.equal(profile.isError, false);
  assert.equal(profile.structuredContent.id, claims.sub);
  assert.deepEqual(JSON.parse(profile.content[0].text), profile.structuredContent);
  const status = await client.callTool({ name: 'get_account_status', arguments: {} });
  assert.deepEqual(status.structuredContent.wallets.map((w) => w.address), [wallet.address]);
  await client.close();
});

test('profile id is stable across re-linking and distinct across accounts', async () => {
  const alice = createEphemeralWallet();
  const bob = createEphemeralWallet();
  const a1 = await linkAccount({ harness: h, wallet: alice });
  const a2 = await linkAccount({ harness: h, wallet: alice }); // fresh DCR client, new grant
  const b1 = await linkAccount({ harness: h, wallet: bob });
  const ids = [];
  for (const { provider } of [a1, a2, b1]) {
    const client = await mcpWith(provider);
    ids.push((await client.callTool({ name: 'get_profile', arguments: {} })).structuredContent.id);
    await client.close();
  }
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.notEqual(a1.provider.clientInformation().client_id, a2.provider.clientInformation().client_id);
});

test('refresh token rotation keeps the same profile', async () => {
  const wallet = createEphemeralWallet();
  const scope = 'openid offline_access dacs.account.read';
  const { provider } = await linkAccount({ harness: h, wallet, scope });
  const tokens = provider.tokens();
  assert.ok(tokens.refresh_token, 'offline_access yields a refresh token');
  const metadata = await discoverAuthorizationServerMetadata(`${h.origin}/oauth`);
  const refreshed = await refreshAuthorization(metadata.issuer, {
    metadata,
    clientInformation: provider.clientInformation(),
    refreshToken: tokens.refresh_token,
    resource: new URL(h.mcpUrl),
  });
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.equal(decodeJwt(refreshed.access_token).sub, decodeJwt(tokens.access_token).sub);
  assert.equal(decodeJwt(refreshed.access_token).aud, h.mcpUrl);
});

test('scope enforcement: a read-only link cannot prepare purchases', async () => {
  const wallet = createEphemeralWallet();
  const { provider } = await linkAccount({ harness: h, wallet, scope: 'dacs.account.read' });
  const { data } = await rawCall(provider.tokens().access_token, 'prepare_purchase', { listingId: 'x-listing', version: 1, seller: `did:demos:agent:${'a'.repeat(64)}`, idempotencyKey: 'scope-test-1' });
  assert.equal(data.result.isError, true);
  assert.match(data.result._meta['mcp/www_authenticate'][0], /error="insufficient_scope".*scope="dacs.purchases.write"/);
});

test('expired, wrong-audience, wrong-issuer and forged tokens are refused with 401', async () => {
  const wallet = createEphemeralWallet();
  const { provider } = await linkAccount({ harness: h, wallet });
  const good = decodeJwt(provider.tokens().access_token);
  const { key, kid } = await serverKey();
  const now = Math.floor(Date.now() / 1000);
  const mint = (overrides, header = {}) => new SignJWT({ scope: good.scope, client_id: good.client_id, ...overrides })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid, ...header })
    .setIssuer(overrides.iss ?? good.iss).setAudience(overrides.aud ?? good.aud).setSubject(good.sub)
    .setIssuedAt(overrides.iat ?? now).setExpirationTime(overrides.exp ?? now + 300).sign(key);

  const control = await rawCall(await mint({}), 'get_profile');
  assert.equal(control.status, 200, 'a correctly minted token is accepted (control)');
  for (const [label, token] of [
    ['expired', await mint({ iat: now - 1000, exp: now - 600 })],
    ['wrong audience', await mint({ aud: 'https://other.example/mcp' })],
    ['wrong issuer', await mint({ iss: 'https://evil.example/oauth' })],
    ['wrong typ', await mint({}, { typ: 'JWT' })],
  ]) {
    const res = await rawCall(token, 'get_profile');
    assert.equal(res.status, 401, label);
    assert.match(res.headers.get('www-authenticate'), /invalid_token/, label);
  }
  // Re-sign nothing: swap in a payload claiming more scope/another subject.
  const [header, , signature] = provider.tokens().access_token.split('.');
  const payload = Buffer.from(JSON.stringify({ ...good, sub: 'acct_someoneelse0000000000' })).toString('base64url');
  assert.equal((await rawCall(`${header}.${payload}.${signature}`, 'get_profile')).status, 401);
  const otherKey = await (await import('jose')).generateKeyPair('ES256');
  const selfSigned = await new SignJWT({ scope: good.scope, client_id: good.client_id })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid }).setIssuer(good.iss).setAudience(good.aud).setSubject(good.sub)
    .setIssuedAt(now).setExpirationTime(now + 300).sign(otherKey.privateKey);
  assert.equal((await rawCall(selfSigned, 'get_profile')).status, 401, 'token signed by a foreign key');
});

test('authorization requires PKCE S256 and the exact resource', async () => {
  const provider = new TestOAuthProvider({ scope: 'dacs.account.read' });
  assert.equal(await auth(provider, { serverUrl: h.mcpUrl, scope: 'dacs.account.read' }), 'REDIRECT');
  const noPkce = new URL(provider.authorizationUrl);
  noPkce.searchParams.delete('code_challenge');
  noPkce.searchParams.delete('code_challenge_method');
  const r1 = await fetch(noPkce, { redirect: 'manual' });
  const loc1 = new URL(r1.headers.get('location'));
  assert.equal(loc1.searchParams.get('error'), 'invalid_request');
  assert.equal(loc1.searchParams.get('iss'), `${h.origin}/oauth`, 'iss on error responses too');

  const plain = new URL(provider.authorizationUrl);
  plain.searchParams.set('code_challenge_method', 'plain');
  const r2 = await fetch(plain, { redirect: 'manual' });
  assert.ok(['invalid_request'].includes(new URL(r2.headers.get('location')).searchParams.get('error')));

  const otherResource = new URL(provider.authorizationUrl);
  otherResource.searchParams.set('resource', 'https://other.example/mcp');
  const r3 = await fetch(otherResource, { redirect: 'manual' });
  assert.equal(new URL(r3.headers.get('location')).searchParams.get('error'), 'invalid_target');
});

test('authorization codes are single-use and bound to the PKCE verifier', async () => {
  const wallet = createEphemeralWallet();
  const provider = new TestOAuthProvider({ scope: 'dacs.account.read' });
  await auth(provider, { serverUrl: h.mcpUrl, scope: 'dacs.account.read' });
  const callback = await completeAuthorizationInBrowser({ authorizationUrl: provider.authorizationUrl, wallet, origin: h.origin });
  const code = callback.searchParams.get('code');
  const metadata = await discoverAuthorizationServerMetadata(`${h.origin}/oauth`);
  const exchange = (verifier) => fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL, client_id: provider.clientInformation().client_id, code_verifier: verifier, resource: h.mcpUrl }),
  });
  const wrong = await exchange(randomBytes(32).toString('base64url'));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'invalid_grant');
  const right = await exchange(provider.codeVerifier());
  assert.equal(right.status, 200);
  const issued = await right.json();
  assert.equal(decodeJwt(issued.access_token).aud, h.mcpUrl);
  const replay = await exchange(provider.codeVerifier());
  assert.equal(replay.status, 400, 'a redeemed code cannot be redeemed again');
  assert.equal((await replay.json()).error, 'invalid_grant');
  // oidc-provider revokes the grant on code replay, but RFC 9068 JWT access
  // tokens stay valid until their short expiry (<= 15 min).
  assert.equal((await rawCall(issued.access_token, 'get_profile')).status, 200, 'JWT access tokens are self-contained until expiry (known limitation)');
});

test('login challenge is one-use, origin/purpose bound, and rejects bad signatures', async () => {
  const wallet = createEphemeralWallet();
  const intruder = createEphemeralWallet();
  const provider = new TestOAuthProvider({ scope: 'dacs.account.read' });
  await auth(provider, { serverUrl: h.mcpUrl, scope: 'dacs.account.read' });
  await assert.rejects(
    completeAuthorizationInBrowser({ authorizationUrl: provider.authorizationUrl, wallet, origin: h.origin, tamper: { signature: intruder.signHex('anything') } }),
    (error) => error.status === 400 && error.data.error === 'bad_signature',
  );
  // A signature over a different (non-challenge) message is rejected too.
  const provider2 = new TestOAuthProvider({ scope: 'dacs.account.read' });
  await auth(provider2, { serverUrl: h.mcpUrl, scope: 'dacs.account.read' });
  await assert.rejects(
    completeAuthorizationInBrowser({ authorizationUrl: provider2.authorizationUrl, wallet, origin: h.origin, tamper: { message: 'dacs-listing:v1:' + 'a'.repeat(64) } }),
    (error) => error.data?.error === 'bad_signature',
  );
  // Replay: complete once, then reuse the consumed challenge id.
  const rows = h.app.db.prepare("SELECT id, consumed_at FROM challenges WHERE purpose = 'account-login' AND consumed_at IS NOT NULL").all();
  assert.ok(rows.length > 0);
  const consumed = h.app.services.challenges;
  assert.throws(() => consumed.verifyAndConsume({ challengeId: rows[0].id, purpose: 'account-login', expectedBinding: {}, signature: wallet.signHex('x'), consumedBy: 'replay' }), /already used/);
});

test('dynamic client registration only accepts allowlisted redirect origins', async () => {
  const metadata = await discoverAuthorizationServerMetadata(`${h.origin}/oauth`);
  const register = (uri) => fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  });
  const bad = await register('https://evil.example/callback');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_redirect_uri');
  const good = await register(CALLBACK_URL);
  assert.equal(good.status, 201);
});

test('OAuth state survives restart: tokens and grants keep working', async () => {
  const wallet = createEphemeralWallet();
  const { provider } = await linkAccount({ harness: h, wallet });
  const before = (await rawCall(provider.tokens().access_token, 'get_profile')).data.result.structuredContent.id;
  await h.restart();
  const res = await rawCall(provider.tokens().access_token, 'get_profile').catch((error) => {
    throw new Error(`after restart: ${error.message} ${error.cause?.code ?? ''} ${error.cause?.message ?? ''}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.structuredContent.id, before);
  assert.equal(createHash('sha256').update(before).digest('hex').length, 64);
});

test('a read-only account link cannot start wallet linking', async () => {
  const { provider } = await linkAccount({ harness: h, wallet: createEphemeralWallet(), scope: 'dacs.account.read' });
  const client = await mcpWith(provider);
  try {
    const result = await client.callTool({ name: 'start_wallet_link', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result._meta['mcp/www_authenticate'][0], /insufficient_scope/);
  } finally { await client.close(); }
});
