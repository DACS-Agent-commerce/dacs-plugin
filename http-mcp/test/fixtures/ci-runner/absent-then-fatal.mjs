import { fileURLToPath } from 'node:url';
// Prints a diagnostic like Node's for a module that does not resolve, then dies of another error.
const missing = fileURLToPath(new URL('./not-carried.mjs', import.meta.url));
process.stderr.write([
  'node:internal/modules/esm/resolve:275',
  '    throw new ERR_MODULE_NOT_FOUND(',
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${missing}' imported from ${fileURLToPath(import.meta.url)}`,
  "  code: 'ERR_MODULE_NOT_FOUND',",
  '',
  'Node.js v22.0.0',
  '',
].join('\n'));
throw new Error('a second fatal error');
