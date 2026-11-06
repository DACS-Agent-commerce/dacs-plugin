import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GateInputError, readCommitObjects } from '../../scripts/public-gate/objects.mjs';
import { createEvalScanner, hasValidEvalConfig } from '../../scripts/public-gate/rules-eval.mjs';
import { CONFIG_FILE, REPO_ROOT, completeArgs, createHistory, createRepo, gateArgs, historyArgs, makeTempDir, runGate, runHistory, sha256, writeList } from '../lib/gate-fixtures.mjs';

const CONFIG = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
const LIMITS = CONFIG.limits;
const EVAL_CALL = 'eval("1 + 1");\n';
const RUNTIME_DIR = 'http-mcp/public/portal/embedded-wallet';
/** The listed chunk that holds dynamic evaluation today. */
const GENERATED_PATH = `${RUNTIME_DIR}/runtime-chunks/chunk-YUIZVLEY.mjs`;
const GENERATED_BYTES = readFileSync(path.join(REPO_ROOT, GENERATED_PATH));
const UNLISTED_COPY = 'src/copy-of-runtime.mjs';

const fileEntry = (name, text, position) => ({ path: name, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text), oid: sha256(text).slice(0, 40), kind: 'blob', position });
/** Scans `files` ([name, text] pairs) in one scanner run; returns { findings, unscannable } with each entry replaced by its path. */
async function scan(files, { config = CONFIG, limits = LIMITS, parser } = {}) {
  const result = await createEvalScanner({ config, limits, parser }).scan(files.map(([name, text], index) => fileEntry(name, text, index + 1)));
  return {
    findings: result.findings.map(({ entry, rule, kind, line }) => ({ path: entry.path, rule, kind, line })),
    unscannable: result.unscannable.map(({ entry, cause }) => ({ path: entry.path, cause })),
  };
}
const pathsOf = (result) => [...new Set(result.findings.map(({ path: name }) => name))].sort();
/** Scans each snippet as `<index>.<extension>` and returns the names of the snippets that fail. */
async function failingSnippets(snippets, extension = 'mjs') {
  const result = await scan(snippets.map((text, index) => [`s${index}.${extension}`, text]));
  assert.deepEqual(result.unscannable, []);
  return pathsOf(result);
}
/** Scans each snippet as `<index>.mjs` and returns the names of the snippets with a finding, whatever else they make unscannable. */
const flaggedSnippets = async (snippets) => pathsOf(await scan(snippets.map((text, index) => [`s${index}.mjs`, text])));
/** Asserts each snippet is unscannable as eval-computed-member and has no finding. */
async function assertComputed(snippets) {
  const result = await scan(snippets.map((text, index) => [`s${index}.mjs`, text]));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unscannable, snippets.map((_, index) => ({ path: `s${index}.mjs`, cause: 'eval-computed-member' })));
}
const names = (count) => Array.from({ length: count }, (_, index) => `s${index}.mjs`).sort();
const failsWith = (cause) => (error) => error instanceof GateInputError && error.cause === cause;
const withListed = (...entries) => ({ ...CONFIG, evalGeneratedFiles: entries.map(([file, bytes]) => ({ path: file, sha256: sha256(bytes), reason: 'generated code that holds eval by design' })) });

test('eval :: "direct eval, new Function and Function calls fail outside the listed generated files" (T06)', async () => {
  const snippets = ['eval("1");', 'new Function("a", "return a");', 'Function("return 1")();', 'const f = new Function("return 1"); f();'];
  assert.deepEqual(await failingSnippets(snippets), names(4));
  const result = await scan([['a.mjs', `const x = 1;\n${EVAL_CALL}`]]);
  assert.deepEqual(result.findings, [{ path: 'a.mjs', rule: 'R-EVAL', kind: 'content', line: 2 }]);
  const listed = await scan([[GENERATED_PATH, GENERATED_BYTES], ['other.mjs', EVAL_CALL]], { config: withListed([GENERATED_PATH, GENERATED_BYTES]) });
  assert.deepEqual(pathsOf(listed), ['other.mjs']);
});

test('eval :: "member, bracket, optional and comma-expression access to the global eval or Function fails, and so does using either as a value or calling a simple alias" (T07)', async () => {
  const failing = [
    'globalThis.eval("1");', 'window["eval"]("1");', 'globalThis?.eval?.("1");', '(0, eval)("1");', 'const run = eval; run("1");', 'const list = [eval];', 'register(eval);',
    'self.Function("return 1");', 'new globalThis.Function("return 1");', 'window[`eval`]("1");', 'const { eval: run } = globalThis;', 'class Runner extends Function {}',
    'globalThis.window.eval("1");', 'const make = window.Function;', '(eval)("1");', 'const o = { eval };',
    '(ok ? window : self).eval("1");', '(window || self).eval("1");', 'new (globalThis ?? window).Function("1");', 'let g; (g = window).eval("1");',
  ];
  assert.deepEqual(await failingSnippets(failing), names(failing.length));
  assert.deepEqual(await failingSnippets(['let handler: Function; type Callback = Function; const x = y as Function;'], 'ts'), []);
});

test('eval :: "the name eval or Function fails on any object and in any key, property, member, binding, specifier or label position, whatever value holds it"', async () => {
  const failing = [
    'thing.eval("1");', 'const o = { eval: 1, Function: 2 };', 'o.Function = 3;', 'class A { eval() {} Function() {} }', 'import { eval as e } from "x"; export { e };', 'g.eval("1");',
    'window.app.eval;', 'const [{ eval: run }, w] = [app, window];', 'export { x as "eval" };', 'import { "Function" as F } from "x";', 'const { "eval": e } = x;', 'x["Function"];', 'x[("eval")];',
    'const o = { ["eval"]: 1 };', 'eval: for (;;) break eval;', 'const { eval: run } = [window][0];', '[window][0].eval();', 'const { eval: run } = { ...window };', 'Object(window).eval();',
    'top.eval();', 'window.parent.eval();', 'frames.eval();',
  ];
  assert.deepEqual(await failingSnippets(failing), names(failing.length));
});

