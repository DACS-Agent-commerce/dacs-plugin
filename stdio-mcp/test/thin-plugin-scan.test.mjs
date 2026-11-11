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
// builtins are builtins, and `client-pkg` is a package boundary. Like Node, `require` mode also
// finds a `.ts` file for an extensionless specifier; `import` mode needs the extension.
function project(t, files, scanConfig = config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-scan-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  const resolve = (spec, importer, mode) => {
    if (isBuiltin(spec)) return {kind: 'builtin', spec};
    if (spec === 'client-pkg') return {kind: 'package', spec, name: spec, file: path.join(root, 'client-pkg.js')};
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(importer), spec);
    const file = [base, base.replace(/\.js$/, '.ts'), ...(mode === 'require' ? [`${base}.ts`] : [])].find(f => fs.existsSync(f));
    return file ? {kind: 'local', file} : null;
  };
  const found = {violation: [], unverifiable: [], waiver: [], edge: []};
  const report = Object.fromEntries(Object.keys(found).map(k => [k, row => found[k].push(row)]));
  const modules = new Map();
  const scan = createModuleScanner({ts, config: scanConfig, resolve, rel: p => path.relative(root, p), report, modules});
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

test('eval and Function read through the global object, an alias or a comma are unverifiable', t => {
  const p = project(t, {'r.mjs': [
    'globalThis.eval("1");', 'globalThis["Function"]("return 1")();', 'window.eval("1 + 1");', '(0, eval)("1 + 1");',
    'const e = eval; e("1 + 1");', 'new globalThis.Function("return 1")();', '',
  ].join('\n'), 'ok.ts': 'export const isFn = (x: unknown): x is Function => typeof eval === "function" && x instanceof Function;\nexport const o = {eval: 1};\n'});
  p.scan('r.mjs'); p.scan('ok.ts');
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.line}`),
    [1, 2, 3, 4, 5, 6].map(l => `r.mjs:reflective-loader:${l}`));
});

test('createRequire under another name, through a namespace or getBuiltinModule, and require.call are unverifiable', t => {
  const p = project(t, {'req.mjs': [
    'import {createRequire as cr} from "node:module";', 'import * as m from "node:module";', 'const n = "./x.js";',
    'const r = cr(import.meta.url); r(n);', 'm.createRequire(import.meta.url)(n);',
    'process.getBuiltinModule("node:module").createRequire(import.meta.url)(n);', 'require.call(null, n);', '',
  ].join('\n')});
  p.scan('req.mjs');
  assert.deepEqual(p.found.unverifiable.map(r => `${r.rule}:${r.line}`).sort(),
    ['aliased-require:4', 'aliased-require:5', 'aliased-require:6', 'aliased-require:7', 'reflective-loader:6']);
});

test('a type assertion or non-null mark does not hide a reflective call, a computed key or an alias', t => {
  const p = project(t, {
    'cast.ts': [
      '(globalThis as any).eval("1");', '(globalThis as any)["Function"]("return 1")();', 'globalThis!.eval("1");',
      '(<any>globalThis).eval("1");', '(globalThis satisfies any).eval("1");', 'self.eval("1");', 'global.eval("1");', '',
    ].join('\n'),
    'key.ts': 'const key = "getTxByHash";\nexport function a(c: any) { return (c[key] as any)("h"); }\nexport function b(c: any) { return c[key]!("h"); }\nexport function d(c: any) { return (c[key])("h"); }\nexport function e(c: any) { return (c[key] satisfies any)("h"); }\n',
    'handoff.ts': '// thin-plugin-waiver primitive:execution-readback -- display only, never gates a payment\nexport function setup(c: any) {\n  const read = c.getTxByHash as any;\n  return {pay: (h: string) => read(h)};\n}\n',
  });
  for (const f of ['cast.ts', 'key.ts', 'handoff.ts']) p.scan(f);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.line}`).sort(), [
    ...[1, 2, 3, 4, 5, 6, 7].map(l => `cast.ts:reflective-loader:${l}`), ...[2, 3, 4, 5].map(l => `key.ts:computed-member-call:${l}`),
  ]);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`), ['handoff.ts:execution-readback:pay']);
});

test('a computed read that can supply a callable value is unverifiable wherever the value goes', t => {
  const p = project(t, {'read.ts': [
    'export function bound(c: any, k: string) { const read = c[k]; return read("h"); }',
    'export function assigned(c: any, k: string) { let read; read = c[k]; return read; }',
    'export function returned(c: any, k: string) { return c[k]; }',
    'export function passed(c: any, k: string) { return use(c[k]); }',
    'export function listed(c: any, k: string) { return [c[k]]; }',
    'export function member(c: any, k: string) { return {read: c[k]}; }',
    'export const optional = (c: any, k: string) => c?.[k];',
    'export function viaCall(c: any, k: string) { return c[k].call(null, "h"); }',
    'export function fallback(c: any, k: string) { return c[k] ?? null; }',
    'export function constructed(c: any, k: string) { return new c[k](); }',
    'export function cast(c: any, k: string) { const read = c[k] as any; return (c[k])!; }',
    'export function computedText(c: any) { const read = c["get" + "TxByHash"]; return read; }',
    '',
  ].join('\n')});
  p.scan('read.ts');
  assert.deepEqual(p.found.violation, []);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.rule}:${r.line}`),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12].map(l => `computed-member-read:${l}`));
});

