// External authorization provider adapter, exercised end-to-end against an
// independently implemented local test issuer (test/fixtures/test-issuer.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client';
import { startHarness } from './helpers/harness.mjs';
import { TestOAuthProvider, CookieJar } from './helpers/oauth.mjs';
import { startTestIssuer } from './fixtures/test-issuer.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

let h;
let issuer;
before(async () => {
  issuer = await startTestIssuer();
  h = await startHarness({ env: { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: issuer.issuer, DACS_OAUTH_COOKIE_KEYS: '' } });
});
after(async () => {
  await h.close();
  await issuer.close();
});

const SCOPE = 'dacs.account.read dacs.agents.write dacs.purchases.write';

async function linkExternal(subject) {
  issuer.state.subject = subject;
  const provider = new TestOAuthProvider({ scope: SCOPE });
  assert.equal(await auth(provider, { serverUrl: h.mcpUrl, scope: SCOPE }), 'REDIRECT');
  const res = await fetch(provider.authorizationUrl, { redirect: 'manual' });
  const callback = new URL(res.headers.get('location'));
  assert.equal(callback.searchParams.get('iss'), issuer.issuer);
  assert.equal(await auth(provider, { serverUrl: h.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope: SCOPE }), 'AUTHORIZED');
  return provider;
}

async function call(provider, name, args = {}) {
  const client = new Client({ name: 'ext', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl), { authProvider: provider }));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

test('protected resource metadata points at the external issuer; no built-in AS is mounted', async () => {
  const prm = await (await fetch(`${h.origin}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(prm.authorization_servers, [issuer.issuer]);
  assert.equal((await fetch(`${h.origin}/oauth/.well-known/openid-configuration`)).status, 404);
  const health = await (await fetch(`${h.origin}/health`)).json();
  assert.equal(health.authMode, 'external');
  assert.equal(health.dependencies.externalIssuer.issuer, issuer.issuer);
});

test('external issuer tokens map (iss, sub) to stable, isolated accounts', async () => {
  const alice1 = await linkExternal('alice');
  const alice2 = await linkExternal('alice');
  const bob = await linkExternal('bob');
  const ids = [];
  for (const p of [alice1, alice2, bob]) ids.push((await call(p, 'get_profile')).structuredContent.id);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.match(ids[0], /^acct_/, 'the profile id is an opaque local id, not the provider subject');
});

test('wallet linking in external mode goes through a signed one-use portal challenge', async () => {
  const provider = await linkExternal('carol');
  const wallet = createEphemeralWallet();
  const link = (await call(provider, 'start_wallet_link')).structuredContent;
  const fragment = new URLSearchParams(new URL(link.linkUrl).hash.slice(1));
  const body = { accountId: fragment.get('a'), expires: Number(fragment.get('e')), nonce: fragment.get('n'), token: fragment.get('t') };
  const post = async (path, extra) => {
    const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }) });
    return { status: r.status, data: await r.json() };
  };
  const challenge = (await post('/portal/api/link/challenge', { address: wallet.address })).data;
  assert.match(challenge.message, /purpose: link-wallet/);
  const done = await post('/portal/api/link/complete', { challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
  assert.equal(done.status, 200);
  assert.equal(done.data.address, wallet.address);
  const replay = await post('/portal/api/link/complete', { challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
  assert.equal(replay.status, 404, 'a used wallet link cannot be replayed');
  const reuse = await post('/portal/api/link/challenge', { address: createEphemeralWallet().address });
  assert.equal(reuse.status, 404, 'a used wallet link cannot issue new challenges');
  assert.match(challenge.message, /account-wallets: none linked yet/);
  assert.match(challenge.message, /Only sign if you started this from your own ChatGPT conversation/);
  const forgedToken = await post('/portal/api/link/challenge', { address: wallet.address, token: 'x'.repeat(43) });
  assert.equal(forgedToken.status, 404);
  const status = (await call(provider, 'get_account_status')).structuredContent;
  assert.deepEqual(status.wallets.map((w) => w.address), [wallet.address]);

  // The same wallet cannot be linked to a second account.
  const dave = await linkExternal('dave');
  const link2 = (await call(dave, 'start_wallet_link')).structuredContent;
  const f2 = new URLSearchParams(new URL(link2.linkUrl).hash.slice(1));
  const body2 = { accountId: f2.get('a'), expires: Number(f2.get('e')), nonce: f2.get('n'), token: f2.get('t') };
  const c2 = await (await fetch(`${h.origin}/portal/api/link/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body2, address: wallet.address }) })).json();
  const r2 = await fetch(`${h.origin}/portal/api/link/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body2, challengeId: c2.challengeId, signature: wallet.signHex(c2.message) }) });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error, 'wallet_linked_elsewhere');
  void CookieJar;
});

test('external tokens with the wrong audience are refused', async () => {
  issuer.state.audienceOverride = 'https://another-resource.example/mcp';
  try {
    const provider = await linkExternal('eve');
    const res = await fetch(h.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${provider.tokens().access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(res.status, 401);
  } finally {
    issuer.state.audienceOverride = null;
  }
});

test('a mismatched issuer metadata document fails closed', async () => {
  const other = await startTestIssuer();
  other.state.metadataIssuerOverride = 'https://impostor.example';
  const h2 = await startHarness({ env: { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: other.issuer, DACS_OAUTH_COOKIE_KEYS: '' }, chain: h.chain, directory: h.directory });
  try {
    const res = await fetch(h2.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer abc.def.ghi' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.ok(res.status >= 500, `expected server_error, got ${res.status}`);
    assert.ok(h2.logs.some((l) => l.includes('external_issuer_unavailable') && l.includes('does not exactly match')));
  } finally {
    await h2.close({ keepFixtures: true });
    await other.close();
  }
});
