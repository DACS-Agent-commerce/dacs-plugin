import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLIENT, fixture, integrityOf, registrations} from './thin-plugin-fixture.mjs';

const checker = fileURLToPath(new URL('../scripts/check-thin-plugin.mjs', import.meta.url));
const reports = fileURLToPath(new URL('./fixtures/thin-plugin-reports/', import.meta.url));
const cli = (f, script = checker) => { f.put('policy.json', f.config); return spawnSync(process.execPath, [script, '--root', f.root, '--config', path.join(f.root, 'policy.json')], {encoding: 'utf8'}); };

// One fixture per report shape. Each report is compared with the saved one in fixtures/thin-plugin-reports;
// THIN_PLUGIN_UPDATE_REPORTS=1 rewrites them after a reviewed change.
const scenarios = {
  'pass': () => {},
  'forbidden-chain': f => { f.put('src/server.ts', `import {sdk} from '${CLIENT}';\nimport './bridge.js';\n${registrations}`); f.put('src/bridge.ts', `import './dacs/local.js';`); f.put('src/dacs/local.ts', 'export const harmless = 1;'); },
  'primitive-and-waiver': f => f.put('src/server.ts', `import {sdk} from '${CLIENT}';\n${registrations}\n// thin-plugin-waiver primitive:canonical-json -- display-only text, never signed\nfunction canonicalize(x) { return x; }\nexport function deriveJobId(x) { return x; }`),
  'unverifiable-import': f => f.put('src/server.ts', `import {sdk} from '${CLIENT}';\n${registrations}\nawait import(target);`),
  'missing-registration': f => { f.config.entries[2].modules[0].registration = 'absent'; },
  'lock-inventory': f => f.change('package-lock.json', p => { p.packages[`node_modules/${CLIENT}`].resolved = 'file:../sdk'; }),
  'pinned-tarball': f => {
    const spec = 'file:vendor/dacs-client-0.1.0.tgz';
    f.change('package.json', p => { p.dependencies[CLIENT] = spec; });
    f.change('package-lock.json', p => { p.packages[''].dependencies[CLIENT] = spec; p.packages[`node_modules/${CLIENT}`] = {version: '0.1.0', resolved: spec, integrity: integrityOf('tarball')}; });
    f.config.pinnedPackages = [{name: CLIENT, integrity: integrityOf('tarball')}];
  },
  'optional-absent': f => { f.config.entries[0].modules.push({file: 'buyer/src/server.mjs', registration: 'dacs_search', optional: true}); },
};

for (const [name, setup] of Object.entries(scenarios)) {
  test(`the JSON report for the ${name} fixture equals the saved report`, t => {
    const f = fixture(t); setup(f);
    const report = f.run(), saved = path.join(reports, `${name}.json`);
    if (process.env.THIN_PLUGIN_UPDATE_REPORTS === '1') { fs.mkdirSync(reports, {recursive: true}); fs.writeFileSync(saved, `${JSON.stringify(report, null, 2)}\n`); }
    assert.deepEqual(report, JSON.parse(fs.readFileSync(saved, 'utf8')));
    assert.ok(!JSON.stringify(report).includes(f.root));
  });
}

test('every saved report belongs to a fixture', () => {
  assert.deepEqual(fs.readdirSync(reports).sort(), Object.keys(scenarios).map(n => `${n}.json`).sort());
});

test('the CLI emits JSON plus a summary with no absolute root', t => {
  const f = fixture(t, `import './bridge.js';`); f.put('src/bridge.ts', `import './dacs/local.js';`); f.put('src/dacs/local.ts', 'export const x = 1;');
  const r = cli(f);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).status, 'violation');
  assert.match(r.stderr, /^Thin plugin: violation; 1 violations, 0 unverifiable, 0 waivers\.$/m);
  assert.match(r.stderr, /^Families: graph violation \(1 violations, 0 unverifiable\); inventory pass/m);
  assert.match(r.stderr, /^Violation local-dacs-module: dacs_search → src\/server\.ts → src\/bridge\.ts → src\/dacs\/local\.ts$/m);
  assert.ok(!r.stdout.includes(f.root) && !r.stderr.includes(f.root));
});

test('the CLI exit codes are 0 for pass, 1 for a violation and 2 for unverifiable', t => {
  assert.equal(cli(fixture(t)).status, 0);
  assert.equal(cli(fixture(t, 'export function deriveJobId(x) { return x; }')).status, 1);
  assert.equal(cli(fixture(t, 'await import(target);')).status, 2);
});

test('the CLI refuses bad arguments and an unreadable config with a JSON report', t => {
  const f = fixture(t);
  for (const [args, stage] of [[['--bogus'], 'arguments'], [['--root'], 'arguments'], [['--root', f.root, '--config', path.join(f.root, 'absent.json')], 'configuration']]) {
    const r = spawnSync(process.execPath, [checker, ...args], {encoding: 'utf8'});
    assert.equal(r.status, 2);
    assert.deepEqual(JSON.parse(r.stdout).unverifiable, [{rule: 'configuration-or-check-failure', file: '.', line: 0, detail: `${stage}-failure`}]);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test('the CLI without the TypeScript parser refuses with JSON and no stack', t => {
  const f = fixture(t);
  for (const s of ['check-thin-plugin.mjs', 'thin-plugin-scan.mjs']) f.put(`scripts/${s}`, fs.readFileSync(new URL(`../scripts/${s}`, import.meta.url), 'utf8'));
  const r = cli(f, path.join(f.root, 'scripts/check-thin-plugin.mjs'));
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).unverifiable[0].rule, 'parser-unavailable');
  assert.ok(!r.stderr.includes(f.root));
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('a symlinked CLI invocation emits the report', t => {
  const f = fixture(t); fs.symlinkSync(path.dirname(checker), path.join(f.root, 'linked-scripts'));
  const r = cli(f, path.join(f.root, 'linked-scripts/check-thin-plugin.mjs'));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).status, 'pass');
});

test('the shortest-chain report handles cycles and starts at the closest configured entry', t => {
  const f = fixture(t, `import './a.js';`);
  f.put('src/a.ts', `import './b.js';`); f.put('src/b.ts', `import './a.js';\nimport './c.js';`); f.put('src/c.ts', `import './dacs/x.js';`);
  f.put('src/dacs/x.ts', 'export const x = 1;');
  f.put('src/near.ts', `import '${CLIENT}';\nimport './dacs/x.js';\nserver.registerTool('near', {}, () => {});`);
  f.config.entries.push({name: 'near', modules: [{file: 'src/near.ts', registration: 'near'}]});
  const r = f.run(), row = r.violations.find(v => v.rule === 'local-dacs-module');
  assert.deepEqual([row.entry, row.chain], ['near', ['src/near.ts', 'src/dacs/x.ts']]);
  // Without the nearer entry the chain runs from the server through the cycle once.
  f.config.entries.pop();
  const far = f.run().violations.find(v => v.rule === 'local-dacs-module');
  assert.deepEqual([far.entry, far.chain], ['dacs_search', ['src/server.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/dacs/x.ts']]);
});

test('inventory findings carry no import chain', t => {
  const f = fixture(t); f.change('package.json', p => { delete p.dependencies[CLIENT]; });
  const row = f.run().violations.find(v => v.rule === 'missing-dacs-client');
  assert.deepEqual([row.chainKind, row.entry, row.chain], ['inventory', null, ['dependency/entry inventory', 'package.json']]);
});
