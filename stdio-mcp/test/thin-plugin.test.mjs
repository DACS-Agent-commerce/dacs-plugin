import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkThinPlugin} from '../scripts/check-thin-plugin.mjs';
import {CLIENT, fixture, integrityOf, names} from './thin-plugin-fixture.mjs';

const rules = rows => rows.map(r => r.rule);
const lockKey = `node_modules/${CLIENT}`;

test('a minimal synthetic fixture passes all five explicit entries', t => {
  const r = fixture(t).run();
  assert.equal(r.exitCode, 0);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.entries.map(e => e.name), names);
  assert.ok(r.entries.every(e => e.reachesClient));
});

test('a missing configured handler cannot pass', t => {
  const f = fixture(t); f.config.entries[0].modules[0].registration = 'absent';
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.violations.some(v => v.rule === 'missing-handler-registration' && v.detail === 'dacs_search:absent'));
});

test('two module roots must each reach the client independently', t => {
  const f = fixture(t); f.put('src/other.js', `server.registerTool('dacs_search', {}, () => {});`);
  f.config.entries[0].modules.push({file: 'src/other.js', registration: 'dacs_search'});
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.violations.some(v => v.rule === 'entry-does-not-reach-client' && v.detail === 'dacs_search:src/other.js'));
  assert.equal(r.entries[0].reachesClient, false);
  assert.ok(r.entries.slice(1).every(e => e.reachesClient));
});

test('each entry needs its own client reachability', t => {
  const f = fixture(t); f.put('src/no-client.js', `server.registerTool('standalone', {}, () => {});`);
  f.config.entries.push({name: 'separate', modules: [{file: 'src/no-client.js', registration: 'standalone'}]});
  assert.equal(f.run().exitCode, 1);
});

test('a type-only client import does not count as reaching the client', t => {
  for (const line of [`import type {sdk} from '${CLIENT}';`, `import {type sdk} from '${CLIENT}';`]) {
    const f = fixture(t); f.put('src/server.ts', `${line}\n${names.map(n => `server.registerTool('${n}', {}, () => {});`).join('\n')}`);
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.entries.every(e => !e.reachesClient));
  }
});

test('a type-only import-equals does not reach the client; an ordinary one does', t => {
  for (const [line, exitCode] of [[`import type sdk = require('${CLIENT}');`, 1], [`import sdk = require('${CLIENT}');`, 0]]) {
    const f = fixture(t); f.put('src/server.ts', `${line}\n${names.map(n => `server.registerTool('${n}', {}, () => {});`).join('\n')}`);
    const r = f.run();
    assert.equal(r.exitCode, exitCode, line);
    assert.ok(r.entries.every(e => e.reachesClient === !exitCode), line);
  }
});

test('a relative graph with JS-to-TS substitution and a cycle reaches the client', t => {
  const f = fixture(t);
  f.put('src/server.ts', `${names.map(n => `server.registerTool('${n}', {}, () => {});`).join('\n')}\nexport * from './middle.js';`);
  f.put('src/middle.ts', `import './server.js'; export * from '${CLIENT}';`);
  assert.equal(f.run().exitCode, 0);
});

test('a literal dynamic import reaches the client; a non-literal one is unverifiable', t => {
  const f = fixture(t, `await import('./lazy.mjs');`); f.put('src/lazy.mjs', `import '${CLIENT}/api';`);
  assert.equal(f.run().exitCode, 0);
  const r = fixture(t, 'await import(target);').run();
  assert.equal(r.exitCode, 2);
  assert.ok(r.unverifiable.some(v => v.rule === 'nonliteral-import'));
});

test('an unresolved import and a parse error fail closed', t => {
  assert.equal(fixture(t, `import './missing.js';`).run().exitCode, 2);
  assert.equal(fixture(t, 'const = ;').run().exitCode, 2);
});

