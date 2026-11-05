import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createEvalScanner } from '../../scripts/public-gate/rules-eval.mjs';
import { CONFIG_FILE, REPO_ROOT, completeArgs, createHistory, createRepo, gateArgs, historyArgs, runGate, runHistory, writeList } from '../lib/gate-fixtures.mjs';

const CONFIG = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
const LIMITS = CONFIG.limits;
const entry = (path, text) => ({ path, kind: 'blob', bytes: Buffer.from(text) });
const scan = (files, options = {}) => createEvalScanner({ config: CONFIG, limits: LIMITS, ...options }).scan(files.map(([path, text]) => entry(path, text)));
const unreadable = 'eval-html-unreadable';

const UNREADABLE_ROWS = [
  ['data-type attribute', '<script data-type="text/plain">eval(1)</script>'],
  ['legacy JavaScript MIME type', '<script type="application/x-javascript">eval(1)</script>'],
  ['slash before event attribute', '<a/onclick=eval(1)>x</a>'],
  ['equals in unquoted handler', "<a onclick=eval('x=1')>x</a>"],
  ['named parentheses entities', '<a onclick="eval&lpar;1&rpar;">x</a>'],
  ['named whitespace entity', '<a onclick="eval&Tab;(1)">x</a>'],
  ['numeric entity', '<a onclick="&#101;val(1)">x</a>'],
  ['hexadecimal entity', '<a onclick="&#x65;val(1)">x</a>'],
  ['encoded quotes', '<a onclick="window[&quot;eval&quot;](1)">x</a>'],
  ['single quoted script type', "<script type='text/javascript'>eval(1)</script>"],
  ['single quoted handler', "<a onclick='eval(1)'>x</a>"],
  ['space around handler equals', '<a onclick = "eval(1)">x</a>'],
  ['other script attributes', '<script data-note=">">eval(1)</script>'],
  ['duplicate script attributes', '<script type="text/plain" type="text/javascript">eval(1)</script>'],
  ['data script is not exempted', '<script type="application/json">eval(1)</script>'],
  ['less than in script body', '<script>if (a < b) eval(1)</script>'],
  ['slash before script attribute', '<script/src="a.mjs">eval(1)</script>'],
  ['unterminated script', '<script>eval(1)'],
  ['closing tag attributes', '<script>eval(1)</script extra>'],
  ['mixed case unquoted handler', '<a ONCLICK=eval(1)>x</a>'],
  ['form feed and slash handler', '<a\f/onclick="eval(1)">x</a>'],
  ['handler after adjacent double quote', '<a title="x"onclick="eval(1)">x</a>'],
  ['handler after adjacent single quote', "<a title='x'onclick=\"eval(1)\">x</a>"],
  ['upper case script', '<SCRIPT>eval(1)</SCRIPT>'],
  ['upper case quoted handler', '<a ONCLICK="eval(1)">x</a>'],
  ['duplicate approved type', '<script type="module" type="module">eval(1)</script>'],
  ['duplicate source', '<script src="a.mjs" src="b.mjs">eval(1)</script>'],
  ['attribute-like code in a script', '<script>const b = "on=1";</script>'],
  ['handler hidden by another attribute', '<a title=" onx=" a // onmouseover="eval(1)">x</a>'],
  ['script hidden inside a handler', "<a onclick=\"a='<script>'; eval(x); b='</script>'\">a</a>"],
  ['unfinished handler', '<a onclick="eval(1)'],
];

test('eval HTML :: exact script and handler forms are read on their original lines in html and htm files', async () => {
  const result = await scan([
    ['page.HTML', '<script>\neval(1);\n</script>\n<a onclick="eval(2)">x</a>'],
    ['page.htm', '<script type="module">\nnew Function("return 1");\n</script>'],
    ['cr.html', 'text\r<script>\reval(1)</script>'],
    ['typed.html', '<script type="text/javascript" src="a.mjs">eval(1)</script>'],
    ['reverse.html', '<script src="a.mjs" type="module">eval(1)</script>'],
    ['comparison.html', '<a onclick="if (a < b) eval(1)">x</a>'],
    ['wrapper.html', '<a onclick="}); eval(1); (function () {">x</a>'],
    ['handler.html', '<button\n onclick="\nreturn Function(\'x\');">x</button>'],
  ]);
  assert.deepEqual(result.unscannable, []);
  assert.deepEqual(result.findings.map(({ entry, line }) => [entry.path, line]), [['page.HTML', 2], ['page.HTML', 4], ['page.htm', 2], ['cr.html', 3], ['typed.html', 1], ['reverse.html', 1], ['comparison.html', 1], ['wrapper.html', 1], ['handler.html', 3]]);
  assert.deepEqual(await scan([['safe.html', '<p>Only once, one by one.</p><script type="module" src="a.mjs"></script><script>ready();</script><a onclick="ready()">x</a>']]), { findings: [], unscannable: [] });
});

