import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../lib/gate-fixtures.mjs';

const trackedFiles = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const exists = (file) => trackedFiles.includes(file);
const read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_FILE = /\.(?:mjs|js|ts)$/;

function relativeImports(file) {
  return [...read(file).matchAll(IMPORT_SPECIFIER)].map((match) => path.posix.join(path.posix.dirname(file), match[1]));
}

const resolves = (target) => exists(target) || exists(target.replace(/\.js$/, '.ts')) || trackedFiles.some((file) => file.startsWith(`${target}/`));

const HTTP_SOURCE = trackedFiles.filter((file) => /^http-mcp\/(?:src|scripts)\//.test(file) && SOURCE_FILE.test(file));
const HTTP_TESTS = trackedFiles.filter((file) => /^http-mcp\/test\/.*\.test\.mjs$/.test(file));
const STDIO_TESTS = trackedFiles.filter((file) => /^stdio-mcp\/test\/.*\.test\.ts$/.test(file));

// The excluded modules: no file under these paths exists in this tree.
const EXCLUDED_PREFIXES = ['http-mcp/src/dacs/', 'http-mcp/src/devnet-demo/', 'http-mcp/vendor/'];
const EXCLUDED_FILES = [
  'http-mcp/src/portal/offline-agreement-broker.mjs',
  'http-mcp/src/portal/devnet-agreement-transport-broker.mjs',
  'http-mcp/public/portal/offline-agreement-broker.mjs',
  'http-mcp/src/purchases.mjs',
  'http-mcp/src/wallet/devnet-native-transport.mjs',
  'http-mcp/src/wallet/durable-journal.mjs',
  'http-mcp/src/util/purchase-readback-cache.mjs',
  'http-mcp/src/buyer-funding.mjs',
  'stdio-mcp/buyer/src/protocol.mjs',
  'http-mcp/scripts/check-node-build.mjs',
];
const isExcludedTarget = (target) => EXCLUDED_PREFIXES.some((prefix) => `${target}/`.startsWith(prefix) || target.startsWith(prefix))
  || EXCLUDED_FILES.includes(target);

// The non-test modules whose imports resolve to excluded modules, each with the follow-up that switches or retires it.
// An entry left here after its module stops importing an excluded path is not reported; remove it with that change.
const SWITCH_OWNER = 'follow-up: switch the import to the published SDK';
const SCRIPT_OWNER = 'follow-up: switch the script, or retire it with its command';
const EXCLUDED_MODULE_IMPORTERS = new Map([
  ['http-mcp/scripts/devnet-demo-operator-bootstrap.mjs', SCRIPT_OWNER],
  ['http-mcp/scripts/devnet-demo-recipient-balance.mjs', SCRIPT_OWNER],
  ['http-mcp/src/app.mjs', SWITCH_OWNER],
  ['http-mcp/src/identities.mjs', SWITCH_OWNER],
  ['http-mcp/src/mcp/seller-content.mjs', SWITCH_OWNER],
  ['http-mcp/src/mcp/server.mjs', SWITCH_OWNER],
  ['http-mcp/src/operations.mjs', SWITCH_OWNER],
  ['http-mcp/src/ops/health.mjs', SWITCH_OWNER],
  ['http-mcp/src/portal/purchase-receipt.mjs', SWITCH_OWNER],
  ['http-mcp/src/portal/wallet-rpc.mjs', SWITCH_OWNER],
]);

const unresolvedImports = (file) => relativeImports(file).filter((target) => !resolves(target));
const excludedModuleImporters = () => HTTP_SOURCE.filter((file) => unresolvedImports(file).length > 0);

test('every unresolved import in http-mcp source targets an excluded path', () => {
  for (const file of excludedModuleImporters()) {
    for (const target of unresolvedImports(file)) assert.ok(isExcludedTarget(target), `${file} misses a module that is not excluded: ${target}`);
  }
  assert.ok(!exists('http-mcp/scripts/check-node-build.mjs'));
});

test('every module that imports an excluded module has a follow-up recorded', () => {
  for (const file of excludedModuleImporters()) {
    const owner = EXCLUDED_MODULE_IMPORTERS.get(file);
    assert.ok(owner, `${file} has an import that does not resolve and no follow-up in EXCLUDED_MODULE_IMPORTERS (a missing module that is not excluded also fails the test above)`);
    if (file.startsWith('http-mcp/scripts/')) assert.equal(owner, SCRIPT_OWNER, `${file} is a script and needs the script follow-up`);
  }
});

test('the excluded paths are absent and tests needed for carried targets are retained, with no post-push removal phase', () => {
  for (const file of EXCLUDED_FILES) assert.ok(!exists(file), file);
  for (const prefix of EXCLUDED_PREFIXES) assert.ok(!trackedFiles.some((file) => file.startsWith(prefix)), prefix);
  const onlyExcluded = [...HTTP_TESTS, ...STDIO_TESTS].filter((file) => {
    const targets = relativeImports(file);
    return targets.length > 0 && targets.every((target) => !resolves(target));
  });
  assert.deepEqual(onlyExcluded, []);
  assert.ok(!trackedFiles.some((file) => /(?:^|\/)(?:carry|removal)[^/]*(?<!\.test)\.(?:mjs|py)$/.test(file)));
});

// Records that are not carried are not named here. This test does not check http-mcp/'s top-level folders: the import
// rules read only http-mcp/src/ and http-mcp/scripts/, so a new tracked folder passes it whatever it imports. Only a complete-scope run of the gate's private list checks every
// path and file for them (docs/PUBLIC-GATE.md); pull-request CI runs the generic scope, so that check happens separately.
test('TESTING and the docs required by retained tests are kept', () => {
  assert.ok(exists('http-mcp/docs/TESTING.md'));
  assert.ok(exists('http-mcp/docs/DEVNET-OPERATOR-CLI-ISSUED-RECOVERY.md'));
  const codeLines = (file) => read(file).split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
  const referencedDocs = new Set(HTTP_TESTS.flatMap((file) => codeLines(file).flatMap((line) => [...line.matchAll(/docs\/([A-Za-z0-9_.-]+\.md)/g)].map((match) => match[1]))));
  const missing = [...referencedDocs].filter((name) => !exists(`http-mcp/docs/${name}`));
  assert.deepEqual(missing.sort(), []);
});

// Helpers and fixtures that no retained file names; each is reached by a computed directory, a spawned path or a fixed historical name.
const COMPUTED_REACH_KEEPS = [
  'http-mcp/test/fixtures/ci-runner/absent-after-output.mjs', 'http-mcp/test/fixtures/ci-runner/absent-after-stdout.mjs',
  'http-mcp/test/fixtures/ci-runner/absent-helper-support.mjs', 'http-mcp/test/fixtures/ci-runner/absent-helper.mjs',
  'http-mcp/test/fixtures/ci-runner/absent-read.mjs', 'http-mcp/test/fixtures/ci-runner/absent-static.mjs',
  'http-mcp/test/fixtures/ci-runner/absent-then-fatal.mjs',
  'http-mcp/test/fixtures/ci-runner/collide.mjs', 'http-mcp/test/fixtures/ci-runner/crash.mjs',
  'http-mcp/test/fixtures/ci-runner/disposition.mjs', 'http-mcp/test/fixtures/ci-runner/empty-reason.mjs',
  'http-mcp/test/fixtures/ci-runner/exit-code.mjs', 'http-mcp/test/fixtures/ci-runner/expected-fail.mjs',
  'http-mcp/test/fixtures/ci-runner/feed-reporter.mjs',
  'http-mcp/test/fixtures/ci-runner/late.mjs',
  'http-mcp/test/fixtures/ci-runner/linger.mjs', 'http-mcp/test/fixtures/ci-runner/mixed.mjs',
  'http-mcp/test/fixtures/ci-runner/root-hook.mjs', 'http-mcp/test/fixtures/ci-runner/suites.mjs',
  'http-mcp/test/fixtures/ci-runner/timeout.mjs', 'http-mcp/test/fixtures/ci-runner/tmpdir.mjs',
  'http-mcp/test/fixtures/seller-durable-state.v1-baseline.mjs',
  'http-mcp/test/helpers/devnet-stop-loader.mjs', 'http-mcp/test/helpers/devnet-stop-operator.mjs',
  'http-mcp/test/helpers/seller-durable-state-lock-holder.mjs', 'http-mcp/test/helpers/seller-state-lease-race.mjs',
  'http-mcp/test/helpers/seller-state-no-procfs.mjs', 'http-mcp/test/helpers/showcase-safety-mutants.mjs',
];

function unreachedHelpers() {
  const helpers = trackedFiles.filter((file) => file.startsWith('http-mcp/test/') && !/\.test\.(?:mjs|js)$/.test(file));
  const reached = new Set(HTTP_TESTS);
  const frontier = [...HTTP_TESTS];
  const textOf = (file) => (/\.(?:mjs|js|json|md|py|exp|sh)$/.test(file) ? read(file) : '');
  while (frontier.length > 0) {
    const text = textOf(frontier.pop());
    for (const helper of helpers) {
      if (!reached.has(helper) && text.includes(path.posix.basename(helper))) {
        reached.add(helper);
        frontier.push(helper);
      }
    }
  }
  return helpers.filter((helper) => !reached.has(helper));
}

test('every computed-reach keep still exists', () => {
  assert.deepEqual(COMPUTED_REACH_KEEPS.filter((file) => !exists(file)), []);
});

test('no helper or fixture is unreachable without being listed', () => {
  assert.deepEqual(unreachedHelpers().filter((helper) => !COMPUTED_REACH_KEEPS.includes(helper)), []);
});