test('the forbidden directory is followed through transitive imports', t => {
  const f = fixture(t, `import './bridge.js';`);
  f.put('src/bridge.ts', `import './dacs/local.js';`); f.put('src/dacs/local.ts', 'export const harmless = 1;');
  assert.ok(f.run().violations.some(v => v.rule === 'local-dacs-module' && v.file === 'src/dacs/local.ts'));
});

test('a symlink into a forbidden directory cannot hide a local copy', t => {
  const f = fixture(t, `import './alias.js';`);
  f.put('src/dacs/local.js', 'export function canonicalize(x) { return x; }');
  fs.symlinkSync(path.join(f.root, 'src/dacs/local.js'), path.join(f.root, 'src/alias.js'));
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.violations.some(v => v.rule === 'local-dacs-module' && v.file === 'src/dacs/local.js'));
  assert.ok(r.violations.some(v => v.rule === 'local-protocol-primitive'));
});

test('a symlinked directory into the forbidden tree is resolved by real path', t => {
  const f = fixture(t, `import './lib/local.js';`);
  f.put('src/dacs/local.js', 'export const x = 1;');
  fs.symlinkSync(path.join(f.root, 'src/dacs'), path.join(f.root, 'src/lib'));
  assert.ok(f.run().violations.some(v => v.rule === 'local-dacs-module'));
});

test('config cannot remove the src/dacs fence', t => {
  const f = fixture(t, `import './dacs/noop.js';`); f.config.forbiddenDirs = [];
  f.put('src/dacs/noop.js', 'export const x = 1;');
  assert.equal(f.run().exitCode, 1);
});

test('a waiver cannot suppress the forbidden directory', t => {
  const f = fixture(t, `import './dacs/local.js';`);
  f.put('src/dacs/local.js', '// thin-plugin-waiver primitive:canonical-json -- display only, no protocol data\nfunction canonicalize(x) { return x; }');
  assert.equal(f.run().exitCode, 1);
});

test('TS path aliases are followed, into the forbidden tree and ahead of the installed client', t => {
  const f = fixture(t, `import 'internal/local';`);
  f.put('tsconfig.json', {compilerOptions: {baseUrl: '.', paths: {'internal/*': ['src/dacs/*']}}}); f.put('src/dacs/local.ts', 'export const v = 1;');
  assert.equal(f.run().exitCode, 1);
  const g = fixture(t);
  g.put('tsconfig.json', {compilerOptions: {baseUrl: '.', paths: {[CLIENT]: ['src/shim.ts']}}}); g.put('src/shim.ts', 'export const sdk = {};');
  assert.equal(g.run().exitCode, 1);
});

test('package import conditions select the import target', t => {
  const f = fixture(t); f.change(`${lockKey}/package.json`, p => { p.exports['.'].import = './missing.js'; });
  const r = f.run();
  assert.equal(r.exitCode, 2);
  assert.ok(r.unverifiable.some(v => v.rule === 'unresolved-import'));
});

test('an unknown export condition is unverifiable and the package is never executed', t => {
  const f = fixture(t, `import './bridge.js';`);
  f.put('node_modules/other/package.json', {name: 'other', exports: {'.': {browser: './index.js'}}});
  f.put('node_modules/other/index.js', `throw new Error('never execute');`); f.put('src/bridge.js', `import 'other';`);
  assert.equal(f.run().exitCode, 2);
});

test('an unlocked local package cannot hide a copied primitive behind a package boundary', t => {
  const f = fixture(t, `import 'local-helper';`);
  f.put('node_modules/local-helper/package.json', {name: 'local-helper', main: 'index.js'});
  f.put('node_modules/local-helper/index.js', `export function agreementHash() { return 'x'; }`);
  assert.equal(f.run().exitCode, 1);
});

