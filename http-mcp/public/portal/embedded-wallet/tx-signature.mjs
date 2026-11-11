// An absent fork is inactive; remembered activation can only cause refusal.
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function txSignatureText(answer, hash, activatedChains = new Set()) {
  if (!object(answer) || !object(answer.forks)) return null;
  const fork = answer.forks.signatureDomain, chainId = answer.chainId;
  if (Object.hasOwn(answer.forks, 'signatureDomain') && (!object(fork) || typeof fork.activated !== 'boolean')) return null;
  if (fork?.activated !== true) return activatedChains.has(chainId) ? null : hash;
  if (!Number.isSafeInteger(chainId) || chainId < 0) return null;
  if (!activatedChains.has(chainId)) activatedChains.add(chainId);
  if (activatedChains.size > 16) activatedChains.delete(activatedChains.values().next().value);
  return `demos-tx:v1:${chainId}:${hash}`;
}
