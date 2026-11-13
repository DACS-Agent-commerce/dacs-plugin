// Helpers (pure apart from readRuntimeGraphFiles) for the generated
// embedded-wallet SDK module graph:
// public/portal/embedded-wallet/demos-runtime.mjs (stable entry) plus the
// content-named chunks under runtime-chunks/, described by runtime-manifest.json.
//
// The manifest is produced by wallet-build/build.mjs from esbuild's metafile.
// checkRuntimeGraph does NOT trust the manifest's import edges: it re-derives
// every module specifier from the shipped bytes and requires them to equal the
// declared edges, to resolve to a declared local file, and the static+dynamic
// closure from the entry to be exactly the declared file set. Packaging
// correctness only: it says nothing about whether the SDK works.
//
// Paths are relative to the embedded-wallet directory (forward slashes).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RUNTIME_MANIFEST_SCHEMA = 'dacs-embedded-wallet-runtime-manifest/1';
export const RUNTIME_ENTRY = 'demos-runtime.mjs';
export const RUNTIME_CHUNK_DIR = 'runtime-chunks';
export const RUNTIME_MANIFEST = 'runtime-manifest.json';
export const RUNTIME_SDK = Object.freeze({ name: '@kynesyslabs/demosdk', version: '4.0.20' });
export const RUNTIME_ESBUILD_VERSION = '0.25.12';
export const RUNTIME_LABEL = 'upstream-demosdk-4.0.20-browser-bundle';
export const RUNTIME_BANNER = 'demos-runtime.mjs — GENERATED, do not edit.';
export const RUNTIME_SDK_LABEL = 'unmodified upstream @kynesyslabs/demosdk 4.0.20';

const CHUNK_PATH = /^runtime-chunks\/[A-Za-z0-9_-]+\.mjs$/;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function isRuntimeGraphPath(path) {
  return path === RUNTIME_ENTRY || CHUNK_PATH.test(path);
}

