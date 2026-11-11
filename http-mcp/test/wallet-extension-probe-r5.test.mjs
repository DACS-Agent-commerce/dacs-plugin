import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { checkSignedTransaction } from '../public/wallet-extension-probe/checks.mjs';
import { nativeVector, storageVector } from '../public/wallet-extension-probe/vectors.mjs';
import { createWalletExtensionProbeRouter } from '../src/portal/wallet-extension-probe.mjs';
import { signedTransaction, installProbeDom, INACTIVE_NETWORK } from './helpers/wallet-extension-probe-dom.mjs';
import { createSdkWallet } from './helpers/wallet-extension-probe-sdk.mjs';
import { startHarness } from './helpers/harness.mjs';
import { startTestIssuer } from './fixtures/test-issuer.mjs';

const wallet = await createSdkWallet(), vectors = { native: () => nativeVector({ from: wallet.address, nonce: 1, timestamp: 1234 }), storage: () => storageVector({ from: wallet.address, nonce: 1, timestamp: 1234 }) };
const fork = (postFork) => postFork ? 'post-fork' : 'pre-fork';
// The real bundled SDK's signed answer, optionally mutated and re-signed with the same key.
async function sdkCheck(name, postFork, mutate, quote) {
  const tx = await vectors[name](), real = await wallet.sdkSign(tx, postFork, quote);
  const returned = mutate ? signedTransaction(wallet, tx, (s) => { s.content = structuredClone(real.content); mutate(s.content); }) : real;
  const result = await checkSignedTransaction(tx, returned, wallet.address, INACTIVE_NETWORK);
  assert.equal(result.hashValid, true); assert.equal(result.signatureValid, true); assert.equal(result.ok, false);
  return { real, result, summary: result.diffSummary };
}
// SDK serialization regressions, inverted.
test('real bundled SDK sign(): post-fork P4/P5 and pre-fork P5 are SDK-expected in one profile', async () => {
  for (const quote of [undefined, { networkFee: 2, rpcFee: 3 }]) {
    for (const [name, postFork] of [['native', true], ['storage', true], ['storage', false]]) {
      const { real, result, summary } = await sdkCheck(name, postFork, null, quote);
      assert.equal(summary.reading, 'sdk-expected-only', `${name} ${fork(postFork)} ${JSON.stringify(result.diffs)}`);
      assert.deepEqual([summary.sdkProfile, summary.unexpected, summary.sdkExpected, summary.amountChanged], [fork(postFork), 0, result.diffs.length, false]);
      const fees = real.content.transaction_fee;
      if (postFork) assert.deepEqual([typeof fees.network_fee, fees.rpc_fee, fees.additional_fee], ['string', quote ? '3000000000' : '0', '0']);
      if (postFork && name === 'storage') assert.equal(real.content.amount, '0');
    }
  }
});

test('real bundled SDK sign(): pre-fork P4 is an unexpected denomination rewrite', async () => {
  for (const quote of [undefined, { networkFee: 2, rpcFee: 3 }]) {
    const { real, summary } = await sdkCheck('native', false, null, quote);
    assert.deepEqual([real.content.amount, ...real.content.gcr_edits.slice(0, 2).map((e) => e.amount)], [0, 0, 0]);
    assert.equal(summary.reading, 'other-unexpected-diffs');
    assert.deepEqual([summary.sdkProfile, summary.amountChanged, summary.nonceChanged, summary.recipientChanged, summary.signerChanged], ['pre-fork', true, false, false, false]);
    assert.equal(summary.unexpected, 2, 'the amount and the zero-amount transfer edits');
  }
});

const toPre = (os) => Number(BigInt(os) / 1_000_000_000n);
const mixed = [
  ['post-fork gas edit in pre-fork form', ['native', 'storage'], true, (c) => { c.gcr_edits[2].amount = 1; }],
  ['post-fork storage debit in pre-fork form', ['storage'], true, (c) => { c.gcr_edits[0].amount = 1; }],
  ['post-fork network fee as a number', ['native', 'storage'], true, (c) => { c.transaction_fee.network_fee = toPre(c.transaction_fee.network_fee); }],
  ['post-fork rpc fee left as number 0', ['native', 'storage'], true, (c) => { c.transaction_fee.rpc_fee = 0; }],
  ['post-fork additional fee left as number 0', ['native', 'storage'], true, (c) => { c.transaction_fee.additional_fee = 0; }],
  ['post-fork P5 amount left as number 0', ['storage'], true, (c) => { c.amount = 0; }],
  ['post-fork additional fee not zero', ['native', 'storage'], true, (c) => { c.transaction_fee.additional_fee = '1'; }],
  ['post-fork non-canonical fee string', ['native', 'storage'], true, (c) => { c.transaction_fee.rpc_fee = '00'; }],
  // Pre-fork P5 with any one post-fork form; HEAD accepted the two edit cases.
  ['pre-fork P5 with a post-fork gas edit, storage debit, fee or amount', ['storage'], false, [
    (c) => { c.gcr_edits[2].amount = '1000000000'; }, (c) => { c.gcr_edits[0].amount = '1000000000'; },
    (c) => { c.transaction_fee.network_fee = '2000000000'; }, (c) => { c.amount = '0'; }, (c) => { c.transaction_fee.additional_fee = '0'; }]],
];
for (const [name, names, postFork, mutate] of mixed) test(`mixed SDK profile is unexpected: ${name}`, async () => {
  for (const vector of names) for (const one of [mutate].flat()) {
    const { summary } = await sdkCheck(vector, postFork, one);
    assert.equal(summary.reading, 'other-unexpected-diffs', vector); assert.equal(summary.unexpected, 1, vector);
  }
});

