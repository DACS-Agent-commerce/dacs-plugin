// Run from http-mcp: node test/helpers/wallet-extension-probe-mutants.mjs <out.jsonl>
// Each mutation runs one relevant test in a private copy; the checkout is never written.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, constants, cpSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const dir = 'public/wallet-extension-probe/', adapter = `${dir}adapter.mjs`, checks = `${dir}checks.mjs`, vectors = `${dir}vectors.mjs`, ui = `${dir}main.mjs`;
const probeRoutes='src/portal/wallet-extension-probe.mjs';
const testFile = 'test/wallet-extension-probe.test.mjs', routes = 'test/wallet-extension-probe-routes.test.mjs';
const r4 = 'test/wallet-extension-probe-r4.test.mjs', r5 = 'test/wallet-extension-probe-r5.test.mjs', docs = 'docs/WALLET-EXTENSION-PROBE.md';
const mutations = [
  // The probe switch is src/switches/DACS_WALLET_EXTENSION_PROBE.switch, parsed by config.mjs's shared flag code.
  ['switch-default', 'src/config.mjs', "out[s.configKey] = env[s.env] === '1';", "out[s.configKey] = env[s.env] !== '0';", routes, 'probe switch'],
  ['route-gate', probeRoutes, 'if(config.walletExtensionProbe!==true) return router;', '', routes, 'switch off hides probes even'],
  ['legacy-byte-identity', 'public/portal/index.html', '<!doctype html>', '<!doctype html>\n<!-- mutant -->', routes, 'switch off hides'],
  ['env-contract-entry', 'src/switches/DACS_WALLET_EXTENSION_PROBE.switch', '"deployValue": null', '"deployValue": "0"', routes, 'probe switch'],
  ['discovery-listener', adapter, "windowObject.addEventListener('demosAnnounceProvider', announce);", '', testFile, 'discovery observes'],
  ['discovery-absence', adapter, "state: p ? 'present' : 'not-observed'", "state: 'present'", testFile, 'discovery observes'],
  ['discovery-late', adapter, 'finish(null), discoveryTimeoutMs', 'finish(null), 1', testFile, 'discovery observes'],
  ['locked-state', adapter, "value.code === 401 ? 'locked' : 'wallet-absent'", "value.code === 401 ? 'wallet-absent' : 'wallet-absent'", testFile, 'discovery observes'],
  ['accounts-shape', adapter, "!hasKeys(value, ['code', 'data']) || ", '', testFile, 'accounts distinguishes'],
  ['accounts-binding', adapter, 'ok: address === null || account === address', 'ok: true', testFile, 'accounts distinguishes'],
  ['connect-denied', adapter, 'response.success !== true', 'false', testFile, 'connect approved'],
  ['connect-shape', adapter, "if (!hasKeys(value, ['address'])) throw new Error('invalid_connect_shape');", '', testFile, 'connect approved'],
  ['address-shape', checks, "if (typeof value !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(value)) throw new Error('invalid_address');", '', testFile, 'connect approved'],
  ['envelope-fields', adapter, "(!hasKeys(response, ['success', 'data']) && !hasKeys(response, ['type', 'id', 'method', 'success', 'data']))", 'false', testFile, 'full extension response'],
  ['envelope-id', adapter, "|| (Object.hasOwn(response, 'id') && (typeof response.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(response.id)))", '', testFile, 'full extension response'],
  ['envelope-method', adapter, "|| (Object.hasOwn(response, 'method') && response.method !== method)", '', testFile, 'full extension response'],
  ['envelope-type', adapter, "|| (Object.hasOwn(response, 'type') && response.type !== 'demosProviderResponse')", '', testFile, 'full extension response'],
  ['exact-verification', checks, "return bytes.length === 64 && await crypto.subtle.verify('Ed25519', key, bytes, new TextEncoder().encode(message));", 'return true;', testFile, 'P3 rejects'],
  ['prefix-rejected', checks, 'new TextEncoder().encode(message));', "new TextEncoder().encode(`prefix:${message}`));", testFile, 'P3 rejects'],
  ['prehash-rejected', checks, 'new TextEncoder().encode(message));', "new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))));", testFile, 'P3 rejects'],
  ['message-algorithm', checks, "&& value.type === 'ed25519'", '', testFile, 'P3 rejects'],
  ['message-account', checks, '&& addressOf(value.address) === address', '', testFile, 'P3 rejects'],
  ['message-shape', checks, "hasKeys(value, ['type', 'data'])", "value && typeof value === 'object'", testFile, 'P3 rejects'],
  ['tx-account', adapter, "if (!address || transaction?.content?.from !== address) throw new Error('connected_account_required');", '', testFile, 'P4/P5 exact signed'],
  ['tx-fields', checks, 'diffs.length === 0 && ', '', testFile, 'P4/P5 exact signed'],
  ...['nonce', 'to', 'amount', 'transaction_fee.network_fee'].map((field) => [`tx-diff-${field}`, checks, 'if (Object.is(a, b)) return;', `if (path === '$.content.${field}' || Object.is(a, b)) return;`, testFile, 'P4/P5 exact signed']),
  ['tx-hash', checks, "const hashValid = /^[0-9a-f]{64}$/.test(signed?.hash ?? '') && signed.hash === computedHash;", 'const hashValid = true;', testFile, 'P4/P5 reject bad hash'],
  ['tx-serialization', checks, 'hashMatchesRequested && ', '', testFile, 'P4/P5 reject bad hash'],
  ['tx-signature', checks, "&& await verifyExact(address, signed.hash, signed.signature.data)", '', testFile, 'P4/P5 reject bad hash'],
  ['tx-signature-shape', checks, "hasKeys(signed?.signature, ['type', 'data']) && ", '', testFile, 'P4/P5 reject bad hash'],
  ['tx-algorithm', checks, "signed.signature.type === 'ed25519'", 'true', testFile, 'P4/P5 reject bad hash'],
  ['send-api-added', adapter, 'return Object.freeze({', "return Object.freeze({ sendTransaction() {},", testFile, 'adapter surface'],
  ['send-provider-called', adapter, 'provider.request(jsonCopy(request))', "provider.request({ method: 'sendTransaction', params: request.params })", testFile, 'adapter surface'],
  ['api-frozen', adapter, 'return Object.freeze({', 'return ({', testFile, 'adapter surface'],
  ['timeout-fence', adapter, 'timedOut = true;', 'timedOut = false;', testFile, 'timeouts fence'],
  ['timeout-request-record', adapter, "...(method === 'signTransaction' ? {} : { request: publicView(request, request) }),", '', testFile, 'timeouts fence'],
  ['concurrent-fence', adapter, 'if ((busy && !reserved) || timedOut)', 'if (timedOut)', testFile, 'provider cannot mutate'],
  ['provider-copy', adapter, 'provider.request(jsonCopy(request))', 'provider.request(request)', testFile, 'provider cannot mutate'],
  ['caller-copy', adapter, 'const requested = jsonCopy(transaction)', 'const requested = transaction', testFile, 'caller mutation'],
  ['inert-json', checks, 'return visit(value, 0);', 'return value;', testFile, 'provider cannot mutate'],
  ['json-finite', checks, '&& Number.isFinite(v)', '', testFile, 'provider cannot mutate'],
  ['json-size', checks, "if (size > 65536) throw new Error('response_bounds'); return v;", 'return v;', testFile, 'provider cannot mutate'],
  ['json-depth', checks, 'depth > 20', 'depth > 200', testFile, 'provider cannot mutate'],
  ['json-count', checks, '++count > 4096', '++count > 40960', testFile, 'provider cannot mutate'],
  ['json-symbol', checks, "if (Reflect.ownKeys(descriptors).some((k) => typeof k !== 'string')) throw new Error('response_not_json');", '', testFile, 'provider cannot mutate'],
  ['json-sparse', checks, "if (Array.isArray(v) && Object.keys(out).length !== v.length) throw new Error('response_not_json');", '', testFile, 'provider cannot mutate'],
  ['record-copy', adapter, '...jsonCopy(result)', '...result', testFile, 'public report omits'],
  ['response-redaction', adapter, 'response: publicView(response, request)', 'response', testFile, 'public report omits'],
  ['diff-redaction', checks, '({ path: d.path, kind: d.kind })', 'd', testFile, 'public report omits'],
  ['text-rendering', ui, 'status.textContent = describe ?', 'status.innerHTML = describe ?', testFile, 'probe DOM requires'],
  ['transaction-opt-in', ui, '!ready.checked || !address', '!address', testFile, 'probe DOM requires'],
  ['popup-once', adapter, "if (popupIssued) throw new Error('popup_already_requested');", '', testFile, 'adapter surface'],
  ['observation-values', adapter, "if (!['approval-window', 'toolbar-popup', 'nothing-observed', 'origin-matches', 'origin-differs'].includes(observation)) throw new Error('invalid_observation');", '', testFile, 'probe DOM requires'],
  ['native-coordinate-shape', vectors, "if (!Number.isSafeInteger(nonce) || nonce !== PROBE_NONCE || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('invalid_coordinates');", '', testFile, 'native vectors match'],
  ['native-denomination', vectors, "amount='1'", 'amount=1', testFile, 'native vectors match'],
  ['native-self', vectors, 'const to=from', "const to='0x'+'0'.repeat(64)", testFile, 'native vectors match'],
  ['native-amount', vectors, "amount='1'", "amount='2'", testFile, 'native vectors match'],
  ['native-no-memo', vectors, 'args: [to, amount]', "args: [to, amount, 'memo']", testFile, 'native vectors match'],
  ['storage-address', vectors, '`${from}:${programName}:${nonce}:`', '`${from}:${programName}:${nonce + 1}:`', testFile, 'P5 exact CREATE'],
  ['storage-metadata', vectors, "metadata: { logicalAddress, contentHash, envelopeHash, artifactKind: 'Agreement' }", 'metadata: { logicalAddress }', testFile, 'P5 exact CREATE'],
  ['owner-gate', probeRoutes, "if(session.accountId!==owner.id) throw new Error('not_owner');", '', routes, 'owner gate hides page and every asset from anonymous'],
  ['bearer-owner', probeRoutes, "if(auth.extra?.issuer!==owner.auth_issuer||auth.extra?.subject!==owner.auth_subject) throw new Error('not_owner');", '', routes, 'owner gate rejects a valid non-owner'],
  ['invalid-bearer-fallback', probeRoutes, 'const auth=await authenticateBearer(req.headers.authorization);', 'const auth=await authenticateBearer(req.headers.authorization).catch(()=>({extra:{issuer:owner.auth_issuer,subject:owner.auth_subject}}));', routes, 'owner gate hides page and every asset from invalid bearer'],
  ['transaction-shape', adapter, 'await assertProbeTransaction(requested);', '', testFile, 'transaction shape allowlist'],
  ['checker-shape', checks, 'await assertProbeTransaction(requested);', '', testFile, 'transaction shape allowlist'],
  ['shape-comparison', vectors, "if(!expected||JSON.stringify(transaction)!==JSON.stringify(expected))", 'if(!expected)', testFile, 'transaction shape allowlist'],
  ['nonce-account-binding', adapter, "if(!hasKeys(value,['address','currentNonce','nextNonce','balanceOs'])||value.address!==address||value.nextNonce!==value.currentNonce+1) throw new Error('nonce_unavailable');", '', testFile, 'default nonce read'],
  ['nonce-owner-wallet', probeRoutes, "if(accounts.walletOwner(address)!==config.walletExtensionProbeOwnerAccount) return res.status(404).json({error:'not_found'});", '', routes, 'probe nonce endpoint'],
  ['nonce-read', adapter, 'assertSignable(await readAccount(connected), requested.content.nonce);', '', testFile, 'transaction probes refuse'],
  ['nonce-read-shape', adapter, "if(!Number.isSafeInteger(currentNonce)||currentNonce<0||currentNonce>=Number.MAX_SAFE_INTEGER||nonce>currentNonce) throw new Error('used_nonce_required');", '', testFile, 'transaction probes refuse'],
  // Prevention before signing, the throwaway balance cap and the fence.
  ['used-nonce-required', adapter, '||nonce>currentNonce)', ')', testFile, 'transaction probes ask only for an already-used nonce'],
  ['probe-nonce-zero', vectors, 'export const PROBE_NONCE = 1;', 'export const PROBE_NONCE = 0;', testFile, 'transaction probes ask only for an already-used nonce'],
  ['balance-cap', adapter, '||BigInt(balanceOs)>PROBE_MAX_BALANCE_OS)', ')', testFile, 'balance cap refuses'],
  ['balance-cap-value', vectors, 'PROBE_MAX_BALANCE_OS = 10_000_000_000n', 'PROBE_MAX_BALANCE_OS = 1_000_000_000_000n', testFile, 'balance cap refuses'],
  ['balance-shape', adapter, "if(typeof balanceOs!=='string'||!/^(0|[1-9][0-9]{0,30})$/.test(balanceOs)||", 'if(', testFile, 'balance cap refuses'],
  ['route-balance', probeRoutes, 'balanceOs:balance.toString()', "balanceOs:'0'", routes, 'probe nonce endpoint'],
  ['reserve-after-read', adapter, 'busy = true;\n      try {\n        await assertProbeTransaction(requested);\n        assertSignable(await readAccount(connected), requested.content.nonce);', 'try {\n        await assertProbeTransaction(requested);\n        assertSignable(await readAccount(connected), requested.content.nonce);\n        busy = true;', testFile, 'concurrent transaction probes'],
  ['release-before-verification', adapter, 'if (!reserved) busy = false;', 'busy = false;', testFile, 'reservation is held through'],
  ['output-real-parent', 'test/helpers/wallet-extension-probe-mutants.mjs', 'const out=join(realpathSync(dirname(resolve(process.argv[2]))),basename(resolve(process.argv[2])));', 'const out=resolve(process.argv[2]);', 'test/wallet-extension-probe-mutants.test.mjs', 'mutant helper refuses a parent-folder symlink'],
  ['output-exclusive', 'test/helpers/wallet-extension-probe-mutants.mjs', 'constants.O_CREAT|constants.O_EXCL|', 'constants.O_CREAT|', 'test/wallet-extension-probe-mutants.test.mjs', 'mutant helper refuses a hardlink alias'],
  ['output-descriptor-append', 'test/helpers/wallet-extension-probe-mutants.mjs', 'writeSync(outFd,', 'writeFileSync(out,', 'test/wallet-extension-probe-mutants.test.mjs', 'appends only through the descriptor'],
  ['transaction-error-export', adapter, "...(method === 'signTransaction' ? {} : { request: publicView(request, request) })", 'request: publicView(request, request)', testFile, 'timeouts fence'],
  ['transaction-response-export', adapter, "if (method !== 'signTransaction') record", 'record', testFile, 'transaction records and clipboard'],
  ['checkout-output', 'test/helpers/wallet-extension-probe-mutants.mjs', "assert.ok(relative(realpathSync('.'),out).startsWith('../'),'output must be outside the checkout');", '', 'test/wallet-extension-probe-mutants.test.mjs', 'mutant helper refuses a new checkout file'],
  ['private-mutation-copy', 'test/helpers/wallet-extension-probe-mutants.mjs', "const projectRoot=mkdtempSync(join(tmpdir(),'wallet-probe-mutants-'));\ncpSync(resolve('.'),projectRoot,{recursive:true,filter:(path)=>!path.split('/').some((v)=>['node_modules','.git'].includes(v))});\nsymlinkSync(resolve('node_modules'),join(projectRoot,'node_modules'),'dir');", "const projectRoot=resolve('.');", 'test/wallet-extension-probe-mutants.test.mjs', 'mutant helper leaves project'],
  ['storage-source', vectors, 'tx.content.from_ed25519_address = from;', '', testFile, 'P5 exact CREATE'],
  // Built-in sign-in only, the account re-check, the page's confirmation
  // and residual text, and honest-SDK diff reading.
  ['external-builtin-only', probeRoutes, "if(config.authMode!=='builtin') {", 'if(false) {', routes, 'built-in sign-in only'],
  ['account-recheck', adapter, "const active = await call('accounts', undefined, true);\n        if (!hasKeys(active, ['code', 'data']) || active.code !== 200 || !sameAccount(active.data, connected)) throw new Error('connected_account_changed');", '', testFile, 'account switch between connect'],
  ['account-recheck-binding', adapter, ' || !sameAccount(active.data, connected)', '', testFile, 'account switch between connect'],
  ['account-recheck-code', adapter, ' || active.code !== 200', '', testFile, 'account switch between connect'],
  ['account-recheck-shape', adapter, "!hasKeys(active, ['code', 'data']) || ", '', testFile, 'account switch between connect'],
  ['account-recheck-before-read', adapter, "assertSignable(await readAccount(connected), requested.content.nonce);\n        // The SDK signs as the extension's active account. A switch since connect\n        // would sign with an account whose nonce and balance were never read.\n        // A switch after this read and before the wallet signs is not detected.\n        const active = await call('accounts', undefined, true);", "const active = await call('accounts', undefined, true);\n        assertSignable(await readAccount(connected), requested.content.nonce);", testFile, 'account re-check runs'],
  ['account-recheck-reserved', adapter, "call('accounts', undefined, true)", "call('accounts')", testFile, 'account re-check runs'],
  ['probe-key-confirmation', ui, 'a fresh key created only for this probe and used nowhere else, holding at most 10 testnet DEM', 'a throwaway key', testFile, 'explicit click on a confirmation'],
  ['residual-p5-wording', ui, 'P5 risks a public storage-program create in the dacs3:agreement: namespace plus storage fees.', 'P5 risks a storage write.', testFile, 'explicit click on a confirmation'],
  ['residual-condition-of-use', ui, 'Condition of use: this remaining risk is accepted on testnet only if the probe key is fresh', 'Condition of use: this remaining risk is accepted', testFile, 'explicit click on a confirmation'],
  ['sdk-extra-names', checks, " || (path === '$.content' && SDK_ADDED.includes(k))", '', testFile, 'honest SDK signing diffs'],
  ['sdk-signer-key', checks, ' && !ownKey(d));', ');', testFile, 'honest SDK signing diffs'],
  ['sdk-fee-numeric', checks, '\'$.content.transaction_fee.network_fee\': () => fee(fees?.network_fee),', '\'$.content.transaction_fee.network_fee\': () => true,', testFile, 'honest SDK signing diffs'],
  ['sdk-nonce-changed', checks, "diffs.some((d) => affects(d, '$.content.nonce'))", 'false', testFile, 'honest SDK signing diffs'],
  ['sdk-recipient-changed', checks, 'diffs.some((d) => RECIPIENT_PATHS.some((path) => affects(d, path)))', 'false', testFile, 'honest SDK signing diffs'],
  ['sdk-reading-text', ui, 'const summary = result?.diffSummary, reading = TRANSACTION_READINGS[summary?.reading] ?? \'\';', 'const summary = result?.diffSummary, reading = \'\';', testFile, 'honest SDK signing diffs'],
  // Exact state edits, sensitive ancestors, hidden refusal and fee wording.
  ['gcr-shape', checks, '\'$.content.gcr_edits\': () => sdkEditsMatch(content?.gcr_edits, requested, address, wire),', '\'$.content.gcr_edits\': () => true,', r4, 'GCR rejects combined transfer, nonce'],
  ["gcr-count", "public/wallet-extension-probe/checks.mjs", " || edits.length !== 4", "", "test/wallet-extension-probe-r4.test.mjs", "GCR rejects missing edit"],
  ['gcr-account', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], Object.hasOwn(e, \'account\') ? { ...e, account: address } : e)', r4, 'GCR rejects debit account'],
  ['gcr-context-sender', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], object(e.context) ? { ...e, context: { ...e.context, sender: address } } : e)', r4, 'GCR rejects storage sender'],
  ['gcr-native-debit', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], c.type === \'native\' && i === 0 ? { ...e, amount } : e)', r4, 'GCR rejects native debit amount'],
  ['gcr-native-credit', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], c.type === \'native\' && i === 1 ? { ...e, amount } : e)', r4, 'GCR rejects native credit amount'],
  ['gcr-nonce', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], i === 3 ? { ...e, amount: 1 } : e)', r4, 'GCR rejects nonce amount'],
  ['gcr-target', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], object(e.context) ? { ...e, target: op.storageAddress } : e)', r4, 'GCR rejects storage target'],
  ['gcr-payload', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], object(e.context) ? { ...e, context: { ...e.context, data: expected[i].context.data } } : e)', r4, 'GCR rejects storage payload'],
  ['gcr-operation', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], object(e.context) ? { ...e, context: { ...e.context, operation: \'CREATE_STORAGE_PROGRAM\' } } : e)', r4, 'GCR rejects storage operation'],
  ['gcr-fee', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], i === 2 ? { ...e, amount: expected[i].amount } : e)', r4, 'GCR rejects gas amount'],
  ['gcr-rollback', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], { ...e, isRollback: false })', r4, 'GCR rejects rollback'],
  ['gcr-exact-keys', checks, 'object(e) && fieldDiffs(expected[i], e).length === 0', 'object(e) && Object.keys(expected[i] ?? {}).every((k) => fieldDiffs(expected[i][k], e[k]).length === 0)', r4, 'GCR rejects extra property'],
  ["sensitive-ancestors", "public/wallet-extension-probe/checks.mjs", " || path.startsWith(`${diff.path}.`)", "", "test/wallet-extension-probe-r4.test.mjs", "sensitive parent replacement"],
  ["external-startup-warning", "src/portal/wallet-extension-probe.mjs", "    logger?.warn('wallet_extension_probe_requires_builtin_sign_in');\n", "", "test/wallet-extension-probe-r4.test.mjs", "external misconfiguration"],
  ["fee-page-bound", "public/wallet-extension-probe/main.mjs", " The fee values are not shown or bounded beyond the 10 DEM balance cap.", "", "test/wallet-extension-probe-r4.test.mjs", "honest SDK page reading"],
  // One complete SDK serialization profile, exact canonical
  // addresses, the page/docs distinctions and the empty external router.
  ['profile-fee-form', checks, 'fee: (v) => typeof v === \'string\' && /^(0|[1-9][0-9]*)$/.test(v)', 'fee: (v) => (typeof v === \'string\' && /^(0|[1-9][0-9]*)$/.test(v)) || (typeof v === \'number\' && v >= 0)', r5, 'post-fork network fee as a number'],
  ['profile-canonical-fee', checks, 'fee: (v) => typeof v === \'string\' && /^(0|[1-9][0-9]*)$/.test(v)', 'fee: (v) => typeof v === \'string\' && /^[0-9]+$/.test(v)', r5, 'non-canonical fee string'],
  ['profile-gaps', checks, 'unexpected: diffs.length - expected + gaps', 'unexpected: diffs.length - expected', r5, 'rpc fee left as number 0'],
  ['profile-additional-fee', checks, 'fees?.additional_fee === wire(0n)', 'fee(fees?.additional_fee)', r5, 'additional fee not zero'],
  ['profile-amount', checks, '\'$.content.amount\': () => amount !== undefined && content?.amount === amount,', '\'$.content.amount\': () => true,', r5, 'P5 amount left as number 0'],
  ['pre-fork-truncation', checks, 'wire: (os) => os % DEM === 0n ? Number(os / DEM) : undefined', 'wire: (os) => Number(os / DEM)', r5, 'pre-fork P4 is an unexpected denomination rewrite'],
  ['gcr-mixed-gas', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], i === 2 && [1, \'1000000000\'].includes(e.amount) ? { ...e, amount: expected[i].amount } : e)', r5, 'post-fork gas edit in pre-fork form'],
  ['gcr-mixed-storage-debit', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], c.type === \'storageProgram\' && i === 0 && [1, \'1000000000\'].includes(e.amount) ? { ...e, amount: expected[i].amount } : e)', r5, 'storage debit in pre-fork form'],
  ['exact-account', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], typeof e.account === \'string\' && e.account.replace(/^0x/i, \'\').toLowerCase() === address.slice(2) ? { ...e, account: address } : e)', r5, 'exact canonical address'],
  ['exact-sender', checks, 'fieldDiffs(expected[i], e)', 'fieldDiffs(expected[i], object(e.context) && String(e.context.sender).replace(/^0x/i, \'\').toLowerCase() === address.slice(2) ? { ...e, context: { ...e.context, sender: address } } : e)', r5, 'exact canonical address'],
  ['exact-signing-key', checks, '\'$.content.from_ed25519_address\': () => content?.from_ed25519_address === address,', '\'$.content.from_ed25519_address\': () => String(content?.from_ed25519_address).replace(/^0x/i, \'\').toLowerCase() === address.slice(2),', r5, 'exact canonical address'],
  ['own-key-signer', checks, 'addressOf(signed?.content?.from_ed25519_address) === address', 'signed?.content?.from_ed25519_address === address', r5, 'exact canonical address'],
  ['amount-changed', checks, 'const amountChanged = diffs.some(', 'const amountChanged = false && diffs.some(', r5, 'pre-fork P4 is an unexpected denomination rewrite'],
  ['page-format-text', ui, '(summary?.reading === \'sdk-expected-only\' ? SDK_FORMATS[summary.sdkProfile] ?? \'\' : \'\')', '\'\'', r5, 'page tells SDK profiles'],
  ['page-amount-text', ui, '(summary?.amountChanged === true ? AMOUNT_REWRITE + (preForkP4 ? PRE_FORK_P4_REWRITE : \'\') : \'\')', '\'\'', r5, 'page tells SDK profiles'],
  ['page-mixed-text', ui, ', or mixed pre-fork and post-fork SDK formats', '', r5, 'page tells SDK profiles'],
  ['condition-of-use-page', ui, ' Use a fresh key used nowhere else. The page cannot check that a key is fresh; that is your responsibility.', '', r5, 'condition of use'],
  ['docs-condition-of-use', docs, 'The residual risk above is accepted on testnet', 'The residual risk above is an open decision', r5, 'condition of use'],
  ['docs-storage-chunk', docs, 'right only because this fixture is below the SDK\'s 10 KiB storage pricing\n  chunk', 'the storage price', r5, 'condition of use'],
  ['docs-traversal-403', docs, 'refuses them with its 403', 'answers them with 404', r5, 'condition of use'],
  ['external-refusal-layer', probeRoutes, '    logger?.warn(\'wallet_extension_probe_requires_builtin_sign_in\');\n    return router;', '    logger?.warn(\'wallet_extension_probe_requires_builtin_sign_in\');\n    router.use((_req,res)=>res.status(404).json({error:\'not_found\'}));\n    return router;', r5, 'same empty router'],
  // Built-in refusal headers, the prefix mount, and the pre-fork P4
  // page text. Mounting the empty switch-off router at the root gives every
  // other request an extra async hop, visible in non-production error stacks.
  ['builtin-refusal-cookie', probeRoutes, '      res.removeHeader(\'set-cookie\');\n', '', r5, 'built-in sign-in: switch-on matches'],
  ['prefix-mount-builtin', 'src/portal/routes.mjs', 'router.use(WALLET_EXTENSION_PROBE_PATH, createWalletExtensionProbeRouter(', 'router.use(config.walletExtensionProbe ? WALLET_EXTENSION_PROBE_PATH : \'/\', createWalletExtensionProbeRouter(', r5, 'built-in sign-in: switch-on matches'],
  ['prefix-mount-external', 'src/portal/routes.mjs', 'router.use(WALLET_EXTENSION_PROBE_PATH, createWalletExtensionProbeRouter(', 'router.use(config.walletExtensionProbe ? WALLET_EXTENSION_PROBE_PATH : \'/\', createWalletExtensionProbeRouter(', r5, 'external issuer: switch-on matches'],
  ['page-p4-only', ui, 'const preForkP4 = vector === \'native\' && summary?.sdkProfile === \'pre-fork\';', 'const preForkP4 = true;', r5, 'pre-fork SDK cause only'],
  ['page-p4-vector', ui, 'vector === \'native\' && summary?.sdkProfile', 'summary?.sdkProfile', r5, 'pre-fork SDK cause only'],
  ['page-p4-profile', ui, 'vector === \'native\' && summary?.sdkProfile === \'pre-fork\'', 'vector === \'native\'', r5, 'pre-fork SDK cause only'],
  ['page-amount-generic', ui, 'AMOUNT_REWRITE + (preForkP4 ? PRE_FORK_P4_REWRITE : \'\')', '(preForkP4 ? AMOUNT_REWRITE + PRE_FORK_P4_REWRITE : \'\')', r5, 'pre-fork SDK cause only'],
  ['docs-amount-format', docs, 'or the same value in a changed format (as in pre-fork P5', 'or a changed value (as in pre-fork P5', r5, 'amountChanged covers'],
  ['docs-nonce-setup', docs, 'first send one ordinary testnet transaction from the key', 'first fund the key', r5, 'amountChanged covers'],
  ['docs-builtin-headers', docs, 'refused request also gets the switch-off headers', 'refused request gets the switch-off status and body', r5, 'amountChanged covers'],
];
assert.ok(process.argv[2], 'output JSONL path is required');
assert.equal(statSync(tmpdir()).mode&0o777,0o700,'a private 0700 TMPDIR is required');
// Checked on the real parent folder, so a symlinked folder cannot point into the
// checkout. The output must not exist: O_EXCL refuses any existing name (file,
// symlink or hardlink alias), O_NOFOLLOW never follows one, and every record is
// appended through this descriptor, never by path.
const out=join(realpathSync(dirname(resolve(process.argv[2]))),basename(resolve(process.argv[2])));
assert.ok(relative(realpathSync(tmpdir()),out)&&!relative(realpathSync(tmpdir()),out).startsWith('..'),'output must be inside the private TMPDIR');
assert.ok(relative(realpathSync('.'),out).startsWith('../'),'output must be outside the checkout');
let outFd;
try {outFd=openSync(out,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
catch(error) {throw new Error(`output must be a new file (${error.code})`);}
const emit=(record)=>writeSync(outFd,`${JSON.stringify(record)}\n`);
const projectRoot=mkdtempSync(join(tmpdir(),'wallet-probe-mutants-'));
cpSync(resolve('.'),projectRoot,{recursive:true,filter:(path)=>!path.split('/').some((v)=>['node_modules','.git'].includes(v))});
symlinkSync(resolve('node_modules'),join(projectRoot,'node_modules'),'dir');
const testTmp=mkdtempSync(join(tmpdir(),'wallet-probe-mutant-data-'));
const childOptions=['--permission','--allow-fs-read=*',`--allow-fs-write=${projectRoot}/src`, `--allow-fs-write=${projectRoot}/public`, `--allow-fs-write=${projectRoot}/deploy`, `--allow-fs-write=${projectRoot}/test`, `--allow-fs-write=${testTmp}`, '--allow-child-process'];
let caught=0;
try {
  for (const [id, path, find, replace, file, pattern] of mutations) {
    const target=join(projectRoot,path),original=readFileSync(target,'utf8');assert.ok(original.includes(find),`${id}: source marker absent`);
    try {
      const index=path==='test/helpers/wallet-extension-probe-mutants.mjs'?original.lastIndexOf(find):original.indexOf(find);
      writeFileSync(target,original.slice(0,index)+replace+original.slice(index+find.length));
      if(process.send) await new Promise((resolve,reject)=>process.send({event:'mutated',id,projectRoot},(e)=>e?reject(e):resolve()));
      const permissions=file==='test/wallet-extension-probe-mutants.test.mjs'?[]:childOptions;
      // No --test-force-exit: it can end a file before its tests register and still exit 0.
      const command=[...permissions,'--test','--test-concurrency=1','--test-reporter=tap',`--test-name-pattern=${pattern}`,file];
      const result=await new Promise((resolve)=>{
        const child=spawn(process.execPath,command,{cwd:projectRoot,env:{...process.env,TMPDIR:testTmp,NODE_OPTIONS:permissions.join(' ')},stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
        child.stdout.on('data',(d)=>{stdout+=d;});child.stderr.on('data',(d)=>{stderr+=d;});
        child.on('close',(status)=>{clearTimeout(timer);resolve({stdout,stderr,status});});
      });
      const failures=[...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m)=>m[1]);
      const killed=result.status!==0&&failures.some((name)=>new RegExp(pattern).test(name));
      const count=(key)=>Number(result.stdout.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]??0);
      const caughtBy=failures.filter((name)=>new RegExp(pattern).test(name));
      emit({id,file,command:['node',...command],exit:result.status,pass:count('pass'),fail:count('fail'),caught:killed,caughtBy,failures,...(killed?{}:{tap:result.stdout+result.stderr})});
      process.stdout.write(killed?`caught ${id} by ${file} :: ${caughtBy.join(' | ')}\n`:`survived ${id} (${file} --test-name-pattern=${pattern})\n`);
      if(killed) caught++;
    } finally {writeFileSync(target,original);}
  }
} finally {closeSync(outFd);rmSync(projectRoot,{recursive:true,force:true});rmSync(testTmp,{recursive:true,force:true});}
process.stdout.write(`${caught}/${mutations.length} mutants caught; checkout untouched\n`);
if(caught!==mutations.length) process.exitCode=1;