// Module specifiers in esbuild ESM output. esbuild hoists every static
// `import ... from "x"`, `import "x"` and `export ... from "x"` into the module
// prologue (after leading comments), so static imports are parsed from that
// prologue only; strings later in the code that merely look like imports are
// not mistaken for them. A static import esbuild emitted elsewhere would be
// missing here and so differ from the manifest's declared edges, which
// checkRuntimeGraph reports. Dynamic `import("x")` calls are searched in the
// whole text; a string that only looks like one is still reported, which can
// fail the check but never hides a real import.
const PROLOGUE_SKIP = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))/;
const PROLOGUE_STATEMENT = /^(?:import|export)\s*(?:[\w$*{][^;"'`]*?\s*from\s*)?(["'])([^"'\n]+)\1\s*;?/;

export function scanModuleSpecifiers(text) {
  const out = { static: [], dynamic: [] };
  let rest = text;
  for (;;) {
    const skip = PROLOGUE_SKIP.exec(rest);
    if (skip) {
      rest = rest.slice(skip[0].length);
      continue;
    }
    const statement = PROLOGUE_STATEMENT.exec(rest);
    if (!statement) break;
    out.static.push(statement[2]);
    rest = rest.slice(statement[0].length);
  }
  const dynamicForm = /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g;
  for (const match of text.matchAll(dynamicForm)) out.dynamic.push(match[2]);
  // Any other import() argument (computed, template with substitutions) cannot be
  // resolved statically; report it so it is never silently accepted.
  for (const match of text.matchAll(/\bimport\s*\(\s*(?!["'`][^"'`\n]+["'`]\s*\))([^)]{0,40})/g)) out.dynamic.push(`<computed:${match[1].trim()}>`);
  return out;
}

// Resolves a relative specifier from a graph file; null for anything else
// (bare package names, URLs, absolute paths, escapes from the wallet dir).
export function resolveLocal(fromPath, specifier) {
  if (!/^\.\.?\//.test(specifier)) return null;
  const parts = fromPath.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

// Files reachable from the entry. `edges(path)` returns the paths it loads.
export function closureFrom(entry, edges) {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    for (const next of edges(queue.shift())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

// Deterministic manifest text for the given graph files and declared edges.
// files: Map<path, Buffer>; edges: Map<path, { imports: string[], dynamicImports: string[] }>.
// shippedPackages: packages with code in the shipped files; noticePackages: every
// package esbuild read (a superset), whose notices demos-runtime.mjs carries.
export function serializeRuntimeManifest({ files, edges, esbuildVersion, shippedPackages = [], noticePackages = [] }) {
  const manifest = {
    schema: RUNTIME_MANIFEST_SCHEMA,
    entry: RUNTIME_ENTRY,
    runtimeLabel: RUNTIME_LABEL,
    sdk: { ...RUNTIME_SDK },
    esbuild: esbuildVersion,
    shippedPackages: uniqueSorted(shippedPackages),
    noticePackages: uniqueSorted(noticePackages),
    files: [...files.keys()].sort().map((path) => ({
      path,
      bytes: files.get(path).length,
      sha256: sha256(files.get(path)),
      imports: [...(edges.get(path)?.imports ?? [])].sort(),
      dynamicImports: [...(edges.get(path)?.dynamicImports ?? [])].sort(),
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseRuntimeManifest(bytes) {
  try {
    return { manifest: JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)), problems: [] };
  } catch (error) {
    return { manifest: null, problems: [`runtime manifest is not JSON: ${error.message}`] };
  }
}

// Declared graph file paths, or [] when the manifest is unusable.
export function runtimeManifestPaths(manifest) {
  return Array.isArray(manifest?.files) ? manifest.files.map((f) => f?.path).filter((p) => typeof p === 'string') : [];
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const uniqueSorted = (list) => [...new Set(list)].sort();

// Complete check of one copy of the graph (source tree, tarball, installed
// package or HTTP downloads). `files` is Map<path, Buffer> keyed relative to the
// embedded-wallet dir and must include the manifest itself and every graph file
// found there (so unlisted chunks are reported). Returns problem strings; [] = ok.
export function checkRuntimeGraph(files) {
  const manifestBytes = files.get(RUNTIME_MANIFEST);
  if (!manifestBytes) return [`${RUNTIME_MANIFEST} missing`];
  const { manifest, problems } = parseRuntimeManifest(manifestBytes);
  if (!manifest) return problems;

  if (manifest.schema !== RUNTIME_MANIFEST_SCHEMA) problems.push(`schema ${JSON.stringify(manifest.schema)} != ${RUNTIME_MANIFEST_SCHEMA}`);
  if (manifest.entry !== RUNTIME_ENTRY) problems.push(`entry ${JSON.stringify(manifest.entry)} != ${RUNTIME_ENTRY}`);
  if (manifest.runtimeLabel !== RUNTIME_LABEL) problems.push(`runtimeLabel ${JSON.stringify(manifest.runtimeLabel)} != ${RUNTIME_LABEL}`);
  if (manifest.sdk?.name !== RUNTIME_SDK.name || manifest.sdk?.version !== RUNTIME_SDK.version) problems.push(`sdk ${JSON.stringify(manifest.sdk)} != ${RUNTIME_SDK.name}@${RUNTIME_SDK.version}`);
  if (manifest.esbuild !== RUNTIME_ESBUILD_VERSION) problems.push(`esbuild ${JSON.stringify(manifest.esbuild)} != ${RUNTIME_ESBUILD_VERSION}`);
  if (!Array.isArray(manifest.files)) return [...problems, 'manifest has no files list'];

  const declared = new Map();
  for (const entry of manifest.files) {
    const path = entry?.path;
    if (typeof path !== 'string' || !isRuntimeGraphPath(path)) {
      problems.push(`declared path ${JSON.stringify(path)} is not ${RUNTIME_ENTRY} or ${RUNTIME_CHUNK_DIR}/<name>.mjs`);
      continue;
    }
    if (declared.has(path)) problems.push(`${path} declared twice`);
    declared.set(path, entry);
  }
  if (!declared.has(RUNTIME_ENTRY)) problems.push(`${RUNTIME_ENTRY} not declared`);

  for (const path of [...files.keys()].filter(isRuntimeGraphPath).sort()) {
    if (!declared.has(path)) problems.push(`${path} present but not declared`);
  }

  const derived = new Map();
  for (const [path, entry] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = files.get(path);
    if (!bytes) {
      problems.push(`${path} missing`);
      continue;
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) problems.push(`${path} bytes/sha256 differ from manifest (${bytes.length} ${sha256(bytes)})`);
    const found = scanModuleSpecifiers(bytes.toString('utf8'));
    const resolved = { imports: [], dynamicImports: [] };
    for (const [kind, list] of [['imports', found.static], ['dynamicImports', found.dynamic]]) {
      for (const specifier of list) {
        const target = resolveLocal(path, specifier);
        if (!target || !isRuntimeGraphPath(target)) problems.push(`${path} imports non-local ${JSON.stringify(specifier)}`);
        else if (!declared.has(target)) problems.push(`${path} imports undeclared ${target}`);
        else resolved[kind].push(target);
      }
    }
    resolved.imports = uniqueSorted(resolved.imports);
    resolved.dynamicImports = uniqueSorted(resolved.dynamicImports);
    derived.set(path, resolved);
    for (const kind of ['imports', 'dynamicImports']) {
      const claimed = Array.isArray(entry[kind]) ? uniqueSorted(entry[kind]) : null;
      if (!claimed || !sameList(claimed, resolved[kind])) problems.push(`${path} declared ${kind} ${JSON.stringify(entry[kind])} != found ${JSON.stringify(resolved[kind])}`);
    }
  }

  if (declared.has(RUNTIME_ENTRY)) {
    const reach = closureFrom(RUNTIME_ENTRY, (p) => [...(derived.get(p)?.imports ?? []), ...(derived.get(p)?.dynamicImports ?? [])]);
    for (const path of declared.keys()) if (!reach.has(path)) problems.push(`${path} declared but unreachable from ${RUNTIME_ENTRY}`);
  }
  return problems;
}

// The only filesystem helper: the manifest, the entry and every file in
// runtime-chunks/ of one embedded-wallet directory (path or file: URL), keyed as
// checkRuntimeGraph expects. Missing files are simply absent from the map.
export function readRuntimeGraphFiles(dir) {
  const root = typeof dir === 'string' ? pathToFileURL(dir.endsWith('/') ? dir : `${dir}/`) : dir;
  const files = new Map();
  for (const path of [RUNTIME_MANIFEST, RUNTIME_ENTRY]) {
    if (existsSync(new URL(path, root))) files.set(path, readFileSync(new URL(path, root)));
  }
  const chunks = new URL(`${RUNTIME_CHUNK_DIR}/`, root);
  if (existsSync(chunks)) {
    for (const entry of readdirSync(chunks, { withFileTypes: true })) files.set(`${RUNTIME_CHUNK_DIR}/${entry.name}`, readFileSync(new URL(entry.name, chunks)));
  }
  return files;
}

// Files loaded by merely importing the entry (static edges only), and the
// remaining files that load only through a dynamic import().
export function runtimeLoadSets(manifest) {
  const byPath = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const eager = closureFrom(RUNTIME_ENTRY, (p) => byPath.get(p)?.imports ?? []);
  const all = closureFrom(RUNTIME_ENTRY, (p) => [...(byPath.get(p)?.imports ?? []), ...(byPath.get(p)?.dynamicImports ?? [])]);
  return { eager: [...eager].sort(), lazy: [...all].filter((p) => !eager.has(p)).sort() };
}
