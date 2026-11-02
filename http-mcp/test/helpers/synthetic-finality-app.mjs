// An isolated module graph for tests of stages after commitment finality.
// Only resolution changes: no production file is rewritten. Unqueried imports
// (including the payment regression) always retain the production hold.
import { registerHooks } from 'node:module';
const source = new URL('../../src/', import.meta.url).href;
const graph = new Set(['app.mjs', 'dacs/protocol-purchases.mjs', 'dacs/buyer-chain-readback.mjs']);
const fixture = new URL('./synthetic-finality-policy.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (!context.parentURL?.endsWith('?synthetic-finality')) return resolved;
  if (resolved.url === `${source}dacs/commitment-finality.mjs`) return { ...resolved, url: fixture };
  if (graph.has(resolved.url.slice(source.length)) && resolved.url.startsWith(source)) return { ...resolved, url: `${resolved.url}?synthetic-finality` };
  return resolved;
} });
export const { createApp } = await import('../../src/app.mjs?synthetic-finality');
export const { createBuyerChainReadback } = await import('../../src/dacs/buyer-chain-readback.mjs?synthetic-finality');