// Uppercase, unprefixed aliases of the connected key.
test('GCR accounts, storage sender and signing key must be the exact canonical address', async () => {
  const alias = (v) => v.slice(2).toUpperCase();
  for (const [name, postFork] of [['native', true], ['storage', true], ['storage', false]]) {
    for (const [field, mutate] of [
      ['edit accounts', (c) => { for (const e of c.gcr_edits) if (e.account) e.account = alias(e.account); }],
      ['every edit account and storage sender', (c) => { for (const e of c.gcr_edits) { if (e.account) e.account = alias(e.account); if (e.context) e.context.sender = alias(e.context.sender); } }],
      ['one prefixed uppercase account', (c) => { c.gcr_edits[3].account = `0x${alias(c.gcr_edits[3].account)}`; }],
      ...(name === 'storage' ? [['storage sender', (c) => { c.gcr_edits[1].context.sender = alias(c.gcr_edits[1].context.sender); }]] : []),
      ...(name === 'native' ? [['from_ed25519_address', (c) => { c.from_ed25519_address = alias(c.from_ed25519_address); }]] : []),
    ]) {
      assert.equal((await sdkCheck(name, postFork)).summary.reading, 'sdk-expected-only');
      const { summary } = await sdkCheck(name, postFork, mutate);
      assert.equal(summary.reading, 'other-unexpected-diffs', `${name} ${fork(postFork)} ${field}`);
      assert.equal(summary.signerChanged, false, 'an alias of the same key is not a signer change');
    }
  }
});

test('the page tells SDK profiles, mixed profiles and the pre-fork P4 rewrite apart', async () => {
  const cases = [
    [await sdkCheck('native', true), /not a nonce rewrite.*post-fork.*OS strings/, /denomination rewrite/],
    [await sdkCheck('storage', false), /not a nonce rewrite.*pre-fork.*DEM numbers/, /denomination rewrite/],
    [await sdkCheck('native', false), /Finding:.*pre-fork SDK wallet does this to P4: it cannot represent one OS.*unexpected denomination rewrite/, /not a nonce rewrite/],
    [await sdkCheck('storage', true, (c) => { c.gcr_edits[2].amount = 1; }), /Finding:.*mixed pre-fork and post-fork SDK formats/, /not a nonce rewrite|denomination rewrite/],
  ];
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    for (const [{ result }, shown, absent] of cases) {
      mountProbe(dom.root, { adapter: { report: () => ({}), connect: async () => ({ address: wallet.address }), signTransaction: async () => result } });
      await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
      dom.nodes().find((n) => n.attributes.type === 'checkbox').checked = true;
      await dom.button('P4 Sign native transfer only').click();
      const status = dom.nodes().find((n) => n.attributes.role === 'status').textContent;
      assert.match(status, shown); assert.doesNotMatch(status, absent);
    }
  } finally { dom.restore(); }
});

