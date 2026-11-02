import { test } from 'node:test';
test('s', { skip: 'why' }, () => {});
test('t', { todo: 'later' }, () => { throw new Error('todo fails'); });
test('fine', () => {});