test('a computed read whose value is only used as data is not flagged', t => {
  const p = project(t, {'data.ts': [
    'export function size(xs: any[], i: number) { return xs[i].length; }',
    'export function same(c: any, k: string) { return c[k] === 1 || !c[k] || typeof c[k] === "string"; }',
    'export function branch(c: any, k: string) { if (c[k]) { return `${c[k]}`; } return c[k] ? 1 : 0; }',
    'export function write(c: any, k: string) { c[k] = 1; c[k] += 1; c[k]++; delete c[k]; }',
    'export function literal(c: any) { return [c["a"], c[0], c.a]; }',
    'export function nested(c: any, k: string) { return c[k].name; }',
    'export function directCall(c: any, k: string) { return c[k]("h"); }',
    '',
  ].join('\n')});
  p.scan('data.ts');
  assert.deepEqual(p.found.violation, []);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.rule}:${r.line}`), ['computed-member-call:7']);
});

test('a computed read of the global object is unverifiable, since the key can resolve to eval', t => {
  const noReadback = {primitives: [{id: 'job-id', names: ['deriveJobId']}]};
  const p = project(t, {'g.ts': [
    'export function direct(key: string) { return globalThis[key]("return 1"); }',
    'export function bound(key: string) { const f = globalThis[key]; return f; }',
    'export function cast(key: string) { return (globalThis as any)[key]; }',
    'export function other(key: string) { return [self[key], window?.[key], global[key]]; }',
    'export function fromCall(key: string) { return new globalThis[key]("return 1"); }',
    'export function safe(key: string) { globalThis[0]; globalThis["setTimeout"]; return globalThis.name + key; }',
    '',
  ].join('\n'), 'plain.ts': 'export function read(c: any, k: string) { const v = c[k]; return v; }\n'}, noReadback);
  p.scan('g.ts'); p.scan('plain.ts');
  assert.deepEqual(p.found.violation, []);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.line}`),
    [1, 2, 3, 4, 4, 4, 5].map(l => `g.ts:reflective-loader:${l}`));
});

