import { test } from 'node:test';
test('prints', () => { for (let i = 0; i < 40; i++) process.stdout.write('x'.repeat(8191) + '\n'); });
