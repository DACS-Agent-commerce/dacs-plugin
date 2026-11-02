import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startHarness, CALLBACK_ORIGIN, CALLBACK_URL } from './helpers/harness.mjs';
import { CookieJar, completeAuthorizationInBrowser, beginAuthorizationInBrowser, startUpgradeHarness } from './helpers/oauth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const allowedOrigins = ['https://chatgpt.com', CALLBACK_ORIGIN, 'http://localhost:65531', 'http://[::1]:65531',
  ...['127.0.0.1', '[::1]'].flatMap((host) => [65528, 65529].map((port) => `http://${host}:${port}`))];
let h, metadata;
before(async () => {
  h = await startHarness({ env: { DACS_ALLOWED_REDIRECT_ORIGINS: allowedOrigins.join(',') } });
  metadata = await (await fetch(`${h.origin}/oauth/.well-known/openid-configuration`)).json();
});
after(async () => h.close());

const register = (values) => fetch(metadata.registration_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: [CALLBACK_URL], token_endpoint_auth_method: 'none', ...values }),
});

const badUris = [
  ['another origin', 'https://evil.example/after-logout'],
  ['javascript scheme', 'javascript:alert(1)'],
  ['data scheme', 'data:text/html,hello'],
  ['userinfo with evil host', 'https://chatgpt.com@evil.example/after-logout'],
  ['userinfo with allowed host', 'https://evil.example@chatgpt.com/after-logout'],
  ['encoded allowed host', 'https://%63hatgpt.com/after-logout'],
  ['encoded evil host', 'https://%65vil.example/after-logout'],
  ['fragment', 'https://chatgpt.com/after-logout#fragment'],
  ['empty fragment', 'https://chatgpt.com/after-logout#'],
  ['mixed-case scheme', 'hTtPs://chatgpt.com/after-logout'],
  ['wildcard host', 'https://*.chatgpt.com/after-logout'],
  ['wildcard path', 'https://chatgpt.com/*'],
  ['host suffix', 'https://chatgpt.com.evil.example/after-logout'],
  ['insecure public origin', 'http://chatgpt.com/after-logout'],
  ['unlisted loopback port', 'http://127.0.0.1:65530/after-logout'],
  ['custom scheme', 'dacs:/after-logout'],
  ['backslash authority', 'https://chatgpt.com\\@evil.example/after-logout'],
  ['control character', 'https://chat\tgpt.com/after-logout'],
  ['missing authority', 'https:///chatgpt.com/after-logout'],
  ['backslash path', 'https://chatgpt.com/safe\\..\\after'],
  ['backslash query', 'https://chatgpt.com/after?next=\\home'],
  ['raw parent segment', 'https://chatgpt.com/safe/../after'],
  ['raw dot segment', 'https://chatgpt.com/safe/./after'],
  ['encoded parent segment', 'https://chatgpt.com/safe/%2e%2e/after'],
  ['mixed encoded parent segment', 'https://chatgpt.com/safe/.%2E/after'],
  ['mixed raw parent segment', 'https://chatgpt.com/safe/%2E./after'],
  ['encoded dot segment', 'https://chatgpt.com/safe/%2e/after'],
  ['terminal parent segment', 'https://chatgpt.com/safe/..'],
  ['terminal encoded dot segment', 'https://chatgpt.com/safe/%2E?next=home'],
  ['explicit default port', 'https://chatgpt.com:443/after-logout?next=%2Fhome'],
  ['uppercase host', 'https://CHATGPT.COM/after-logout'],
  ['missing root slash', 'https://chatgpt.com'],
];

for (const [label, uri] of badUris) {
  for (const key of ['post_logout_redirect_uris', 'redirect_uris']) test(`DCR refuses ${label} in ${key}`, async () => {
    // One bad entry must refuse the whole registration, including a valid entry.
    const response = await register({ [key]: [CALLBACK_URL, uri] });
    const body = await response.json();
    assert.equal(response.status, 400, `${key}: ${JSON.stringify(body)}`);
    assert.equal(body.error, 'invalid_redirect_uri', key);
  });
}

