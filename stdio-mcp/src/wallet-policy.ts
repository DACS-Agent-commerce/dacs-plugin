/** The legacy tools' wallet opener: policy is rechecked each time, before any key is loaded. */
import { join } from 'node:path';
import { markerPresent, writeBlocker, type Config } from './config.js';
import { loadMnemonic } from './keystore.js';
import type { SecretGuard } from './secrets.js';
import type { DemosChain } from './chain.js';

export function createLegacyWalletOpener(config: Config, guard: SecretGuard, chain: Pick<DemosChain, 'openWallet'>) {
  return async () => {
    if (['KILL', 'STOP'].some((marker) => markerPresent(join(config.stateDir, marker)))) throw new Error('Writes are stopped');
    const blocker = writeBlocker(config);
    if (blocker) throw new Error(blocker);
    return chain.openWallet(loadMnemonic(config, guard));
  };
}
