#!/usr/bin/env node
// Purchase-path checker. Static only: it parses source text and never imports or executes
// the modules it checks.
//
// checkThinPlugin(root, config) reads the inventory (dependency roots, entries, forbidden
// directories, primitive families), resolves each entry's imports through the per-file scanner,
// and returns a report. Run as a command it prints the report as JSON on stdout and a summary on
// stderr, and exits 0 (pass), 1 (violation) or 2 (unverifiable); a violation outranks unverifiable.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire, isBuiltin} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createModuleScanner} from './thin-plugin-scan.mjs';
// A missing parser must produce a JSON refusal, not a Node stack.
let ts;
try { ts = createRequire(import.meta.url)('typescript'); } catch { /* reported as parser-unavailable */ }

const CLIENT = '@kynesyslabs/dacs-client';
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const semver = /^(?:[~^]|>=?|<=?|=)?\s*v?\d+\.\d+(?:\.\d+|\.x|\.\*)(?:-[\w.-]+)?(?:\+[\w.-]+)?(?:\s*\|\|?\s*[~^<>=v\d.* -]+)?$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const registry = (u, name) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && x.hostname === 'registry.npmjs.org' && x.pathname.includes('/-/') && x.pathname.endsWith('.tgz') && (!name || decodeURIComponent(x.pathname).startsWith(`/${name}/-/`)); } catch { return false; } };
// A registry range, or an npm: alias whose target is the same package name: an alias to a
// differently named package is never a registry spec for the name it is installed under.
const registrySpec = (name, v) => { if (typeof v !== 'string') return false; const a = v.match(/^npm:((?:@[^/@\s]+\/)?[^/@\s]+)@(.+)$/); return a ? a[1] === name && semver.test(a[2]) : semver.test(v); };
const sha512 = i => { const m = typeof i === 'string' && i.match(/^sha512-([A-Za-z0-9+/]{86}==)$/); return !!m && Buffer.from(m[1], 'base64').length === 64 && Buffer.from(m[1], 'base64').toString('base64') === m[1]; };
const packageName = s => s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
const within = (r, p) => p === r || p.startsWith(r + path.sep);
const statusOf = code => code === 0 ? 'pass' : code === 1 ? 'violation' : 'unverifiable';

