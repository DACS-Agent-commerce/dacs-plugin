// Packaging-correctness tests for the generated embedded-wallet runtime graph
// helper (scripts/embedded-wallet-runtime.mjs) and for the shipped graph itself.
//
// Contract (docs/EMBEDDED-WALLET-PACKAGING.md): demos-runtime.mjs is the stable
// entry; every other graph file is runtime-chunks/<name>.mjs; runtime-manifest.json
// lists every graph file with exact bytes and SHA-256 and its local static and
// dynamic imports; all imports are relative and resolve to declared files; the
// static+dynamic closure from the entry is exactly the declared set; nothing
// undeclared sits in runtime-chunks/; identity pins are demosdk 4.0.20 and
// esbuild 0.25.12. Fixture manifests are written by hand here (not by
// serializeRuntimeManifest), and each negative case starts from the accepting
// control and changes one thing, re-hashing the changed file so the targeted
// rule, not a stale hash, is what fails. Ordinary offline fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RUNTIME_CHUNK_DIR, RUNTIME_ENTRY, RUNTIME_MANIFEST, RUNTIME_MANIFEST_SCHEMA, checkRuntimeGraph, readRuntimeGraphFiles,
  resolveLocal, runtimeLoadSets, scanModuleSpecifiers, serializeRuntimeManifest,
} from '../scripts/embedded-wallet-runtime.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');

// SYNTHETIC graph shaped like esbuild split output. Not the SDK.
const FIXTURE_SOURCES = {
  'demos-runtime.mjs': '/* SYNTHETIC entry */\nexport * from "./runtime-chunks/entry-A.mjs";\n',
  'runtime-chunks/entry-A.mjs': '/* c */import{a as b}from"./chunk-B.mjs";export const Demos=b;export const later=()=>import("./lazy-C.mjs");',
  // A string that merely looks like an import, after the prologue: not an import.
  'runtime-chunks/chunk-B.mjs': '/* c */export const a=1;export const s="loaded from \'./not-a-file.mjs\' later";',
  'runtime-chunks/lazy-C.mjs': '/* c */import"./chunk-B.mjs";export const c=2;',
};
const FIXTURE_EDGES = {
  'demos-runtime.mjs': { imports: ['runtime-chunks/entry-A.mjs'], dynamicImports: [] },
  'runtime-chunks/entry-A.mjs': { imports: ['runtime-chunks/chunk-B.mjs'], dynamicImports: ['runtime-chunks/lazy-C.mjs'] },
  'runtime-chunks/chunk-B.mjs': { imports: [], dynamicImports: [] },
  'runtime-chunks/lazy-C.mjs': { imports: ['runtime-chunks/chunk-B.mjs'], dynamicImports: [] },
};

function fixture({ sources = FIXTURE_SOURCES, edges = FIXTURE_EDGES, patch = (m) => m } = {}) {
  const manifest = patch({
    schema: RUNTIME_MANIFEST_SCHEMA,
    entry: 'demos-runtime.mjs',
    runtimeLabel: 'upstream-demosdk-4.0.20-browser-bundle',
    sdk: { name: '@kynesyslabs/demosdk', version: '4.0.20' },
    esbuild: '0.25.12',
    shippedPackages: [],
    noticePackages: [],
    files: Object.keys(sources).sort().map((path) => ({
      path, bytes: Buffer.byteLength(sources[path]), sha256: hash(sources[path]), ...(edges[path] ?? { imports: [], dynamicImports: [] }),
    })),
  });
  const files = new Map(Object.entries(sources).map(([path, text]) => [path, Buffer.from(text)]));
  files.set(RUNTIME_MANIFEST, Buffer.from(JSON.stringify(manifest)));
  return files;
}

const withSources = (changes) => ({ ...FIXTURE_SOURCES, ...changes });

test('control: the synthetic split graph passes, and its eager/lazy sets follow the declared edges', () => {
  assert.deepEqual(checkRuntimeGraph(fixture()), []);
  assert.deepEqual(runtimeLoadSets(JSON.parse(fixture().get(RUNTIME_MANIFEST))), {
    eager: ['demos-runtime.mjs', 'runtime-chunks/chunk-B.mjs', 'runtime-chunks/entry-A.mjs'],
    lazy: ['runtime-chunks/lazy-C.mjs'],
  });
});

test('a missing lazily loaded chunk is reported, not only eagerly imported files', () => {
  const files = fixture();
  files.delete('runtime-chunks/lazy-C.mjs');
  assert.deepEqual(checkRuntimeGraph(files), ['runtime-chunks/lazy-C.mjs missing']);
});