test('a computed read handed on by a logical assignment or a template tag is still unverifiable', t => {
  const p = project(t, {'handed.ts': [
    'export function called(c: any, k: string) { return (c[k] ??= null)("h"); }',
    'export function orBound(c: any, k: string) { const g = (c[k] ||= 0); return g; }',
    'export function andPassed(c: any, k: string) { return use(c[k] &&= 0); }',
    'export function wrapped(c: any, k: string) { return ((c[k] as any) ||= 0)!; }',
    'export function tagged(c: any, k: string) { return tag`${c[k]}`; }',
    'export function taggedMember(c: any, k: string) { return String.raw`a${c[k]}b${c[k]}`; }',
    'export function tagItself(c: any, k: string) { return c[k]`x`; }',
    '',
  ].join('\n'), 'kept.ts': [
    'export function statement(c: any, k: string) { c[k] ||= 1; c[k] ??= 1; (c[k] &&= 1); }',
    'export function plain(c: any, k: string) { c[k] = c[k] + 1; return `${c[k]}`; }',
    '',
  ].join('\n')});
  p.scan('handed.ts'); p.scan('kept.ts');
  assert.deepEqual(p.found.violation, []);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`),
    [1, 2, 3, 4, 5, 6, 6, 7].map(l => `handed.ts:${l}:computed-member-read`));
});

test('a computed read of the global object is unverifiable whatever is taken from it or done with it next', t => {
  const noReadback = {primitives: [{id: 'job-id', names: ['deriveJobId']}]};
  const p = project(t, {'g.ts': [
    'export function nested(a: string, b: string) { return globalThis[a][b]("return 1"); }',
    'export function ctor(k: string) { return globalThis[k].constructor("return 1")(); }',
    'export function literalMember(k: string) { return (globalThis as any)[k]["constructor"]; }',
    'export function chain(k: string) { return globalThis[k].mainModule.require("fs"); }',
    'export function logicalBound(k: string) { const g = (globalThis[k] ||= 0); return g; }',
    'export function logicalCalled(k: string) { return (globalThis[k] ??= 0)("return 1"); }',
    'export function tagged(k: string) { return tag`${globalThis[k]}`; }',
    'export function optionalMember(k: string) { return self?.[k]?.name; }',
    '',
  ].join('\n'), 'data.ts': [
    'export function writes(k: string) { globalThis[k] ||= 1; (window[k] ??= 1); globalThis[k] += 1; delete global[k]; }',
    'export function inspected(k: string) { return [typeof self[k], k in self, self[k] === undefined, !self[k], `${self[k]}`]; }',
    '',
  ].join('\n')}, noReadback);
  p.scan('g.ts'); p.scan('data.ts');
  assert.deepEqual(p.found.violation, []);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`),
    [1, 2, 3, 4, 5, 6, 7, 8].map(l => `g.ts:${l}:reflective-loader`));
});

