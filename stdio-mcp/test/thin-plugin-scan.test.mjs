import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire, isBuiltin} from 'node:module';
import {createModuleScanner} from '../scripts/thin-plugin-scan.mjs';

const ts = createRequire(import.meta.url)('typescript');
const config = {primitives: [
  {id: 'canonical-json', names: ['canonicalize'], calls: ['JSON.stringify', 'sort'], literals: ['dacs-agreement:v1:']},
  {id: 'job-id', names: ['deriveJobId']},
  {id: 'execution-readback', names: ['readExecution'], calls: ['getTxByHash'], references: ['getTxByHash']},
]};

// Files under a temp root; a minimal resolver: relative paths are local files,
// builtins are builtins, and `client-pkg` is a package boundary.
function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-scan-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  const resolve = (spec, importer) => {
    if (isBuiltin(spec)) return {kind: 'builtin', spec};
    if (spec === 'client-pkg') return {kind: 'package', spec, name: spec, file: path.join(root, 'client-pkg.js')};
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(importer), spec);
    const file = [base, base.replace(/\.js$/, '.ts')].find(f => fs.existsSync(f));
    return file ? {kind: 'local', file} : null;
  };
  const found = {violation: [], unverifiable: [], waiver: [], edge: []};
  const report = Object.fromEntries(Object.keys(found).map(k => [k, row => found[k].push(row)]));
  const modules = new Map();
  const scan = createModuleScanner({ts, config, resolve, rel: p => path.relative(root, p), report, modules});
  return {found, modules, scan: name => scan(path.join(root, name))};
}
const rules = rows => rows.map(r => `${r.rule}:${r.detail}`);

test('the factory refuses an incomplete context and keeps no state between scanners', t => {
  assert.throws(() => createModuleScanner({ts, config}), /invalid scanner context/);
  const a = project(t, {'a.ts': 'export function deriveJobId() { return 1; }\n'});
  const b = project(t, {'a.ts': 'export const ok = 1;\n'});
  a.scan('a.ts'); b.scan('a.ts');
  assert.equal(a.found.violation.length, 1);
  assert.deepEqual(b.found.violation, []);
  assert.equal(b.modules.size, 1);
});

test('a local primitive declared by name is flagged', t => {
  const p = project(t, {'jcs.ts': 'export function deriveJobId(x: string) { return x; }\n'});
  p.scan('jcs.ts');
  assert.deepEqual(rules(p.found.violation), ['local-protocol-primitive:job-id:deriveJobId']);
});

test('a renamed canonical-JSON encoder is flagged from its body calls and literal', t => {
  const body = (literal) => `export const encode = (v: object) => '${literal}' + JSON.stringify(v, Object.keys(v).sort());\n`;
  const p = project(t, {'enc.ts': body('dacs-agreement:v1:'), 'plain.ts': body('display:')});
  p.scan('enc.ts'); p.scan('plain.ts');
  assert.deepEqual(rules(p.found.violation), ['local-protocol-primitive:canonical-json:encode']);
  assert.equal(p.found.violation[0].file, 'enc.ts');
});

test('non-literal and reflective imports come back as unverifiable, not clean', t => {
  const p = project(t, {'m.mjs': [
    'const name = "./x.js";', 'await import(name);', 'require(`./${name}`);', 'eval("1");',
    'new Function("return 1");', 'const r = require;', 'const target = import.meta.resolve("./x.js");', '',
  ].join('\n')});
  p.scan('m.mjs');
  assert.deepEqual(p.found.violation, []);
  assert.deepEqual(p.found.unverifiable.map(r => r.rule).sort(),
    ['aliased-require', 'aliased-require', 'nonliteral-import', 'nonliteral-import', 'reflective-loader', 'reflective-loader', 'reflective-loader']);
});

test('a waiver without a reason is refused, and an unused waiver is reported', t => {
  const p = project(t, {
    'ok.ts': '// thin-plugin-waiver primitive:job-id -- display-only label, never signed\nexport function deriveJobId() { return 1; }\n',
    'short.ts': '// thin-plugin-waiver primitive:job-id -- tbd\nexport function deriveJobId() { return 1; }\n',
    'unused.ts': '// thin-plugin-waiver primitive:job-id -- nothing here needs this\nexport const ok = 1;\n',
  });
  for (const f of ['ok.ts', 'short.ts', 'unused.ts']) p.scan(f);
  assert.deepEqual(p.found.waiver.map(w => [w.file, w.primitive]), [['ok.ts', 'job-id']]);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.rule}`).sort(),
    ['short.ts:invalid-or-unused-waiver', 'short.ts:local-protocol-primitive', 'unused.ts:invalid-or-unused-waiver']);
});

test('transaction-by-hash references are flagged through members, destructuring and aliases', t => {
  const p = project(t, {
    'member.ts': 'export function a(c: any) { return c.getTxByHash("h"); }\n',
    'element.ts': 'export function b(c: any) { return c?.["getTxByHash"]("h"); }\n',
    'destructure.ts': 'export function d(c: any) { const {getTxByHash: read} = c; return read("h"); }\n',
    'alias.ts': 'export function e(c: any) { const read = c.getTxByHash; return read("h"); }\n',
    'param.ts': 'export function f({getTxByHash: unused}: any) { return 1; }\n',
    'escape.ts': 'declare const c: any;\nc.getTxByHash("h");\n',
    'type.ts': 'export type Reader = { getTxByHash(h: string): unknown };\n',
  });
  for (const f of ['member.ts', 'element.ts', 'destructure.ts', 'alias.ts', 'param.ts', 'escape.ts', 'type.ts']) p.scan(f);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`).sort(), [
    'alias.ts:execution-readback:e', 'destructure.ts:execution-readback:d', 'element.ts:execution-readback:b', 'member.ts:execution-readback:a', 'param.ts:execution-readback:f',
  ]);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.rule}`), ['escape.ts:readback-reference-escape']);
});

test('a waived readback helper makes its importer readback too', t => {
  const p = project(t, {
    'helper.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\n',
    'caller.ts': 'import {show} from "./helper.js";\nexport function decide(c: any) { return show(c); }\n',
  });
  p.scan('caller.ts');
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`), ['caller.ts:execution-readback:decide']);
});

test('the scan returns each module\'s import edges with type-only flags', t => {
  const p = project(t, {
    'entry.ts': [
      'import {sdk} from "client-pkg";', 'import type {T} from "./types.js";', 'import {type U} from "./types.js";',
      'import {helper} from "./helper.js";', 'export type {T};', 'import fs from "node:fs";', '',
    ].join('\n'),
    'types.ts': 'export type T = 1; export type U = 2;\n',
    'helper.ts': 'import {sdk} from "client-pkg";\nexport const helper = sdk;\n',
  });
  const result = p.scan('entry.ts');
  assert.deepEqual(result.imports.map(i => [i.kind, i.typeOnly, i.line]),
    [['package', false, 1], ['local', true, 2], ['local', true, 3], ['local', false, 4], ['builtin', false, 6]]);
  assert.deepEqual(p.found.edge.map(e => `${e.from}>${e.to}:${e.typeOnly}`).sort(), [
    'entry.ts>client-pkg.js:false', 'entry.ts>helper.ts:false', 'entry.ts>node:fs:false', 'entry.ts>types.ts:true', 'entry.ts>types.ts:true',
    'helper.ts>client-pkg.js:false',
  ]);
  assert.deepEqual([...p.modules.keys()].map(f => path.basename(f)).sort(), ['entry.ts', 'helper.ts', 'types.ts']);
  assert.deepEqual(p.found.violation, []);
});
