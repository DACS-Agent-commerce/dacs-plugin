// Reproducible build of the embedded wallet SDK runtime from the exact pinned
// upstream @kynesyslabs/demosdk 4.0.16 using esbuild 0.25.12.
//
// Run from chatgpt/wallet-build after an `npm install --ignore-scripts`:
//   node build.mjs
// Output is a local ES module graph under public/portal/embedded-wallet/:
//   demos-runtime.mjs       stable entry: re-exports the built entry chunk and
//                           ends with the license notices of every bundled package
//   runtime-chunks/*.mjs    content-named esbuild chunks (code splitting)
//   runtime-manifest.json   every graph file with bytes, SHA-256 and its local
//                           static/dynamic imports, plus SDK/esbuild identity
// Every import in the graph is a relative path inside runtime-chunks/; no bare,
// URL or CDN imports. Code splitting lets esbuild keep modules that are only
// reached through the SDK's own dynamic import() calls, or that the SDK
// package declares side-effect-free and the wallet never uses, out of the
// files evaluated on import. The SDK source is not modified.
//
// Stale chunks are deleted only when the previous runtime-manifest.json lists
// them; any other unexpected file in runtime-chunks/ stops the build.
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import {
  RUNTIME_CHUNK_DIR, RUNTIME_ENTRY, RUNTIME_MANIFEST, checkRuntimeGraph, closureFrom, isRuntimeGraphPath, parseRuntimeManifest,
  runtimeLoadSets, runtimeManifestPaths, serializeRuntimeManifest,
} from '../scripts/embedded-wallet-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const walletDir = join(here, '..', 'public', 'portal', 'embedded-wallet');
const chunkDir = join(walletDir, RUNTIME_CHUNK_DIR);
const EXPECTED = { '@kynesyslabs/demosdk': '4.0.16', esbuild: '0.25.12' };

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertPins() {
  const manifest = readJson(join(here, 'package.json'));
  const deps = manifest.dependencies ?? {};
  if (JSON.stringify(deps) !== JSON.stringify(EXPECTED) || manifest.scripts) {
    throw new Error(`wallet-build/package.json must pin exactly ${JSON.stringify(EXPECTED)} with no scripts`);
  }
  for (const [name, version] of Object.entries(EXPECTED)) {
    const installed = readJson(join(here, 'node_modules', name, 'package.json')).version;
    if (installed !== version) throw new Error(`installed ${name}@${installed}, expected ${version}`);
  }
  if (esbuild.version !== EXPECTED.esbuild) throw new Error(`esbuild runtime ${esbuild.version}, expected ${EXPECTED.esbuild}`);
}

// node_modules/<name>/... or node_modules/@scope/<name>/..., innermost wins.
function packageRootOf(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const length = parts[at + 1]?.startsWith('@') ? 3 : 2;
  return parts.slice(0, at + length).join('/');
}

function noticeFor(root) {
  const manifest = readJson(join(here, root, 'package.json'));
  const files = readdirSync(join(here, root))
    .filter((name) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(name))
    .sort();
  const texts = files.map((name) => `--- ${name} ---\n${readFileSync(join(here, root, name), 'utf8').trim()}`);
  const license = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? null);
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
  const header = `${manifest.name}@${manifest.version} — license: ${license}${author ? ` — author: ${author}` : ''}`;
  return texts.length ? `${header}\n${texts.join('\n')}` : `${header}\n(no license file shipped in the package; license as declared in its package.json)`;
}