test('eval :: "interfaces, implements clauses and declare declarations are erased by TypeScript, so nothing in them counts; a class extends clause and the code around them still do"', async () => {
  const erased = [
    'interface I extends Function {}', 'class C implements Function {}', 'interface I extends globalThis.Function {}', 'class C implements window.Function {}', 'class C extends Base implements Function {}',
    'interface I { [window.eval]: number }', 'interface I { [globalThis[k]]: number }',
    'declare class C extends Function {}', 'export declare class C extends Function {}', 'declare namespace N { class C extends Function {} }', 'declare module "m" { export class C extends Function {} }',
    'declare const x = eval("1");', 'declare function f() { eval("1"); }', 'declare enum E { A = eval("1") }', 'declare global { var g: typeof eval; }', 'class C { declare static x: Function }',
    'namespace N { declare class C { m() { eval("1"); } } }',
  ];
  assert.deepEqual(await failingSnippets(erased, 'ts'), []);
  assert.deepEqual(await failingSnippets(['interface P extends Function {}\nconst x = <div />;'], 'tsx'), []);
  const running = [
    'class C extends Function {}', 'class C extends globalThis.Function implements I {}', 'const C = class extends Function {};', 'export class C extends Function {}', 'const f = eval<string>;',
    'class C implements I { run = eval; }', 'interface I {}\neval("1");', 'declare const x: number;\neval("1");', 'namespace N { eval("1"); }',
    // The emitter keeps these despite `declare`: an export assignment, an import alias and a decorated class field.
    'declare export default eval(payload);', 'declare export = eval(payload);', 'declare import e = globalThis.eval;\ne("1");', 'declare import e = Function;\nnew e("x");',
    'export declare import e = globalThis.eval;', 'declare export import e = globalThis.eval;', 'class C { @(eval("1")) declare x: number }', 'class C { @(globalThis.eval) declare x: number }',
    'class C { declare x = eval("1") }',
  ];
  assert.deepEqual(await failingSnippets(running, 'ts'), names(running.length).map((name) => name.replace('.mjs', '.ts')));
  assert.deepEqual(await failingSnippets(['interface\nI\n{ eval("1") }', 'declare\nnamespace\nN\n{ eval("1") }']), names(2));
  assert.deepEqual(await scan([['a.ts', 'class C implements I { m() { return globalThis[k]; } }']]), { findings: [], unscannable: [{ path: 'a.ts', cause: 'eval-computed-member' }] });
});

test('eval :: "type-only imports and exports are erased by TypeScript, so a name in them counts for nothing; the same forms without type still count"', async () => {
  const erased = [
    'import type { eval as E } from "pkg";', 'import type { Function } from "pkg";', 'import type { "eval" as E } from "pkg";', 'import { type eval as E } from "pkg";', 'import { type Function } from "pkg";',
    'import type { eval as E }\nfrom "pkg";', 'export type { eval } from "pkg";', 'export type { eval as E } from "pkg";', 'export type { x as Function } from "pkg";', 'export { type eval } from "pkg";',
    'export type { eval };', 'export { type eval as E };', 'import type e = globalThis.eval;', 'export type * as eval from "pkg";', 'import type eval from "pkg";',
  ];
  assert.deepEqual(await failingSnippets(erased, 'ts'), []);
  assert.deepEqual(await failingSnippets(['import type { eval as E } from "pkg";'], 'tsx'), []);
  const running = [
    'import { eval as E } from "pkg";', 'import { type A, eval as E } from "pkg";', 'import { Function } from "pkg";', 'export { eval } from "pkg";', 'export { type A, eval } from "pkg";',
    'export * as eval from "pkg";', 'import eval from "pkg";', 'import e = globalThis.eval;', 'import type { A } from "pkg";\neval("1");', 'export type { A } from "pkg";\neval("1");',
  ];
  assert.deepEqual(await failingSnippets(running, 'ts'), names(running.length).map((name) => name.replace('.mjs', '.ts')));
});

test('eval :: "a global object or timer named only in an erased type counts for nothing; named in code that runs, it still counts"', async () => {
  const typeOnly = [
    'const v = ({} as typeof globalThis)[key];', 'const v = (<typeof window>{})[key];', 'const v = ({} satisfies Partial<typeof self>)[key];', 'const v = (o as Window & typeof globalThis)[key];',
    'const v = make<typeof window>()[key];', 'const v = (make<typeof global>)[key];', 'const v = ((w: typeof window) => w)(o)[key];', 'const v = ((): typeof self => o)()[key];',
    'const v = (class implements globalThis.I {})[key];', 'const v = (class { x!: typeof window })[key];', 'const v = (class { declare x: typeof window })[key];',
    'const { [k]: v } = o as typeof globalThis;', 'const { [k]: v = (d as typeof window) } = o;', 'const { [k]: f = (w: typeof window) => 0 } = o;', '({ [k]: v } = o as typeof globalThis);',
    'for (const { [k]: v } of list as Array<typeof window>) {}', 'function f({ [k]: v } = o as typeof self) {}',
    'make<typeof setTimeout>()("x");', '((t: typeof setInterval) => run)(o)("x");', '(o as typeof window).setTimeout("x");', 'make<typeof setTimeout>()`x`;',
  ];
  assert.deepEqual(await scan(typeOnly.map((text, index) => [`s${index}.ts`, text])), { findings: [], unscannable: [] });
  const openKeys = [
    'const v = (o as any, globalThis)[key];', 'const v = (globalThis as any)[key];', 'const v = ((w: typeof window) => globalThis)(o)[key];', 'const { [k]: v } = globalThis as typeof globalThis;',
    'const v = (class extends globalThis.B {})[key];', 'const v = (class { @(globalThis.d) declare x: T })[key];',
  ];
  const unjudged = await scan(openKeys.map((text, index) => [`s${index}.ts`, text]));
  assert.deepEqual(unjudged.findings, []);
  assert.deepEqual(unjudged.unscannable, openKeys.map((_, index) => ({ path: `s${index}.ts`, cause: 'eval-computed-member' })));
  const timers = ['make<typeof x>(setTimeout)("x");', '(window as typeof window).setTimeout("x");'];
  assert.deepEqual(await failingSnippets(timers, 'ts'), ['s0.ts', 's1.ts']);
});

test('eval :: "executable template substitutions are parsed; the same words in strings, template text, comments and regular expressions pass" (T08)', async () => {
  const failing = ['const t = `${eval("1")}`;', 'const t = `a ${`b ${new Function("x")}`}`;'];
  assert.deepEqual(await failingSnippets(failing), names(2));
  const harmless = ['const a = "eval(1) new Function(1)";', "const b = 'Function(1)';", 'const c = `eval(1) ${1} new Function`;', '// eval(1)\n/* new Function(1) */\nconst d = 1;', 'const e = /eval\\(1\\)|Function\\(/;'];
  assert.deepEqual(await failingSnippets(harmless), []);
});

const scanHtml =(html, options) => scan([['page.html', html]], options);
const UNREADABLE = [{ path: 'page.html', cause: 'eval-html-unreadable' }];
const htmlFinding = (line) => ({ path: 'page.html', rule: 'R-EVAL', kind: 'content', line });