export function checkThinPlugin(root, config) {
  root = fs.realpathSync(root);
  const violations = [], unverifiable = [], waivers = [], edges = [], modules = new Map(), skipped = [];
  const rel = p => within(root, p) ? path.relative(root, p).split(path.sep).join('/') || '.' : '<outside-project>';
  const issue = (list, rule, file, line = 0, detail = '') => list.push({rule, file: rel(file), line, detail});
  const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { issue(unverifiable, 'unreadable-json', p); return null; } };
  const safeFile = p => { try { const real = fs.realpathSync(p); if (!within(root, real)) return null; return fs.statSync(real).isFile() ? real : null; } catch { return null; } };
  if (!config || !Array.isArray(config.entries) || !config.entries.length || !Array.isArray(config.primitives) || !config.primitives.length || !Array.isArray(config.dependencyRoots) || !config.dependencyRoots.length) {
    issue(unverifiable, 'invalid-config', path.join(root, 'scripts/thin-plugin.config.json'));
    return finish();
  }
  if (!ts) { issue(unverifiable, 'parser-unavailable', root); return finish(); }

  // Package boundaries: installed package directories whose lock record is a concrete registry
  // resolution, or a pinned tarball (pinnedPackages) carrying the exact pinned sha512 integrity.
  const registryPackages = new Set();
  // Dependency roots are compared by real path, the same form resolve() sees for importers.
  const realDir = d => { const dir = path.resolve(root, d.path); try { return fs.realpathSync(dir); } catch { return dir; } };
  const roots = [{path: '.'}, ...config.dependencyRoots.filter(d => d.path !== '.')].map(d => ({...d, dir: realDir(d)}));
  // A lock record is a package boundary only for an installed-package key (relative segments,
  // ending node_modules/<name>) inside the dependency root that owns that path: the deepest
  // declared root containing it. A record cannot vouch for a path in another root.
  const rootDirs = roots.map(d => d.dir).filter(d => within(root, d));
  const ownerOf = p => rootDirs.filter(d => within(d, p)).sort((a, b) => b.length - a.length)[0];
  const installedKey = key => {
    const s = key.split('/'), i = s.lastIndexOf('node_modules');
    if (!s.every(x => x && x !== '.' && x !== '..' && !x.includes('\\'))) return false;
    return i >= 0 && ((i === s.length - 2 && !s[i + 1].startsWith('@')) || (i === s.length - 3 && s[i + 1].startsWith('@')));
  };
  // The installed copy must name the package it is installed as, so an alias cannot stand in for it.
  const installedAs = (dir, key, name) => { const m = safeFile(path.join(dir, key, 'package.json')); if (!m) return false; try { return JSON.parse(fs.readFileSync(m, 'utf8')).name === name; } catch { return false; } };
  const pins = new Map((Array.isArray(config.pinnedPackages) ? config.pinnedPackages : []).filter(p => p && typeof p.name === 'string' && /^@kynesyslabs\/[\w.-]+$/.test(p.name) && sha512(p.integrity)).map(p => [p.name, p.integrity]));
  // A pinned record: the exact pinned integrity, not a link, an exact version, its own name (when it
  // carries one) and a tarball, either a file: archive or the registry URL of that same name.
  const pinnedRecord = (value, name) => pins.has(name) && !value.link && value.integrity === pins.get(name) && (value.name === undefined || value.name === name) && exactVersion.test(value.version ?? '')
    && typeof value.resolved === 'string' && (/^file:[^\s]+\.tgz$/.test(value.resolved) || registry(value.resolved, name));
  const seenRoots = new Set();
  for (const d of roots) {
    const dir = d.dir;
    if (!within(root, dir)) { issue(unverifiable, 'dependency-root-escape', dir); continue; }
    if (seenRoots.has(dir)) continue; seenRoots.add(dir);
    if (!fs.existsSync(dir) && d.optional) continue;
    const p = path.join(dir, 'package.json'), l = path.join(dir, 'package-lock.json');
    const pkg = readJson(p), lock = readJson(l);
    if (!pkg || !lock) continue;
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') { issue(unverifiable, 'unsupported-lockfile', l); continue; }
    // Pinned records in THIS root only; a spec is exempt only when it equals that record's resolved tarball.
    const pinnedHere = new Map([...pins.keys()].flatMap(name => { const r = lock.packages[`node_modules/${name}`]; return r && typeof r === 'object' && pinnedRecord(r, name) ? [[name, r.resolved]] : []; }));
    const specOk = (name, version) => registrySpec(name, version) || (pinnedHere.has(name) && version === pinnedHere.get(name));
    for (const section of sections) for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith('@kynesyslabs/') && !specOk(name, version)) issue(violations, 'non-registry-dependency', p, 0, `${section}.${name}`);
    }
    for (const [key, value] of Object.entries(lock.packages)) {
      if (!value || typeof value !== 'object') { issue(unverifiable, 'malformed-lock-record', l, 0, key); continue; }
      for (const section of sections) for (const [name, version] of Object.entries(value[section] ?? {})) {
        if (name.startsWith('@kynesyslabs/') && !specOk(name, version)) issue(violations, 'non-registry-lock-spec', l, 0, `packages[${JSON.stringify(key)}].${section}.${name}`);
      }
      const match = key.match(/(?:^|\/)node_modules\/(@kynesyslabs\/[^/]+)$/);
      const name = match?.[1] ?? (key && value.name?.startsWith('@kynesyslabs/') ? value.name : null);
      const pinned = !!name && key === `node_modules/${name}` && pinnedHere.has(name);
      const keyName = installedKey(key) ? packageName(key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)) : null;
      if (keyName && !value.link && ownerOf(path.resolve(dir, key)) === dir && installedAs(dir, key, keyName)
        && ((registry(value.resolved, keyName) && typeof value.integrity === 'string') || pinned)) registryPackages.add(path.resolve(dir, key));
      if (name && !pinned && (value.link || !exactVersion.test(value.version ?? '') || (value.name !== undefined && value.name !== (match?.[1] ?? name)) || !registry(value.resolved, match?.[1] ?? name) || typeof value.integrity !== 'string' || !/^sha(?:256|384|512)-/.test(value.integrity))) {
        issue(violations, 'non-registry-lock-resolution', l, 0, `packages[${JSON.stringify(key)}] (${name})`);
      }
    }
    // A declared SDK dependency must have the matching concrete locked package.
    for (const section of sections) for (const name of Object.keys(pkg[section] ?? {})) if (name.startsWith('@kynesyslabs/')) {
      if (!lock.packages[`node_modules/${name}`]) issue(violations, 'missing-lock-resolution', l, 0, `packages["node_modules/${name}"]`);
      if ((lock.packages['']?.[section] ?? {})[name] !== pkg[section][name]) issue(violations, 'manifest-lock-mismatch', l, 0, `packages[""].${section}.${name}`);
    }
  }
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg?.dependencies?.[CLIENT]) issue(violations, 'missing-dacs-client', path.join(root, 'package.json'));

  let tsOptions = null;
  const tc = path.join(root, 'tsconfig.json');
  if (fs.existsSync(tc)) {
    const opts = ts.readConfigFile(tc, ts.sys.readFile);
    if (opts.error) issue(unverifiable, 'invalid-tsconfig', tc);
    else {
      const parsed = ts.parseJsonConfigFileContent(opts.config, ts.sys, root);
      // No-input diagnostics do not change resolution; malformed compiler options do.
      if (parsed.errors.some(d => ![18002, 18003].includes(d.code))) issue(unverifiable, 'invalid-tsconfig', tc);
      tsOptions = parsed.options;
    }
  }
  function fileTarget(p, sourceTs = false) {
    const substitutions = /\.([mc]?js)$/.test(p) ? [p.replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts').replace(/\.js$/, '.ts'), p.replace(/\.js$/, '.tsx')] : [];
    const candidates = sourceTs ? [...substitutions, p] : [p, ...substitutions];
    if (!path.extname(p)) candidates.push(...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].map(e => p + e), ...['index.ts', 'index.js', 'index.mjs'].map(e => path.join(p, e)));
    for (const c of candidates) { const f = safeFile(c); if (f) return f; }
    return null;
  }
  function selectExport(value, mode, star = '') {
    if (typeof value === 'string') return value.replaceAll('*', star);
    if (value === null) return null;
    if (Array.isArray(value)) {
      for (const target of value) { const selected = selectExport(target, mode, star); if (selected !== undefined && selected !== null) return selected; }
      return null;
    }
    if (value && typeof value === 'object') for (const [condition, target] of Object.entries(value)) if (['node', mode, 'default', ...(config.conditions ?? [])].includes(condition)) {
      const selected = selectExport(target, mode, star); if (selected !== undefined) return selected;
    }
    return undefined;
  }
  function mapping(map, key, mode) {
    if (typeof map === 'string' || Array.isArray(map) || Object.keys(map ?? {}).every(k => !k.startsWith('.'))) return key === '.' ? selectExport(map, mode) : null;
    if (Object.hasOwn(map, key)) return selectExport(map[key], mode);
    const patterns = Object.keys(map).filter(k => k.includes('*')).sort((a, b) => b.length - a.length);
    for (const p of patterns) { const [start, end] = p.split('*'); if (key.startsWith(start) && key.endsWith(end)) return selectExport(map[p], mode, key.slice(start.length, end ? -end.length : undefined)); }
    return null;
  }
  function resolve(spec, importer, mode = 'import') {
    if (isBuiltin(spec)) return {kind: 'builtin', spec};
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const target = fileTarget(path.resolve(path.dirname(importer), spec), /\.[mc]?tsx?$/.test(importer));
      return target ? {kind: 'local', file: target} : null;
    }
    if (spec.startsWith('#') || /^(?:https?:|data:|file:)/.test(spec)) return null;
    if (tsOptions && /\.[mc]?tsx?$/.test(importer)) {
      const r = ts.resolveModuleName(spec, importer, tsOptions, ts.sys).resolvedModule;
      if (r && !r.isExternalLibraryImport) { const file = safeFile(r.resolvedFileName); if (file) return {kind: 'local', file}; return null; }
    }
    const name = packageName(spec); let dir = path.dirname(importer);
    while (within(root, dir)) {
      const base = path.join(dir, 'node_modules', name), manifest = safeFile(path.join(base, 'package.json'));
      if (manifest) {
        const meta = readJson(manifest); if (!meta) return null;
        const sub = spec.slice(name.length), key = sub ? '.' + sub : '.';
        const target = meta.exports !== undefined ? mapping(meta.exports, key, mode) : sub ? '.' + sub : meta.main ?? './index.js';
        if (!target || typeof target !== 'string' || (meta.exports !== undefined && !target.startsWith('./'))) return null;
        const file = fileTarget(path.resolve(base, target)); if (!file || !within(fs.realpathSync(base), file)) return null;
        // A symlinked or unlocked package is local code, scanned like any other module.
        if (fs.realpathSync(base) !== path.resolve(base) || !registryPackages.has(path.resolve(base))) return {kind: 'local', file};
        return {kind: 'package', file, spec, name};
      }
      if (dir === root) break; dir = path.dirname(dir);
    }
    return null;
  }
  // Export origin through local import/re-export edges (cycle-safe): 'package' when the
  // exported binding terminates at a locked registry package, else 'local'/'absent'/'cycle'/'unknown'.
  const exportMaps = new Map();
  function exportsOf(file) {
    if (exportMaps.has(file)) return exportMaps.get(file);
    const map = new Map(), stars = [], out = {map, stars}; exportMaps.set(file, out);
    if (!/\.(?:[mc]?[jt]s|[jt]sx)$/.test(file)) return out;
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), imports = new Map();
    for (const s of sf.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteralLike(s.moduleSpecifier) && s.importClause) {
      const res = resolve(s.moduleSpecifier.text, file), c = s.importClause;
      if (c.name) imports.set(c.name.text, {res, name: 'default'});
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) imports.set(e.name.text, {res, name: (e.propertyName ?? e.name).text});
    }
    for (const s of sf.statements) {
      if (ts.isExportDeclaration(s)) {
        const res = s.moduleSpecifier && ts.isStringLiteralLike(s.moduleSpecifier) ? resolve(s.moduleSpecifier.text, file) : null;
        if (!s.exportClause) { if (s.moduleSpecifier) stars.push(res); continue; }
        if (ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) {
          const local = (e.propertyName ?? e.name).text;
          map.set(e.name.text, s.moduleSpecifier ? {res, name: local} : imports.get(local) ?? {def: true});
        }
      } else if (ts.canHaveModifiers(s) && ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { if (ts.isIdentifier(d.name)) map.set(d.name.text, {def: true}); }
        else if (s.name && ts.isIdentifier(s.name)) map.set(s.name.text, {def: true});
      }
    }
    return out;
  }
  function originOf(file, name, seen = new Set()) {
    const key = `${file}\0${name}`; if (seen.has(key)) return 'cycle'; seen.add(key);
    const follow = d => !d.res ? 'unknown' : d.res.kind === 'package' || d.res.kind === 'builtin' ? 'package' : d.res.kind === 'local' ? originOf(d.res.file, d.name, seen) : 'unknown';
    const {map, stars} = exportsOf(file), d = map.get(name);
    if (d) return d.def ? 'local' : follow(d);
    for (const res of stars) { const o = follow({res, name}); if (o !== 'absent') return o; }
    return 'absent';
  }
  const report = {violation: row => violations.push(row), unverifiable: row => unverifiable.push(row), waiver: row => waivers.push(row), edge: row => edges.push(row)};
  const scan = createModuleScanner({ts, config, resolve, exportOrigin: originOf, rel, report, modules});

  const entryResults = [];
  for (const entry of config.entries) {
    if (typeof entry?.name !== 'string' || !Array.isArray(entry.modules) || !entry.modules.length) { issue(unverifiable, 'invalid-entry', root); continue; }
    const starts = [];
    for (const m of entry.modules) {
      if (typeof m?.file !== 'string' || typeof m.registration !== 'string') { issue(unverifiable, 'invalid-entry-module', root); continue; }
      const f = safeFile(path.resolve(root, m.file));
      if (!f) { if (m.optional && !fs.existsSync(path.resolve(root, m.file))) skipped.push({entry: entry.name, file: m.file, reason: 'optional-module-absent'}); else issue(unverifiable, 'missing-entry-module', path.resolve(root, m.file), 0, entry.name); continue; }
      starts.push(f);
      if (!scan(f).registrations.includes(m.registration)) issue(violations, 'missing-handler-registration', f, 0, `${entry.name}:${m.registration}`);
    }
    // Each module root reaches the client on its own, through runtime (not type-only) imports.
    const reachesClient = start => {
      const seen = new Set(); let hit = false;
      const go = (file, runtime) => {
        const key = `${file}:${runtime}`; if (seen.has(key)) return; seen.add(key);
        for (const imp of modules.get(file)?.imports ?? []) {
          const active = runtime && !imp.typeOnly;
          if (imp.kind === 'package' && imp.name === CLIENT && active) hit = true;
          if (imp.kind === 'local') go(imp.file, active);
        }
      }; go(start, true); return hit;
    };
    const lacking = starts.filter(r => !reachesClient(r)), client = starts.length > 0 && lacking.length === 0;
    if (!starts.length) issue(unverifiable, 'missing-purchase-entry', root, 0, entry.name);
    if (!client) issue(unverifiable.length ? unverifiable : violations, unverifiable.length ? 'entry-client-unverifiable' : 'entry-does-not-reach-client', root, 0, `${entry.name}:${lacking.map(rel).join(',')}`);
    entryResults.push({name: entry.name, modules: starts.map(rel), reachesClient: client});
  }
  return finish(entryResults);

  function finish(entries = []) {
    const exitCode = violations.length ? 1 : unverifiable.length ? 2 : 0;
    const dedup = rows => [...new Map(rows.map(r => [JSON.stringify(r), r])).values()];
    // Multi-source breadth-first traversal from the entry modules: one shortest local import chain
    // per finding, starting at the closest configured entry and independent of scan order; a module
    // already reached is never queued again, so a cycle ends the walk.
    const adjacency = new Map(), shortest = new Map(), queue = [];
    for (const edge of edges) if (edge.kind === 'local') adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    for (const entry of entries) for (const module of entry.modules) if (!shortest.has(module)) { shortest.set(module, {entry: entry.name, chain: [module], chainKind: 'import'}); queue.push(module); }
    for (let i = 0; i < queue.length; i++) {
      const previous = shortest.get(queue[i]);
      for (const to of adjacency.get(queue[i]) ?? []) if (!shortest.has(to)) { shortest.set(to, {...previous, chain: [...previous.chain, to]}); queue.push(to); }
    }
    // Dependency and config findings have no import edge; they are labelled as inventory findings
    // instead of being given an import chain from an entry.
    const annotate = rows => dedup(rows).map(row => ({...row, ...(shortest.get(row.file) ?? {chainKind: 'inventory', chain: ['dependency/entry inventory', row.file], entry: null})}));
    const v = annotate(violations), u = annotate(unverifiable);
    return {schemaVersion: 1, status: statusOf(exitCode), exitCode, summary: summarize(v, u), entries, modules: [...modules.keys()].map(rel).sort(), edges, violations: v, unverifiable: u, waivers: dedup(waivers), skipped};
  }
}

