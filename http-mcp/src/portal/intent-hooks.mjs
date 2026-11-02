// Switch-on hooks for the embedded wallet's one Start approval
// (DACS_INTENT_APPROVAL=on; default off).
//
// portal.js, embedded-wallet/approval.mjs, embedded-wallet-bridge.mjs and
// embedded-wallet/sdk-provider.mjs ship byte-identical to the build
// without this feature, so with the switch off they are ordinary static files
// (same bytes as the package, same Range, ETag, Last-Modified and HEAD
// behaviour, for every path spelling express.static accepts). With the switch
// on, the server inserts each hook at one exact anchor at startup and serves
// the result in place of the file. Startup fails unless every anchor occurs
// exactly once and every hook lands exactly once: a moved or duplicated anchor
// can never yield a half-hooked asset.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const START_BRANCH = `    // Embedded wallet only: one Start dialog, then machine-checked signatures.
    if (walletSource === 'embedded' && startIntent?.covers({ provider, terms: t })) {
      const next = await startIntent.run({ id, token, address, provider, broker: offlineAgreementBroker, api, log, recheck: recheckUntilSettled });
      log(\`DACS step: \${next.evidence?.protocol?.stage ?? next.status}.\`, next.status === 'awaiting_approval' ? 'ok' : '');
      render(next);
      return;
    }
`;

// Each hook replaces one exact source anchor with one exact replacement.
export const INTENT_HOOKS = Object.freeze([
  Object.freeze({ asset: 'portal.js', name: 'start-module-variable',
    anchor: "const WRITE_METHODS = ['sendTransaction',",
    replacement: "let startIntent = null; // DACS_INTENT_APPROVAL=on: one Start approval (public/portal-intent/start.mjs)\nconst WRITE_METHODS = ['sendTransaction'," }),
  Object.freeze({ asset: 'portal.js', name: 'purchase-page-bridge',
    anchor: "    const { openEmbeddedWallet } = await import('/portal/assets/embedded-wallet-bridge.mjs');\n",
    replacement: "    if (path[1] === 'purchase') {\n      startIntent = await import('/portal/assets/intent/start.mjs');\n    }\n    const { openEmbeddedWallet } = await import('/portal/assets/embedded-wallet-bridge.mjs');\n" }),
  Object.freeze({ asset: 'portal.js', name: 'session-opener',
    anchor: "    embedded = await openEmbeddedWallet($('embedded-wallet'),",
    replacement: "    embedded = await (startIntent?.openEmbeddedWallet ?? openEmbeddedWallet)($('embedded-wallet')," }),
  Object.freeze({ asset: 'portal.js', name: 'embedded-start-branch',
    anchor: '    needBoundWallet(t);\n    let planned = await savedPlan();\n',
    replacement: `    needBoundWallet(t);\n${START_BRANCH}    let planned = await savedPlan();\n` }),
  Object.freeze({ asset: 'embedded-wallet/approval.mjs', name: 'intent-dialog-note',
    anchor: "  sign: 'Signing proves you control this wallet. It does not move funds.',\n};\n",
    replacement: "  sign: 'Signing proves you control this wallet. It does not move funds.',\n  approvePurchaseIntent: 'Approving lets this wallet sign only the purchase steps listed above, once each, after checking every purchase step automatically against these exact values. If an Agreement record is listed with operator RPC auth signatures, the wallet also makes exactly those; they sign no transaction and move no funds. Anything different stops with nothing signed. Sending funds is not included and needs its own approval.',\n};\n" }),
  // The SDK session's class comes from the caller's gate (gate.mjs fenceSdk),
  // so the signatures it makes without a dialog stop when the Start is dropped.
  Object.freeze({ asset: 'embedded-wallet-bridge.mjs', name: 'bridge-sdk-fence-parameter',
    anchor: 'export async function sessionFactory({ approve, transactionTransport, anchorJournal }) {\n',
    replacement: 'export async function sessionFactory({ approve, transactionTransport, anchorJournal, fenceSdk = null }) {\n' }),
  Object.freeze({ asset: 'embedded-wallet-bridge.mjs', name: 'bridge-sdk-fence',
    anchor: '  return createSdkWalletSession({ DemosCtor: Demos, ',
    replacement: '  return createSdkWalletSession({ DemosCtor: fenceSdk ? fenceSdk(Demos) : Demos, ' }),
  Object.freeze({ asset: 'embedded-wallet/sdk-provider.mjs', name: 'source-phase-marker',
    anchor: "export const EMBEDDED_NETWORK = 'unconfigured';",
    replacement: "export const INTENT_SOURCE_PHASE_FENCE = true;\nexport const EMBEDDED_NETWORK = 'unconfigured';" }),
  // Each source phase of the Agreement CREATE asks that fenced class first
  // (gate.mjs holdSourcePhase), so a dropped or expired Start sends no bind,
  // signature or broadcast request; late answers and errors are checked too.
  // release still frees the lease. The plain
  // SDK class has no such method, so outside a Start nothing changes.
  Object.freeze({ asset: 'embedded-wallet/sdk-provider.mjs', name: 'source-phase-fence',
    anchor: '    const sourcePhase=async(body)=>{const auth=',
    replacement: '    const sourcePhase=async(body)=>{demos.holdSourcePhase?.(body.phase);try{const auth=' }),
  // Keep a successfully granted signature lease before the recheck can throw,
  // so the session's existing finally still releases it after a dropped Start.
  Object.freeze({ asset: 'embedded-wallet/sdk-provider.mjs', name: 'source-phase-answer-fence',
    anchor: 'return v;};\n    if(transport.devnetAgreement){const bound=await sourcePhase',
    replacement: "if(body.phase==='signature')lease=v;return v;}finally{demos.holdSourcePhase?.(body.phase);}};\n    if(transport.devnetAgreement){const bound=await sourcePhase" }),
]);
export const INTENT_HOOK_ASSETS = Object.freeze([...new Set(INTENT_HOOKS.map((h) => h.asset))]);

export class IntentHookError extends Error {
  constructor(message) { super(`DACS_INTENT_APPROVAL=on: ${message}; refusing to start`); this.name = 'IntentHookError'; }
}
const occurrences = (text, part) => text.split(part).length - 1;

export function validateIntentAssets(publicDir) {
  for (const asset of INTENT_HOOK_ASSETS) {
    if (/\/\*intent\{|\}intent\*\//.test(readFileSync(join(publicDir, asset), 'utf8'))) throw new IntentHookError(`${asset} contains obsolete intent markers`);
  }
}

// The hooked bytes of each asset, or throws IntentHookError.
export function applyIntentHooks(publicDir, hooks = INTENT_HOOKS) {
  validateIntentAssets(publicDir);
  const out = new Map();
  for (const asset of new Set(hooks.map((h) => h.asset))) {
    const original = readFileSync(join(publicDir, asset), 'utf8');
    const mine = hooks.filter((h) => h.asset === asset);
    let text = original;
    for (const hook of mine) {
      if (hook.replacement === hook.anchor) throw new IntentHookError(`hook ${hook.name} has no insertion`);
      if (occurrences(original, hook.anchor) !== 1) throw new IntentHookError(`anchor of hook ${hook.name} occurs ${occurrences(original, hook.anchor)} times in ${asset}, not once`);
      if (occurrences(original, hook.replacement) !== 0) throw new IntentHookError(`${asset} already contains hook ${hook.name}`);
      if (occurrences(text, hook.anchor) !== 1) throw new IntentHookError(`anchor of hook ${hook.name} overlaps another hook in ${asset}`);
      text = text.replace(hook.anchor, () => hook.replacement);
    }
    for (const hook of mine) if (occurrences(text, hook.replacement) !== 1) throw new IntentHookError(`hook ${hook.name} did not land exactly once in ${asset}`);
    const body = Buffer.from(text, 'utf8');
    // The whole asset's weak ETag (express's form), also on partial answers.
    const etag = `W/"${body.length.toString(16)}-${createHash('sha1').update(body).digest('base64').slice(0, 27)}"`;
    out.set(asset, { body, etag, mtime: statSync(join(publicDir, asset)).mtime });
  }
  return out;
}

// One satisfiable bytes range, as express.static answers it; null for none.
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start < 0) start = 0;
  return start > end || start >= size ? null : { start, end };
}

// Switch on: serves the hooked assets in place of the files, for every path
// spelling that reaches them. GET and HEAD only, with ETag, Last-Modified,
// conditional requests and single byte ranges like express.static.
export function intentHookedAssets(publicDir) {
  const assets = applyIntentHooks(publicDir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let name;
    try { name = posix.normalize(decodeURIComponent(req.path)).replace(/^\/+/, ''); } catch { return next(); }
    const asset = assets.get(name);
    if (!asset) return next();
    res.set({ 'accept-ranges': 'bytes', 'content-type': 'text/javascript; charset=utf-8', etag: asset.etag, 'last-modified': asset.mtime.toUTCString() });
    const range = req.headers.range === undefined ? undefined : byteRange(req.headers.range, asset.body.length);
    if (range === null) {
      res.status(416).set('content-range', `bytes */${asset.body.length}`);
      return res.end();
    }
    if (range) {
      res.status(206).set('content-range', `bytes ${range.start}-${range.end}/${asset.body.length}`);
      return res.send(asset.body.subarray(range.start, range.end + 1));
    }
    return res.send(asset.body);
  };
}