test('eval :: "HTML scripts and handlers in the exact forms are judged as code, and a finding carries its line in the HTML file" (T08)', async (t) => {
  await t.test('each allowed script form reports the line of the eval call inside its body', async () => {
    for (const tag of ['<script>', '<script type="module">', '<script type="text/javascript">', '<script src="app.js">', '<script src="app.js" type="module">']) {
      assert.deepEqual(await scanHtml(`<p>one</p>\n<p>two</p>\n${tag}\nconst x = 1;\neval("1");\n</script>\n`), { findings: [htmlFinding(5)], unscannable: [] }, tag);
    }
  });
  await t.test('a handler reports its own line, and a value over several lines counts them', async () => {
    const html = '<p>x</p>\n<a href="#" onclick="go()">a</a>\n<b onmouseover="eval(1)">b</b>\n<i onfocus="a();\nnew Function(1)">c</i>\n';
    assert.deepEqual(await scanHtml(html), { findings: [htmlFinding(3), htmlFinding(5)], unscannable: [] });
  });
  await t.test('lines count as the JavaScript parser counts them: CRLF and a lone CR are one break each', async () => {
    for (const lineBreak of ['\r\n', '\r']) {
      const html = ['<p>x</p>', '<script>', 'eval(1);', '</script>', '<a onclick="', 'new Function(1)">c</a>', ''].join(lineBreak);
      assert.deepEqual((await scanHtml(html)).findings, [htmlFinding(3), htmlFinding(6)], JSON.stringify(lineBreak));
    }
  });
  await t.test('an .htm file is read the same way', async () => {
    const result = await scan([['page.htm', '<script>eval(1);</script>\n<a onclick="eval(1)">x</a>\n']]);
    assert.deepEqual(result.findings.map(({ line }) => line), [1, 2]);
  });
  await t.test('a handler that closes its own wrapper, or ends in a line comment, cannot hide code', async () => {
    assert.deepEqual((await scanHtml('<a onclick="}); eval(1); (function () {">x</a>\n')).findings, [htmlFinding(1)]);
    assert.deepEqual(await scanHtml('<a onclick="go() // note">x</a>\n<b onclick="eval(1) // note">y</b>\n'), { findings: [htmlFinding(2)], unscannable: [] });
  });
  await t.test('an on…= inside an accepted handler value is code, not another attribute', async () => {
    assert.deepEqual(await scanHtml('<img onerror="this.onerror=null; eval(1)" src="a.png">\n'), { findings: [htmlFinding(1)], unscannable: [] });
  });
});

test('eval :: "HTML with no code to judge gives no finding and no unscannable entry: blank and src-only scripts, harmless handlers and the same words in text or comments"', async () => {
  const harmless = ['<script src="app.js"></script>', '<script></script>', '<script type="module">  \n </script>', '<a onclick="go(1)">eval(1)</a>', '<a onclick="return false">x</a>',
    '<p>eval("1") and new Function("x") in text</p>', '<!-- eval(1) -->', '<script>const s = "eval(1)"; // new Function(1)\n</script>',
    '<input person="a" region="b" onclick>', '<a xonclick="eval(1)" 9onclick="eval(1)">x</a>'];
  assert.deepEqual(await scanHtml(`${harmless.join('\n')}\n`), { findings: [], unscannable: [] });
});

test('eval :: "script forms outside the exact list are unreadable, never read as data or skipped: another type, data-type, a type inside a value, other attributes, case, spacing, an entity, no closing tag or a < in the body" (T08)', async () => {
  const forms = [
    '<script type="application/json">{"a":1}</script>', '<script data-type="application/json" type="text/javascript">eval("1");</script>', '<script type="text/javascript" data-type="application/json">eval("1");</script>',
    '<script data-note="type=application/json">eval("1");</script>', '<script type="application/json" type="text/javascript">eval("1");</script>', '<script type="module" type="application/json">x</script>',
    "<script type='module'>eval(1);</script>", '<script type=module>eval(1);</script>', '<script type="text&#47;javascript">eval(1);</script>', '<script type="text/jscript">eval(1);</script>',
    '<SCRIPT>eval(1);</SCRIPT>', '<script >eval(1);</script>', '<script\ntype="module">eval(1);</script>', '<script/type="module">eval(1);</script>', '<script async>eval(1);</script>', '<script src="a.js"/>',
    '<script src="a&amp;b.js">eval(1);</script>', '<script src="a<b.js">eval(1);</script>', '<script src=\'a.js\'>eval(1);</script>', '<scripts>eval(1);</scripts>',
    '<script>eval(1);', '<script>if (a < b) eval(1);</script>', '<script>eval(1);</script >', '<script>eval(1);</SCRIPT>',
  ];
  for (const form of forms) assert.deepEqual(await scanHtml(`<p>x</p>\n${form}\n`), { findings: [], unscannable: UNREADABLE }, form);
});

test('eval :: "handler forms outside the exact form are unreadable and entities are never decoded; a name that only ends in on, or starts after a letter or digit, is no handler" (T08)', async () => {
  const forms = [
    "<a onclick='eval(1)'>x</a>", '<a onclick=eval(1)>x</a>', '<a onclick = "eval(1)">x</a>', '<a onclick ="eval(1)">x</a>', '<a ONCLICK="eval(1)">x</a>', '<a OnClick="eval(1)">x</a>', '<a\nonclick="eval(1)">x</a>',
    '<a\tonclick="eval(1)">x</a>', '<a data-onclick="eval(1)">x</a>', '<a onclick="&#101;val(1)">x</a>', '<a onclick="a&amp;b">x</a>', '<a onclick2="x">y</a>', '<a on="x">y</a>', '<p>turn on = 3</p>',
    '<a onclick="never closed>x</a>',
  ];
  for (const form of forms) assert.deepEqual(await scanHtml(`<p>x</p>\n${form}\n`), { findings: [], unscannable: UNREADABLE }, form);
  assert.deepEqual(await scanHtml('<a person="1" xonclick="eval(1)" 9onload="eval(1)" region=2>x</a>\n'), { findings: [], unscannable: [] });
});

test('eval :: "an accepted script body is masked before handlers are looked for, so a property assignment of an on... name inside code is neither unreadable nor a handler"', async () => {
  const html = '<script>\nwindow.onload = go;\neval(a); // this.onerror=null\n</script>\n<a onclick="go()">x</a>\n';
  assert.deepEqual(await scanHtml(html), { findings: [htmlFinding(3)], unscannable: [] });
  assert.deepEqual(await scanHtml('<script>const b = "a.on=1";</script>\n'), { findings: [], unscannable: [] });
});

test('eval :: "a page whose quoting hides a handler is unreadable, never clean: a <script in an attribute value, an on…= in a script body or in another handler value, a script inside a handler value"', async () => {
  const hiding = [
    `<a title="<script>'" onclick="eval(1)" y="'</script>">x</a>`, // a script body that holds a real handler
    `<a onclick="a='<script>'; eval(x); b='</script>'">a</a>`, // a script inside a handler value
    `<a onclick="eval(x); a='<script>'">x</a><b title="</script>">y</b>`, // a handler value that reaches a script body
    `<a title=" onx=" a // onmouseover="eval(1)">x</a>`, // a fake handler that swallows the real one
    '<script>const a = " onclick=\'x\' ";</script>', '<script>eval(a); // onload=\n</script>', '<script>\nonclick = go;</script>', '<script>const b = "on=1";</script>',
  ];
  for (const html of hiding) assert.deepEqual(await scanHtml(`${html}\n`), { findings: [], unscannable: UNREADABLE }, html);
  assert.deepEqual(await scanHtml('<a title="t" onclick="eval(1)" y="z">x</a>\n'), { findings: [htmlFinding(1)], unscannable: [] });
  assert.deepEqual(await scanHtml('<script>const a = 1;</script>\n<a onclick="if (a < b) eval(1)">x</a>\n'), { findings: [htmlFinding(2)], unscannable: [] });
  assert.deepEqual(await scanHtml('<a onclick="this.onerror=null">x</a>\n<script>window.onload=go;</script>\n'), { findings: [], unscannable: [] });
});

