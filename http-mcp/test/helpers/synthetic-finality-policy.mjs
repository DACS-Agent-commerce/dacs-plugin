// TEST DOUBLE ONLY. This module is outside the package's shipped files.
// Downstream delivery/recovery tests replace the unavailable finality policy,
// rather than enabling a native payment bypass in the production application.
import { requireCommitmentFinality as productionHold } from '../../src/dacs/commitment-finality.mjs';
export async function requireCommitmentFinality(readback, verifyFinality, scope = {}) {
  if (readback.status !== 'verified' || readback.substrate !== 'source-native-one-node') return readback;
  if (readback.finality === 'synthetic-fixture') return readback;
  let verdict;
  try { verdict = await verifyFinality?.({ ...scope, receipt: readback.anchorReceipt }); } catch { /* fixture hold */ }
  return verdict === 'valid' ? { ...readback, finality: 'synthetic-fixture' } : productionHold(readback);
}
