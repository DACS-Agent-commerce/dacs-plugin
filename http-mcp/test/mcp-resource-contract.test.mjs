import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIGNALS_LISTINGS_RESOURCE_URI } from '../src/mcp/ui.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('widget host expects the served GitHub signals resource URI', () => {
  const source = read('deploy/test/mcp-apps.browser.test.mjs');
  const expected = /const EXPECTED_SIGNALS_LISTINGS_URI = '([^']+)';/.exec(source);
  assert.ok(expected, 'widget resource expectation is explicit');
  assert.equal(expected[1], SIGNALS_LISTINGS_RESOURCE_URI);
});
test('current consumer guides name the served GitHub signals resource version', () => {
  const version = SIGNALS_LISTINGS_RESOURCE_URI.split('/').at(-1).replace('.html', '');
  for (const path of ['README.md','docs/TESTER-QUICKSTART.md']) assert.ok(read(path).includes(version), path);
});