test('eval :: "a page with many scripts and many handlers is read in linear time"', async () => {
  const html = `${'<script>a;</script>'.repeat(30_000)}\n${'<a onclick="go()">x</a>'.repeat(30_000)}`;
  assert.deepEqual(await scanHtml(html, { limits: { ...LIMITS, maxEvalUnitBytes: html.length + 1 } }), { findings: [], unscannable: [] });
});

test('eval :: "a script or handler that cannot be parsed is a parse error, a computed global member is unscannable, and findings elsewhere in the page are still reported"', async () => {
  assert.deepEqual(await scanHtml('<script>eval(</script>\n'), { findings: [], unscannable: [{ path: 'page.html', cause: 'eval-parse-error' }] });
  assert.deepEqual(await scanHtml('<a onclick="eval(">x</a>\n'), { findings: [], unscannable: [{ path: 'page.html', cause: 'eval-parse-error' }] });
  assert.deepEqual(await scanHtml('<a onclick="globalThis[k]">x</a>\n'), { findings: [], unscannable: [{ path: 'page.html', cause: 'eval-computed-member' }] });
  assert.deepEqual(await scanHtml('<script>eval(1);</script>\n<a onclick="globalThis[k]">x</a>\n'), { findings: [htmlFinding(1)], unscannable: [{ path: 'page.html', cause: 'eval-computed-member' }] });
});

test('eval :: "an HTML file is held to maxEvalUnitBytes and to the exact generated-file exceptions like any other file"', async () => {
  const html = '<script>eval(1);</script>\n';
  const tight = { ...LIMITS, maxEvalUnitBytes: Buffer.byteLength(html) - 1 };
  assert.deepEqual(await scanHtml(html, { limits: tight }), { findings: [], unscannable: [{ path: 'page.html', cause: 'limit:maxEvalUnitBytes' }] });
  const listed = await scan([['gen/page.html', html], ['other.html', html]], { config: withListed(['gen/page.html', html]) });
  assert.deepEqual(pathsOf(listed), ['other.html']);
});

test('eval :: "a 200,000-space tag and 50,000 script starts are read in linear time: unreadable, never a parse timeout"', async () => {
  const limits = { ...LIMITS, evalDeadlineMs: 20_000 };
  const hostile = [`<script${' '.repeat(200_000)}>eval(1);</script>`, '<script '.repeat(50_000), `<script>${'x'.repeat(1_000_000)}`, `${' on'.repeat(100_000)}=`];
  for (const html of hostile) assert.deepEqual(await scanHtml(html, { limits }), { findings: [], unscannable: UNREADABLE }, html.slice(0, 20));
  for (const html of [' on'.repeat(100_000), 'on'.repeat(500_000), `on${'a'.repeat(1_000_000)}`]) assert.deepEqual(await scanHtml(html, { limits }), { findings: [], unscannable: [] }, html.slice(0, 20));
  assert.deepEqual(await scanHtml(`<a${' '.repeat(200_000)}onclick="eval(1)">x</a>`, { limits }), { findings: [htmlFinding(1)], unscannable: [] });
});

test('eval :: "a gate run reports an unreadable HTML file as an unscannable entry and exits 2, not as a finding"', () => {
  const repo = createRepo([{ path: 'page.html', content: '<script type="application/json">{}</script>\n' }]);
  const run = runGate(gateArgs(repo, 'generic'));
  assert.equal(run.status, 2, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).unscannable, [{ location: `${repo.commit}:1`, cause: 'eval-html-unreadable' }]);
});

test('eval :: "the stated limits: a global object or timer held in a variable, a timer string held in a variable or property or passed as a value, a computed key on an expression naming no global object, property-reading functions, this and constructor chains"', async () => {
  const limits = [
    'const g = globalThis; g[name]("1");', 'const later = setTimeout; later("go()", 1);', 'const code = "go()"; setTimeout(code, 1);', 'setTimeout(task.code, 1);', 'top[name]("1");',
    'parent[name]; frames[name];', 'Reflect.get(globalThis, name)("1");', 'Object.values(window);', 'this[name]("1");', '(() => {}).constructor("1");',
    'Reflect.apply(setTimeout, window, ["go()"]);', '["go()"].forEach(setTimeout);',
  ];
  assert.deepEqual(await scan(limits.map((text, index) => [`s${index}.mjs`, text])), { findings: [], unscannable: [] });
});

test('eval :: "this repository\'s own tracked files give no R-EVAL finding and no unscannable entry"', async () => {
  const listed = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--cached'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  assert.deepEqual(await scan(files.map((file) => [file, readFileSync(path.join(REPO_ROOT, file))])), { findings: [], unscannable: [] });
});

test('eval :: "findings up to maxReportEntries are reported and one more stops the run with limit:maxReportEntries, never as a parser failure"', async (t) => {
  const evalLines = (count, line = 'eval(1);') => `${line}\n`.repeat(count);
  await t.test('1000 distinct lines, or 1000 lines with two calls each, are 1000 findings', async () => {
    assert.equal((await scan([['a.mjs', evalLines(LIMITS.maxReportEntries)]])).findings.length, LIMITS.maxReportEntries);
    assert.equal((await scan([['a.mjs', evalLines(LIMITS.maxReportEntries, 'eval(1); eval(2);')]])).findings.length, LIMITS.maxReportEntries);
  });
  await t.test('1001 or 1002 distinct lines in one file, or 1200 across two files of the same or other bytes, reach the limit', async () => {
    for (const files of [[['a.mjs', evalLines(1001)]], [['a.mjs', evalLines(1002)]], [['a.mjs', evalLines(600)], ['b.mjs', evalLines(600)]], [['a.mjs', evalLines(600)], ['b.mjs', `${evalLines(599)}eval(2);\n`]]]) {
      await assert.rejects(scan(files), failsWith('limit:maxReportEntries'), files.map(([name]) => name).join());
    }
  });
});

test('eval :: "a unit nested past the parser\'s stack depth is unscannable as eval-too-deep, and the other units of its batch are still judged"', async () => {
  const depth = 20_000;
  const deep = [['parens.mjs', `const a = ${'('.repeat(depth)}1${')'.repeat(depth)};\n`], ['chain.mjs', `const a = "a"${' + "a"'.repeat(depth)};\n`]];
  const result = await scan([...deep, ['good.mjs', EVAL_CALL]]);
  assert.deepEqual(result.unscannable, [{ path: 'parens.mjs', cause: 'eval-too-deep' }, { path: 'chain.mjs', cause: 'eval-too-deep' }]);
  assert.deepEqual(pathsOf(result), ['good.mjs']);
});