test('a waiver without a reason is refused, and an unused waiver is reported', t => {
  const p = project(t, {
    'ok.ts': '// thin-plugin-waiver primitive:job-id -- display-only label, never signed\nexport function deriveJobId() { return 1; }\n',
    'short.ts': '// thin-plugin-waiver primitive:job-id -- tbd\nexport function deriveJobId() { return 1; }\n',
    'unused.ts': '// thin-plugin-waiver primitive:job-id -- nothing here needs this\nexport const ok = 1;\n',
    'bare.ts': '// thin-plugin-waiver primitive:job-id\nexport const ok = 1;\n',
    'empty.ts': '// thin-plugin-waiver primitive:job-id -- \nexport const ok = 1;\n',
  });
  for (const f of ['ok.ts', 'short.ts', 'unused.ts', 'bare.ts', 'empty.ts']) p.scan(f);
  assert.deepEqual(p.found.waiver.map(w => [w.file, w.primitive]), [['ok.ts', 'job-id']]);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.rule}`).sort(),
    ['bare.ts:invalid-or-unused-waiver', 'empty.ts:invalid-or-unused-waiver', 'short.ts:invalid-or-unused-waiver', 'short.ts:local-protocol-primitive', 'unused.ts:invalid-or-unused-waiver']);
});

test('transaction-by-hash references are flagged through members, destructuring and aliases', t => {
  const p = project(t, {
    'member.ts': 'export function a(c: any) { return c.getTxByHash("h"); }\n',
    'element.ts': 'export function b(c: any) { return c?.["getTxByHash"]("h"); }\n',
    'destructure.ts': 'export function d(c: any) { const {getTxByHash: read} = c; return read("h"); }\n',
    'alias.ts': 'export function e(c: any) { const read = c.getTxByHash; return read("h"); }\n',
    'param.ts': 'export function f({getTxByHash: unused}: any) { return 1; }\n',
    'escape.ts': 'declare const c: any;\nc.getTxByHash("h");\n',
    'export-member.ts': 'declare const c: any;\nexport default c.getTxByHash;\n',
    'computed.ts': 'export function g(c: any) { const key = "getTxByHash"; return c[key]("h"); }\nexport function h(c: any) { return c["getTx" + "ByHash"]("h"); }\nexport function k(xs: any[]) { return xs[0](); }\n',
    'handoff.ts': '// thin-plugin-waiver primitive:execution-readback -- display only, never gates a payment\nexport function setup(c: any) {\n  const read = c.getTxByHash;\n  return {\n    pay: (h: string) => read(h),\n  };\n}\n',
    'type.ts': 'export type Reader = { getTxByHash(h: string): unknown };\n',
  });
  for (const f of ['member.ts', 'element.ts', 'destructure.ts', 'alias.ts', 'param.ts', 'escape.ts', 'type.ts', 'computed.ts', 'handoff.ts', 'export-member.ts']) p.scan(f);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`).sort(), [
    'alias.ts:execution-readback:e', 'destructure.ts:execution-readback:d', 'element.ts:execution-readback:b', 'handoff.ts:execution-readback:pay', 'member.ts:execution-readback:a', 'param.ts:execution-readback:f',
  ]);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.line}`).sort(),
    ['computed.ts:computed-member-call:1', 'computed.ts:computed-member-call:2', 'escape.ts:readback-reference-escape:2', 'export-member.ts:readback-reference-escape:2']);
});

test('a waived readback helper makes its importer readback too', t => {
  const p = project(t, {
    'helper.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\n',
    'caller.ts': 'import {show} from "./helper.js";\nexport function decide(c: any) { return show(c); }\n',
  });
  p.scan('caller.ts');
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`), ['caller.ts:execution-readback:decide']);
});

test('a type-only re-export is not a primitive definition', t => {
  const p = project(t, {
    'types.ts': 'export type deriveJobId = (x: string) => string;\n',
    'a.ts': 'export type {deriveJobId} from "./types.js";\n',
    'b.ts': 'export {type deriveJobId} from "./types.js";\n',
    'c.ts': 'export {deriveJobId} from "./types.js";\n',
  });
  for (const f of ['a.ts', 'b.ts', 'c.ts']) p.scan(f);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`), ['c.ts:job-id:deriveJobId']);
});

test('a waived readback helper makes its importer readback through every import form', t => {
  const waived = (decl) => `// thin-plugin-waiver primitive:execution-readback -- status display only\n${decl} { return c.getTxByHash("h"); }\n`;
  const p = project(t, {
    'helper.ts': waived('export function show(c: any)') + 'export {show as view};\n',
    'dflt.ts': waived('export default function show(c: any)'),
    'named.ts': waived('function show(c: any)') + 'export default show;\n',
    'barrel.ts': 'export {show} from "./helper.js";\n',
    'star.ts': 'export * from "./helper.js";\n',
    'ns.ts': 'import * as h from "./helper.js";\nexport function a(c: any) { return h.show(c); }\nexport function b(c: any) { return h["view"](c); }\n',
    'renamed.ts': 'import {view} from "./helper.js";\nexport function a(c: any) { return view(c); }\n',
    'default.ts': 'import show from "./dflt.js";\nimport other from "./named.js";\nexport function a(c: any) { return show(c); }\nexport function b(c: any) { return other(c); }\n',
    'via-barrel.ts': 'import {show} from "./barrel.js";\nimport * as s from "./star.js";\nexport function a(c: any) { return show(c); }\nexport function b(c: any) { return s.view(c); }\n',
  });
  for (const f of ['ns.ts', 'renamed.ts', 'default.ts', 'via-barrel.ts']) p.scan(f);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`).sort(), [
    'default.ts:execution-readback:a', 'default.ts:execution-readback:b', 'ns.ts:execution-readback:a', 'ns.ts:execution-readback:b',
    'renamed.ts:execution-readback:a', 'via-barrel.ts:execution-readback:a', 'via-barrel.ts:execution-readback:b',
  ]);
  assert.deepEqual(p.found.unverifiable, []);
});

test('an import cycle cannot hide a waived readback helper from its importer', t => {
  const files = {
    'helper.ts': 'import {decide} from "./caller.js";\n// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\nexport const again = decide;\n',
    'caller.ts': 'import {show} from "./helper.js";\nexport function decide(c: any) { return show(c); }\n',
  };
  const helperFirst = project(t, files), callerFirst = project(t, files);
  helperFirst.scan('helper.ts'); callerFirst.scan('caller.ts');
  assert.deepEqual(helperFirst.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.detail}`), ['caller.ts:cyclic-waived-import:./helper.js']);
  assert.deepEqual(callerFirst.found.violation.map(r => `${r.file}:${r.detail}`), ['caller.ts:execution-readback:decide']);
});

