// DACS_SDK_PURCHASES (src/switches/DACS_SDK_PURCHASES.switch): the plugin's own purchase switch is an off/on enum that is off by default and in a deployment.
// loadConfig refuses `on` unless the chain RPC is a remote https node, every named SDK purchase part is in the client namespace, and the switch-on path is validated.
// The installed bin runs unhooked: it refuses `on` before it opens a database or listens, and boots with the switch off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as installedClient from '@kynesyslabs/dacs-client';
import { ConfigError, SWITCHES, loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';
import { CALLBACK_ORIGIN } from './helpers/harness.mjs';
import { linkedUser, tool, toolRaw } from './helpers/flows.mjs';
import { prepareArgs, switchOnHarness } from './helpers/switch-on-world.mjs';

const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const remoteChain = { DACS_CHAIN_RPC_URL: 'https://node.chain.invalid' };
const on = { ...base, ...remoteChain, DACS_SDK_PURCHASES: 'on' };
const entry = () => SWITCHES.find((s) => s.env === 'DACS_SDK_PURCHASES');
const refusedWith = (code, message) => (error) => error instanceof ConfigError && error.code === code && error.message === message;
const RECORDER_MISSING = 'sdk_part_missing: P19r createPurchaseEvidenceRecorder';
// An inert stand-in for the recorder factory: requireSdkPurchaseParts only looks the name up.
const inertRecorderFactory = () => { throw new Error('a placeholder is never called'); };

test('DACS_SDK_PURCHASES is off by default and its deploy value is off', () => {
  const s = entry();
  assert.ok(s, 'the switch file exists');
  assert.equal(s.kind, 'enum');
  assert.deepEqual([...s.values], ['off', 'on']);
  assert.equal(s.default, 'off');
  assert.equal(s.deployValue, 'off');
  assert.equal(s.configKey, 'sdkPurchases');
  assert.deepEqual(s.held, {}, 'on is a deploy setting, not a held value');
  assert.equal(loadConfig(base).sdkPurchases, 'off');
  assert.equal(loadConfig({ ...base, DACS_SDK_PURCHASES: 'off' }).sdkPurchases, 'off');
});

test('DACS_SDK_PURCHASES accepts only off or on, and 1, true and the empty string are refused by loadConfig', () => {
  assert.throws(() => loadConfig(on), (error) => error instanceof ConfigError && error.message !== 'DACS_SDK_PURCHASES must be off or on', 'on is a known value, refused later by its own rules');
  for (const value of ['1', 'true', '', 'ON', ' on']) {
    assert.throws(() => loadConfig({ ...base, DACS_SDK_PURCHASES: value }), (error) => error instanceof ConfigError && error.message === 'DACS_SDK_PURCHASES must be off or on', JSON.stringify(value));
  }
});

test('loadConfig with the evidence recorder absent refuses DACS_SDK_PURCHASES=on with sdk_part_missing naming its part, the installed namespace refuses the same way, with every named part present it refuses switch_on_not_validated, and off is accepted', () => {
  const withoutRecorder = { ...installedClient };
  delete withoutRecorder.createPurchaseEvidenceRecorder;
  assert.throws(() => loadConfig(on, { clientNamespace: withoutRecorder }), refusedWith('sdk_part_missing', RECORDER_MISSING));
  assert.equal(typeof installedClient.createPurchaseEvidenceRecorder, 'undefined', 'the installed client has no evidence recorder yet');
  assert.throws(() => loadConfig(on), refusedWith('sdk_part_missing', RECORDER_MISSING));
  const allNamed = { ...installedClient, createPurchaseEvidenceRecorder: inertRecorderFactory };
  assert.throws(() => loadConfig(on, { clientNamespace: allNamed }), (error) => error instanceof ConfigError && error.code === 'switch_on_not_validated' && error.message.startsWith('switch_on_not_validated: '));
  for (const clientNamespace of [withoutRecorder, allNamed, undefined]) {
    assert.equal(loadConfig({ ...base, ...remoteChain }, { clientNamespace }).sdkPurchases, 'off');
  }
});

test('with DACS_SDK_PURCHASES=on the chain RPC must be https and not loopback, checked before the SDK parts', () => {
  const allNamed = { ...installedClient, createPurchaseEvidenceRecorder: inertRecorderFactory };
  const message = 'DACS_SDK_PURCHASES=on requires an https, non-loopback DACS_CHAIN_RPC_URL';
  for (const chain of [{}, { DACS_CHAIN_RPC_URL: 'https://127.0.0.1:8443' }, { DACS_CHAIN_RPC_URL: 'https://localhost' }, { DACS_CHAIN_RPC_URL: 'http://localhost:9', DACS_ALLOW_INSECURE_LOCALHOST: '1' }]) {
    const env = { ...base, ...chain, DACS_SDK_PURCHASES: 'on' };
    assert.throws(() => loadConfig(env, { clientNamespace: allNamed }), (error) => error instanceof ConfigError && error.message === message, JSON.stringify(chain));
    assert.equal(loadConfig({ ...env, DACS_SDK_PURCHASES: 'off' }).sdkPurchases, 'off', 'off keeps any chain RPC the other settings allow');
  }
});

test('the configuration carries no chain identity of its own, whatever the environment says', () => {
  const config = loadConfig({ ...base, ...remoteChain, DACS_CHAIN_NETWORK: 'demos-testnet', DACS_CHAIN_PINNED_IDENTITY: 'ab'.repeat(32) });
  assert.deepEqual(Object.keys(config.chain).sort(), ['network', 'rpcUrl', 'timeoutMs']);
  assert.ok(!JSON.stringify(config).includes('ab'.repeat(32)));
});

const BIN = fileURLToPath(new URL('../bin/dacs-chatgpt-plugin.mjs', import.meta.url));
const SHIPPED_LOADCONFIG_CALLERS = ['bin/dacs-chatgpt-plugin.mjs', 'bin/offline-fixtures/operator.mjs'];
const silentLogger = () => createLogger({ level: 'error', sink: () => {} });

function scratchDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A bin run sees only PATH and these settings, never the test's own environment.
const binEnv = (dataDir, settings) => ({ PATH: process.env.PATH, DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir, HOST: '127.0.0.1', ...settings });

/** Runs the installed bin with the switch on to its exit. Returns its exit code, signal, output and the files left in its data directory. */
function runBinOn(t, extra = {}) {
  const dataDir = scratchDir(t, 'sdk-switch-on-');
  const run = spawnSync(process.execPath, [BIN], { env: binEnv(dataDir, { ...on, PORT: '0', ...extra }), encoding: 'utf8', timeout: 60_000 });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, dataFiles: readdirSync(dataDir) };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Starts the installed bin with every switch off and waits for its listening log line. Stopped with SIGTERM after the test. */
async function startBinOff(t) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [BIN], {
    env: binEnv(scratchDir(t, 'sdk-switch-off-'), { DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN, PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  for await (const line of createInterface({ input: child.stderr })) {
    if (line.includes('"event":"listening"')) break;
  }
  assert.equal(child.exitCode, null, 'the bin is still running');
  return { origin, mcpUrl: `${origin}/mcp`, stop: async () => { child.kill('SIGTERM'); const [code] = await exited; return code; } };
}

test('the actual installed bin with DACS_SDK_PURCHASES=on refuses through requireSdkPurchaseParts with code sdk_part_missing naming exactly the parts the installed pin lacks, the code and names the namespace test asserts for that namespace, exits 2, creates no database file and never listens; off boots and /health answers 200', async (t) => {
  const refused = runBinOn(t);
  assert.deepEqual(refused, { status: 2, signal: null, stdout: '', stderr: `configuration error: ${RECORDER_MISSING}\n`, dataFiles: [] });

  const bin = await startBinOff(t);
  const health = await fetch(`${bin.origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).sdkPurchases, { switch: 'off', evidence: 'unavailable' });
  assert.equal(await bin.stop(), 0, 'SIGTERM stops the bin cleanly');
});

test('every shipped call of loadConfig (bin/dacs-chatgpt-plugin.mjs and bin/offline-fixtures/operator.mjs) passes one argument; an environment variable clientNamespace and an environment variable DACS_CLIENT_NAMESPACE, each holding a namespace path, leave the unhooked installed bin\'s on result, exit, database and listener state equal to a plain run on the same pin; and with the bin running off, a purchase tool call carrying a clientNamespace argument still refuses sdk_purchases_off and changes no configuration', async (t) => {
  for (const file of SHIPPED_LOADCONFIG_CALLERS) {
    const calls = [...readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8').matchAll(/\bloadConfig\(([^()]*)\)/g)].map((match) => match[1]);
    assert.ok(calls.length > 0, file);
    assert.deepEqual(calls.filter((args) => args.includes(',') || args.trim() === ''), [], `${file} passes the environment alone`);
  }

  const namespaceFile = join(scratchDir(t, 'sdk-switch-namespace-'), 'namespace.mjs');
  writeFileSync(namespaceFile, 'export const createPurchaseEvidenceRecorder = () => ({});\n');
  const plain = runBinOn(t);
  for (const variable of ['clientNamespace', 'DACS_CLIENT_NAMESPACE']) {
    assert.deepEqual(runBinOn(t, { [variable]: namespaceFile }), plain, variable);
  }

  const bin = await startBinOff(t);
  const user = await linkedUser(bin);
  const purchase = { listingId: 'fixture-report', version: 1, seller: `did:demos:agent:${'a'.repeat(64)}`, idempotencyKey: 'switch-off-namespace-1' };
  const withNamespace = await toolRaw(bin, user, 'prepare_purchase', { ...purchase, clientNamespace: namespaceFile }).catch((error) => ({ isError: true, content: [{ text: error.message }] }));
  assert.equal(withNamespace.isError, true, 'a clientNamespace argument is refused');
  assert.equal((await tool(bin, user, 'prepare_purchase', purchase)).error, 'sdk_purchases_off');
  assert.deepEqual((await (await fetch(`${bin.origin}/health`)).json()).sdkPurchases, { switch: 'off', evidence: 'unavailable' }, 'the configuration is unchanged');
  assert.equal(await bin.stop(), 0);
});

test('with DACS_SDK_PURCHASES off a purchase never reaches a client purchase path', async (t) => {
  const dataDir = scratchDir(t, 'sdk-switch-app-');
  const config = loadConfig({ ...base, DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: dataDir });
  const app = await createApp({ config, logger: silentLogger() });
  t.after(() => app.close());
  await assert.rejects(app.services.purchases.prepare({ accountId: 'acct_1', listingId: 'fixture-report', version: 1 }), (error) => error.code === 'sdk_purchases_off');
});

test('with DACS_SDK_PURCHASES=on, a purchase reaches the SDK client purchase path; a build without that path refuses `on` at config load', async (t) => {
  assert.throws(() => loadConfig(on), (error) => error instanceof ConfigError && error.code === 'sdk_part_missing');
  const { h, node } = await switchOnHarness(t);
  const user = await linkedUser(h);
  const readsAtStartup = node.reads.length;
  // The client's own purchase hold answers: the call went through the session's client purchase service.
  const prepared = await tool(h, user, 'prepare_purchase', { listingId: 'fixture-report', version: 1, seller: user.wallet.claim, idempotencyKey: 'switch-on-1' });
  assert.equal(prepared.error, 'profile_not_admitted');
  assert.ok(node.reads.length > readsAtStartup, 'the buyer session bound over the node before the client answered');
  await assert.rejects(h.app.services.purchases.prepare(prepareArgs(h, user, 'switch-on-2')), (error) => error.code === 'profile_not_admitted' && error.cause === undefined);
});