function commentSafe(text) {
  return text.replace(/\*\//g, '*\\/');
}

// Transitive SDK dependencies outside the ed25519 wallet path (snarkjs and
// ffjavascript for ZK, fastfile, node-seal, falcon-sign, ejs) import Node
// builtins such as fs/os/readline/crypto. An installed npm package of the same
// name (for example `buffer`) is still used; only builtins that resolve to
// nothing in the browser become an empty CommonJS module, so those unrelated
// features fail if ever invoked instead of loading Node code. The stubbed
// names are printed in the build summary.
const stubbed = new Set();
const nodeBuiltinStub = {
  name: 'node-builtin-stub',
  setup(build) {
    const names = builtinModules.filter((name) => !name.startsWith('_')).map((name) => name.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&'));
    const filter = new RegExp(`^(node:)?(${names.join('|')})(/.*)?$`);
    build.onResolve({ filter }, async (args) => {
      if (args.pluginData?.skipStub) return undefined;
      if (!args.path.startsWith('node:')) {
        const real = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { skipStub: true } });
        // A package `browser` mapping to false (the SDK declares this for
        // crypto/fs/path/...) resolves to a non-file result: stub it too.
        if (!real.errors.length && real.namespace === 'file' && isAbsolute(real.path)) return real;
      }
      stubbed.add(args.path.replace(/^node:/, ''));
      return { path: args.path, namespace: 'node-builtin-stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'node-builtin-stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

assertPins();

// Refuse to touch runtime-chunks/ if it holds anything the previous manifest
// does not list (hand-placed or foreign files are never deleted).
const previousPaths = existsSync(join(walletDir, RUNTIME_MANIFEST))
  ? runtimeManifestPaths(parseRuntimeManifest(readFileSync(join(walletDir, RUNTIME_MANIFEST))).manifest)
  : [];
const presentChunks = existsSync(chunkDir) ? readdirSync(chunkDir).map((name) => `${RUNTIME_CHUNK_DIR}/${name}`) : [];
const foreign = presentChunks.filter((path) => !previousPaths.includes(path));
if (foreign.length) throw new Error(`${RUNTIME_CHUNK_DIR}/ holds files not listed in the previous ${RUNTIME_MANIFEST}: ${foreign.join(', ')}`);

const result = await esbuild.build({
  absWorkingDir: here,
  entryPoints: ['entry.mjs'],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  write: false,
  metafile: true,
  outdir: walletDir,
  entryNames: `${RUNTIME_CHUNK_DIR}/[name]-[hash]`,
  chunkNames: `${RUNTIME_CHUNK_DIR}/chunk-[hash]`,
  outExtension: { '.js': '.mjs' },
  banner: { js: '/* Generated chunk of demos-runtime.mjs (upstream @kynesyslabs/demosdk 4.0.16, esbuild 0.25.12); third-party notices are at the end of ../demos-runtime.mjs. */' },
  inject: ['shims.mjs'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  plugins: [nodeBuiltinStub],
  logLevel: 'warning',
});

const walletRel = (absOrBuildRel) => relative(walletDir, isAbsolute(absOrBuildRel) ? absOrBuildRel : join(here, absOrBuildRel)).split(sep).join('/');

// Graph files and the edges esbuild reports for them.
const files = new Map();
const edges = new Map();
for (const file of result.outputFiles) {
  const path = walletRel(file.path);
  if (!isRuntimeGraphPath(path) || path === RUNTIME_ENTRY) throw new Error(`unexpected esbuild output ${path}`);
  files.set(path, Buffer.from(file.contents));
}
let builtEntry = null;
for (const [outPath, output] of Object.entries(result.metafile.outputs)) {
  const path = walletRel(outPath);
  if (!files.has(path)) throw new Error(`metafile output ${path} was not produced`);
  if (output.entryPoint === 'entry.mjs') builtEntry = path;
  const imports = [];
  const dynamicImports = [];
  for (const record of output.imports) {
    const target = walletRel(record.path);
    if (record.external || !files.has(target)) throw new Error(`${path} imports ${record.path} outside the generated graph`);
    if (record.kind === 'import-statement') imports.push(target);
    else if (record.kind === 'dynamic-import') dynamicImports.push(target);
    else throw new Error(`${path} has unsupported import kind ${record.kind}`);
  }
  edges.set(path, { imports, dynamicImports });
}
if (!builtEntry) throw new Error('esbuild produced no entry chunk');

// esbuild still emits a file for a dynamic-import target whose only importer
// was tree-shaken away. Nothing in the graph references such a file, so it can
// never load; it is not shipped and is listed in the build summary instead.
const reachable = closureFrom(builtEntry, (path) => [...edges.get(path).imports, ...edges.get(path).dynamicImports]);
const unreferenced = [...files.keys()].filter((path) => !reachable.has(path)).sort().map((path) => ({
  path,
  entryPoint: result.metafile.outputs[relative(here, join(walletDir, path)).split(sep).join('/')]?.entryPoint ?? null,
}));
for (const { path } of unreferenced) {
  files.delete(path);
  edges.delete(path);
}

// Notices cover every package esbuild read (as the single-file build did);
// shippedPackages names only those with bytes in a shipped file.
const outputKey = (path) => relative(here, join(walletDir, path)).split(sep).join('/');
const packageId = (root) => {
  const manifest = readJson(join(here, root, 'package.json'));
  return `${manifest.name}@${manifest.version}`;
};
const roots = [...new Set(Object.keys(result.metafile.inputs).map(packageRootOf).filter(Boolean))].sort();
const bundled = roots.map(packageId);
const shippedRoots = [...new Set([...files.keys()].flatMap((path) => Object.entries(result.metafile.outputs[outputKey(path)].inputs)
  .filter(([, used]) => used.bytesInOutput > 0).map(([input]) => packageRootOf(input)).filter(Boolean)))].sort();
const notices = roots.map(noticeFor);

// Stable public entry: same exports as the built entry chunk.
const banner = [
  '/*',
  ' * demos-runtime.mjs — GENERATED, do not edit. Experimental, default-off.',
  ' * Browser bundle of the unmodified upstream @kynesyslabs/demosdk 4.0.16 (public npm,',
  ' * license "MIT" declared in its package.json, author Kynesys Labs; the package ships no',
  ' * LICENSE file) built with esbuild 0.25.12 from chatgpt/wallet-build (entry.mjs, build.mjs).',
  ' * Not the V2 server-only modified runtime. No CDN imports; no network work on import.',
  ` * Local module graph: this entry plus ${files.size} chunks in ./${RUNTIME_CHUNK_DIR}/, listed with`,
  ` * SHA-256 in ./${RUNTIME_MANIFEST}. Packages with shipped code: ${shippedRoots.length}. Third-party`,
  ` * notices of all ${roots.length} packages read by the build are appended at the end of this file.`,
  ' */',
].join('\n');
const trailer = `\n/*\n * THIRD-PARTY NOTICES\n *\n${commentSafe(notices.join('\n\n')).split('\n').map((line) => ` * ${line}`.trimEnd()).join('\n')}\n */\n`;
const entrySpecifier = `./${builtEntry}`;
files.set(RUNTIME_ENTRY, Buffer.from(`${banner}\nexport * from ${JSON.stringify(entrySpecifier)};\n${trailer}`));
edges.set(RUNTIME_ENTRY, { imports: [builtEntry], dynamicImports: [] });

const manifestText = serializeRuntimeManifest({ files, edges, esbuildVersion: esbuild.version, shippedPackages: shippedRoots.map(packageId), noticePackages: bundled });
const check = checkRuntimeGraph(new Map([...files, [RUNTIME_MANIFEST, Buffer.from(manifestText)]]));
if (check.length) {
  // Context for each problem: the text around a reported specifier, or the
  // metafile record of an unreachable output.
  const context = check.map((problem) => {
    const nonLocal = /^(\S+) imports non-local (".*")$/.exec(problem);
    if (nonLocal) {
      const text = files.get(nonLocal[1]).toString('utf8');
      const at = text.indexOf(JSON.parse(nonLocal[2]));
      return `${problem}\n    near: ${JSON.stringify(text.slice(Math.max(0, at - 120), at + 60))}`;
    }
    const unreachable = /^(\S+) declared but unreachable/.exec(problem);
    if (unreachable) {
      const key = relative(here, join(walletDir, unreachable[1])).split(sep).join('/');
      const output = result.metafile.outputs[key];
      const importers = Object.entries(result.metafile.outputs).filter(([, o]) => o.imports.some((r) => r.path === key)).map(([k]) => k);
      return `${problem}\n    entryPoint: ${output?.entryPoint}; importers: ${JSON.stringify(importers)}; inputs: ${JSON.stringify(Object.keys(output?.inputs ?? {}).slice(0, 5))}`;
    }
    return problem;
  });
  throw new Error(`generated graph fails its own closure check:\n${context.join('\n')}`);
}

// Write: new chunks, the entry, the manifest; then remove previous-manifest
// chunks that are no longer produced.
mkdirSync(chunkDir, { recursive: true });
for (const [path, bytes] of files) writeFileSync(join(walletDir, path), bytes);
writeFileSync(join(walletDir, RUNTIME_MANIFEST), manifestText);
const removed = previousPaths.filter((path) => path.startsWith(`${RUNTIME_CHUNK_DIR}/`) && !files.has(path) && presentChunks.includes(path));
for (const path of removed) rmSync(join(walletDir, path));

// Where the SDK's FHE module and node-seal (which compile WebAssembly at
// module evaluation) ended up: files loaded on import vs. only lazily.
const { eager, lazy } = runtimeLoadSets(JSON.parse(manifestText));
const wasmInputs = (path) => Object.entries(result.metafile.outputs[outputKey(path)]?.inputs ?? {})
  .filter(([, used]) => used.bytesInOutput > 0)
  .map(([input]) => input)
  .filter((input) => /^node_modules\/node-seal\/|^node_modules\/@kynesyslabs\/demosdk\/build\/encryption\/FHE\//.test(input));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
process.stdout.write(`${JSON.stringify({
  entry: `public/portal/embedded-wallet/${RUNTIME_ENTRY}`,
  entrySha256: sha(files.get(RUNTIME_ENTRY)),
  manifest: `public/portal/embedded-wallet/${RUNTIME_MANIFEST}`,
  manifestSha256: sha(manifestText),
  files: files.size,
  totalBytes: [...files.values()].reduce((n, b) => n + b.length, 0),
  eagerFiles: eager,
  lazyFiles: lazy,
  removedStaleFiles: removed,
  unreferencedOutputsNotShipped: unreferenced,
  esbuild: esbuild.version,
  demosdk: readJson(join(here, 'node_modules/@kynesyslabs/demosdk/package.json')).version,
  noticePackages: bundled.length,
  noticePackagesSha256: sha(bundled.join('\n')),
  shippedPackages: shippedRoots.map(packageId),
  lockfilePresent: existsSync(join(here, 'package-lock.json')),
  stubbedNodeBuiltins: [...stubbed].sort(),
  wasmModulesInEagerFiles: eager.flatMap((path) => wasmInputs(path).map((input) => `${path}: ${input}`)),
  wasmModulesInLazyFiles: lazy.flatMap((path) => wasmInputs(path).map((input) => `${path}: ${input}`)),
  warnings: result.warnings.length,
}, null, 2)}\n`);