test('a waived readback helper reached through a form that cannot carry the waiver is unverifiable', t => {
  const forms = {
    'destructure.ts': 'import * as h from "./helper.js";\nconst {show, show: s} = h;\nexport function a(c: any) { return show(c); }\nexport function b(c: any) { return s(c); }\n',
    'equals.ts': 'import h = require("./helper.js");\nexport function a(c: any) { return h.show(c); }\nexport function b(c: any) { return (h as any).show(c); }\ntype H = typeof h;\n',
    'late.ts': 'const {show} = h;\nexport function a(c: any) { return show(c); }\nimport * as h from "./helper.js";\n',
    'star-as.ts': 'export * as ns from "./helper.js";\n',
    'ns-export.ts': 'import * as h from "./helper.js";\nexport {h};\n',
    'ns-copy.ts': 'import * as h from "./helper.js";\nconst g = h;\nexport function a(c: any) { return use(h, c); }\nexport function b(c: any) { const {...r} = h; return r; }\nexport const k = (key: string) => h[key];\n',
    'dynamic.ts': 'export async function a(c: any) { const h = await import("./helper.js"); return h.show(c); }\nexport function b(c: any) { return require("./helper.js").show(c); }\n',
    'equals-export.ts': 'export import h = require("./helper.js");\n',
  };
  const p = project(t, {'helper.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\n', ...forms});
  for (const f of Object.keys(forms)) p.scan(f);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`).sort(), ['destructure.ts:execution-readback:a', 'destructure.ts:execution-readback:b', 'equals.ts:execution-readback:a', 'equals.ts:execution-readback:b', 'late.ts:execution-readback:a']);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`).sort(), [
    'dynamic.ts:1:untracked-waived-import', 'dynamic.ts:2:untracked-waived-import', 'equals-export.ts:1:untracked-waived-import',
    'ns-copy.ts:2:namespace-escape', 'ns-copy.ts:3:namespace-escape', 'ns-copy.ts:4:namespace-escape', 'ns-copy.ts:5:computed-member-read', 'ns-copy.ts:5:namespace-escape', 'ns-export.ts:2:namespace-escape', 'star-as.ts:1:untracked-waived-import',
  ]);
  // The same forms over a module without readback waivers add nothing, except the computed read h[key] itself.
  const plain = project(t, {'helper.ts': 'export function show(c: any) { return c; }\n', ...forms});
  for (const f of Object.keys(forms)) plain.scan(f);
  assert.deepEqual(plain.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`), ['ns-copy.ts:5:computed-member-read']);
});

test('an import cycle through a barrel cannot hide a waived readback helper from either end', t => {
  const helper = 'import {decide} from "./caller.js";\n// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\nexport const again = decide;\n';
  const barrels = {
    from: ['export {show} from "./helper.js";\n', 'import {show} from "./barrel.js";'],
    local: ['import {show} from "./helper.js";\nexport {show};\n', 'import {show} from "./barrel.js";'],
    default: ['import {show} from "./helper.js";\nexport default show;\n', 'import show from "./barrel.js";'],
  };
  for (const [kind, [barrel, importLine]] of Object.entries(barrels)) {
    const files = {'helper.ts': helper, 'barrel.ts': barrel, 'caller.ts': `${importLine}\nexport function decide(c: any) { return show(c); }\n`};
    const seen = Object.fromEntries(['barrel.ts', 'caller.ts', 'helper.ts'].map(first => {
      const p = project(t, files);
      for (const f of [first, ...Object.keys(files)]) p.scan(f);
      return [first, [...p.found.violation, ...p.found.unverifiable].map(r => `${r.file}:${r.rule}:${r.detail}`)];
    }));
    assert.deepEqual(seen, {
      'barrel.ts': ['caller.ts:cyclic-waived-import:./barrel.js'],
      'caller.ts': ['caller.ts:local-protocol-primitive:execution-readback:decide'],
      'helper.ts': ['barrel.ts:cyclic-waived-import:./helper.js'],
    }, kind);
  }
});

test('a module-level alias of a readback member makes its importer readback through every export shape', t => {
  const client = 'declare const client: any;\n';
  const helpers = {
    'const.ts': client + 'export const read = client.getTxByHash;\n',
    'element.ts': client + 'export const read = client["getTxByHash"];\n',
    'destructure.ts': client + 'export const {getTxByHash: read} = client;\n',
    'with-rest.ts': client + 'export const {getTxByHash: read, ...rest} = client;\n',
    'local-export.ts': client + 'const alias = client.getTxByHash;\nexport {alias as read};\n',
    'default.ts': client + 'const alias = client.getTxByHash;\nexport default alias;\n',
    'barrel.ts': 'export {read} from "./const.js";\n',
    'star.ts': 'export * from "./const.js";\n',
  };
  const importers = {
    'use-const.ts': 'import {read} from "./const.js";\nexport function viaConst(h: string) { return read(h); }\n',
    'use-element.ts': 'import {read} from "./element.js";\nexport function viaElement(h: string) { return read(h); }\n',
    'use-destructure.ts': 'import {read} from "./destructure.js";\nexport function viaDestructure(h: string) { return read(h); }\n',
    'use-with-rest.ts': 'import {read} from "./with-rest.js";\nexport function viaWithRest(h: string) { return read(h); }\n',
    'use-local-export.ts': 'import {read} from "./local-export.js";\nexport function viaLocalExport(h: string) { return read(h); }\n',
    'use-default.ts': 'import read from "./default.js";\nexport function viaDefault(h: string) { return read(h); }\n',
    'use-barrel.ts': 'import {read} from "./barrel.js";\nexport function viaBarrel(h: string) { return read(h); }\n',
    'use-star.ts': 'import {read} from "./star.js";\nexport function viaStar(h: string) { return read(h); }\n',
    'use-namespace.ts': 'import * as h from "./const.js";\nexport function viaNamespace(x: string) { return h.read(x); }\n',
    'use-top-level.ts': 'import {read} from "./const.js";\nread("h");\n',
  };
  const p = project(t, {...helpers, ...importers});
  for (const f of Object.keys(importers)) p.scan(f);
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`).sort(), [
    'use-barrel.ts:execution-readback:viaBarrel', 'use-const.ts:execution-readback:viaConst', 'use-default.ts:execution-readback:viaDefault',
    'use-destructure.ts:execution-readback:viaDestructure', 'use-element.ts:execution-readback:viaElement', 'use-local-export.ts:execution-readback:viaLocalExport',
    'use-namespace.ts:execution-readback:viaNamespace', 'use-star.ts:execution-readback:viaStar', 'use-with-rest.ts:execution-readback:viaWithRest',
  ]);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`), ['use-top-level.ts:2:readback-reference-escape']);
});

const cycleAliases = {
  member: 'const read = client.getTxByHash;',
  element: 'const read = client["getTxByHash"];',
  object: 'const {getTxByHash: read} = client;',
  'quoted-object': 'const {"getTxByHash": read} = client;',
  'computed-object': 'const {["getTxByHash"]: read} = client;',
  'computed-nested-object': 'const {x: {["getTxByHash"]: read}} = client;',
  'computed-array-object': 'const [{["getTxByHash"]: read}] = [client];',
  'object-rest': 'const {getTxByHash: read, ...rest} = client;',
  'nested-object': 'const {x: {getTxByHash: read}} = client;',
  array: 'const [{getTxByHash: read}] = [client];',
  'nested-array': 'const [[{getTxByHash: read}]] = [[client]];',
  'object-array': 'const {x: [{getTxByHash: read}]} = client;',
  'array-object-array': 'const [{x: [{getTxByHash: read}]}] = [client];',
  'omitted-element': 'const [, {getTxByHash: read}] = [0, client];',
  'array-rest': 'const [...[{getTxByHash: read}]] = [client];',
  namespace: 'import * as h from "./waived.js";\nconst {show: read} = h;',
  'quoted-namespace': 'import * as h from "./waived.js";\nconst {"show": read} = h;',
  'shorthand-namespace': 'import * as h from "./waived.js";\nconst {read} = h;',
  'defaulted-namespace': 'import * as h from "./waived.js";\nconst {show: read = () => null} = h;',
  'import-equals-namespace': 'import h = require("./waived.js");\nconst {show: read} = h;',
};
const cycleExports = {
  declaration: [s => s.replace('const ', 'export const '), 'helper', 'import {read}'],
  local: [s => `${s}\nexport {read};`, 'helper', 'import {read}'],
  default: [s => `${s}\nexport default read;`, 'helper', 'import read'],
  barrel: [s => `${s}\nexport {read};`, 'barrel', 'import {read}'],
  star: [s => `${s}\nexport {read};`, 'star', 'import {read}'],
};
for (const [shape, alias] of Object.entries(cycleAliases)) for (const [kind, [expose, source, importLine]] of Object.entries(cycleExports)) {
  test(`an import cycle cannot hide a module-level readback alias: ${shape}, ${kind} export`, t => {
    const files = {
      'helper.ts': `import {decide} from "./caller.js";\ndeclare const client: any;\n${expose(alias)}\nexport const again = decide;\n`,
      'caller.ts': `${importLine} from "./${source}.js";\nexport function decide(h: string) { return read(h); }\n`,
      'barrel.ts': 'export {read} from "./helper.js";\n',
      'star.ts': 'export * from "./helper.js";\n',
      'waived.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\nexport {show as read};\n',
    };
    const helperFirst = project(t, files), callerFirst = project(t, files);
    helperFirst.scan('helper.ts'); callerFirst.scan('caller.ts');
    const cycleFile = source === 'helper' ? 'caller.ts' : `${source}.ts`;
    assert.deepEqual(helperFirst.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.detail}`), [`${cycleFile}:cyclic-waived-import:./helper.js`]);
    assert.deepEqual(callerFirst.found.violation.map(r => `${r.file}:${r.detail}`), ['caller.ts:execution-readback:decide']);
    assert.deepEqual(helperFirst.found.violation, []);
    assert.deepEqual(callerFirst.found.unverifiable, []);
  });
}

