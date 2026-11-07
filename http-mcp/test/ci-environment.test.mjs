import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/http-mcp-tests.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('CI runs in a digest-pinned container matching the locked browser version', () => {
  const image = workflow.match(/image: (mcr\.microsoft\.com\/playwright:v([^@]+)@sha256:([a-f0-9]{64}))\n/);
  assert.ok(image, 'the job must select immutable container bytes');
  assert.equal(image[2], `${pkg.devDependencies['playwright-core']}-noble`);
  assert.match(workflow, /options: --init --ipc=host/);
  assert.match(workflow, /shell: bash/);
  assert.match(workflow, /require\('playwright-core'\)\.chromium\.executablePath\(\)/);
  assert.doesNotMatch(workflow, /npx playwright-core install/);
});

test('CI resolves the exact terminal driver only from isolated signed snapshot sources', () => {
  assert.match(workflow, /https:\/\/snapshot\.ubuntu\.com\/ubuntu\/20251020T000000Z noble main universe/);
  assert.match(workflow, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
  assert.match(workflow, /Dir::Etc::sourcelist=\$apt_root\/sources\.list/);
  assert.match(workflow, /Dir::Etc::sourceparts=-/);
  assert.match(workflow, /Dir::State::lists=\$apt_root\/lists/);
  assert.match(workflow, /apt-get "\$\{apt_options\[@\]\}" -o APT::Update::Error-Mode=any update/);
  assert.match(workflow, /apt-get "\$\{apt_options\[@\]\}" install -y --no-install-recommends expect=5\.45\.4-3 tcl-expect=5\.45\.4-3/);
  assert.doesNotMatch(workflow, /sudo apt-get|trusted=yes|allow-unauthenticated/);
});

test('CI gives the checkout and HOME to pwuser before running tests without root privileges', () => {
  const prepare = workflow.indexOf('- name: Prepare the test user');
  const run = workflow.indexOf('- name: Run tests as pwuser');
  assert.ok(prepare > workflow.indexOf('apt-get "${apt_options[@]}" install'), 'install system packages before dropping privileges');
  assert.ok(run > prepare, 'make the checkout and npm HOME writable before running tests');
  assert.match(workflow.slice(prepare, run), /test "\$\(id -u pwuser\)" = 1001/);
  assert.match(workflow.slice(prepare, run), /test "\$\(id -g pwuser\)" = 1001/);
  assert.match(workflow.slice(prepare, run), /chown -R 1001:1001 "\$GITHUB_WORKSPACE" "\$HOME"/);
  assert.match(workflow.slice(run), /setpriv --reuid=1001 --regid=1001 --clear-groups bash -c '[\s\S]*umask 0022[\s\S]*exec npm run test:ci\n\s*'/);
  assert.equal((workflow.match(/npm run test:ci/g) ?? []).length, 1, 'the suite must only run after dropping privileges');
});

test('CI runs the whole suite, browser files included, in the digest-pinned container with no seller-reference checkout, and uploads results even on failure', () => {
  assert.match(pkg.scripts['test:ci'], /^node scripts\/run-test-files\.mjs \. test-results\.jsonl \d+ --browser /, 'test:ci adds the browser files');
  assert.equal((workflow.match(/\bnpm run test:ci\b/g) ?? []).length, 1);
  const container = workflow.match(/^ {6}image: (\S+)$/m);
  assert.ok(container, 'the job runs in one container');
  const [repository, digest] = container[1].split('@');
  assert.match(repository, /^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble$/);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/, 'the container is pinned by digest');
  assert.ok(workflow.includes(`echo "- container: ${container[1]}"`), 'the runner record names the same container');

  assert.doesNotMatch(workflow, /seller|DACS_SELLER_INTEROP_REFERENCE/i, 'no seller-reference env, checkout, cache path or install');
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 1, 'one checkout, of this repository');
  assert.match(workflow, /cache-dependency-path: \|\n {12}http-mcp\/package-lock\.json\n {12}http-mcp\/wallet-build\/package-lock\.json\n/);

  const upload = workflow.slice(workflow.indexOf('- name: Upload per-file results'));
  assert.match(upload, /^ {8}if: always\(\)$/m);
  assert.match(upload, /^ {10}name: http-mcp-test-results$/m);
  assert.match(upload, /^ {12}http-mcp\/test-results\.jsonl$/m);
  assert.doesNotMatch(upload, /continue-on-error/);

  const docs = readFileSync(new URL('../docs/CI.md', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /seller-reference|DACS_SELLER_INTEROP_REFERENCE|Frozen seller reference/, 'the docs drop the seller reference with the job');
  assert.match(docs, /node \.\.\/scripts\/ci\/sdk-input\.mjs --prepare http-mcp/, 'the docs name the validation step');
});

test('the suite does not run as root on GitHub Actions', { skip: !process.env.GITHUB_ACTIONS }, () => {
  assert.notEqual(process.getuid(), 0, 'root bypasses file ownership and permission checks');
  assert.notEqual(process.getgid(), 0, 'the test user must not retain the root group');
});