test('a workspace symlink cannot impersonate the locked registry client', t => {
  const f = fixture(t); fs.rmSync(path.join(f.root, lockKey), {recursive: true});
  f.put('src/dacs/package.json', {name: CLIENT, exports: './index.js'}); f.put('src/dacs/index.js', 'export const sdk = {};');
  fs.symlinkSync(path.join(f.root, 'src/dacs'), path.join(f.root, lockKey));
  assert.equal(f.run().exitCode, 1);
});

test('client exports used as values are a boundary, not copied code', t => {
  for (const body of [`const {deriveJobId} = require('${CLIENT}');`, `const {deriveJobId} = await import('${CLIENT}');`, `export {canonicalize} from '${CLIENT}';`, 'const adapter = {canonicalize: sdk.canonicalize};'])
    assert.equal(fixture(t, body).run().exitCode, 0, body);
});

test('a local export alias of a client binding through a barrel is a boundary', t => {
  const f = fixture(t, `export {canonicalize} from './barrel.js';`); f.put('src/barrel.ts', `export {canonicalize} from '${CLIENT}';`);
  assert.equal(f.run().exitCode, 0);
  const g = fixture(t, `export {canonicalize} from './barrel.js';`); g.put('src/barrel.ts', 'export const canonicalize = (x: unknown) => x;');
  assert.equal(g.run().exitCode, 1);
});

for (const spec of ['file:../sdk', 'link:../sdk', '../vendor/sdk.tgz', 'https://example.test/sdk.tgz', 'git+https://example.test/sdk.git', 'vendor/sdk', 'workspace:*']) {
  test(`the manifest refuses ${spec}`, t => {
    const f = fixture(t); f.change('package.json', p => { p.dependencies[CLIENT] = spec; });
    assert.ok(f.run().violations.some(v => v.rule === 'non-registry-dependency'));
  });
}

for (const spec of ['file:../sdk', 'git+https://example.test/sdk', 'https://example.test/sdk.tgz', `https://registry.npmjs.org/other/-/other-0.1.0.tgz`]) {
  test(`the lock resolution refuses ${spec} and names the lock record`, t => {
    const f = fixture(t); f.change('package-lock.json', p => { p.packages[lockKey].resolved = spec; });
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.violations.some(v => v.rule === 'non-registry-lock-resolution' && v.detail.includes(`packages["${lockKey}"]`)));
  });
}

test('nested lock records and lock root specs are checked', t => {
  const f = fixture(t); f.change('package-lock.json', p => {
    p.packages['node_modules/a/node_modules/@kynesyslabs/dacs'] = {version: 'file:vendor/sdk.tgz'};
    p.packages[''].optionalDependencies = {'@kynesyslabs/dacs': 'file:vendor/a.tgz'};
  });
  const r = f.run();
  assert.ok(r.violations.some(v => v.detail.includes('node_modules/a/node_modules/@kynesyslabs/dacs')));
  assert.ok(r.violations.some(v => v.rule === 'non-registry-lock-spec'));
});

test('manifest-lock drift, a missing lock record and a missing client fail', t => {
  const f = fixture(t); f.change('package-lock.json', p => { delete p.packages[lockKey]; delete p.packages[''].dependencies; });
  assert.deepEqual(rules(f.run().violations).filter(r => r.startsWith('m')).sort(), ['manifest-lock-mismatch', 'missing-lock-resolution']);
  const g = fixture(t); g.change('package.json', p => { delete p.dependencies[CLIENT]; });
  assert.ok(g.run().violations.some(v => v.rule === 'missing-dacs-client'));
});

test('the root dependency checks cannot be configured away', t => {
  const f = fixture(t); f.config.dependencyRoots = [{path: 'optional-other', optional: true}];
  f.change('package.json', p => { p.dependencies['@kynesyslabs/dacs'] = 'file:vendor/a.tgz'; });
  assert.ok(f.run().violations.some(v => v.rule === 'non-registry-dependency'));
});