test('condition of use, fresh-key responsibility and the 10 KiB storage bound are stated', async () => {
  const docs = readFileSync(new URL('../docs/WALLET-EXTENSION-PROBE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const checks = readFileSync(new URL('../public/wallet-extension-probe/checks.mjs', import.meta.url), 'utf8').replace(/\s*\/\/\s*/g, ' ');
  assert.doesNotMatch(docs, /remains open|open (?:owner )?decision|is an open condition/i);
  assert.match(docs, /Condition of use\.\*\* The residual risk above is accepted on testnet, on one condition: the probe uses a fresh key that is used nowhere else and holds at most 10 testnet DEM\./);
  assert.match(docs, /cannot check that a key is fresh or used nowhere else; that is the owner's responsibility/);
  assert.match(docs, /one-DEM storage debit is right only because this fixture is below the SDK's 10 KiB storage pricing chunk/);
  assert.match(checks, /storage debit is one DEM only because this fixture is below the SDK's 10 KiB storage pricing chunk/);
  assert.match(docs, /dot segments under `\/portal\/assets\/`.*existing portal asset handler refuses them with its 403, as on `main` and with the switch off/);
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    mountProbe(dom.root, { adapter: { report: () => ({}) } });
    const text = dom.root.textContent;
    assert.match(text, /Condition of use: this remaining risk is accepted on testnet only if the probe key is fresh, used nowhere else and holds at most 10 testnet DEM\./);
    assert.match(text, /Use a fresh key used nowhere else\. The page cannot check that a key is fresh; that is your responsibility\./);
  } finally { dom.restore(); }
});

test('an enabled probe under an external issuer mounts the same empty router as switch-off', () => {
  const logs = [], make = (walletExtensionProbe) => createWalletExtensionProbeRouter({ config: { walletExtensionProbe, authMode: 'external' }, logger: { warn: (...a) => logs.push(a) } });
  assert.equal(make(false).stack.length, 0);
  assert.equal(make(true).stack.length, 0);
  assert.deepEqual(logs, [['wallet_extension_probe_requires_builtin_sign_in']]);
});

// External bytes: the whole application,
// raw request targets (no client-side dot-segment normalization), every header.
function raw(origin, method, path, headers) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const { date, ...rest } = res.headers; assert.ok(date); resolve({ status: res.statusCode, headers: rest, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject); req.end();
  });
}
const probeTargets = ['/portal/wallet-extension-probe', '/portal/wallet-extension-probe/', '/portal/wallet-extension-probe/assets/main.mjs', '/portal/wallet-extension-probe/assets/MAIN.MJS',
  `/portal/wallet-extension-probe/nonce/${wallet.address}`, '/PORTAL/WALLET-EXTENSION-PROBE/ASSETS/main.mjs', '/PORTAL/Wallet-Extension-Probe', '/portal/%77allet-extension-probe/assets/main.mjs',
  '/portal/wallet-extension-probe%2Fassets%2Fmain.mjs', '/portal/wallet-extension-probe/assets/%6dain.mjs', '/portal/wallet-extension-probe//assets/main.mjs', '//portal/wallet-extension-probe',
  '/portal//wallet-extension-probe', '/portal/wallet%2Dextension-probe', '/portal/./wallet-extension-probe', '/portal/x/../wallet-extension-probe',
  '/portal/wallet-extension-probe;x', '/portal/wallet-extension-probe?x=1', '/portal/wallet-extension-probe.', '/portal/wallet-extension-probe%20'];
const assetTraversals = ['/portal/assets/../wallet-extension-probe/assets/main.mjs', '/portal/assets/%2e%2e/%2e%2e/wallet-extension-probe/main.mjs', '/portal/assets/..%2fwallet-extension-probe/assets/main.mjs', '/portal/assets/../wallet-extension-probe'];
// /health embeds each harness's own origin, so it is checked in the routes test instead.
const controls = ['/portal/assets/portal.css', '/portal/assets/../portal.css', '/portal/link', '/portal/unknown'];
// Express fixes its error-page mode from NODE_ENV when the app is created.
test('external issuer: switch-on matches switch-off byte for byte through the full app, in and outside production', async () => {
  for (const nodeEnv of ['production', 'test', 'development', undefined]) await externalParity(nodeEnv);
});
async function externalParity(nodeEnv) {
  const previous = process.env.NODE_ENV, issuer = await startTestIssuer(), servers = [];
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  try {
    const env = { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: issuer.issuer, DACS_OAUTH_COOKIE_KEYS: '' };
    servers.push(await startHarness({ env: { ...env, DACS_WALLET_EXTENSION_PROBE: '1', DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT: 'probe-owner' } }), await startHarness({ env }));
    for (let round = 0; round < 3; round++) for (const path of [...probeTargets, ...assetTraversals, ...controls]) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) for (const headers of [{}, { authorization: 'Bearer owner' }]) {
        const [on, off] = [await raw(servers[0].origin, method, path, headers), await raw(servers[1].origin, method, path, headers)];
        assert.deepEqual(on, off, `${nodeEnv} ${method} ${path} ${round}`);
        if (probeTargets.includes(path)) assert.deepEqual([on.status, on.body], [404, method === 'HEAD' ? '' : '{"error":"not_found"}'], `${method} ${path}`);
        if (assetTraversals.includes(path) && ['GET', 'HEAD'].includes(method)) assert.equal(on.status, 403, `${method} ${path}`);
        assert.doesNotMatch(on.body, /probe-root|demosAnnounceProvider|Demos Wallet extension probes/, `${method} ${path}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    for (const s of servers) await s.close();
    await issuer.close();
  }
}

// Built-in sign-in with an owner configured. The session lookup must not clear
// a stale cookie only with the switch on, and outside production the probe
// router must not change the asset handler's 403 stack for other paths.
const staleSession = { cookie: '_session=x; _session.sig=x' };
test('built-in sign-in: switch-on matches switch-off byte for byte through the full app, with and without a stale session cookie, in and outside production', async () => {
  for (const nodeEnv of ['production', 'test', 'development', undefined]) await builtinParity(nodeEnv);
});
async function builtinParity(nodeEnv) {
  const previous = process.env.NODE_ENV, servers = [];
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  try {
    const env = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32), DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT: 'probe-owner' };
    for (const probe of [{ DACS_WALLET_EXTENSION_PROBE: '1' }, {}]) {
      const h = await startHarness({ env: { ...env, ...probe } });
      servers.push(h);
      h.app.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('probe-owner', h.config.builtinIssuer, 'probe-owner', new Date().toISOString());
      h.app.services.accounts.linkWallet({ accountId: 'probe-owner', address: wallet.address, challengeId: 'fixture' });
    }
    assert.deepEqual(servers.map((s) => [s.config.authMode, s.config.walletExtensionProbe]), [['builtin', true], ['builtin', false]]);
    for (let round = 0; round < 3; round++) for (const path of [...probeTargets, ...assetTraversals, ...controls]) {
      for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) for (const headers of [{}, staleSession, { authorization: 'Bearer owner' }]) {
        const [on, off] = [await raw(servers[0].origin, method, path, headers), await raw(servers[1].origin, method, path, headers)];
        assert.deepEqual(on, off, `${nodeEnv} ${method} ${path} ${Object.keys(headers)} ${round}`);
        if (probeTargets.includes(path)) assert.deepEqual([on.status, on.body, on.headers['set-cookie']], [404, method === 'HEAD' ? '' : '{"error":"not_found"}', undefined], `${method} ${path}`);
        if (assetTraversals.includes(path) && ['GET', 'HEAD'].includes(method)) assert.equal(on.status, 403, `${method} ${path}`);
        assert.doesNotMatch(on.body, /probe-root|demosAnnounceProvider|Demos Wallet extension probes/, `${method} ${path}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    for (const s of servers) await s.close();
  }
}

// amountChanged is not always the pre-fork P4 rewrite.
test('the page gives the pre-fork SDK cause only for a pre-fork P4 answer', async () => {
  const cases = [
    ['P4 Sign native transfer only', await sdkCheck('native', false), true],
    ['P5 Sign storage CREATE only', await sdkCheck('storage', false, (c) => { c.amount = '0'; }), false],
    ['P4 Sign native transfer only', await sdkCheck('native', true, (c) => { c.amount = '2'; }), false],
    ['P5 Sign storage CREATE only', await sdkCheck('storage', true, (c) => { c.amount = '1'; }), false],
  ];
  const dom = installProbeDom();
  try {
    const { mountProbe } = await import('../public/wallet-extension-probe/main.mjs');
    for (const [label, { result }, preForkP4] of cases) {
      assert.equal(result.diffSummary.amountChanged, true, label);
      mountProbe(dom.root, { adapter: { report: () => ({}), connect: async () => ({ address: wallet.address }), signTransaction: async () => result } });
      await dom.button('P2 / P8 Connect (approve or deny in wallet)').click();
      dom.nodes().find((n) => n.attributes.type === 'checkbox').checked = true;
      await dom.button(label).click();
      const status = dom.nodes().find((n) => n.attributes.role === 'status').textContent;
      assert.match(status, /The amount was rewritten, in value or in format \(amountChanged\)\./, `${label} ${result.diffSummary.sdkProfile}`);
      (preForkP4 ? assert.match : assert.doesNotMatch)(status, /pre-fork SDK wallet does this to P4/, `${label} ${result.diffSummary.sdkProfile}`);
    }
  } finally { dom.restore(); }
});

test('docs: amountChanged covers a changed value or format, the nonce-1 setup transaction and built-in refusal headers', () => {
  const docs = readFileSync(new URL('../docs/WALLET-EXTENSION-PROBE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(docs, /changed unexpectedly, as in pre-fork P4/);
  assert.match(docs, /`amountChanged` is true when [^.]*: a changed value \(as in pre-fork P4, which signs amount 0\) or the same value in a changed format \(as in pre-fork P5 signing `"0"` instead of `0`\)\./);
  assert.match(docs, /The probe asks for a transaction signature only once nonce 1 is already used, so first send one ordinary testnet transaction from the key/);
  assert.match(docs, /With built-in sign-in, a refused request also gets the switch-off headers/);
  assert.match(docs, /mounts the probe router under `\/portal\/wallet-extension-probe` in every mode, so requests for any other path/);
});
