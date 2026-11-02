// Vault stores for the experimental embedded wallet. A store holds at most one
// vault record: get() -> record | null, put(record), delete(). Every write goes
// through assertVaultRecord, so only ciphertext and public fields are ever
// stored. Neither store is durable across devices or ChatGPT sessions; the
// exported encrypted backup file is the portable recovery path.
import { assertVaultRecord, VaultError } from './vault.mjs';

// Tab memory only: gone when the page closes. Used by tests and as the
// fallback when site storage is unavailable.
export function createMemoryVaultStore(initial = null) {
  let record = initial ? assertVaultRecord(initial) : null;
  return {
    kind: 'memory',
    async get() {
      return record;
    },
    async put(value) {
      record = assertVaultRecord(value);
    },
    async delete() {
      record = null;
    },
  };
}

// Optional origin-local IndexedDB store, ciphertext only. Browsers may clear
// it at any time: private windows, storage pressure, site-data clearing, and
// third-party/partitioned storage in embedded frames (such as a ChatGPT
// iframe) can each make it disappear or never persist at all.
export function createIndexedDbVaultStore({ dbName = 'dacs-embedded-wallet-experimental', indexedDB = globalThis.indexedDB } = {}) {
  const STORE = 'vault';
  const KEY = 'current';
  const unavailable = (cause) => new VaultError('storage_unavailable', `browser storage is unavailable${cause?.name ? ` (${cause.name})` : ''}`);
  let opening = null;
  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      if (!indexedDB?.open) return reject(unavailable());
      let req;
      try {
        req = indexedDB.open(dbName, 1);
      } catch (error) {
        return reject(unavailable(error));
      }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(unavailable(req.error));
      req.onblocked = () => reject(unavailable());
    }).catch((error) => {
      opening = null; // allow a later retry
      throw error;
    });
    return opening;
  };
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result;
      let tx;
      try {
        tx = db.transaction(STORE, mode);
        const req = action(tx.objectStore(STORE));
        req.onsuccess = () => {
          result = req.result;
        };
      } catch (error) {
        return reject(unavailable(error));
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(unavailable(tx.error));
      tx.onabort = () => reject(unavailable(tx.error));
    });
  };
  return {
    kind: 'indexeddb',
    async get() {
      const value = await run('readonly', (store) => store.get(KEY));
      return value == null ? null : assertVaultRecord(value);
    },
    async put(value) {
      const record = assertVaultRecord(value);
      await run('readwrite', (store) => store.put(JSON.parse(JSON.stringify(record)), KEY));
    },
    async delete() {
      await run('readwrite', (store) => store.delete(KEY));
    },
  };
}