test('changed bytes of one declared file are reported for that file only', () => {
  const files = fixture();
  const bytes = Buffer.from(files.get('runtime-chunks/chunk-B.mjs'));
  bytes[bytes.length - 1] ^= 1;
  files.set('runtime-chunks/chunk-B.mjs', bytes);
  assert.deepEqual(checkRuntimeGraph(files), [`runtime-chunks/chunk-B.mjs bytes/sha256 differ from manifest (${bytes.length} ${hash(bytes)})`]);
});

test('an undeclared file in runtime-chunks/ is reported', () => {
  const files = fixture();
  files.set('runtime-chunks/extra.mjs', Buffer.from('export {};'));
  assert.deepEqual(checkRuntimeGraph(files), ['runtime-chunks/extra.mjs present but not declared']);
});

test('bare, URL, computed and escaping imports are each reported as non-local', () => {
  const cases = [
    ['import"axios";export const c=2;', '"axios"'],
    ['import{x}from"https://cdn.example.test/x.mjs";export const c=2;', '"https://cdn.example.test/x.mjs"'],
    ['export const c=()=>import("https://cdn.example.test/y.mjs");', '"https://cdn.example.test/y.mjs"'],
    ['export const c=(u)=>import(u);', '"<computed:u>"'],
    ['import"../../index.mjs";export const c=2;', '"../../index.mjs"'],
  ];
  for (const [text, specifier] of cases) {
    const files = fixture({ sources: withSources({ 'runtime-chunks/lazy-C.mjs': text }), edges: { ...FIXTURE_EDGES, 'runtime-chunks/lazy-C.mjs': { imports: [], dynamicImports: [] } } });
    assert.deepEqual(checkRuntimeGraph(files), [`runtime-chunks/lazy-C.mjs imports non-local ${specifier}`], text);
  }
});

test('an import of an undeclared local chunk is reported', () => {
  const text = 'import{a as b}from"./chunk-B.mjs";import"./chunk-Z.mjs";export const Demos=b;export const later=()=>import("./lazy-C.mjs");';
  const files = fixture({ sources: withSources({ 'runtime-chunks/entry-A.mjs': text }) });
  assert.deepEqual(checkRuntimeGraph(files), ['runtime-chunks/entry-A.mjs imports undeclared runtime-chunks/chunk-Z.mjs']);
});

test('declared edges that differ from the shipped bytes are reported', () => {
  const files = fixture({ edges: { ...FIXTURE_EDGES, 'runtime-chunks/lazy-C.mjs': { imports: [], dynamicImports: [] } } });
  assert.deepEqual(checkRuntimeGraph(files), ['runtime-chunks/lazy-C.mjs declared imports [] != found ["runtime-chunks/chunk-B.mjs"]']);
  const dynamicAsStatic = fixture({ edges: { ...FIXTURE_EDGES, 'runtime-chunks/entry-A.mjs': { imports: ['runtime-chunks/chunk-B.mjs', 'runtime-chunks/lazy-C.mjs'], dynamicImports: [] } } });
  assert.deepEqual(checkRuntimeGraph(dynamicAsStatic), [
    'runtime-chunks/entry-A.mjs declared imports ["runtime-chunks/chunk-B.mjs","runtime-chunks/lazy-C.mjs"] != found ["runtime-chunks/chunk-B.mjs"]',
    'runtime-chunks/entry-A.mjs declared dynamicImports [] != found ["runtime-chunks/lazy-C.mjs"]',
  ]);
});

test('a declared file no import reaches is reported', () => {
  const files = fixture({ sources: withSources({ 'runtime-chunks/orphan.mjs': 'export const o=1;' }) });
  assert.deepEqual(checkRuntimeGraph(files), ['runtime-chunks/orphan.mjs declared but unreachable from demos-runtime.mjs']);
});

test('identity pins, schema, entry and declared paths are enforced', () => {
  const cases = [
    [(m) => ({ ...m, sdk: { name: '@kynesyslabs/demosdk', version: '4.0.17' } }), 'sdk {"name":"@kynesyslabs/demosdk","version":"4.0.17"} != @kynesyslabs/demosdk@4.0.20'],
    [(m) => ({ ...m, esbuild: '0.25.11' }), 'esbuild "0.25.11" != 0.25.12'],
    [(m) => ({ ...m, schema: 'other/1' }), `schema "other/1" != ${RUNTIME_MANIFEST_SCHEMA}`],
    [(m) => ({ ...m, runtimeLabel: 'patched' }), 'runtimeLabel "patched" != upstream-demosdk-4.0.20-browser-bundle'],
  ];
  for (const [patch, problem] of cases) assert.deepEqual(checkRuntimeGraph(fixture({ patch })), [problem]);
  const traversal = fixture({ patch: (m) => ({ ...m, files: [...m.files, { path: '../secret.mjs', bytes: 1, sha256: '0'.repeat(64), imports: [], dynamicImports: [] }] }) });
  assert.deepEqual(checkRuntimeGraph(traversal), ['declared path "../secret.mjs" is not demos-runtime.mjs or runtime-chunks/<name>.mjs']);
  // files[1] in path order is runtime-chunks/chunk-B.mjs.
  const duplicate = fixture({ patch: (m) => ({ ...m, files: [...m.files, m.files[1]] }) });
  assert.deepEqual(checkRuntimeGraph(duplicate), ['runtime-chunks/chunk-B.mjs declared twice']);
});

