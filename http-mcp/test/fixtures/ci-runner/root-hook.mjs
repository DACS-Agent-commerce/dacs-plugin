import { after, test } from 'node:test';
test('passes', () => {});
after(() => { throw new Error('root after hook failed'); });