// The client installed from a tarball before it is published, pinned by its sha512 integrity.
function pinnedFixture(t, {integrity = integrityOf('tarball'), link = false} = {}) {
  const f = fixture(t), spec = 'file:vendor/dacs-client-0.1.0.tgz';
  f.change('package.json', p => { p.dependencies[CLIENT] = spec; });
  f.change('package-lock.json', p => { p.packages[''].dependencies[CLIENT] = spec; p.packages[lockKey] = {version: '0.1.0', resolved: spec, integrity, ...(link ? {link: true} : {})}; });
  f.config.pinnedPackages = [{name: CLIENT, integrity: integrityOf('tarball')}];
  return f;
}

test('a pinned tarball passes with the exact integrity', t => {
  const r = pinnedFixture(t).run();
  assert.equal(r.exitCode, 0);
  assert.ok(r.entries.every(e => e.reachesClient));
});

test('a pinned tarball fails with a different integrity', t => {
  const r = pinnedFixture(t, {integrity: integrityOf('other')}).run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.violations.some(v => v.rule === 'non-registry-lock-resolution'));
  assert.ok(r.entries.every(e => !e.reachesClient));
});

test('a pinned tarball fails when the lock record is marked as a link', t => {
  const r = pinnedFixture(t, {link: true}).run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.violations.some(v => v.rule === 'non-registry-lock-resolution'));
});

test('a pinned tarball fails when the installed copy names another package', t => {
  const f = pinnedFixture(t); f.change(`${lockKey}/package.json`, p => { p.name = '@kynesyslabs/demosdk'; });
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.entries.every(e => !e.reachesClient));
});

test('a manifest alias to a differently named package, with a matching lock record and installed copy, does not pass', t => {
  const f = fixture(t), spec = 'npm:@kynesyslabs/demosdk@4.0.17';
  f.change('package.json', p => { p.dependencies[CLIENT] = spec; });
  f.change('package-lock.json', p => { p.packages[''].dependencies[CLIENT] = spec; p.packages[lockKey] = {name: '@kynesyslabs/demosdk', version: '4.0.17', resolved: 'https://registry.npmjs.org/@kynesyslabs/demosdk/-/demosdk-4.0.17.tgz', integrity: integrityOf('alias')}; });
  f.change(`${lockKey}/package.json`, p => { p.name = '@kynesyslabs/demosdk'; });
  const r = f.run();
  assert.equal(r.exitCode, 1);
  assert.ok(r.violations.some(v => v.rule === 'non-registry-dependency'));
  assert.ok(r.violations.some(v => v.rule === 'non-registry-lock-resolution'));
  assert.ok(r.entries.every(e => !e.reachesClient));
});

test('an npm: alias to the same package name is a registry spec', t => {
  const f = fixture(t), spec = `npm:${CLIENT}@0.1.0`;
  f.change('package.json', p => { p.dependencies[CLIENT] = spec; });
  f.change('package-lock.json', p => { p.packages[''].dependencies[CLIENT] = spec; });
  assert.equal(f.run().exitCode, 0);
});

test('a malformed lock is unverifiable and cannot pass', t => {
  const f = fixture(t); f.put('package-lock.json', '{');
  const r = f.run();
  assert.equal(r.exitCode, 2);
  assert.ok(r.unverifiable.some(v => v.rule === 'unreadable-json' && v.file === 'package-lock.json'));
  const g = fixture(t); g.change('package-lock.json', p => { p.lockfileVersion = 1; });
  assert.equal(g.run().exitCode, 2);
});

test('an unsupported config fails closed', t => {
  const f = fixture(t);
  for (const config of [{}, null, {...f.config, entries: []}]) assert.equal(checkThinPlugin(f.root, config).exitCode, 2);
});

test('a violation outranks unverifiable', t => {
  const r = fixture(t, `import './missing.js';\nexport function deriveJobId(x) { return x; }`).run();
  assert.ok(r.violations.length > 0 && r.unverifiable.length > 0);
  assert.equal(r.exitCode, 1);
  assert.equal(r.status, 'violation');
});
