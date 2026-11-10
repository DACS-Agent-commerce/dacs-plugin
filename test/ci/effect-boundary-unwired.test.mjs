import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../lib/gate-fixtures.mjs';

const ALLOWLIST = [
  'http-mcp/public/portal/embedded-wallet/effect-boundary.mjs',
  'http-mcp/public/portal/embedded-wallet/effect-records.mjs',
  'http-mcp/test/',
  'test/ci/effect-boundary-unwired.test.mjs',
];
const GUARD_MESSAGE = 'This module must not be wired to a page or route until its sign and send tails re-read authority; '
  + 'remove this guard in the PR that adds that re-read.';

function matchesUnwiredModule(file, source) {
  if (ALLOWLIST.some((allowed) => allowed.endsWith('/') ? file.startsWith(allowed) : file === allowed)) return false;
  return /effect-(?:boundary|records)\.mjs/.test(source);
}

function assertUnwired(files) {
  const wired = files.filter(({ file, source }) => matchesUnwiredModule(file, source)).map(({ file }) => file);
  assert.deepEqual(wired, [], `${GUARD_MESSAGE}\n${wired.join('\n')}`);
}

test('effect modules stay unwired in the tracked tree', () => {
  const files = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  assertUnwired(files.map((file) => ({ file, source: readFileSync(path.join(REPO_ROOT, file), 'utf8') })));
});

for (const moduleName of ['effect-boundary.mjs', 'effect-records.mjs']) {
  const target = `../portal/embedded-wallet/${moduleName}`;
  const imports = [
    ['a static import', `import { effect }\nfrom '${target}';`],
    ['a side-effect import', `import '${target}';`],
    ['a dynamic import', `await import(\n"${target}?mode=page");`],
    ['a require call', `const effect = require( '${target}' );`],
    ['a named re-export', `export { effect } from '${target}';`],
    ['a star re-export', `export * from '${target}';`],
  ];
  for (const [kind, source] of imports) {
    test(`matches ${kind} of ${moduleName} in a public file and a route`, () => {
      for (const file of ['http-mcp/public/fixture.mjs', 'http-mcp/src/routes/fixture.mjs']) {
        assert.equal(matchesUnwiredModule(file, source), true, file);
      }
    });
  }

  test(`matches ${moduleName} imports at different relative depths`, () => {
    for (const prefix of ['./', '../', '../../another/path/', './nested/../']) {
      assert.equal(matchesUnwiredModule('http-mcp/src/routes/fixture.mjs', `import '${prefix}${moduleName}';`), true);
    }
  });

  test(`matches a module script source for ${moduleName}`, () => {
    const source = `<script type="module" src="/portal/embedded-wallet/${moduleName}"></script>`;
    assert.equal(matchesUnwiredModule('http-mcp/public/fixture.html', source), true);
  });

  test(`matches a plain public string reference to ${moduleName}`, () => {
    const source = `const moduleFile = '${moduleName}';`;
    assert.equal(matchesUnwiredModule('http-mcp/public/nested/fixture.js', source), true);
    assert.equal(matchesUnwiredModule('http-mcp/src/fixture.mjs', source), true);
  });

  test(`matches non-relative references to ${moduleName} in a file under http-mcp/src/`, () => {
    const forms = [
      ['an asset-list entry', `const assets = ['embedded-wallet/${moduleName}'];`],
      ['an absolute-path import', `const loaded = import('/portal/assets/embedded-wallet/${moduleName}');`],
      ['an absolute script src in a template string', `const page = \`<script type="module" src="/portal/embedded-wallet/${moduleName}"></script>\`;`],
      ['a new URL call', `const url = new URL('./embedded-wallet/${moduleName}', base);`],
      ['a package exports entry', `{ "exports": { "./wallet-effect": "./http-mcp/public/portal/embedded-wallet/${moduleName}" } }`],
    ];
    for (const [kind, source] of forms) {
      assert.equal(matchesUnwiredModule('http-mcp/src/portal/fixture.mjs', source), true, kind);
      const page = { file: 'http-mcp/src/portal/fixture.mjs', source };
      assert.throws(() => assertUnwired([page]), (error) => {
        assert.ok(error.message.includes(GUARD_MESSAGE), kind);
        assert.ok(error.message.includes(page.file), kind);
        return true;
      }, kind);
    }
  });

  test(`allows ${moduleName} imports only in the listed files and test directory`, () => {
    const source = `import '${target}';`;
    for (const file of [...ALLOWLIST.slice(0, 2), 'http-mcp/test/browser/fixture.test.mjs']) {
      assert.equal(matchesUnwiredModule(file, source), false, file);
    }
    for (const file of ['test/ci/fixture.test.mjs', 'http-mcp/tests/fixture.mjs', `${ALLOWLIST[0]}.copy`]) {
      assert.equal(matchesUnwiredModule(file, source), true, file);
    }
  });

  test(`rejects an in-memory fixture page importing ${moduleName} with the removal instruction`, () => {
    const page = { file: 'http-mcp/public/fixture.html', source: `<script type="module">import '${target}';</script>` };
    assert.throws(() => assertUnwired([page]), (error) => {
      assert.ok(error.message.includes(GUARD_MESSAGE));
      assert.ok(error.message.includes(page.file));
      return true;
    });
  });
}
