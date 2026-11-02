// Run from http-mcp/: node test/helpers/mutate-dcr.mjs [output-directory]
// Mutates private source/test copies, one mutant per process. The invoking
// checkout and its dependencies are never written, even if killed by SIGKILL.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { killed, passed, runNodeTest } from './node-test-child.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const originalPath = join(root, 'src/auth/authorization-server.mjs');
const original = readFileSync(originalPath, 'utf8');
const outputDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'dcr-mutants-'));
mkdirSync(outputDir, { recursive: true });
const testFile = 'test/oauth-logout.test.mjs';

function replaceOnce(source, from, to) {
  assert.ok(source.includes(from), `mutation anchor missing: ${from}`);
  assert.equal(source.indexOf(from), source.lastIndexOf(from), `mutation anchor ambiguous: ${from}`);
  return source.replace(from, to);
}
const change = (from, to) => (source) => replaceOnce(source, from, to);
const combine = (...changes) => (source) => changes.reduce((value, mutate) => mutate(value), source);
const roundTrip = change('    if (url.href !== uri) return false;\n', '');
const authBody = '    return this.redirectUris.includes(uri) && redirectAllowed(uri, config.allowedRedirectOrigins);';
const logoutBody = '    return this.postLogoutRedirectUris.includes(uri) && redirectAllowed(uri, config.allowedRedirectOrigins);';
const authMatcher = `  provider.Client.prototype.redirectUriAllowed = function (uri) {\n${authBody}\n  };\n`;
const logoutMatcher = `  provider.Client.prototype.postLogoutRedirectUriAllowed = function (uri) {\n${logoutBody}\n  };\n`;
const mutants = [
  ['remove-logout-property', change("properties: ['redirect_uris', 'post_logout_redirect_uris']", "properties: ['redirect_uris']")],
  ['skip-logout-validation', change('validator(_ctx, key, value, metadata) {', "validator(_ctx, key, value, metadata) {\n        if (key === 'post_logout_redirect_uris') return;")],
  ['skip-authorization-validation', change('validator(_ctx, key, value, metadata) {', "validator(_ctx, key, value, metadata) {\n        if (key === 'redirect_uris') return;")],
  ['any-entry-instead-of-every', change('!value.every((uri)', '!value.some((uri)')],
  ['remove-raw-character-guard', change("  if (typeof uri !== 'string' || /[\\u0000-\\u0020\\u007f#*\\\\]/.test(uri)) return false;\n", '')],
  ['remove-authority-and-roundtrip-guards', combine(roundTrip, change("  if (!authority || !authority[1] || /[%\\\\]/.test(authority[1])) return false;", '  if (!authority || !authority[1]) return false;'))],
  ['remove-credentials-and-hash-guard', change('    if (url.hash || url.username || url.password) return false;\n', '')],
  ['remove-roundtrip-guard', roundTrip],
  ['remove-dot-segment-and-roundtrip-guards', combine(roundTrip, change("  if (path.split('/').some((segment) => /^(?:\\.|%2e){1,2}$/i.test(segment))) return false;\n", ''))],
  ['remove-backslash-and-roundtrip-guards', combine(roundTrip, change('/[\\u0000-\\u0020\\u007f#*\\\\]/.test(uri)', '/[\\u0000-\\u0020\\u007f#*]/.test(uri)'))],
  ['allow-every-origin', change('    return allowedOrigins.includes(url.origin);', '    return true;')],
  ['reject-nonempty-logout', change('validator(_ctx, key, value, metadata) {', "validator(_ctx, key, value, metadata) {\n        if (key === 'post_logout_redirect_uris' && value?.length) throw new errors.InvalidRedirectUri();")],
  ['reject-empty-logout', change("(key === 'redirect_uris' && value.length === 0)", '(value.length === 0)')],
  ['restore-native-authorization-port-exception', change(authMatcher, '')],
  ['restore-native-logout-port-exception', change(logoutMatcher, '')],
  ['skip-authorization-membership', change(authBody, '    return redirectAllowed(uri, config.allowedRedirectOrigins);')],
  ['skip-logout-membership', change(logoutBody, '    return redirectAllowed(uri, config.allowedRedirectOrigins);')],
  ['skip-authorization-runtime-allowlist', change(authBody, '    return this.redirectUris.includes(uri);')],
  ['skip-logout-runtime-allowlist', change(logoutBody, '    return this.postLogoutRedirectUris.includes(uri);')],
  ['skip-resume-revalidation', change("ctx.oidc.route === 'resume' && !client?.redirectUriAllowed(ctx.oidc.params.redirect_uri)", 'false')],
  ['skip-confirmation-revalidation', change("ctx.oidc.route === 'end_session_confirm'", 'false')],
  ['allow-arbitrary-internal-resume', change("        if (!internalResume) throw new errors.InvalidRequest('post_logout_redirect_uri not registered');", '')],
  ['reject-internal-resume', change('        if (!internalResume) throw', '        if (true) throw')],
  ['skip-query-serialization-check', change("    if (query !== -1 && (uri.slice(query + 1) !== url.searchParams.toString() || query === uri.length - 1)) return false;\n", '')],
  ['skip-response-parameter-collision-check', change("    if (['code', 'state', 'error', 'error_description', 'error_uri', 'iss'].some((key) => url.searchParams.has(key))) return false;\n", '')],
];

