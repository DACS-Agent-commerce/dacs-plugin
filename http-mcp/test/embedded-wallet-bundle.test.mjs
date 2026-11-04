// Built browser runtime public/portal/embedded-wallet/demos-runtime.mjs (a local
// esbuild module graph: the entry plus runtime-chunks/, see runtime-manifest.json):
// public export contract and import-time WebAssembly behaviour, loaded in Node.
//
// Ordinary functional checks only: not a security review and not browser/CSP
// proof (the browser suites carry that). The page CSP is script-src 'self'
// without 'wasm-unsafe-eval', so any WebAssembly compilation at import time
// fails there. Upstream @kynesyslabs/demosdk 4.0.16 compiles node-seal WASM when
// encryption/FHE/index.js is evaluated (top-level `(async () => { seal = await
// SEAL(); })()`). The single-file build evaluated it on import; the code-split
// build keeps it out of the shipped graph (the SDK declares that module
// side-effect-free and the wallet never uses FHE). The regression below is the
// acceptance condition: zero WebAssembly compilations while importing.
//
// Node itself lazily compiles one WebAssembly module of its own (undici's
// llhttp HTTP parser) the first time code reads a fetch-related global such as
// Headers. That is host plumbing, absent in browsers, so it is triggered and
// attributed to node:internal/deps/undici BEFORE the measured import; nothing is
// filtered out of the measurement itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import net from 'node:net';
import { runtimeLoadSets } from '../scripts/embedded-wallet-runtime.mjs';

const walletDir = new URL('../public/portal/embedded-wallet/', import.meta.url);
const bundleUrl = new URL('demos-runtime.mjs', walletDir);
const manifestUrl = new URL('runtime-manifest.json', walletDir);
const BUNDLE_BLOCKED = existsSync(bundleUrl) && existsSync(manifestUrl) ? false : 'BLOCKED: demos-runtime.mjs / runtime-manifest.json have not been built (run node build.mjs in wallet-build/)';
const EXPECTED_EXPORTS = ['DEMOS_SDK_PACKAGE', 'DEMOS_SDK_VERSION', 'Demos', 'Identities', 'RUNTIME_LABEL', 'validateMnemonic'];

const networkAttempts = [];
net.Socket.prototype.connect = function trappedConnect() {
  networkAttempts.push('net.Socket.connect');
  throw new Error('network disabled in embedded wallet bundle tests');
};
globalThis.fetch = async () => {
  networkAttempts.push('fetch');
  throw new Error('network disabled in embedded wallet bundle tests');
};

// Every embedded-wallet file Node's module loader resolves, in order.
const resolvedWalletFiles = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith(walletDir.href)) resolvedWalletFiles.push(result.url.slice(walletDir.href.length));
    return result;
  },
});

// Record every WebAssembly compilation entry point. Each wrapper delegates to
// the original, so observed code behaves exactly as without the record.
const wasmCalls = [];
// Call sites, reported as diagnostics so a recorded compilation is attributable.
const wasmCallSites = [];
const callSite = () => new Error('call site').stack.split('\n').slice(2, 10).map((line) => line.trim()).join(' <- ');
const original = {
  compile: WebAssembly.compile,
  compileStreaming: WebAssembly.compileStreaming,
  instantiate: WebAssembly.instantiate,
  instantiateStreaming: WebAssembly.instantiateStreaming,
  Module: WebAssembly.Module,
};
for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']) {
  if (typeof original[name] !== 'function') continue;
  WebAssembly[name] = function recorded(...args) {
    wasmCalls.push(name);
    wasmCallSites.push(`${name}: ${callSite()}`);
    return original[name].apply(this, args);
  };
}
WebAssembly.Module = new Proxy(original.Module, {
  construct(target, args, newTarget) {
    wasmCalls.push('Module');
    wasmCallSites.push(`Module: ${callSite()}`);
    return Reflect.construct(target, args, newTarget);
  },
});

// Smallest valid module: "\0asm" + version 1.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Imports `href` and records WebAssembly use during the import plus a bounded
// window for asynchronous import-time work (node-seal's init is such work).
async function measureImport(href, windowMs = 1000) {
  const start = wasmCalls.length;
  const files = resolvedWalletFiles.length;
  const module = await import(href);
  await delay(windowMs);
  return { module, calls: wasmCalls.slice(start), sites: wasmCallSites.slice(start), resolved: resolvedWalletFiles.slice(files) };
}