test('eval HTML :: every non-exact candidate is unscannable, without data-script exemptions or entity decoding', async () => {
  for (const [label, text] of UNREADABLE_ROWS) {
    const result = await scan([['page.html', text]]);
    assert.deepEqual(result.unscannable.map(({ cause }) => cause), [unreadable], label);
  }
});

test('eval HTML :: every non-exact row fails closed in generic, complete and history modes, including removed files', async (t) => {
  const entries = UNREADABLE_ROWS.map(([label, content], index) => ({ path: `${String(index).padStart(3, '0')}.${index % 2 ? 'htm' : 'html'}`, content, label }));
  const repo = createRepo(entries);
  const list = writeList(['unrelated-private-label']);
  const files = Object.fromEntries(entries.map(({ path, content }) => [path, content]));
  const history = createHistory([{}, { files }, { files: { 'clean.txt': 'ok\n' } }]);
  const cases = [
    ['generic', () => runGate(gateArgs(repo, 'generic')), repo.commit],
    ['complete', () => runGate(completeArgs(repo, list)), repo.commit],
    ['history', () => runHistory(historyArgs(history, list)), history.commits[1]],
  ];
  for (const [mode, run, commit] of cases) await t.test(mode, () => {
    const result = run();
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.rules.find(({ id }) => id === 'R-EVAL').status, 'unscannable');
    assert.equal(report.unscannable.length, entries.length);
    entries.forEach(({ label }, index) => assert.ok(report.unscannable.some((row) => row.location === `${commit}:${index + 1}` && row.cause === unreadable), label));
  });
});

test('eval HTML :: report caps and per-file parser errors keep their causes and other files are still judged', async () => {
  const limits = { ...LIMITS, maxReportEntries: 2 };
  const two = '<script>\neval(1);\neval(2);\n</script>';
  assert.equal((await scan([['two.html', two]], { limits })).findings.length, 2);
  await assert.rejects(scan([['three.html', `${two}\n<a onclick="eval(3)">x</a>`]], { limits }), (error) => error.cause === 'limit:maxReportEntries');
  const deep = `<script>const a = ${'('.repeat(20_000)}1${')'.repeat(20_000)};</script>`;
  const result = await scan([['deep.html', deep], ['broken.htm', '<script>eval(;</script>'], ['good.html', '<a onclick="eval(1)">x</a>']]);
  assert.deepEqual(result.unscannable.map(({ entry, cause }) => [entry.path, cause]), [['deep.html', 'eval-too-deep'], ['broken.htm', 'eval-parse-error']]);
  assert.deepEqual(result.findings.map(({ entry }) => entry.path), ['good.html']);
});

test('eval HTML :: slow candidates and a stalled parser stay under the child deadline and an outside watchdog', () => {
  const driver = `
    import { readFileSync } from 'node:fs';
    import { createEvalScanner } from './scripts/public-gate/rules-eval.mjs';
    const config = JSON.parse(readFileSync('public-gate.config.json', 'utf8'));
    const files = ['<script '.repeat(50_000), '<a onclick="'.repeat(50_000), '<script>' + 'x'.repeat(500_000)];
    const scanner = createEvalScanner({ config, limits: { ...config.limits, evalDeadlineMs: 2000 } });
    const result = await scanner.scan(files.map((text, index) => ({ path: index + '.html', kind: 'blob', bytes: Buffer.from(text) })));
    const stalled = createEvalScanner({ config, limits: { ...config.limits, evalDeadlineMs: 100 }, parser: { command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'] } });
    const timeout = await stalled.scan([{ path: 'slow.html', kind: 'blob', bytes: Buffer.from('<script>eval(1)</script>') }]);
    process.stdout.write(JSON.stringify([result.unscannable.map(({ cause }) => cause), timeout.unscannable.map(({ cause }) => cause)]));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '1' } });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const [causes, timeout] = JSON.parse(result.stdout);
  assert.equal(causes.length, 3);
  assert.ok(causes.every((cause) => [unreadable, 'eval-parse-timeout'].includes(cause)));
  assert.deepEqual(timeout, ['eval-parse-timeout']);
});
