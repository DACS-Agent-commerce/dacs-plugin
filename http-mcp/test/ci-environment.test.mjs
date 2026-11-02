import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('CI supplies the frozen seller checkout and its locked dependencies to the tests', () => {
  const checkout = workflow.slice(workflow.indexOf('- name: Fetch the frozen seller reference'), workflow.indexOf('- uses: actions/setup-node@'));
  assert.match(checkout, /uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(checkout, /repository: \$\{\{ github\.repository \}\}/);
  assert.match(checkout, /ref: seller-reference-dbe07f9c\n/);
  assert.match(checkout, /path: seller-reference\n/);
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /\btoken:/, 'use the default read-only GITHUB_TOKEN');
  assert.match(workflow, /env:\n\s+DACS_SELLER_INTEROP_REFERENCE: \$\{\{ github\.workspace \}\}\/seller-reference\n/);
  assert.match(workflow, /cache-dependency-path: \|[\s\S]*seller-reference\/v2\/seller\/package-lock\.json/);
  const install = workflow.indexOf('- name: Install the frozen seller reference dependencies');
  assert.ok(install > workflow.indexOf('- uses: actions/setup-node@'));
  assert.ok(install < workflow.indexOf('- name: Run tests as pwuser'));
  assert.match(workflow.slice(install), /run: npm ci --ignore-scripts --no-audit --no-fund\n\s+working-directory: seller-reference\/v2\/seller\n/);
});

test('both seller loaders reject missing artifacts and changed bytes in a 17-file git checkout', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-reference-checkout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reference = join(dir, 'reference');
  mkdirSync(join(reference, '.git'), { recursive: true });
  writeFileSync(join(reference, '.git/HEAD'), 'ref: refs/heads/moved-tag\n');
  mkdirSync(join(reference, 'v2/seller'), { recursive: true });
  writeFileSync(join(reference, 'v2/seller/agreement-context.mjs'), "throw new Error('unverified reference imported');\n");
  for (let i = 1; i < 17; i++) writeFileSync(join(reference, `file-${i}`), `changed artifact ${i}\n`);
  for (const [helper, entry] of [['agreement-context-integration', 'sellerReference'], ['current-broker-interactions-interop', 'startInteropSeller']]) {
    for (const [path, expected] of [[reference, { message: 'unchanged seller reference digest' }], [join(dir, 'absent'), { code: 'ENOENT' }]]) {
      const source = `import assert from 'node:assert/strict';
        const api = await import(${JSON.stringify(new URL(`./helpers/${helper}.mjs`, import.meta.url).href)});
        const expected = ${JSON.stringify(expected)};
        await assert.rejects(() => api[${JSON.stringify(entry)}](), (error) => {
          if (expected.message) assert.equal(error.message.split('\\n')[0], expected.message);
          if (expected.code) assert.equal(error.code, expected.code);
          return true;
        });`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, DACS_SELLER_INTEROP_REFERENCE: path }, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.error, undefined, `${helper}: ${result.error}`);
      assert.equal(result.signal, null, `${helper}: ${result.stderr}`);
      assert.equal(result.status, 0, `${helper}: ${result.stdout}\n${result.stderr}`);
    }
  }
});

test('the suite does not run as root on GitHub Actions', { skip: !process.env.GITHUB_ACTIONS }, () => {
  assert.notEqual(process.getuid(), 0, 'root bypasses file ownership and permission checks');
  assert.notEqual(process.getgid(), 0, 'the test user must not retain the root group');
});
