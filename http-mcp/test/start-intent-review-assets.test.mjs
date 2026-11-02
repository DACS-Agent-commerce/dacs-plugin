import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet } from 'node:http';
import { startHarness } from './helpers/harness.mjs';
const PUBLIC = fileURLToPath(new URL('../public/portal/', import.meta.url));

for (const [name, headers, method] of [
  ['Range', { range: 'bytes=0-9' }, 'GET'],
  ['HEAD', {}, 'HEAD'],
  ['conditional GET', {}, 'GET'],
]) {
  test(`switch-off ${name} uses shipped-file static semantics`, async t => {
    const h = await startHarness(); t.after(() => h.close());
    const path = '/portal/assets/portal.js'; const full = await fetch(h.origin + '/portal/assets/portal%2ejs');
    const etag = full.headers.get('etag'); const modified = full.headers.get('last-modified'); const bytes = Buffer.from(await full.arrayBuffer());
    const disk = readFileSync(join(PUBLIC, 'portal.js'));
    const requestHeaders = name === 'conditional GET' ? { 'if-none-match': etag } : headers;
    // fetch adds cache-control:no-cache for validators; use an ordinary HTTP conditional request.
    const r = await new Promise((resolve, reject) => {
      const req = httpGet(h.origin + path, { headers: requestHeaders, method }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: { get: key => res.headers[key] }, body: Buffer.concat(chunks) }));
      }); req.on('error', reject);
    }); const body = r.body;
    assert.equal(r.status, name === 'Range' ? 206 : name === 'conditional GET' ? 304 : 200);
    assert.equal(r.headers.get('etag'), etag); assert.equal(r.headers.get('last-modified'), modified); assert.ok(modified);
    if (name === 'Range') { assert.equal(r.headers.get('content-range'), `bytes 0-9/${disk.length}`); assert.deepEqual(body, disk.subarray(0, 10)); }
    else if (name === 'HEAD') { assert.equal(r.headers.get('content-length'), String(disk.length)); assert.equal(body.length, 0); }
    else assert.equal(body.length, 0);
    assert.deepEqual(bytes, disk);
  });
}
for (const spelling of ['/portal/assets//portal.js', '/portal/assets/portal%2ejs', '/portal/assets/embedded-wallet%2Fapproval.mjs', '/portal/assets/embedded-wallet/approval%2emjs']) {
  test(`switch-off alternate path ${spelling} has no intent hooks`, async t => {
    const h = await startHarness(); t.after(() => h.close());
    const r = await fetch(h.origin + spelling); assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), /startIntent|approvePurchaseIntent|\/\*intent\{|\}intent\*\//);
  });
}
for (const [name, marker] of [['missing close', '/*intent{*/ evil();'], ['nested', '/*intent{*/ a /*intent{*/ b /*}intent*/ c /*}intent*/'], ['orphan close', 'evil(); /*}intent*/']]) {
  test(`startup rejects ${name} markers`, async () => {
    const { applyIntentHooks } = await import('../src/portal/intent-hooks.mjs');
    const dir = mkdtempSync(join(process.env.TMPDIR, 'hooks-')); mkdirSync(join(dir, 'embedded-wallet'));
    try {
      for (const name of ['portal.js', 'embedded-wallet/approval.mjs', 'embedded-wallet-bridge.mjs', 'embedded-wallet/sdk-provider.mjs']) writeFileSync(join(dir, name), readFileSync(join(PUBLIC, name)));
      writeFileSync(join(dir, 'portal.js'), readFileSync(join(dir, 'portal.js'), 'utf8') + marker);
      assert.throws(() => applyIntentHooks(dir), /refusing to start/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const damage of ['missing', 'duplicate']) {
  test(`startup rejects a ${damage} hook anchor`, async () => {
    const { applyIntentHooks, INTENT_HOOKS } = await import('../src/portal/intent-hooks.mjs'); const hook = INTENT_HOOKS[0];
    const dir = mkdtempSync(join(process.env.TMPDIR, 'hooks-')); mkdirSync(join(dir, 'embedded-wallet'));
    try {
      for (const name of ['portal.js', 'embedded-wallet/approval.mjs', 'embedded-wallet-bridge.mjs', 'embedded-wallet/sdk-provider.mjs']) writeFileSync(join(dir, name), readFileSync(join(PUBLIC, name)));
      const text = readFileSync(join(dir, hook.asset), 'utf8'); writeFileSync(join(dir, hook.asset), damage === 'missing' ? text.replace(hook.anchor, '') : text + hook.anchor);
      assert.throws(() => applyIntentHooks(dir), /refusing to start/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('the release checker receives the exact shipped approval asset with the switch off', async t => {
  const h = await startHarness(); t.after(() => h.close());
  const { fetchAsset, checkAssetResponse } = await import('../scripts/check-embedded-wallet-package.mjs');
  const path = 'public/portal/embedded-wallet/approval.mjs';
  assert.deepEqual(checkAssetResponse(path, readFileSync(join(PUBLIC, 'embedded-wallet/approval.mjs')), await fetchAsset(h.origin, path)), []);
});

test('healthy source anchors insert each switch-on hook once', async () => {
  const { applyIntentHooks, INTENT_HOOKS } = await import('../src/portal/intent-hooks.mjs');
  const assets = applyIntentHooks(PUBLIC);
  for (const hook of INTENT_HOOKS) assert.equal(assets.get(hook.asset).body.toString('utf8').split(hook.replacement).length, 2);
});
