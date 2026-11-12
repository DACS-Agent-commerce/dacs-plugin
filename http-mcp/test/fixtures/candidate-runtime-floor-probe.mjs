// Runs under the runtime being tested: builds the client purchase service as the plugin's composition
// would, before it opens the app database, and reports what the construction did.
// Usage: candidate-runtime-floor-probe.mjs <data directory>
import { readdirSync } from 'node:fs';
import { createPurchaseService } from '@kynesyslabs/dacs-client';

const [dataDirectory] = process.argv.slice(2);
const admission = { binding: {}, currentLocal: () => ({}) };
let refusal = null;
try {
  createPurchaseService({ admission });
} catch (error) {
  refusal = { code: error.code, message: error.message };
}
process.stdout.write(JSON.stringify({ version: process.version, refusal, filesOpened: readdirSync(dataDirectory) }));