for (const uri of [
  'https://chatgpt.com/after-logout',
  'https://chatgpt.com/after-logout?next=%2Fhome',
  'https://chatgpt.com/cb?q=%7E&space=a+b&empty=&slash=%2Fhome&semi=a%3Bb',
  'https://chatgpt.com/cb?q=one&q=two',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/connector/oauth/test-callback-id',
  'https://chatgpt.com/%63allback',
  'https://chatgpt.com/safe/a..b?next=..%2Fhome',
  `${CALLBACK_ORIGIN}/after-logout`,
  'http://localhost:65531/after-logout',
  'http://[::1]:65531/after-logout',
]) test(`DCR accepts ${uri} in both redirect lists`, async () => {
  const response = await register({ redirect_uris: [uri], post_logout_redirect_uris: [uri] });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.deepEqual(body.redirect_uris, [uri]);
  assert.deepEqual(body.post_logout_redirect_uris, [uri]);
  const authorization = await authorize(body.client_id, uri);
  assert.equal(authorization.status, 303);
  const location = new URL(authorization.headers.get('location'));
  assert.equal(location.searchParams.get('error'), 'invalid_request');
  // OAuth appends response parameters; removing only those must recover the
  // exact registered URI, including its original path and query encoding.
  for (const key of ['error', 'error_description', 'iss']) location.searchParams.delete(key);
  assert.equal(location.href, uri);
  await authorization.body?.cancel();
  const finish = await logout(body.client_id, uri);
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.get('location'), uri);
  await finish.body?.cancel();
  const withState = await logout(body.client_id, uri, undefined, 'round-two-state');
  assert.equal(withState.status, 303);
  assert.equal(withState.headers.get('location'), `${uri}${uri.includes('?') ? '&' : '?'}state=round-two-state`);
  await withState.body?.cancel();
});

test('DCR keeps logout redirects optional and accepts an empty list', async () => {
  for (const values of [{}, { post_logout_redirect_uris: [] }]) {
    const response = await register(values);
    assert.equal(response.status, 201, await response.text());
  }
});

for (const value of [null, 'https://chatgpt.com/after-logout', {}, [null], [42]]) test(`DCR refuses malformed logout metadata ${JSON.stringify(value)}`, async () => {
  const response = await register({ post_logout_redirect_uris: value });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, 'invalid_redirect_uri');
});

async function logout(clientId, target, idTokenHint, state) {
  const url = new URL(metadata.end_session_endpoint);
  url.search = new URLSearchParams({
    ...(idTokenHint ? { id_token_hint: idTokenHint } : { client_id: clientId }),
    post_logout_redirect_uri: target,
    ...(state === undefined ? {} : { state }),
  });
  const jar = new CookieJar();
  const start = await fetch(url, { redirect: 'manual' });
  jar.store(start);
  if (start.status !== 200) return start;
  const html = await start.text();
  const action = /action="([^"]+)"/.exec(html)?.[1];
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(action && xsrf, 'logout confirmation form');
  assert.equal(new URL(action).origin, h.origin, 'only submit to the local server');
  return fetch(action, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header(action) },
    body: new URLSearchParams({ xsrf, logout: 'yes' }),
  });
}

function authorize(clientId, target) {
  const url = new URL(metadata.authorization_endpoint);
  // Missing PKCE causes a real authorization error redirect after URI checks,
  // without needing a wallet session or contacting the callback listener.
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: target, response_type: 'code' });
  return fetch(url, { redirect: 'manual' });
}

for (const target of ['https://chatgpt.com/safe\\..\\after', 'https://chatgpt.com/safe/../after', 'https://chatgpt.com/safe/%2e%2e/after']) {
  for (const flow of ['authorization', 'logout']) test(`${flow} never emits a normalized path for ${target}`, async () => {
    const response = await register({ redirect_uris: [target], post_logout_redirect_uris: [target] });
    if (response.status === 201) {
      const client = await response.json();
      const finish = await (flow === 'authorization' ? authorize : logout)(client.client_id, target);
      assert.equal(finish.status, 303);
      const location = new URL(finish.headers.get('location'));
      if (flow === 'authorization') {
        for (const key of ['error', 'error_description', 'iss']) location.searchParams.delete(key);
      }
      assert.equal(location.href, target, 'emitted callback must equal the accepted registration');
    }
    assert.equal(response.status, 400, 'noncanonical metadata must be refused at registration');
  });
}