test('control: the WebAssembly record observes compilation through each entry point', async () => {
  const start = wasmCalls.length;
  assert.ok(new WebAssembly.Module(EMPTY_WASM) instanceof original.Module);
  await WebAssembly.compile(EMPTY_WASM);
  await WebAssembly.instantiate(EMPTY_WASM);
  assert.deepEqual(wasmCalls.slice(start), ['Module', 'compile', 'instantiate']);
  wasmCalls.length = start;
  wasmCallSites.length = start;
});

test('control: an import whose top-level async init compiles WebAssembly is caught by the import measurement', async () => {
  // Same shape as node-seal's init in the SDK FHE module: an un-awaited async
  // IIFE at module top level.
  const source = `(async () => { await WebAssembly.instantiate(new Uint8Array([${EMPTY_WASM.join(',')}])); })(); export const marker = 1;`;
  const { module, calls } = await measureImport(`data:text/javascript,${encodeURIComponent(source)}`, 200);
  assert.equal(module.marker, 1);
  assert.deepEqual(calls, ['instantiate']);
});

test('host: Node\'s own lazily loaded fetch internals compile only undici WebAssembly, before the measured import', async (t) => {
  const start = wasmCalls.length;
  // Reading these globals loads Node's internal undici (fetch is trapped above).
  const fetchApi = { Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response, FormData: globalThis.FormData };
  for (const [name, value] of Object.entries(fetchApi)) assert.equal(typeof value, 'function', name);
  for (let waited = 0; waited < 3000 && !wasmCalls.slice(start).includes('instantiate'); waited += 20) await delay(20);
  await delay(100);
  const sites = wasmCallSites.slice(start);
  for (const site of sites) t.diagnostic(site);
  for (const site of sites) assert.match(site, /\(node:internal\/deps\/undici\//, 'host WebAssembly comes from Node\'s undici only');
});

let importRecord = null;
async function importBundle() {
  if (importRecord) return importRecord;
  // Minimal browser globals the bundle's browser code paths look up (as in
  // embedded-wallet-sdk.test.mjs); no DOM, network or storage is provided.
  globalThis.window ??= globalThis;
  globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  const { module, calls, sites, resolved } = await measureImport(bundleUrl.href);
  importRecord = { runtime: module, wasmDuringImport: calls, wasmCallSites: sites, resolved };
  return importRecord;
}

test('built runtime exports exactly the documented upstream SDK surface', { skip: BUNDLE_BLOCKED }, async () => {
  const { runtime } = await importBundle();
  assert.deepEqual(Object.keys(runtime).sort(), EXPECTED_EXPORTS);
  assert.equal(typeof runtime.Demos, 'function');
  assert.equal(typeof runtime.Identities, 'function');
  assert.equal(typeof runtime.validateMnemonic, 'function');
  assert.equal(runtime.DEMOS_SDK_PACKAGE, '@kynesyslabs/demosdk');
  assert.equal(runtime.DEMOS_SDK_VERSION, '4.0.16');
  assert.equal(runtime.RUNTIME_LABEL, 'upstream-demosdk-4.0.16-browser-bundle');
  assert.equal(runtime.validateMnemonic('correct horse battery staple'), false);
  assert.equal(runtime.validateMnemonic(42), false);
  const demos = new runtime.Demos();
  const mnemonic = demos.newMnemonic(128);
  assert.equal(runtime.validateMnemonic(mnemonic), true);
});

test('importing the built runtime compiles no WebAssembly (strict CSP without wasm-unsafe-eval)', { skip: BUNDLE_BLOCKED }, async (t) => {
  const { wasmDuringImport, wasmCallSites: sites } = await importBundle();
  t.diagnostic(`WebAssembly calls while importing the runtime: ${JSON.stringify(wasmDuringImport)}`);
  for (const site of sites) t.diagnostic(site);
  assert.deepEqual(wasmDuringImport, []);
});

test('importing the entry loads exactly the manifest\'s eager files; lazy chunks wait for their dynamic import()', { skip: BUNDLE_BLOCKED }, async () => {
  const { resolved } = await importBundle();
  const { eager, lazy } = runtimeLoadSets(JSON.parse(readFileSync(manifestUrl, 'utf8')));
  assert.ok(lazy.length > 0, 'the build has lazily loaded chunks');
  assert.deepEqual([...new Set(resolved)].sort(), eager);
});

test('no network was attempted while loading the runtime', () => {
  assert.deepEqual(networkAttempts, []);
});