// Per-family summary: a row with an import chain is a graph finding; dependency, manifest, lock,
// config and entry rows are inventory findings. Each family's status uses the exit-code precedence.
export function summarize(violations, unverifiable) {
  const family = row => row.chainKind === 'import' ? 'graph' : 'inventory';
  const out = {};
  for (const name of ['graph', 'inventory']) {
    const fv = violations.filter(r => family(r) === name), fu = unverifiable.filter(r => family(r) === name), rules = {};
    for (const r of [...fv, ...fu]) rules[r.rule] = (rules[r.rule] ?? 0) + 1;
    out[name] = {violations: fv.length, unverifiable: fu.length, status: statusOf(fv.length ? 1 : fu.length ? 2 : 0), rules};
  }
  const exitCode = violations.length ? 1 : unverifiable.length ? 2 : 0;
  out.overall = {violations: violations.length, unverifiable: unverifiable.length, status: statusOf(exitCode), exitCode};
  return out;
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  let result, stage = 'arguments';
  try {
    const args = process.argv.slice(2); let root = path.resolve(fileURLToPath(new URL('..', import.meta.url))), configFile = null;
    for (let i = 0; i < args.length; i++) { if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i]); else if (args[i] === '--config' && args[i + 1]) configFile = path.resolve(args[++i]); else throw new Error('arguments'); }
    stage = 'configuration';
    const config = JSON.parse(fs.readFileSync(configFile ?? path.join(root, 'scripts/thin-plugin.config.json'), 'utf8'));
    stage = 'check';
    result = checkThinPlugin(root, config);
  } catch {
    const unverifiable = [{rule: 'configuration-or-check-failure', file: '.', line: 0, detail: `${stage}-failure`}];
    result = {schemaVersion: 1, status: 'unverifiable', exitCode: 2, summary: summarize([], unverifiable), entries: [], modules: [], edges: [], violations: [], unverifiable, waivers: [], skipped: []};
  }
  console.log(JSON.stringify(result, null, 2));
  const s = result.summary;
  console.error(`Thin plugin: ${result.status}; ${result.violations.length} violations, ${result.unverifiable.length} unverifiable, ${result.waivers.length} waivers.`);
  console.error(`Families: graph ${s.graph.status} (${s.graph.violations} violations, ${s.graph.unverifiable} unverifiable); inventory ${s.inventory.status} (${s.inventory.violations} violations, ${s.inventory.unverifiable} unverifiable).`);
  for (const row of [...result.violations, ...result.unverifiable]) console.error(`${result.violations.includes(row) ? 'Violation' : 'Unverifiable'} ${row.rule}: ${row.entry ? row.entry + ' → ' : ''}${(row.chain ?? [row.file]).join(' → ')}${row.chainKind === 'inventory' ? ' (inventory; no import edge)' : ''}${row.line ? ':' + row.line : ''}${row.detail ? ` [${row.detail}]` : ''}`);
  process.exitCode = result.exitCode;
}
