// Test-only. src/ops/health.mjs imports three modules that this checkout does not
// carry yet (see test/known-failures.json: the carry-over entries for the
// ops-health tests). Importing this file registers a resolve hook that gives
// exactly those three, and only while they are absent, a stand-in with the names
// health.mjs reads. A module that exists is always used as it is. Nothing else
// is stubbed: the code under test is the real health.mjs and the real verifier.
import { register } from 'node:module';

const hooks = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const STUBS = {
  'src/dacs/seller-http.mjs': 'export const sellerFailureCause = () => null;',
  'src/dacs/wallet-transactions.mjs': 'export const deriveStorageAddress = () => { throw new Error("stand-in: not reached by these tests"); };',
  'src/wallet/durable-journal.mjs': 'export const DURABLE_WALLET_JOURNAL_FORMAT = "TEST-stand-in-journal/v1"; export const DURABLE_WALLET_JOURNAL_VERSION = 1;',
};
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    const path = fileURLToPath(url);
    for (const [suffix, source] of Object.entries(STUBS)) {
      if (path.endsWith('/http-mcp/' + suffix) && !existsSync(path)) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);