test('an empty namespace destructure does not forward aliases in an import cycle', t => {
  const files = {
    'helper.ts': 'import {decide} from "./caller.js";\nimport * as h from "./data.js";\nconst {} = h;\nexport const read = () => 1;\nexport const again = decide;\n',
    'caller.ts': 'import {read} from "./helper.js";\nexport function decide() { return read(); }\n',
    'data.ts': 'export const value = 1;\n',
  };
  for (const first of ['helper.ts', 'caller.ts']) {
    const p = project(t, files);
    p.scan(first);
    assert.deepEqual(p.found.violation, []);
    assert.deepEqual(p.found.unverifiable, []);
  }
});

test('an import-equals namespace without a file extension is followed in an import cycle from either end', t => {
  const files = {
    'helper.ts': 'import {decide} from "./caller.js";\nimport h = require("./waived");\nconst {show: read} = h;\nexport {read};\nexport const again = decide;\n',
    'caller.ts': 'import {read} from "./helper.js";\nexport function decide(h: string) { return read(h); }\n',
    'waived.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\n',
  };
  const helperFirst = project(t, files), callerFirst = project(t, files);
  helperFirst.scan('helper.ts'); callerFirst.scan('caller.ts');
  assert.deepEqual(helperFirst.found.unverifiable.map(r => `${r.file}:${r.rule}:${r.detail}`), ['caller.ts:cyclic-waived-import:./helper.js']);
  assert.deepEqual(callerFirst.found.violation.map(r => `${r.file}:${r.detail}`), ['caller.ts:execution-readback:decide']);
});

