import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(new URL('../src/dacs/service-request.mjs', import.meta.url), 'utf8');
const checks = readFileSync(new URL('./service-request.test.mjs', import.meta.url), 'utf8')
  .replace('../src/dacs/service-request.mjs', './module.mjs')
  .replace("'@kynesyslabs/dacs'", JSON.stringify(import.meta.resolve('@kynesyslabs/dacs')));
const remove = (code) => {
  const lines = source.split('\n').filter((line) => line.includes(`fail('${code}',`));
  assert.equal(lines.length, 1, `one guard for ${code}`);
  return source.replace(lines[0], '');
};
const replace = (before, after) => { assert.equal(source.split(before).length, 2, `one mutation site for ${before}`); return source.replace(before, after); };
const PROXY_GUARD = "if (types.isProxy(value)) fail('service_request_shape', 'the request must be a plain JSON object, not a proxy');";
const mutants = [
  ['exact keys', () => replace("if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key)))", 'if (false)'), 'shape refuses missing, extra, symbolic and prototype keys'],
  ['plain prototype', () => replace('if (prototype !== Object.prototype && prototype !== null)', 'if (false)'), 'shape refuses missing, extra, symbolic and prototype keys'],
  ['enumerable data properties', () => replace("if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))", 'if (false)'), 'shape refuses accessors and nonenumerable fields without invoking code'],
  // With the proxy guard present no input reaches the catch, so this second layer is mutated with the guard removed.
  ['reflection errors behind the proxy guard', () => replace("fail('service_request_shape', 'the request could not be inspected as plain JSON');", 'throw error;').replace(PROXY_GUARD, ''), 'shape refuses accessors and nonenumerable fields without invoking code'],
  ['public-data type', () => remove('service_request_type'), 'type, service id and version fail closed without coercion'],
  ['service id', () => remove('service_request_service'), 'type, service id and version fail closed without coercion'],
  ['version', () => remove('service_request_version'), 'type, service id and version fail closed without coercion'],
  ['primitive nonempty input', () => remove('service_request_input'), 'input is a primitive nonempty string; the one-character lower boundary is admitted'],
  ['character limit and early huge-input refusal', () => remove('service_request_character_limit'), 'huge strings stop at character length before UTF-8 measurement, scans, serialization or hashing'],
  ['hashing before huge-input refusal', () => replace('const request = fields(value);', "const request = fields(value); createHash('sha256').update(request.input, 'utf8').digest('hex');"), 'huge strings stop at character length before UTF-8 measurement, scans, serialization or hashing'],
  ['UTF-8 byte limit', () => remove('service_request_byte_limit'), 'UTF-8 byte boundary admits 2000 and refuses 2001 independently of character count'],
  ['control classification', () => remove('service_request_control'), 'all C0 controls and DEL are refused, including line breaks and tabs'],
  ['ASCII including bidi and surrogates', () => remove('service_request_non_ascii'), 'bidi, non-ASCII, zero-width characters and malformed surrogates are refused'],
  ['canonical storage-byte limit', () => remove('service_request_serialization_limit'), 'canonical storage-byte boundary accounts for JSON escaping: 3072 admitted, 3073 refused'],
  ['inclusive character boundary', () => replace('text.length > SERVICE_REQUEST_LIMITS', 'text.length >= SERVICE_REQUEST_LIMITS'), 'character boundary admits 2000 and refuses 2001 before scanning or serialization'],
  ['inclusive UTF-8 boundary', () => replace("Buffer.byteLength(text, 'utf8') >", "Buffer.byteLength(text, 'utf8') >="), 'UTF-8 byte boundary admits 2000 and refuses 2001 independently of character count'],
  ['inclusive canonical boundary', () => replace('CANONICAL_OVERHEAD + escapedBytes >', 'CANONICAL_OVERHEAD + escapedBytes >='), 'canonical storage-byte boundary accounts for JSON escaping: 3072 admitted, 3073 refused'],
  ['canonical overhead counted', () => replace('CANONICAL_OVERHEAD + escapedBytes >', 'escapedBytes >'), 'canonical storage-byte boundary accounts for JSON escaping: 3072 admitted, 3073 refused'],
  ['slash incorrectly counted as escaped', () => replace('text.match(/["\\\\]/gu)', 'text.match(/["\\\\/]/gu)'), 'canonical storage-byte boundary accounts for JSON escaping: 3072 admitted, 3073 refused'],
  ['escaped bytes counted before serialization', () => replace('const escapedBytes = text.length + (text.match(', 'const escapedBytes = text.length + 0 * (text.match('), 'escaped JSON size refuses before serialization or hashing'],
  ['serialization before canonical-size refusal', () => replace('const escapedBytes =', 'JSON.stringify(request); const escapedBytes ='), 'escaped JSON size refuses before serialization or hashing'],
  ['proxy guard', () => replace(PROXY_GUARD, ''), 'live and revoked proxies refuse with a fixed message before any trap runs'],
  ['proxy guard after reflection', () => replace(PROXY_GUARD, '').replace('const keys = Reflect.ownKeys(value);', `const keys = Reflect.ownKeys(value); ${PROXY_GUARD}`), 'live and revoked proxies refuse with a fixed message before any trap runs'],
  ['lexical key order', () => replace('for (const key of FIELDS)', 'for (const key of keys)'), 'canonical bytes and SHA-256 match JCS across every key order'],
  ['JSON escaping', () => replace('JSON.stringify(request);', 'JSON.stringify(request).replaceAll(String.fromCharCode(92), \'\');'), 'canonical bytes and SHA-256 match JCS across every key order'],
  ['whole canonical hash scope', () => replace(".update(canonical, 'utf8')", ".update(request.input, 'utf8')"), 'canonical bytes and SHA-256 match JCS across every key order'],
  ['SHA-256 algorithm', () => replace("createHash('sha256')", "createHash('sha512')"), 'canonical bytes and SHA-256 match JCS across every key order'],
  ['preserve exact text', () => replace('const text = request.input;', 'const text = request.input = request.input.trim();'), 'the exact v1 request is public-data and snapshots its input without normalization'],
  ['detached snapshot', () => replace('const result = {};', 'const result = value;'), 'the exact v1 request is public-data and snapshots its input without normalization'],
  ['frozen request', () => replace('request: Object.freeze(request)', 'request'), 'the exact v1 request is public-data and snapshots its input without normalization'],
  ['frozen result', () => replace('return Object.freeze({ request: Object.freeze(request), canonical, requestHash });', 'return { request: Object.freeze(request), canonical, requestHash };'), 'the exact v1 request is public-data and snapshots its input without normalization'],
];

test('unmodified admission passes every witness before mutation', () => {
  const result = run(source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 14\b/);
});
for (const [name, mutation, witness] of mutants) test(`mutant killed: ${name}`, () => {
  const result = run(mutation());
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.split('\n').some((line) => /^not ok \d+ - /.test(line) && line.endsWith(witness)), `the intended witness must fail: ${witness}\n${result.stdout}`);
});

function run(module) {
  const directory = mkdtempSync(join(tmpdir(), 'service-request-mutant-'));
  try {
    writeFileSync(join(directory, 'module.mjs'), module);
    writeFileSync(join(directory, 'test.mjs'), checks);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', join(directory, 'test.mjs')], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