test('eval :: "every JS and TS extension, including .jsx, .tsx, .mts, .cts and .d.mts, is parsed" (T09)', async () => {
  const bySyntax = { js: EVAL_CALL, mjs: EVAL_CALL, cjs: EVAL_CALL, jsx: 'const a = <p>{eval("1")}</p>;\n', ts: 'const n: number = eval("1") as number;\n', mts: 'const n: number = eval("1");\n', cts: 'const n: number = eval("1");\n',
    tsx: 'const a: JSX.Element = <p>{eval("1")}</p>;\n', 'd.ts': 'declare const n: number;\neval("1");\n', 'd.mts': 'declare const n: number;\neval("1");\n', 'd.cts': 'declare const n: number;\neval("1");\n' };
  const result = await scan(Object.entries(bySyntax).map(([extension, text]) => [`unit.${extension}`, text]));
  assert.deepEqual(result.unscannable, []);
  assert.deepEqual(pathsOf(result), Object.keys(bySyntax).map((extension) => `unit.${extension}`).sort());
  assert.deepEqual((await scan([['notes.txt', EVAL_CALL], ['notes.md', EVAL_CALL], ['data.json', '{"a": "eval(1)"}\n']])).findings, []);
});

test('eval :: "the generated-file list is exact: a new unlisted chunk fails and a stale entry fails" (T10)', async (t) => {
  const listed = CONFIG.evalGeneratedFiles;
  await t.test('the shipped list names the seven runtime chunks and demos-runtime.mjs, each with the SHA-256 of the file the repository holds', () => {
    assert.equal(listed.length, 8);
    assert.equal(listed.filter(({ path: file }) => file.includes('/runtime-chunks/')).length, 7);
    assert.ok(listed.some(({ path: file }) => file === `${RUNTIME_DIR}/demos-runtime.mjs`));
    assert.ok(listed.some(({ path: file }) => file === GENERATED_PATH));
    for (const entry of listed) assert.equal(sha256(readFileSync(path.join(REPO_ROOT, entry.path))), entry.sha256, entry.path);
  });
  await t.test('every listed file passes as it is, and a chunk beside them, or a listed file with changed bytes, fails', async () => {
    const real = listed.map((entry) => [entry.path, readFileSync(path.join(REPO_ROOT, entry.path))]);
    assert.deepEqual((await scan(real)).findings, []);
    const newChunk = `${RUNTIME_DIR}/runtime-chunks/chunk-NEWNEWNEW.mjs`;
    const changed = await scan([[newChunk, EVAL_CALL], [GENERATED_PATH, `${GENERATED_BYTES.toString('utf8')}\n`]]);
    assert.deepEqual(pathsOf(changed), [newChunk, GENERATED_PATH].sort());
  });
  await t.test('an entry whose path the scan held only at other bytes stops the run as stale; one held at its bytes, or not held at all, does not', async () => {
    const config = withListed(['gen/a.mjs', 'one\n']);
    const scanner = createEvalScanner({ config, limits: LIMITS });
    await scanner.scan([fileEntry('gen/a.mjs', 'two\n', 1)]);
    assert.throws(() => scanner.requireNoStaleException(), (error) => error instanceof GateInputError && error.cause === 'stale-eval-exception');
    const held = createEvalScanner({ config, limits: LIMITS });
    await held.scan([fileEntry('gen/a.mjs', 'two\n', 1)]);
    await held.scan([fileEntry('gen/a.mjs', 'one\n', 1)]);
    held.requireNoStaleException();
    const absent = createEvalScanner({ config, limits: LIMITS });
    await absent.scan([fileEntry('other.mjs', 'one\n', 1)]);
    absent.requireNoStaleException();
  });
  await t.test('a malformed generated list is invalid configuration, and a gate run reports R-EVAL', () => {
    assert.equal(hasValidEvalConfig(CONFIG), true);
    const entry = listed[0];
    const bad = [undefined, {}, [{ ...entry, sha256: 'abc' }], [{ ...entry, reason: '' }], [{ ...entry, path: '' }], [entry, entry], [{ ...entry, extra: 1 }], [{ path: entry.path, reason: 'x' }]];
    for (const evalGeneratedFiles of bad) assert.equal(hasValidEvalConfig({ ...CONFIG, evalGeneratedFiles }), false, JSON.stringify(evalGeneratedFiles));
    const repo = createRepo([{ path: 'a.mjs', content: EVAL_CALL }]);
    const run = runGate(gateArgs(repo, 'generic'));
    assert.equal(run.status, 1, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).rules.find(({ id }) => id === 'R-EVAL'), { id: 'R-EVAL', status: 'findings' });
  });
});

test('eval :: "a computed member access on a global object with a non-literal key is unscannable" (T11)', async () => {
  const unscannable = ['globalThis[name]("1");', 'window["ev" + "al"]("1");', 'self[names[0]];', 'globalThis?.[key];', 'const pick = (k) => window[k];', '(ok ? window : self)[k]("1");'];
  const result = await scan(unscannable.map((text, index) => [`s${index}.mjs`, text]));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unscannable, unscannable.map((_, index) => ({ path: `s${index}.mjs`, cause: 'eval-computed-member' })));
  const passing = await scan([['ok.mjs', 'list[i]; thing[key]; window[0]; window["name"]; globalThis["location"];\n']]);
  assert.deepEqual(passing, { findings: [], unscannable: [] });
  assert.deepEqual(pathsOf(await scan([['literal.mjs', 'globalThis["eval"]("1");\n']])), ['literal.mjs']);
});

test('eval :: "a non-literal key read from any expression that names a global object, by member or destructuring, is unscannable; the same reads on expressions naming none pass"', async () => {
  await assertComputed([
    'const { [i]: { [k]: run } } = [globalThis];', 'const [{ ...rest }] = [window];', 'window.window[k];', '(0, window)[k];', '(c ? window : self)[k];', 'for (const { [k]: run } of [window]) {}',
    '({ [k]: run } = window);', 'window[1n];', 'window[-0];', 'const { 1n: run } = window;', 'pick(window)[k];', '[window][0][k];', 'const { a: { [k]: run } = window } = {};',
    'let run; for ({ [k]: run } of [self]) {}', 'function f({ ...all } = globalThis) {}',
  ]);
  const controls = [
    'const { [i]: { [k]: run } } = [other];', 'const [{ ...rest }] = [other];', 'thing.window[k];', '(0, other)[k];', '(c ? a : b)[k];', 'for (const { [k]: run } of [other]) {}',
    '({ [k]: run } = other);', 'thing[1n];', 'const { window: { [k]: run } } = other;', 'globalThis.window ??= globalThis;', 'Object.assign(globalThis, saved);',
  ];
  assert.deepEqual(await scan(controls.map((text, index) => [`s${index}.mjs`, text])), { findings: [], unscannable: [] });
});