test('a readback alias declared outside a top-level statement is unverifiable, not clean', t => {
  const helpers = {
    'block-var.ts': 'declare const client: any;\n{ var read = client.getTxByHash; }\nexport {read};\n',
    'block-destructure.ts': 'declare const client: any;\n{ var {getTxByHash: read} = client; }\nexport {read};\n',
    'namespace-var.ts': 'declare const client: any;\nexport namespace N { export var read = client.getTxByHash; }\n',
  };
  const importers = {
    'use-block-var.ts': 'import {read} from "./block-var.js";\nexport function viaBlockVar(h: string) { return read(h); }\n',
    'use-block-destructure.ts': 'import {read} from "./block-destructure.js";\nexport function viaBlockDestructure(h: string) { return read(h); }\n',
    'use-namespace-var.ts': 'import {N} from "./namespace-var.js";\nexport function viaNamespaceVar(h: string) { return N.read(h); }\n',
  };
  const p = project(t, {...helpers, ...importers});
  for (const f of Object.keys(importers)) p.scan(f);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`).sort(),
    ['block-destructure.ts:2:readback-reference-escape', 'block-var.ts:2:readback-reference-escape', 'namespace-var.ts:2:readback-reference-escape']);
});

test('export = of a readback alias is unverifiable, not clean', t => {
  const p = project(t, {
    'alias.ts': 'declare const client: any;\nconst read = client.getTxByHash;\nexport = read;\n',
    'waived.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nfunction show(c: any) { return c.getTxByHash("h"); }\nexport = show;\n',
    'use-alias.ts': 'import read = require("./alias");\nexport function viaAlias(h: string) { return read(h); }\n',
  });
  for (const f of ['use-alias.ts', 'waived.ts']) p.scan(f);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.line}:${r.rule}`).sort(), ['alias.ts:3:readback-reference-escape', 'waived.ts:3:readback-reference-escape']);
});

