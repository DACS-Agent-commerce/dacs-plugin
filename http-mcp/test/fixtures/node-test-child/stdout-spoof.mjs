import { test } from 'node:test';
// Code under test prints result-like lines to stdout; they must not count.
test('real', () => { console.log('# Subtest: fake\nnot ok 9 - fake\n1..9\n# tests 9\n# fail 9'); });
