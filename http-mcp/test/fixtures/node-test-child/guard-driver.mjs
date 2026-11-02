// node guard-driver.mjs <sigterm|exit|prompt>: a helper process that runs a fixture through
// runNodeTest and is then interrupted, exits, or waits for the result.
import { fileURLToPath } from 'node:url';
import { runNodeTest } from '../../helpers/node-test-child.mjs';

const fixtures = fileURLToPath(new URL('.', import.meta.url)), mode = process.argv[2];
if (mode === 'version') Object.defineProperty(process, 'version', { value: 'v99.0.0' });
if (mode === 'prompt' || mode === 'version') {
  const result = await runNodeTest('pass.mjs', { cwd: fixtures, timeoutMs: 60000, expected: null });
  console.log(`resolved ${result.incomplete}`);
  console.log(`nodeVersion ${result.nodeVersion}`);
} else {
  runNodeTest('hang.mjs', { cwd: fixtures, timeoutMs: 60000, expected: null,
    onSpawn: (pid) => { console.log(`group ${pid}`); if (mode === 'exit') setTimeout(() => process.exit(0), 300); } });
}