test('a computed string-literal key in a destructure reads the readback member like a plain key', t => {
  const p = project(t, {
    'inside-function.ts': 'export function decide(c: any, h: string) { const {["getTxByHash"]: read} = c; return read(h); }\n',
    'alias.ts': 'declare const client: any;\nexport const {["getTxByHash"]: read} = client;\n',
    'use-alias.ts': 'import {read} from "./alias.js";\nexport function viaAlias(h: string) { return read(h); }\n',
  });
  p.scan('inside-function.ts'); p.scan('use-alias.ts');
  assert.deepEqual(p.found.violation.map(r => `${r.file}:${r.detail}`).sort(), ['inside-function.ts:execution-readback:decide', 'use-alias.ts:execution-readback:viaAlias']);
  assert.deepEqual(p.found.unverifiable, []);
});

test('a type-only re-export of a waived dependency namespace is not a runtime namespace escape', t => {
  const p = project(t, {
    'helper.ts': '// thin-plugin-waiver primitive:execution-readback -- status display only\nexport function show(c: any) { return c.getTxByHash("h"); }\n',
    'type-export.ts': 'import type * as h from "./helper.js";\nexport type {h};\n',
    'inline-type-export.ts': 'import type * as h from "./helper.js";\nexport {type h};\n',
    'value-export.ts': 'import * as h from "./helper.js";\nexport {h};\n',
  });
  for (const f of ['type-export.ts', 'inline-type-export.ts', 'value-export.ts']) p.scan(f);
  assert.deepEqual(p.found.unverifiable.map(r => `${r.file}:${r.rule}`), ['value-export.ts:namespace-escape']);
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
