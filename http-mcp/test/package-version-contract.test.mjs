import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
test('deployment build and retag commands use the Compose image version', () => {
  const image = `dacs-chatgpt-plugin:${pkg.version}`;
  assert.ok(read('deploy/compose.yaml').includes(`image: ${image}`));
  for (const path of ['deploy/RUNBOOK.md','deploy/README.md','docs/DEPLOYMENT-CHECKLIST.md']) {
    const doc = read(path);
    assert.ok(doc.includes(image), path);
    assert.doesNotMatch(doc, /dacs-chatgpt-plugin:0\.1\.0\b/, path);
  }
  assert.match(read('docs/DEPLOYMENT-CHECKLIST.md').split('\n')[8], /`http-mcp\/` package root/);
});
test('current tester and deployment scope labels identify the partial v2 package', () => {
  for (const path of ['docs/TESTER-QUICKSTART.md','docs/OFFLINE-TESTER.md','deploy/README.md','deploy/RUNBOOK.md']) {
    const doc = read(path);
    assert.match(doc, /\bpartial v2\b/, path);
    assert.doesNotMatch(doc, /\bv0\.1\b/, path);
  }
});
