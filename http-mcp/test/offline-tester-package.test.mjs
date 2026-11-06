// Deterministic helpers of scripts/check-offline-tester-package.mjs: the
// installed-import oracle, the secret scan and argument parsing. The checker's
// pack/install/browser run itself is executed separately (it needs npm and Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { importFindings, secretHits, parseArgs, probePort, LAUNCHER_FILES, inside, toolingPreflight, compareNodeVersions, SOURCE_CHECKER_MIN_NODE, walletUiState, backupExportComplete, backupTextProblems, waitForWalletState } from '../scripts/check-offline-tester-package.mjs';

test('tooling preflight: supported runtime passes; missing registerHooks and older Node fail with a clear message', () => {
  const hook = () => {};
  assert.equal(SOURCE_CHECKER_MIN_NODE, '22.15.0');
  // Otherwise-valid controls: only the property under test differs.
  assert.deepEqual(toolingPreflight({ version: '22.22.0', registerHooks: hook }), []);
  assert.deepEqual(toolingPreflight({ version: '22.15.0', registerHooks: hook }), []);
  const missing = toolingPreflight({ version: '22.22.0', registerHooks: undefined });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /node:module\.registerHooks is not available/);
  const older = toolingPreflight({ version: '22.13.0', registerHooks: hook });
  assert.equal(older.length, 1);
  assert.match(older[0], /needs Node >= 22\.15\.0 \(tested on 22\.22\.0\); this is Node 22\.13\.0\. The installed launcher itself still supports Node >= 22\.13/);
  assert.equal(toolingPreflight({ version: '22.13.0', registerHooks: undefined }).length, 2);
  // The real runtime running this test (the helper's Node 22.22.0) is supported.
  assert.deepEqual(toolingPreflight(), []);
});

test('Node version comparison boundaries', () => {
  assert.equal(compareNodeVersions('22.14.9', '22.15.0'), -1);
  assert.equal(compareNodeVersions('v22.15.0', '22.15.0'), 0);
  assert.equal(compareNodeVersions('22.15.1', '22.15.0'), 1);
  assert.equal(compareNodeVersions('23.0.0', '22.15.0'), 1);
  assert.equal(compareNodeVersions('22.9.0', '22.15.0'), -1, 'numeric, not lexical');
});

test('wallet UI diagnostics report public state only (never textarea or input values)', async () => {
  const backupValue = 'BACKUP-CIPHERTEXT-SHOULD-NOT-APPEAR';
  const node = (props) => ({ hidden: false, disabled: false, textContent: '', ...props });
  const textarea = node({ hidden: false, value: backupValue });
  const errorLine = node({ hidden: true, textContent: 'Could not export the encrypted backup.' });
  const root = {
    getAttribute: (name) => (name === 'aria-busy' ? 'false' : null),
    querySelectorAll: () => [node({ textContent: 'Export encrypted backup' }), node({ textContent: 'Lock wallet', disabled: true })],
    querySelector: (sel) => ({ h2: node({ textContent: 'Wallet unlocked' }), '.ew-error': errorLine, 'textarea.ew-backup-text': textarea })[sel] ?? null,
  };
  const previous = globalThis.document;
  const previousStyle = globalThis.getComputedStyle;
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true, getElementById: () => root, querySelector: () => null };
  globalThis.getComputedStyle = () => ({ display: 'block' });
  try {
    const state = await walletUiState({ evaluate: async (fn) => fn() });
    assert.deepEqual(state, {
      visibility: 'visible', hasFocus: true, walletRoot: true, ariaBusy: 'false', heading: 'Wallet unlocked', errorText: null,
      exportButton: { disabled: false }, backupTextShown: true, backupTextRendered: true, backupTextHasValue: true,
      restoreButton: null, unlockButton: null, dialogOpen: false,
    });
    assert.ok(!JSON.stringify(state).includes(backupValue));
    errorLine.hidden = false;
    assert.equal((await walletUiState({ evaluate: async (fn) => fn() })).errorText, 'Could not export the encrypted backup.');
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
    if (previousStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousStyle;
  }
});

// Regression for the installed-run backup failure: a visibility wait
// resolved while the export handler was still busy, because the CSS renders
// the still-`hidden` textarea, and an empty backup was restored.
const BROKEN_F2 = { ariaBusy: 'true', exportButton: { disabled: true }, backupTextShown: false, backupTextRendered: true, backupTextHasValue: false };
const DONE_F2 = { ariaBusy: 'false', exportButton: { disabled: false }, backupTextShown: true, backupTextRendered: true, backupTextHasValue: true };

test('export completion requires shown + value + not busy; the recorded broken state is not complete', () => {
  assert.equal(backupExportComplete(DONE_F2), true, 'valid control');
  assert.equal(backupExportComplete(BROKEN_F2), false, 'exact recorded failing state');
  // One property differs from the valid control each time.
  assert.equal(backupExportComplete({ ...DONE_F2, ariaBusy: 'true' }), false);
  assert.equal(backupExportComplete({ ...DONE_F2, backupTextShown: false }), false);
  assert.equal(backupExportComplete({ ...DONE_F2, backupTextHasValue: false }), false);
  // Rendered-by-CSS alone (the old visibility signal) is not completion.
  assert.equal(backupExportComplete({ ...BROKEN_F2, backupTextRendered: true }), false);
  assert.equal(backupExportComplete(undefined), false);
});

