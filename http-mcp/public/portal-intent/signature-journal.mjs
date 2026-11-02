// Public, durable once-per-approval claims. A claim is written before asking
// the SDK for a signature and names the server's Start record, so no reload
// or other tab can request the same step under the same approval again. A new
// Start is a new record and a new approval: it may sign that step again (the
// same bytes, or a fresh challenge), which is how an interrupted Start retries.
// IndexedDB transactions serialize competing claims on the same object store.
// No secrets, signatures or recovery phrases are stored here.
import { IntentMismatch } from './intent.mjs';
export function createSignatureJournal({ indexedDB = globalThis.indexedDB } = {}) {
  let database;
  const open = () => database ??= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('durable wallet storage is unavailable'));
    const request = indexedDB.open('dacs-start-signature-journal-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('claims');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('durable wallet storage is blocked'));
  });
  const claim = async (intent, step) => {
    try {
      const db = await open();
      const key = JSON.stringify([intent.record, intent.wallet, step]);
      await new Promise((resolve, reject) => {
        const tx = db.transaction('claims', 'readwrite');
        // add (never put) makes a pre-existing claim an error, even if another
        // tab made it between this tab's dialog and signature request.
        tx.objectStore('claims').add({ state: 'requested', at: Date.now() }, key);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error ?? new Error('the signature was already requested'));
        tx.onerror = () => {}; // onabort reports it once
      });
    } catch {
      throw new IntentMismatch('journal', `the ${step} signature was already requested under this approval, or durable storage failed; start again`);
    }
  };
  // false when durable storage cannot be opened: the portal then keeps the
  // per-step dialogs instead of the one Start approval.
  claim.available = () => open().then(() => true, () => false);
  return claim;
}