test('eval :: "eval or Function taken out of a global object by any destructuring fails, and a computed key or a rest element on one is unscannable"', async (t) => {
  await t.test('a literal key fails whether it is declared, assigned, a parameter default, a loop variable, nested, in an array, or the source is a conditional', async () => {
    const failing = [
      'const { eval: run } = globalThis;', 'const { ["eval"]: run } = globalThis;', 'const { [`Function`]: Make } = window;', 'let run; ({ eval: run } = globalThis);', 'let run; (({ eval: run } = self));',
      'function f({ eval: run } = globalThis) { return run; }', 'const f = ({ Function: Make } = window) => Make;', 'for (const { eval: run } of [globalThis]) run("1");',
      'let run; for ({ eval: run } of [window]) run("1");', 'const { self: { eval: run } } = globalThis;', 'const [{ eval: run }] = [globalThis];', 'let run; [{ eval: run }] = [window];',
      'const { a: { eval: run } = globalThis } = {};', 'let run; ({ a: { eval: run } = globalThis } = {});', 'const { eval: run } = ready ? globalThis : other;', 'const { eval: run } = other || window;',
      'const { eval: run } = (0, globalThis);', 'const { "Function": Make } = global;', 'let run; ({ window: { eval: run } = other } = globalThis);', 'const { a: { eval: run } } = { a: window };',
      'const { window: { eval: run } } = { window };', 'let run; [...[{ eval: run }]] = [window];', 'let o; const { eval: run } = (o = window);', 'const { a: { eval: run } } = { ...{ a: window } };',
      'const { self: { eval: run } } = globalThis;', 'const { "window": { eval: run } } = globalThis;', 'const [a, { eval: run }] = [app, window];', 'const { window: { self: { Function: Make } } } = globalThis;',
      'let run; ({ self: { eval: run } } = globalThis);', 'let run; [, { eval: run }] = [a, window];', 'const [, { eval: run }] = [...list, window];', 'const [...[{ eval: run }]] = [window];',
      'function f({ self: { eval: run } } = window) {}', 'for (const { self: { eval: run } } of [globalThis]) {}',
    ];
    assert.deepEqual(await flaggedSnippets(failing), names(failing.length));
  });
  await t.test('a computed key or a rest element on a global object is unscannable, as a member access is, and so is one nested under any key of it', async () => {
    await assertComputed([
      'const { [name]: run } = globalThis;', 'const { ...all } = globalThis;', 'let all; ({ ...all } = window);', 'let run; ({ [name]: run } = self);', 'function f({ [name]: run } = globalThis) {}',
      'for (const { [name]: run } of [globalThis]) {}', 'const { self: { [name]: run } } = globalThis;', 'const { [`a${suffix}`]: run } = global;',
      'const { app: { [name]: run } } = window;', 'const { app: { ...rest } } = window;', 'let rest; ({ app: { ...rest } } = window);',
    ]);
  });
  await t.test('the same patterns with no eval or Function key on other values, and other literal keys of a global object, pass', async () => {
    const passing = ['const { [name]: run } = other;', 'const { ...rest } = other;', 'const { a, b } = globalThis;', 'const { setTimeout: later } = globalThis;', 'let run; ({ a: run } = globalThis);'];
    assert.deepEqual(await scan(passing.map((text, index) => [`s${index}.mjs`, text])), { findings: [], unscannable: [] });
  });
  await t.test('an eval or Function key fails on any value, nested or not, a global object or not', async () => {
    const failing = [
      'const { eval: run } = other;', 'function f({ eval: run }) { return run; }', 'function f({ eval: run } = {}) { return run; }', 'let run; ({ eval: run } = other);', 'const list = [globalThis, { eval: 1 }];',
      'list = [globalThis, { Function: 1 }];', 'for (const { eval: run } of items) {}', 'for (const { eval: run } of [first, second]) {}', 'const { a: { eval: run } } = other;', 'register({ eval: 1 }, globalThis);',
      'const { app: { eval: run } } = window;', 'const { app: { Function: Make } } = globalThis;', 'let run; ({ app: { eval: run } } = window);', 'let run, w; [{ eval: run }, w] = [app, window];',
      'const [{ eval: run }] = [[window]];', 'const { window: { app: { eval: run } } } = globalThis;', 'const [...{ eval: run }] = [window];', 'const { list: [{ eval: run }] } = window;',
      'const { eval: run } = [globalThis];', 'function f({ app: { eval: run } } = window) {}', 'for (const { app: { eval: run } } of [window]) {}', 'try {} catch ({ app: { eval: run } }) {}',
      'const { a: { eval: run } } = { ...other };', 'const { a = { eval: 1 } } = window;',
    ];
    assert.deepEqual(await flaggedSnippets(failing), names(failing.length));
  });
});

test('eval :: "computed, BigInt and negative-zero keys over literals holding globals fail by the nested eval or Function name"', async () => {
  const failing = [
    'const i = 0; const { [i]: { eval: run } } = [globalThis]; run("6 * 7");',
    'let run; const i = 0; ({ [i]: { Function: run } } = [globalThis]); new run("return 6 * 7");',
    'const { 1n: { eval: run } } = [null, globalThis]; run("6 * 7");',
    'const { [-0]: { eval: run } } = [window];',
    'for (const { [k]: { eval: run } } of [[window]]) run("1");',
    'const { [k]: { eval: run } } = { a: window };',
    'let run; ({ [k]: { eval: run } } = { a: window });',
    'function f({ [k]: { eval: run } } = { a: window }) {}',
    'const { [k]: [{ eval: run }] } = { a: [window] };',
    'const [, ...{ [k - 1]: { eval: run } }] = [0, window];',
    'const { 1n: { eval: run } } = { 1: window };',
    'const [...[{ [k]: { eval: run } }]] = [[0, window]];',
  ];
  assert.deepEqual(await flaggedSnippets(failing), names(failing.length));
  assert.deepEqual(pathsOf(await scan([['other.mjs', 'const { [k]: { eval: run } } = { a: other };']])), ['other.mjs']);
});