for (const host of ['127.0.0.1', '[::1]']) {
  for (const flow of ['authorization', 'logout']) {
    for (const [label, port, permitted] of [
      ['registered port', 65531, true],
      ['second registered port', 65528, true],
      ['unregistered allowlisted port', 65529, false],
      ['unregistered unallowlisted port', 65530, false],
    ]) test(`native ${host} ${flow}: ${label}`, async () => {
      const uris = [65531, 65528].map((p) => `http://${host}:${p}/callback`);
      const response = await register({ application_type: 'native', redirect_uris: uris, post_logout_redirect_uris: uris });
      assert.equal(response.status, 201, await response.clone().text());
      const client = await response.json();
      assert.equal(client.application_type, 'native');
      const target = `http://${host}:${port}/callback`;
      const finish = await (flow === 'authorization' ? authorize : logout)(client.client_id, target);
      assert.equal(finish.status, permitted ? 303 : 400, target);
      if (permitted) {
        const location = new URL(finish.headers.get('location'));
        if (flow === 'authorization') {
          assert.equal(location.searchParams.get('error'), 'invalid_request');
          for (const key of ['error', 'error_description', 'iss']) location.searchParams.delete(key);
        }
        assert.equal(location.href, target);
      } else {
        assert.equal(finish.headers.get('location'), null);
      }
      await finish.body?.cancel();
    });
  }
}

for (const target of [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/connector/oauth/test-callback-id',
  'http://127.0.0.1:65531/callback',
  'http://[::1]:65531/callback',
  'https://chatgpt.com/cb?q=%7E&space=a+b&empty=&slash=%2Fhome&semi=a%3Bb',
  'https://chatgpt.com/cb?q=one&q=two',
]) test(`successful authorization and ID-token logout preserve ${target}`, async () => {
  const native = target.startsWith('http:');
  const response = await register({
    ...(native ? { application_type: 'native' } : {}),
    redirect_uris: [target], post_logout_redirect_uris: [target], scope: 'openid',
  });
  assert.equal(response.status, 201, await response.clone().text());
  const client = await response.json();
  const verifier = 'a'.repeat(43);
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: target, response_type: 'code', scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const callback = await completeAuthorizationInBrowser({ authorizationUrl: url,
    wallet: createEphemeralWallet(), origin: h.origin, callbackUrl: target });
  const code = callback.searchParams.get('code');
  assert.ok(code, callback.href);
  const destination = new URL(callback);
  for (const key of ['code', 'iss']) destination.searchParams.delete(key);
  assert.equal(destination.href, target);
  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
      code, redirect_uri: target, code_verifier: verifier }),
  });
  const tokens = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
  assert.ok(tokens.id_token);
  if (native) for (const port of [65529, 65530]) {
    const finish = await logout(undefined, target.replace(':65531/', `:${port}/`), tokens.id_token);
    assert.equal(finish.status, 400, `ID-token logout must refuse port ${port}`);
    assert.equal(finish.headers.get('location'), null);
    await finish.body?.cancel();
  }
  const finish = await logout(undefined, target, tokens.id_token);
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.get('location'), target);
  await finish.body?.cancel();
});

