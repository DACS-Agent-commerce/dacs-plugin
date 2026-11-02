// Browser entry for public/portal/embedded-wallet/demos-runtime.mjs.
//
// Re-exports the unmodified upstream @kynesyslabs/demosdk 4.0.16 classes. This
// is the public npm package, NOT the V2 server-only modified runtime tarball.
// Nothing here talks to the network: importing the SDK only defines classes
// (plus the SDK's own idle `demos` singleton); RPC work happens only when a
// caller invokes connect()/confirm()/broadcast()/nodeCall() and friends, which
// the embedded wallet adapter never does.
//
// Identities and the SDK word list are imported by file path because 4.0.16
// does not expose them as package subpaths without the heavier barrels.
//
// build.mjs bundles this entry with esbuild code splitting into a local module
// graph (demos-runtime.mjs + runtime-chunks/); the exports below are the same
// whether the graph is one file or many.
import { validateMnemonic as bip39ValidateMnemonic } from '@scure/bip39';
import { wordList } from './node_modules/@kynesyslabs/demosdk/build/encryption/PQC/falconts/wordlist.js';

export { Demos } from '@kynesyslabs/demosdk/websdk';
export { Identities } from './node_modules/@kynesyslabs/demosdk/build/abstraction/Identities.js';

export const DEMOS_SDK_PACKAGE = '@kynesyslabs/demosdk';
export const DEMOS_SDK_VERSION = '4.0.16';
export const RUNTIME_LABEL = 'upstream-demosdk-4.0.16-browser-bundle';

// Exactly the check Demos.connectWallet applies before treating a string as a
// mnemonic (bip39.validateMnemonic(masterSeed, wordList)). connectWallet
// silently treats anything else as a BIP-39 passphrase and derives a different
// identity, so importers must refuse input that fails this check.
export function validateMnemonic(mnemonic) {
  return typeof mnemonic === 'string' && bip39ValidateMnemonic(mnemonic, wordList);
}
