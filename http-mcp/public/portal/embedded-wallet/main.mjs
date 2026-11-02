// Standalone bootstrap for /portal/assets/embedded-wallet/index.html
// (EXPERIMENTAL, default-off). The SDK seam modules, sdk-provider.mjs and
// demos-runtime.mjs, are separate modules. They are imported only when the
// person first creates, imports or unlocks a wallet, so a missing SDK bundle
// shows an error instead of a blank page.
//
// No network work happens here. The session gets no transactionTransport, so
// transaction and identity writes stay unavailable. This page forwards no
// state or provider anywhere: nothing goes to window.demos, the parent frame or
// a server. The trusted portal wires onPublicState/onProviderReady through
// ../embedded-wallet-bridge.mjs instead.
import { mountEmbeddedWallet } from './ui.mjs';
import { createIndexedDbVaultStore, createMemoryVaultStore } from './stores.mjs';

// validateMnemonic is the SDK's own recovery-phrase check exported by
// demos-runtime.mjs. Without it importMnemonic (and so unlock) fails closed.
async function sessionFactory({ approve }) {
  const [{ createSdkWalletSession }, { Demos, Identities, validateMnemonic }] = await Promise.all([import('./sdk-provider.mjs'), import('./demos-runtime.mjs')]);
  return createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, approve });
}

// data-vault-store="indexeddb" keeps the ciphertext vault in this origin's
// IndexedDB when available; anything else keeps it in tab memory only.
async function chooseStore(preference) {
  if (preference !== 'indexeddb') return createMemoryVaultStore();
  const store = createIndexedDbVaultStore();
  try {
    await store.get();
  } catch (error) {
    // Unreachable storage (sandboxed or partitioned frame): fall back to memory.
    // A damaged stored record keeps the IndexedDB store so the UI reports it.
    if (error?.code === 'storage_unavailable') return createMemoryVaultStore();
  }
  return store;
}

const root = document.getElementById('embedded-wallet');
mountEmbeddedWallet(root, { sessionFactory, vaultStore: await chooseStore(root.dataset.vaultStore) });