for (const host of ['127.0.0.1', '[::1]']) {
  for (const flow of ['authorization', 'logout']) test(`native ${host} ${flow} rechecks the runtime allowlist for a loaded client`, async () => {
    const target = `http://${host}:65531/callback`;
    const response = await register({ application_type: 'native', redirect_uris: [target], post_logout_redirect_uris: [target] });
    assert.equal(response.status, 201);
    const client = await response.json();
    const run = flow === 'authorization' ? authorize : logout;
    const warm = await run(client.client_id, target);
    assert.equal(warm.status, 303);
    await warm.body?.cancel();
    // Keep the provider's validated client cache, but remove its origin from
    // the test configuration to isolate runtime policy from metadata validation.
    const origins = h.config.allowedRedirectOrigins;
    const saved = [...origins];
    origins.splice(origins.indexOf(new URL(target).origin), 1);
    try {
      const finish = await run(client.client_id, target);
      assert.equal(finish.status, 400);
      assert.equal(finish.headers.get('location'), null);
      await finish.body?.cancel();
    } finally {
      origins.splice(0, origins.length, ...saved);
    }
  });
}

for (const key of ['redirect_uris', 'post_logout_redirect_uris']) {
  for (const uri of ['https://chatgpt.com/safe/../after', 'https://CHATGPT.COM/after-logout']) {
    test(`stored ${key} ${uri} fails closed after restart`, async () => {
      const response = await register({ post_logout_redirect_uris: [CALLBACK_URL] });
      assert.equal(response.status, 201);
      const client = await response.json();
      const row = h.app.db.prepare("SELECT payload FROM oidc_models WHERE model = 'Client' AND id = ?").get(client.client_id);
      const payload = JSON.parse(row.payload);
      // Retain the valid callback so both requests would work if the stored
      // invalid entry were silently ignored instead of refusing the client.
      payload[key] = [CALLBACK_URL, uri];
      h.app.db.prepare("UPDATE oidc_models SET payload = ? WHERE model = 'Client' AND id = ?").run(JSON.stringify(payload), client.client_id);
      await h.restart();
      for (const run of [authorize, logout]) {
        const finish = await run(client.client_id, CALLBACK_URL);
        assert.equal(finish.status, 400);
        assert.equal(finish.headers.get('location'), null);
        await finish.body?.cancel();
      }
    });
  }
}

test('logout redirects to a registered allowlisted URI after confirmation', async () => {
  const target = 'https://chatgpt.com/after-logout';
  const response = await register({ post_logout_redirect_uris: [target] });
  assert.equal(response.status, 201);
  const client = await response.json();
  const finish = await logout(client.client_id, target);
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.get('location'), target);
  await finish.body?.cancel();
});

test('logout refuses unregistered URIs, including an allowlisted origin', async () => {
  const response = await register({ post_logout_redirect_uris: ['https://chatgpt.com/after-logout'] });
  assert.equal(response.status, 201);
  const client = await response.json();
  for (const target of ['https://evil.example/after-logout', 'https://chatgpt.com/unregistered']) {
    const finish = await logout(client.client_id, target);
    assert.equal(finish.status, 400, target);
    assert.equal(finish.headers.get('location'), null, target);
    assert.match(await finish.text(), /post_logout_redirect_uri not registered/);
  }
});

const unstableQueries = ['q=~', 'q=a%20b', 'q=%2fhome', 'bare', 'q=a;b', 'q=1&&x=2', ''];
const reservedQueries = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'];
for (const query of [...unstableQueries, ...reservedQueries.map((key) => `${key}=existing`)]) {
  for (const key of ['redirect_uris', 'post_logout_redirect_uris']) test(`DCR refuses unstable or reserved query ${query} in ${key}`, async () => {
    const uri = `https://chatgpt.com/cb?${query}`;
    const response = await register({ [key]: [CALLBACK_URL, uri] });
    if (response.status === 201 && unstableQueries.includes(query)) {
      const client = await response.json();
      const emitted = await (key === 'redirect_uris'
        ? authorize(client.client_id, uri)
        : logout(client.client_id, uri, undefined, 'query-regression'));
      assert.equal(emitted.status, 303);
      // Compare the raw prefix; URLSearchParams.delete would conceal changes.
      assert.ok(emitted.headers.get('location').startsWith(`${uri}&`), emitted.headers.get('location'));
    }
    assert.equal(response.status, 400, 'unstable or colliding queries must be rejected');
  });
}