test('backup text precondition: names the wallet address; empty/garbage/other address rejected without echoing text', () => {
  const address = `0x${'ab'.repeat(32)}`;
  const valid = JSON.stringify({ notice: 'x', version: 1, address, kdf: {}, ciphertext: 'c' });
  assert.deepEqual(backupTextProblems(valid, address), []);
  assert.deepEqual(backupTextProblems(valid, address.toUpperCase().replace('0X', '0x')), []);
  assert.deepEqual(backupTextProblems('', address), ['backup text is empty']);
  assert.deepEqual(backupTextProblems('   ', address), ['backup text is empty']);
  assert.deepEqual(backupTextProblems('{"address":', address), ['backup text is not JSON']);
  assert.deepEqual(backupTextProblems('[1]', address), ['backup text is not a JSON object']);
  assert.deepEqual(backupTextProblems(JSON.stringify({ address: `0x${'cd'.repeat(32)}` }), address), ['backup does not name the wallet address']);
  assert.ok(backupTextProblems('secret-ish garbage', address).every((p) => !p.includes('garbage')));
});

test('bounded wallet-state wait: resolves when the predicate holds, times out with the last state otherwise', async () => {
  const sequence = [BROKEN_F2, BROKEN_F2, DONE_F2];
  let i = 0;
  const ok = await waitForWalletState(null, backupExportComplete, { timeoutMs: 2000, intervalMs: 5, read: async () => sequence[Math.min(i++, sequence.length - 1)] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.state, DONE_F2);
  const started = Date.now();
  const stuck = await waitForWalletState(null, backupExportComplete, { timeoutMs: 60, intervalMs: 5, read: async () => BROKEN_F2 });
  assert.equal(stuck.ok, false);
  assert.deepEqual(stuck.state, BROKEN_F2);
  assert.ok(Date.now() - started < 1000, 'bounded');
});

const projectRoot = '/tmp/otpkg/project';
const packageRoot = `${projectRoot}/node_modules/@dacs-agent-commerce/dacs-chatgpt-plugin`;
const sourceRoot = '/srv/checkout/chatgpt';
const url = (p) => pathToFileURL(p).href;
const findings = (p) => importFindings({ url: p.startsWith('node:') || p.includes('://') ? p : url(p), projectRoot, packageRoot, sourceRoot });

test('import oracle accepts builtins and modules inside the install project', () => {
  assert.deepEqual(findings('node:crypto'), []);
  assert.deepEqual(findings(`${packageRoot}/src/app.mjs`), []);
  assert.deepEqual(findings(`${projectRoot}/node_modules/express/index.js`), []);
  // Regression (first installed run): a dependency's own `test` module is a
  // runtime module, not a plugin test file.
  assert.deepEqual(findings(`${packageRoot}/node_modules/@swaggerexpert/jsonpath/es/test/index.mjs`), []);
});

test('import oracle rejects source checkout, plugin test/wallet-build and dev-dependency modules', () => {
  assert.match(findings(`${sourceRoot}/src/app.mjs`).join(), /outside the install project.*source checkout/);
  assert.match(findings(`${packageRoot}/test/helpers/harness.mjs`).join(), /plugin test or wallet-build/);
  assert.match(findings(`${packageRoot}/wallet-build/build.mjs`).join(), /plugin test or wallet-build/);
  assert.match(findings(`${projectRoot}/node_modules/playwright-core/index.mjs`).join(), /dev dependency/);
  assert.match(findings('https://cdn.example/x.mjs').join(), /non-file import/);
});

test('port probe: accepting while listening, refused after close (fresh TCP, not a pooled fetch)', async () => {
  const server = http.createServer((_req, res) => res.end('x'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await probePort(origin), 'accepting');
  await new Promise((r) => server.close(r));
  assert.equal(await probePort(origin), 'refused');
});

test('secret scan finds raw and re-encoded secrets and reports only labels', () => {
  const secret = 'abandon ability able about above absent';
  const hits = secretHits(['clean', { body: encodeURIComponent(secret) }, Buffer.from(secret).toString('base64url')], [secret]);
  assert.deepEqual(hits, [1, 2].map((item) => `secret ${'#'}0 in item ${'#'}${item}`));
  assert.ok(hits.every((h) => !h.includes('abandon')));
  assert.deepEqual(secretHits(['nothing here'], [secret]), []);
});

test('arguments: --keep, bounded overall timeout, unknown refused; launcher file list covers bin and doc', () => {
  assert.deepEqual(parseArgs([]), { keep: false, overallTimeoutMs: 540_000 });
  assert.equal(parseArgs(['--keep']).keep, true);
  assert.throws(() => parseArgs(['--overall-timeout-ms', '10']), /overall-timeout-ms/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.ok(LAUNCHER_FILES.includes('bin/dacs-chatgpt-offline-test.mjs'));
  assert.ok(LAUNCHER_FILES.includes('bin/offline-fixtures/operator.mjs'));
  assert.ok(LAUNCHER_FILES.includes('docs/OFFLINE-TESTER.md'));
  assert.equal(inside('/a/b', '/a/b/c'), true);
  assert.equal(inside('/a/b', '/a/bc'), false);
});