// Validate every substitution before allocating the disposable project.
for (const [, mutate] of mutants) assert.notEqual(mutate(original), original);
const privateDir = mkdtempSync(join(tmpdir(), 'dcr-mutants-work-'));
const workRoot = join(privateDir, 'project');
const sourcePath = join(workRoot, 'src/auth/authorization-server.mjs');
const restore = () => writeFileSync(sourcePath, original);
const cleanup = () => rmSync(privateDir, { recursive: true, force: true });
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
for (const name of ['src', 'test', 'public', 'package.json']) cpSync(join(root, name), join(workRoot, name), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(workRoot, 'node_modules'), 'dir');
const basePath = join(privateDir, 'base-authorization-server.mjs');
writeFileSync(basePath, readFileSync(process.env.DCR_BASE_SOURCE || join(root, 'test/fixtures/authorization-server.pre-dcr-logout.mjs')));
const originalSnapshot = join(privateDir, 'original-authorization-server.mjs');
writeFileSync(originalSnapshot, original);
const testEnv = { ...process.env, DCR_BASE_SOURCE: basePath, DCR_HELPER_ORIGINAL: originalSnapshot };
delete testEnv.NODE_TEST_CONTEXT;
console.log(`workspace: ${workRoot}`);

// The baseline run's results, which every later run must report; the baseline itself must pass.
let expected = null;
async function run(name) {
  // Each run leads its own process group, printed so a caller that SIGKILLs this helper can kill the run too.
  const result = await runNodeTest(testFile, { cwd: workRoot, env: testEnv, timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024, expected,
    onSpawn: (pid) => console.log(`${name}: process group ${pid}`) });
  writeFileSync(join(outputDir, `${name}.tap`), result.stdout + result.stderr);
  const row = { name, nodeVersion: result.nodeVersion, exit: result.exit, tests: result.tests, pass: result.pass, fail: result.fail, skipped: result.skipped, incomplete: result.incomplete,
    notOk: result.notOk, passed: passed(result), killed: killed(result),
    caughtBy: [...result.tap.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]) };
  results.push(row);
  assert.equal(row.incomplete, null, `${name}: missing test results (${row.incomplete})`);
  expected ??= result.names;
  return row;
}

const results = [];
try {
  const baseline = await run('baseline');
  // A failed root after hook leaves exit 0 and no failed test on Node 22 (a failed before hook fails every test): passed() refuses both.
  assert.ok(baseline.passed, `clean baseline must pass: not ok: ${baseline.notOk.join(', ')}`);
  console.log(`baseline: ${baseline.pass} passed`);
  for (const [name, mutate] of mutants) {
    writeFileSync(sourcePath, mutate(original));
    let result;
    try { result = await run(name); } finally { restore(); }
    assert.equal(result.tests, baseline.tests, `${name}: incomplete run`);
    assert.equal(result.skipped, 0, `${name}: skipped tests`);
    assert.ok(result.killed, `${name}: mutant survived: no regression assertion failed (exit ${result.exit}, not ok: ${result.notOk.join(', ')})`);
    console.log(`${name}: caught (${result.pass} pass / ${result.fail} fail)`);
  }
  const restored = await run('restored');
  assert.ok(restored.passed, `restored source must pass: not ok: ${restored.notOk.join(', ')}`);
  assert.equal(restored.tests, baseline.tests);
  console.log(`restored: ${restored.pass} passed; ${mutants.length} mutants caught; logs: ${outputDir}`);
} finally {
  cleanup();
  writeFileSync(join(outputDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}