// Start the pre-fix fixture, persist a pending flow, then boot working-tree source in a new
// process against the same database, issuer port and cookie keys.
for (const host of ['127.0.0.1', '[::1]']) {
  for (const flow of ['authorization', 'logout']) {
    for (const [label, port, allowed, withdraw] of [
      ['unregistered unallowlisted port', 65530, false, false],
      ['unregistered allowlisted port', 65529, false, false],
      ['withdrawn registered origin', 65531, false, true],
      ['registered destination', 65531, true, false],
    ]) test(`upgrade pending ${host} ${flow}: ${label}`, async () => {
      const u = await startUpgradeHarness({ allowedOrigins });
      try {
        const discovery = await (await fetch(`${u.origin}/oauth/.well-known/openid-configuration`)).json();
        const registered = `http://${host}:65531/callback`;
        const target = `http://${host}:${port}/callback`;
        const registration = await fetch(discovery.registration_endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ application_type: 'native', redirect_uris: [registered],
            post_logout_redirect_uris: [registered], token_endpoint_auth_method: 'none', scope: 'openid' }),
        });
        assert.equal(registration.status, 201, await registration.clone().text());
        const client = await registration.json();
        let resume, jar;
        if (flow === 'authorization') {
          const url = new URL(discovery.authorization_endpoint);
          url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: target,
            response_type: 'code', scope: 'openid', code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url'),
            code_challenge_method: 'S256' });
          ({ redirectTo: resume, jar } = await beginAuthorizationInBrowser({ authorizationUrl: url,
            wallet: createEphemeralWallet(), origin: u.origin, callbackUrl: target }));
          assert.ok(resume);
        } else {
          const url = new URL(discovery.end_session_endpoint);
          url.search = new URLSearchParams({ client_id: client.client_id, post_logout_redirect_uri: target });
          jar = new CookieJar();
          const start = await fetch(url, { redirect: 'manual' });
          jar.store(start);
          assert.equal(start.status, 200);
          const html = await start.text();
          resume = /action="([^"]+)"/.exec(html)?.[1];
          jar.xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
          assert.ok(resume && jar.xsrf);
        }
        await u.upgrade({ origins: withdraw ? allowedOrigins.filter((origin) => origin !== new URL(target).origin) : allowedOrigins });
        const finish = await fetch(resume, { redirect: 'manual',
          ...(flow === 'logout' ? { method: 'POST', body: new URLSearchParams({ xsrf: jar.xsrf, logout: 'yes' }) } : {}),
          headers: { cookie: jar.header(resume), 'content-type': 'application/x-www-form-urlencoded' } });
        assert.equal(finish.status, allowed ? 303 : 400, `${flow}: ${finish.headers.get('location')}`);
        if (allowed) {
          const location = finish.headers.get('location');
          if (flow === 'authorization') {
            assert.ok(new URL(location).searchParams.get('code'), location);
            assert.ok(location.startsWith(`${target}?`));
          } else assert.equal(location, target);
        } else assert.equal(finish.headers.get('location'), null);
        await finish.body?.cancel();
      } finally { await u.close(); }
    });
  }
}