test('a missing or unreadable manifest is reported', () => {
  const files = fixture();
  files.delete(RUNTIME_MANIFEST);
  assert.deepEqual(checkRuntimeGraph(files), ['runtime-manifest.json missing']);
  files.set(RUNTIME_MANIFEST, Buffer.from('{"schema":'));
  assert.match(checkRuntimeGraph(files).join(), /^runtime manifest is not JSON: /);
});

test('scanModuleSpecifiers reads esbuild prologue imports and import() calls, not look-alike strings', () => {
  assert.deepEqual(scanModuleSpecifiers('/* a */\n// b\nimport{x as y}from"./a.mjs";import*as n from"./b.mjs";import"./c.mjs";export*from"./d.mjs";export{z}from"./e.mjs";const s="x from \'./no.mjs\'";f(()=>import("./lazy.mjs"));'), {
    static: ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs'],
    dynamic: ['./lazy.mjs'],
  });
  assert.equal(resolveLocal('runtime-chunks/a.mjs', './b.mjs'), 'runtime-chunks/b.mjs');
  assert.equal(resolveLocal('demos-runtime.mjs', './runtime-chunks/b.mjs'), 'runtime-chunks/b.mjs');
  assert.equal(resolveLocal('demos-runtime.mjs', '../x.mjs'), null);
  assert.equal(resolveLocal('runtime-chunks/a.mjs', 'buffer'), null);
});

test('serializeRuntimeManifest is deterministic and its output passes the check', () => {
  const files = new Map(Object.entries(FIXTURE_SOURCES).map(([p, t]) => [p, Buffer.from(t)]));
  const edges = new Map(Object.entries(FIXTURE_EDGES));
  const forward = serializeRuntimeManifest({ files, edges, esbuildVersion: '0.25.12', shippedPackages: ['b@1', 'a@1', 'a@1'] });
  const reversed = serializeRuntimeManifest({ files: new Map([...files].reverse()), edges: new Map([...edges].reverse()), esbuildVersion: '0.25.12', shippedPackages: ['a@1', 'b@1'] });
  assert.equal(forward, reversed);
  assert.deepEqual(JSON.parse(forward).shippedPackages, ['a@1', 'b@1']);
  assert.deepEqual(checkRuntimeGraph(new Map([...files, [RUNTIME_MANIFEST, Buffer.from(forward)]])), []);
});

// ---- the real generated graph (packaging only, not wallet behaviour) ----------

const realDir = new URL('../public/portal/embedded-wallet/', import.meta.url);

test('real shipped graph: closed, local, pinned, content-named, with lazy chunks and no FHE/node-seal code', () => {
  const files = readRuntimeGraphFiles(realDir);
  assert.deepEqual(checkRuntimeGraph(files), []);
  const manifest = JSON.parse(files.get(RUNTIME_MANIFEST));
  assert.equal(manifest.entry, RUNTIME_ENTRY);
  for (const { path } of manifest.files) if (path !== RUNTIME_ENTRY) assert.match(path, new RegExp(`^${RUNTIME_CHUNK_DIR}/(chunk|entry)-[A-Z0-9]{8}\\.mjs$`), path);
  const { eager, lazy } = runtimeLoadSets(manifest);
  assert.ok(eager.includes(RUNTIME_ENTRY) && lazy.length > 0, 'eager entry plus lazily loaded chunks');
  assert.ok(manifest.shippedPackages.includes('@kynesyslabs/demosdk@4.0.20'));
  assert.ok(!manifest.shippedPackages.some((id) => id.startsWith('node-seal@')), 'node-seal code is not shipped');
  for (const id of manifest.shippedPackages) assert.ok(manifest.noticePackages.includes(id), `notices cover ${id}`);
  const notices = files.get(RUNTIME_ENTRY).toString('utf8');
  for (const id of manifest.noticePackages) assert.ok(notices.includes(`${id} — license:`), `notice for ${id}`);
});
