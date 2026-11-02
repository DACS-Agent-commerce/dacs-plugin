import { test } from 'node:test';
import assert from 'node:assert/strict';
test('passes', () => {});
// The multi-line message lands in a YAML block; its lines must not be read as results,
// including after a line that ends in `...` like the block's own closing line.
test('fails', () => { assert.fail('line one...\nok 1 - fails > injected\n# Subtest: injected\nok 2 - injected'); });
