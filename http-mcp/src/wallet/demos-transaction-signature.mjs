// Transaction signatures, in the form the configured node uses.
//
// A transaction is authorised by an Ed25519 signature over one preimage that the
// node's own getNetworkInfo answer selects: the UTF-8 transaction hash while its
// signatureDomain fork is inactive, the UTF-8 string "demos-tx:v1:<chainId>:<hash>"
// once it is active. The answer must say which, with a safe nonnegative integer
// chainId when active; an absent fork is inactive. An unreadable or malformed answer selects
// nothing and no signature verifies. There is no second form to fall back to and no
// domain taken from a caller or a record. Raw message verification (login
// challenges, identity proofs, DACS-domain messages) stays in demos-signature.mjs.
import { txSignatureText } from '../../public/portal/embedded-wallet/tx-signature.mjs';
import { verifyDemosSignature } from './demos-signature.mjs';

const HASH = /^[0-9a-f]{64}$/;

// 'valid' | 'invalid' | 'unavailable' (the answer selects no preimage).
export function verifyDemosTransactionSignature({ networkInfo, hash, signature, publicKey, activatedChains = new Set() }) {
  const message = txSignatureText(networkInfo, typeof hash === 'string' ? hash : '', activatedChains);
  if (message === null) return 'unavailable';
  if (typeof hash !== 'string' || !HASH.test(hash)) return 'invalid';
  return verifyDemosSignature({ address: publicKey, message, signature }) ? 'valid' : 'invalid';
}
