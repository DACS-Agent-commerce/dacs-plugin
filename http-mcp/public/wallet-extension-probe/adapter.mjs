import { addressOf, checkSignedTransaction, hasKeys, jsonCopy, messageSignature, publicView, verifyExact } from './checks.mjs';
import { PROBE_MAX_BALANCE_OS, assertProbeTransaction } from './vectors.mjs';

async function readAccountState(address) {
  const response=await fetch(`/portal/wallet-extension-probe/nonce/${address}`,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw new Error('nonce_unavailable');
  const value=jsonCopy(await response.json());
  if(!hasKeys(value,['address','currentNonce','nextNonce','balanceOs'])||value.address!==address||value.nextNonce!==value.currentNonce+1) throw new Error('nonce_unavailable');
  return { currentNonce: value.currentNonce, balanceOs: value.balanceOs };
}
// The configured node's getNetworkInfo answer, read through the portal rather
// than from the wallet under test; it decides which bytes a transaction
// signature covers.
async function readNetworkInfo() {
  const response=await fetch('/portal/wallet-extension-probe/network',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw new Error('network_unavailable');
  return jsonCopy(await response.json());
}
// Checked before the provider sees a transaction. The requested nonce must
// already be used and the account must be a throwaway holding at most
// PROBE_MAX_BALANCE_OS.
function assertSignable(account, nonce) {
  const { currentNonce, balanceOs } = account ?? {};
  if(!Number.isSafeInteger(currentNonce)||currentNonce<0||currentNonce>=Number.MAX_SAFE_INTEGER||nonce>currentNonce) throw new Error('used_nonce_required');
  if(typeof balanceOs!=='string'||!/^(0|[1-9][0-9]{0,30})$/.test(balanceOs)||BigInt(balanceOs)>PROBE_MAX_BALANCE_OS) throw new Error('throwaway_balance_required');
}
const sameAccount = (value, connected) => { try { return addressOf(value) === connected; } catch { return false; } };

const REQUEST_METHODS = Object.freeze(['connect', 'sign', 'signTransaction']);
export function createExtensionProbeAdapter({ windowObject = window, discoveryTimeoutMs = 3000, requestTimeoutMs = 60000, now = () => Date.now(), readAccount = readAccountState, readNetwork = readNetworkInfo } = {}) {
  let provider = null, address = null, busy = false, timedOut = false, popupIssued = false;
  const records = [];
  const record = (probe, result) => { records.push({ probe, at: new Date(now()).toISOString(), ...jsonCopy(result) }); return result; };
  // `reserved` means the caller already holds the session fence and releases it.
  async function call(method, params, reserved = false) {
    if ((!REQUEST_METHODS.includes(method) && method !== 'accounts') || !provider) throw new Error('provider_unavailable');
    if ((busy && !reserved) || timedOut) throw new Error('session_fenced');
    busy = true;
    const started = now(), request = params === undefined ? { method } : { method, params: jsonCopy(params) };
    let timer;
    try {
      const response = jsonCopy(await Promise.race([
        Promise.resolve().then(() => method === 'accounts' ? provider.accounts() : provider.request(jsonCopy(request))),
        new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')); }, requestTimeoutMs); }),
      ]));
      if (method !== 'signTransaction') record('request', { method, request: publicView(request, request), response: publicView(response, request), durationMs: now() - started });
      if (method === 'accounts') return response;
      if (!response || response.success !== true) throw new Error(response?.success === false ? 'denied_or_locked' : 'malformed_envelope');
      if ((!hasKeys(response, ['success', 'data']) && !hasKeys(response, ['type', 'id', 'method', 'success', 'data']))
        || (Object.hasOwn(response, 'id') && (typeof response.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(response.id)))
        || (Object.hasOwn(response, 'method') && response.method !== method)
        || (Object.hasOwn(response, 'type') && response.type !== 'demosProviderResponse')) throw new Error('malformed_envelope');
      return response.data;
    } catch (error) {
      const code = ['timeout', 'denied_or_locked', 'malformed_envelope', 'response_not_json', 'response_bounds'].includes(error?.message) ? error.message : 'provider_error';
      record('request-error', { method, code, ...(method === 'signTransaction' ? {} : { request: publicView(request, request) }), durationMs: now() - started });
      throw new Error(code);
    } finally { clearTimeout(timer); if (!reserved) busy = false; }
  }
  return Object.freeze({
    async discover() {
      if (busy || timedOut) throw new Error('session_fenced');
      busy = true; provider = null; address = null;
      try {
        return await new Promise((resolve) => {
          let timer;
          const finish = (p) => {
            clearTimeout(timer); windowObject.removeEventListener('demosAnnounceProvider', announce);
            provider = p;
            resolve(record('P1', { state: p ? 'present' : 'not-observed', method: 'demosRequestProvider' }));
          };
          const announce = (event) => { const p = event?.detail?.provider; if (typeof p?.request === 'function') finish(p); };
          windowObject.addEventListener('demosAnnounceProvider', announce);
          timer = setTimeout(() => finish(null), discoveryTimeoutMs);
          windowObject.dispatchEvent(new Event('demosRequestProvider'));
        });
      } finally { busy = false; }
    },
    async accounts() {
      const value = await call('accounts');
      if (!hasKeys(value, ['code', 'data']) || ![200, 401, 404].includes(value.code) || (value.code !== 200 && value.data !== null)) return record('P1', { state: 'malformed-account-response', ok: false });
      if (value.code !== 200) return record('P1', { state: value.code === 401 ? 'locked' : 'wallet-absent', ok: false });
      const account = addressOf(value.data);
      return record('P1', { state: 'account-readable', address: account, ok: address === null || account === address });
    },
    async connect() {
      address = null;
      const value = await call('connect');
      if (!hasKeys(value, ['address'])) throw new Error('invalid_connect_shape');
      address = addressOf(value.address);
      return record('P2/P8', { ok: true, address, ui: 'owner-observation-required' });
    },
    async signMessage(message) {
      const connected = address;
      const value = await call('sign', [message]);
      let ok = false;
      try { ok = connected !== null && await verifyExact(connected, message, messageSignature(value, connected)); } catch {}
      return record('P3', { ok, address: connected, message: publicView(message, message), reason: ok ? 'exact-utf8-ed25519' : 'exact-message-or-account-check-failed' });
    },
    async signTransaction(transaction) {
      if (!address || transaction?.content?.from !== address) throw new Error('connected_account_required');
      const requested = jsonCopy(transaction), connected = address;
      if (busy || timedOut) throw new Error('session_fenced');
      busy = true;
      try {
        await assertProbeTransaction(requested);
        assertSignable(await readAccount(connected), requested.content.nonce);
        const networkInfo = await readNetwork();
        // The SDK signs as the extension's active account. A switch since connect
        // would sign with an account whose nonce and balance were never read.
        // A switch after this read and before the wallet signs is not detected.
        const active = await call('accounts', undefined, true);
        if (!hasKeys(active, ['code', 'data']) || active.code !== 200 || !sameAccount(active.data, connected)) throw new Error('connected_account_changed');
        const signed = await call('signTransaction', [requested], true);
        const result = await checkSignedTransaction(requested, signed, connected, networkInfo);
        return record(requested.content.type === 'native' ? 'P4' : 'P5', { method: 'signTransaction', ...result });
      } finally { busy = false; }
    },
    openPopup() {
      if (popupIssued) throw new Error('popup_already_requested');
      popupIssued = true;
      windowObject.postMessage({ type: 'openpopup' }, '*');
      return record('P8', { method: 'openpopup', state: 'requested', ui: 'owner-observation-required' });
    },
    observeUi(observation) {
      if (!['approval-window', 'toolbar-popup', 'nothing-observed', 'origin-matches', 'origin-differs'].includes(observation)) throw new Error('invalid_observation');
      return record('P8', { observation, evidence: 'owner-reported' });
    },
    report() { return JSON.parse(JSON.stringify({ version: 1, mode: 'sign-only-no-payment', records })); },
  });
}
