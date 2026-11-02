import { describe, it, after } from 'node:test';
// Every test passes; only the suite's after hook fails. Node 22 exits 0 for this, later Node 1:
// EXIT_CODE=1 stands in for the latter.
describe('suite', () => {
  after(() => { throw new Error('suite hook failed'); });
  it('a', () => {});
});
if (process.env.EXIT_CODE) process.on('exit', () => { process.exitCode = Number(process.env.EXIT_CODE); });