test('SIGKILL during a mutant leaves the invoking source unchanged', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'dcr-kill-'));
  let child, group;
  try {
    for (const name of ['src', 'test', 'public', 'package.json']) cpSync(join(root, name), join(dir, name), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const source = join(dir, 'src/auth/authorization-server.mjs');
    const original = readFileSync(process.env.DCR_HELPER_ORIGINAL ?? source, 'utf8');
    writeFileSync(source, original);
    // Isolate helper behavior with a tiny runner. Hold mutants open for SIGKILL, marking the hold.
    writeFileSync(join(dir, 'original.mjs'), original);
    writeFileSync(join(dir, 'test/oauth-logout.test.mjs'), `
      import { test } from 'node:test';
      import { readFileSync, writeFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      test('source unchanged', async () => {
        const actual = readFileSync('src/auth/authorization-server.mjs', 'utf8');
        const expected = readFileSync(process.env.DCR_KILL_ORIGINAL, 'utf8');
        if (actual !== expected) { writeFileSync(process.env.DCR_KILL_HELD, ''); await new Promise((resolve) => setTimeout(resolve, 30_000)); }
        assert.equal(actual, expected);
      });
    `);
    // TMPDIR=dir puts the killed helper's private copy under dir, removed below.
    const held = join(dir, 'held');
    const helperEnv = { ...process.env, TMPDIR: dir, DCR_BASE_SOURCE: join(dir, 'original.mjs'), DCR_KILL_ORIGINAL: join(dir, 'original.mjs'), DCR_KILL_HELD: held };
    delete helperEnv.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, ['test/helpers/mutate-dcr.mjs', join(dir, 'logs')], {
      cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: helperEnv,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let mutated = false;
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const privateRoot = /^workspace: (.+)$/m.exec(output)?.[1];
      const candidate = privateRoot ? join(privateRoot, 'src/auth/authorization-server.mjs') : source;
      // Each run has its own process group; the held mutant run is the one after the baseline.
      group = [...output.matchAll(/^(\S+): process group (\d+)$/gm)].find(([, name]) => name !== 'baseline')?.[2];
      if (readFileSync(candidate, 'utf8') !== original && group && existsSync(held)) { mutated = true; break; }
      if (child.exitCode !== null) throw new Error(`helper exited before mutation: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(mutated, `helper must be killed while a mutant is installed: ${output}`);
    const exited = once(child, 'exit');
    process.kill(-child.pid, 'SIGKILL');
    await exited;
    assert.equal(readFileSync(source, 'utf8'), original, 'SIGKILL must leave the invoking checkout untouched');
    // The held run outlives the helper in its own group; killing that group, as a SIGKILLing caller must, ends it.
    const groupGone = () => { try { process.kill(-Number(group), 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
    assert.equal(groupGone(), false, `held mutant run ${group} must still be running`);
    process.kill(-Number(group), 'SIGKILL');
    for (let waited = 0; !groupGone() && waited < 5000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(groupGone(), true, `held mutant run ${group} must end with its group`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    if (group) try { process.kill(-Number(group), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    rmSync(dir, { recursive: true, force: true });
  }
});


test('account switching keeps the provider internal logout resume destination working', async () => {
  const jar = new CookieJar();
  let pending;
  for (let turn = 0; turn < 2; turn += 1) {
    const response = await register({ scope: 'openid' });
    assert.equal(response.status, 201);
    const client = await response.json();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK_URL,
      response_type: 'code', scope: 'openid', prompt: 'login',
      code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url'), code_challenge_method: 'S256' });
    pending = await beginAuthorizationInBrowser({ authorizationUrl: url, wallet: createEphemeralWallet(), origin: h.origin, jar });
    assert.ok(pending.redirectTo);
    const resume = await fetch(pending.redirectTo, { redirect: 'manual', headers: { cookie: jar.header(pending.redirectTo) } });
    jar.store(resume);
    if (turn === 0) {
      assert.equal(resume.status, 303);
      assert.ok(new URL(resume.headers.get('location')).searchParams.get('code'));
      await resume.body?.cancel();
    } else {
      assert.equal(resume.status, 200);
      const html = await resume.text();
      const action = /action="([^"]+)"/.exec(html)?.[1];
      const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
      assert.ok(action && xsrf);
      const confirmed = await fetch(action, { method: 'POST', redirect: 'manual',
        headers: { cookie: jar.header(action), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ xsrf, logout: 'yes' }) });
      jar.store(confirmed);
      assert.equal(confirmed.status, 303);
      assert.equal(confirmed.headers.get('location'), pending.redirectTo);
      await confirmed.body?.cancel();
      const final = await fetch(pending.redirectTo, { redirect: 'manual', headers: { cookie: jar.header(pending.redirectTo) } });
      assert.equal(final.status, 303);
      assert.ok(new URL(final.headers.get('location')).searchParams.get('code'));
      await final.body?.cancel();
    }
  }
});