const STUB_DIR = makeTempDir('eval-stub');
/** A parser stand-in: a script that runs `body`; the stub's folder holds its pid file `pid.txt`. */
function stubParser(body) {
  const file = path.join(STUB_DIR, `stub-${sha256(body).slice(0, 12)}.mjs`);
  writeFileSync(file, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(STUB_DIR, 'pid.txt'))}, String(process.pid));\n${body}\n`);
  return { command: process.execPath, args: [file] };
}
const isGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};
test('eval :: "a unit the parser cannot read, or one over the size limit, or a parse past its deadline, fails as unscannable with its cause, and the deadline kills the parser child" (T12)', async (t) => {
  await t.test('a unit with a syntax error is unscannable as a parse error, beside a good unit that is still judged', async () => {
    const result = await scan([['broken.mjs', 'eval(;\n'], ['good.mjs', EVAL_CALL]]);
    assert.deepEqual(result.unscannable, [{ path: 'broken.mjs', cause: 'eval-parse-error' }]);
    assert.deepEqual(pathsOf(result), ['good.mjs']);
  });
  await t.test('a unit over the size limit is unscannable without being sent to a parser', async () => {
    const neverRun = { command: path.join(STUB_DIR, 'no-such-parser'), args: [] };
    const result = await scan([['big.mjs', `const a = "${'x'.repeat(200)}";\n`]], { limits: { ...LIMITS, maxEvalUnitBytes: 100 }, parser: neverRun });
    assert.deepEqual(result, { findings: [], unscannable: [{ path: 'big.mjs', cause: 'limit:maxEvalUnitBytes' }] });
  });
  await t.test('a parse past its deadline is unscannable as a timeout, and the parser child no longer exists', async () => {
    const parser = stubParser('process.stdin.resume();\nsetInterval(() => {}, 1000);');
    const result = await scan([['slow.mjs', EVAL_CALL]], { limits: { ...LIMITS, evalDeadlineMs: 1000 }, parser });
    assert.deepEqual(result, { findings: [], unscannable: [{ path: 'slow.mjs', cause: 'eval-parse-timeout' }] });
    assert.ok(isGone(Number(readFileSync(path.join(STUB_DIR, 'pid.txt'), 'utf8'))), 'the parser child is still running');
  });
  await t.test('a reply that is not what the protocol allows stops the run as a parser failure; an oversized reply keeps its own cause', async () => {
    const replies = ['process.stdout.write("not json");', 'process.stdout.write("{\\"results\\": []}");', 'process.stdout.write(\'{"results":[{"lines":[0]}]}\');',
      'process.stdout.write(\'{"results":[{"lines":[],"cause":"made-up"}]}\');', 'process.exit(3);'];
    for (const reply of replies) {
      await assert.rejects(scan([['a.mjs', EVAL_CALL]], { parser: stubParser(`process.stdin.resume();\n${reply}`) }), failsWith('eval-parser-failed'), reply);
    }
    const flood = stubParser('process.stdin.resume();\nprocess.stdout.write("x".repeat(5000));');
    await assert.rejects(scan([['a.mjs', EVAL_CALL]], { limits: { ...LIMITS, maxEvalOutputBytes: 1000 }, parser: flood }), failsWith('subprocess-output-limit'));
    await assert.rejects(scan([['a.mjs', EVAL_CALL]], { parser: { command: path.join(STUB_DIR, 'missing'), args: [] } }), failsWith('subprocess-spawn-failed'));
  });
  await t.test('a gate run reports a parse error as an unscannable entry and exits 2, not as a finding', () => {
    const repo = createRepo([{ path: 'broken.mjs', content: 'eval(;\n' }]);
    const run = runGate(gateArgs(repo, 'generic'));
    assert.equal(run.status, 2, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.unscannable, [{ location: `${repo.commit}:1`, cause: 'eval-parse-error' }]);
    assert.deepEqual(report.findings, []);
    assert.ok(!run.stdout.includes('broken.mjs'));
  });
});

const evalFindings = (report) => report.findings.filter(({ rule }) => rule === 'R-EVAL').map(({ kind, commit, location, line }) => ({ kind, commit, location, line }));
const listFile = () => writeList(['unrelated-private-label']);

test('eval :: "history: the same bytes at a listed generated-file path and at an unlisted executable path are two occurrences; the unlisted one fails even when it was removed before the target and whatever the traversal order; a benign rename of a non-executable file passes" (T13)', () => {
  const listedOnly = { 'a.txt': 'ok\n', [GENERATED_PATH]: GENERATED_BYTES.toString('utf8') };
  const both = { ...listedOnly, [UNLISTED_COPY]: GENERATED_BYTES.toString('utf8') };
  const orders = {
    'unlisted first, then removed': createHistory([{}, { files: { 'a.txt': 'ok\n', [UNLISTED_COPY]: GENERATED_BYTES.toString('utf8') } }, { files: listedOnly }]),
    'listed first, unlisted added then removed': createHistory([{}, { files: listedOnly }, { files: both }, { files: listedOnly }]),
  };
  for (const [label, history] of Object.entries(orders)) {
    const run = runHistory(historyArgs(history, listFile()));
    const copyCommit = history.commits[label.startsWith('unlisted') ? 1 : 2];
    const found = evalFindings(JSON.parse(run.stdout));
    assert.equal(found.length, 1, `${label}: ${run.stderr}`);
    assert.equal(found[0].commit, copyCommit, label);
    assert.ok(found[0].location.startsWith(`${copyCommit}:`), label);
  }
  const renamed = createHistory([{}, { files: { 'notes.txt': `${EVAL_CALL}text\n` } }, { files: { 'docs/notes.md': `${EVAL_CALL}text\n` } }]);
  const rename = runHistory(historyArgs(renamed, listFile()));
  assert.deepEqual(evalFindings(JSON.parse(rename.stdout)), [], rename.stderr);
  assert.equal(rename.status, 0, rename.stderr);
  const stale = createHistory([{}, { files: { [GENERATED_PATH]: 'changed bytes\n' } }]);
  const staleRun = runHistory(historyArgs(stale, listFile()));
  assert.equal(staleRun.status, 2);
  assert.match(staleRun.stderr, /^stale-eval-exception: /m);
});

test('eval :: "setTimeout and setInterval with string arguments fail outside exact generated-file exceptions; function callbacks pass, and history evaluates each occurrence" (T14)', async () => {
  const failing = ['setTimeout("go()", 1);', "setInterval('go()', 1);", 'window.setTimeout("go()");', 'globalThis["setInterval"]("go()", 5);', 'setTimeout(`go(${x})`, 1);', 'setTimeout("a" + b, 1);', 'self?.setTimeout("go()");',
    'window.setTimeout(cond ? "go()" : fn, 1);', 'setTimeout(cond ? fn : "go()", 1);', 'setTimeout(fn || "go()");', 'setInterval(fn ?? "go()");', 'setTimeout(ok && "go()");', 'let s; setTimeout(s = "go()", 1);',
    'let s = ""; setTimeout(s += "go()", 1);', '(globalThis || window).setTimeout("go()", 1);', '(cond ? setTimeout : setInterval)("go()", 1);', 'setTimeout("a" + (c ? "b" : "c"), 1);',
    // Any first argument but a function, a name or a property access may be a string: a call, a method result, a spread, a conditional or a logical operand.
    'setTimeout(String(code));', 'setTimeout("a".concat("()"));', 'setTimeout(...["x()"]);', 'window.setTimeout(String(c));', '[setTimeout][0]("x()");', 'setTimeout(c ? f : "x()");',
    'setTimeout(cond ? f : g, 1);', 'setTimeout(fn || other, 1);', 'setTimeout(tasks[0], 1);', 'setTimeout`go()`;', 'window.parent.setInterval(String(c));', 'setTimeout.call(null, "go()");',
    // A callee that only holds a timer (.call, .apply, .bind, a wrapper, a conditional or array) takes the code at a position nobody can know, so any argument but a receiver, a function or a number fails.
    'setTimeout.call(window, "go()");', 'setTimeout.call(undefined, "go()");', 'setInterval.call(self, "go()", 5);', 'setTimeout["call"](window, "go()");', 'setTimeout?.call(window, "go()");', '(0, setTimeout.call)(window, "go()");',
    'setTimeout.apply(window, ["go()"]);', 'setTimeout.apply(window, args);', 'setTimeout.bind(window, "go()")();', 'setTimeout.call.call(setTimeout, window, "go()");', 'window.setTimeout.call(null, "go()");',
    'globalThis["setTimeout"].apply(null, ["go()"]);', 'window.setTimeout.bind(window)("go()");', '(cond ? window.setTimeout : f)("go()");', '[window.setTimeout][0]("go()");', 'window.setTimeout.call`go()`;',
    'setTimeout.call(window, fn, 1);'];
  assert.deepEqual(await failingSnippets(failing), names(failing.length));
  const passing = ['setTimeout(() => go(), 1);', 'setTimeout(function () { go(); }, 1);', 'setInterval(callback, 5);', 'thing.setTimeout("go()");', 'setTimeout();', 'const delay = setTimeout;', 'clearTimeout("x");',
    '(cond ? thing : other).setTimeout("go()");', 'socket.setTimeout(3000, () => {});', 'setTimeout(this.tick, 1);', 'setTimeout((fn), 1);',
    'setTimeout.call(window, () => go(), 1);', 'setTimeout(() => go(), 5_000).unref();', 'setTimeout(fn, 1).refresh();', 'window.setTimeout(() => go(), 1);', '(0, setTimeout)(fn);'];
  assert.deepEqual(await failingSnippets(passing), []);
  const listed = await scan([[GENERATED_PATH, 'setTimeout("go()", 1);\n'], ['other.mjs', 'setTimeout("go()", 1);\n']], { config: withListed([GENERATED_PATH, 'setTimeout("go()", 1);\n']) });
  assert.deepEqual(pathsOf(listed), ['other.mjs']);
  const history = createHistory([{}, { files: { 'a.txt': 'ok\n', 'timer.mjs': 'setTimeout("go()", 1);\n' } }, { files: { 'a.txt': 'ok\n', 'timer.mjs': 'setTimeout(go, 1);\n' } }]);
  const run = runHistory(historyArgs(history, listFile()));
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(evalFindings(JSON.parse(run.stdout)), [{ kind: 'content', commit: history.commits[1], location: `${history.commits[1]}:2`, line: 1 }]);
});

const linkTo = (target) => ({ content: target, mode: '120000' });
const SCRIPT_LINKS = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'].flatMap((extension) => [`l.${extension}`, `U.${extension.toUpperCase()}`]);
const evalSymlinks = (report) => report.unscannable.filter(({ cause }) => cause === 'eval-symlink');

test('eval :: "a symlink with a script extension, in any case, is unscannable as eval-symlink in generic and complete scope and is never followed; a link of another kind gets nothing from R-EVAL"', async (t) => {
  const repo = createRepo([{ path: 'target.txt', content: EVAL_CALL }, { path: 'link.txt', ...linkTo('target.txt') }, ...SCRIPT_LINKS.map((file) => ({ path: file, ...linkTo('target.txt') }))]);
  await t.test('the scanner over the commit\'s own Git objects', async () => {
    const { entries } = await readCommitObjects({ repo: repo.dir, commit: repo.commit, limits: LIMITS });
    const result = await createEvalScanner({ config: CONFIG, limits: LIMITS }).scan(entries);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.unscannable.map(({ entry, cause }) => `${entry.path} ${cause}`).sort(), SCRIPT_LINKS.map((file) => `${file} eval-symlink`).sort());
  });
  for (const [scope, args] of [['generic', gateArgs(repo, 'generic')], ['complete', completeArgs(repo, listFile())]]) {
    await t.test(`a ${scope} gate run`, () => {
      const run = runGate(args);
      assert.equal(run.status, 2, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.deepEqual(report.findings, []);
      assert.equal(evalSymlinks(report).length, SCRIPT_LINKS.length);
      assert.equal(report.unscannable.length, SCRIPT_LINKS.length);
      assert.deepEqual(report.rules.find(({ id }) => id === 'R-EVAL'), { id: 'R-EVAL', status: 'unscannable' });
    });
  }
});

test('eval :: "history: a script symlink is eval-symlink at the commit that holds it, also when a later commit deletes it, when it dangles and when it points at another link"', () => {
  const links = { 'gone.MJS': linkTo('target.txt'), 'dangling.ts': linkTo('missing.js'), 'first.js': linkTo('second.cjs'), 'second.cjs': linkTo('target.txt') };
  const history = createHistory([{}, { files: { 'target.txt': EVAL_CALL, ...links } }, { files: { 'target.txt': EVAL_CALL } }]);
  const run = runHistory(historyArgs(history, listFile()));
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(evalSymlinks(report).map(({ commit }) => commit), Object.keys(links).map(() => history.commits[1]));
  assert.equal(report.unscannable.length, Object.keys(links).length);
});

test('eval :: "a listed generated path held as a symlink is eval-symlink and never exempt, even when its link text has the listed bytes"', async () => {
  const repo = createRepo([{ path: 'chunk.txt', content: EVAL_CALL }, { path: GENERATED_PATH, ...linkTo('chunk.txt') }]);
  const { entries } = await readCommitObjects({ repo: repo.dir, commit: repo.commit, limits: LIMITS });
  const scanner = createEvalScanner({ config: withListed([GENERATED_PATH, 'chunk.txt']), limits: LIMITS });
  const result = await scanner.scan(entries);
  assert.deepEqual(result.unscannable.map(({ entry, cause }) => ({ path: entry.path, cause })), [{ path: GENERATED_PATH, cause: 'eval-symlink' }]);
  scanner.requireNoStaleException();
  const run = runGate(gateArgs(repo, 'generic'));
  assert.equal(run.status, 2, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).unscannable, [{ location: `${repo.commit}:2`, cause: 'eval-symlink' }]);
});

test('eval :: "a script-extension blob that is not text is eval-not-text when the reader accepts it as reviewed binary; one the reader already refuses gets nothing more from R-EVAL"', async () => {
  const bytes = Buffer.from('eval\0("1")');
  const config = { ...CONFIG, binaryDispositions: [...CONFIG.binaryDispositions, { path: 'reviewed.jsx', sha256: sha256(bytes), reason: 'reviewed binary' }] };
  const result = await scan([['reviewed.jsx', bytes], ['unreviewed.jsx', bytes], ['nul.js', bytes]], { config });
  assert.deepEqual(result, { findings: [], unscannable: [{ path: 'reviewed.jsx', cause: 'eval-not-text' }] });
});
