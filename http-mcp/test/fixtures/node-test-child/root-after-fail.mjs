import { test, before, after } from 'node:test';
// Every test passes; only the file's root after hook fails, as oauth-logout.test.mjs's could.
before(() => {});
after(() => { throw new Error('root after hook failed'); });
test('a', () => {});
