// The complete import scan of the shipped tree, and the load check of every carried entry point. An entry "loads" when
// its whole module graph links: every import resolves and every named import exists. Linking evaluates no entry code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_DIR_ENV } from '../scripts/candidate-archives.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// The served wallet's bundled runtime is generated code with no repository imports.
const SKIPPED = new Set(['node_modules', 'runtime-chunks']);
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const SCRIPT_SRC = /<script\b[^>]*\bsrc="([^"]+)"/g;
// The portal's static mounts (src/portal/routes.mjs): a served URL names the file under the mounted directory.
const SERVED = [['/portal/assets/intent/', 'public/portal-intent/'], ['/portal/assets/', 'public/portal/'], ['/portal/showcase/', 'public/showcase/']];
// portal.js still names the browser broker, which this tree does not carry; the wallet's browser flow owns those two imports.
const LISTED_UNRESOLVED = [
  { file: 'public/portal/portal.js', specifier: '/portal/assets/offline-agreement-broker.mjs' },
  { file: 'public/portal/portal.js', specifier: '/portal/assets/offline-agreement-broker.mjs' },
];

const sources = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (SKIPPED.has(name)) return [];
  return statSync(path).isDirectory() ? sources(path) : /\.(?:m?js|html)$/.test(name) ? [path] : [];
});

function specifiers(file) {
  const text = readFileSync(file, 'utf8');
  const imports = [...text.matchAll(IMPORT)].map((match) => match[1] ?? match[2] ?? match[3]);
  return file.endsWith('.html') ? [...imports, ...[...text.matchAll(SCRIPT_SRC)].map((match) => match[1])] : imports;
}

function target(file, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier);
  const mount = SERVED.find(([prefix]) => specifier.startsWith(prefix));
  return mount ? join(root, mount[1], specifier.slice(mount[0].length)) : null;
}

test('no file under src, public, scripts or bin imports a not-carried path by static, dynamic or served-URL import, except the two listed portal.js imports of the not-carried browser broker', () => {
  const files = ['src', 'public', 'scripts', 'bin'].flatMap((top) => sources(join(root, top)));
  assert.ok(files.some((file) => file.endsWith('.html')) && files.some((file) => file.endsWith('src/app.mjs')));
  const unresolved = [];
  let served = 0;
  for (const file of files) {
    for (const specifier of specifiers(file)) {
      const path = target(file, specifier);
      if (specifier.startsWith('/')) served += 1;
      if (path !== null && !existsSync(path)) unresolved.push({ file: relative(root, file), specifier });
    }
  }
  assert.ok(served > 0, 'the scan read served-URL imports');
  assert.deepEqual(unresolved, LISTED_UNRESOLVED);
});

// Links one entry's module graph in a child process. Plugin files become source text modules that are never evaluated;
// packages and node built-ins are imported and wrapped, so their exports are checked against each named import.
const LINK_CHILD = `
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pluginRoot = pathToFileURL(process.argv[1]).href;
const modules = new Map();
async function moduleFor(url) {
  if (!modules.has(url)) modules.set(url, (async () => {
    if (url.startsWith(pluginRoot) && !url.includes('/node_modules/')) {
      return new vm.SourceTextModule(readFileSync(fileURLToPath(url), 'utf8'), { identifier: url, initializeImportMeta(meta) { meta.url = url; } });
    }
    const namespace = await import(url);
    const names = Object.keys(namespace);
    return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, namespace[name]); }, { identifier: url });
  })());
  return modules.get(url);
}
const entry = await moduleFor(pathToFileURL(process.argv[2]).href);
await entry.link((specifier, referencing) => moduleFor(import.meta.resolve(specifier, referencing.identifier)));
process.stdout.write(String(modules.size));
`;

function links(entry) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--experimental-import-meta-resolve', '--no-warnings', '--input-type=module', '-e', LINK_CHILD, root, join(root, entry)],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  return { ok: child.status === 0 && Number(child.stdout) > 1, detail: `${entry}: ${child.stderr.trim().split('\n').slice(0, 4).join(' | ')}` };
}

// scripts/showcase-safety.mjs drives the showcase's test fixtures, which load modules this tree does not carry.
const NOT_CARRIED_SCRIPTS = ['scripts/showcase-safety.mjs'];
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the plugin bin loads, check-package steps 4 and 5 pass, and every carried script and bin entry loads', async (t) => {
  await t.test('the plugin bin links', () => {
    const result = links(packageJson.bin['dacs-chatgpt-plugin']);
    assert.ok(result.ok, result.detail);
  });

  await t.test('every carried script and bin entry links', () => {
    const entries = [...Object.values(packageJson.bin), ...readdirSync(join(root, 'bin')).filter((name) => name.endsWith('.mjs')).map((name) => `bin/${name}`),
      ...readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.mjs')).map((name) => `scripts/${name}`)];
    const carried = [...new Set(entries.map((entry) => relative(root, join(root, entry))))].filter((entry) => !NOT_CARRIED_SCRIPTS.includes(entry));
    assert.ok(carried.length > 10);
    assert.deepEqual(carried.map(links).filter((result) => !result.ok).map((result) => result.detail), []);
  });

  await t.test('check-package installs the packed plugin offline and replays the Dockerfile, steps 4 and 5', { skip: process.env[CANDIDATE_DIR_ENV] ? false : `${CANDIDATE_DIR_ENV} names no archive directory` }, () => {
    const work = mkdtempSync(join(tmpdir(), 'check-package-'));
    try {
      const run = spawnSync(process.execPath, [join(root, 'scripts/check-package.mjs')], { cwd: root, env: { ...process.env, TMPDIR: work }, encoding: 'utf8', timeout: 600_000 });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-2000));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
