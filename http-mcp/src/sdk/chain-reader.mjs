// The plugin's Demos chain reader. It reads identities itself and takes every
// other read from a chain reader passed in: the client's public testnet reader
// or a native transport's chainReader(). It holds no key and cannot sign,
// send or record payment evidence.
//
// The identity read is the one the pinned @kynesyslabs/dacs DemosAdapter makes
// through demosdk: a gcr_routine getIdentities POST, sent unsigned with the
// SDK's empty authentication headers. The answer is capped at the dacs CCI
// encoded-byte limit before decoding, a non-200 result is unavailable (never
// "no identities"), and the decoded value is bounded by
// assertDemosCciResponseBounds before it is returned.
import { DEMOS_CCI_RESPONSE_LIMITS, assertDemosCciResponseBounds } from '@kynesyslabs/dacs/identity';
import { fetchBoundedJson, OutboundError } from '../util/http.mjs';
import { normalizeDemosAddress } from '../wallet/demos-signature.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const SIMULATION_HEADER = 'x-dacs-simulation';
const UNSIGNED_SDK_HEADERS = Object.freeze({ identity: 'ed25519:', signature: '', timestamp: '' });
const SIMULATED = 'simulated-fixture';
const PUBLIC_READ = 'public-chain-read';
// The reads the client's public reader offers; a native chainReader() offers them too.
const CHAIN_READS = Object.freeze(['readStorageProgram', 'getAddressBalance', 'getTransactionFees', 'networkIdentity', 'getAddressNonce',
  'observePurchaseTransfer', 'observeTransfer', 'getTransaction', 'findTransferAtNonce']);

function delegatedReads(chainReads) {
  if (chainReads === null) return {};
  const reads = {};
  for (const name of CHAIN_READS) {
    if (typeof chainReads[name] !== 'function') throw new TypeError(`the chain reads passed in have no ${name}`);
    reads[name] = (...args) => chainReads[name](...args);
  }
  return reads;
}

/**
 * Creates the Demos chain reader for identity reads, with the reads of
 * `chainReads` (the client's public reader or a native transport's
 * chainReader()) when one is passed.
 *
 * Returns a frozen object: `network`, `rpcOrigin`, `pinnedIdentity` (from
 * `chainReads`, else null), `evidenceMode` (`simulated-fixture` once any
 * answer is marked simulated, else `public-chain-read`), `getIdentities` and
 * the delegated reads. `getIdentities(address, { timeoutMs })` resolves the
 * decoded `{ result: 200, response }` envelope and rejects OutboundError
 * `unavailable` (no answer, non-200 result) or `invalid` (oversized, malformed
 * or out-of-bounds answer).
 *
 * Throws TypeError when `chainReads` lacks one of the public reads.
 */
export function createDemosChainReader({ rpcUrl, network, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, chainReads = null }) {
  const endpoint = new URL(rpcUrl);
  const reads = delegatedReads(chainReads);
  let markedSimulated = false;

  const observingFetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.headers.get(SIMULATION_HEADER)) markedSimulated = true;
    return response;
  };

  async function getIdentities(address, { timeoutMs: readTimeoutMs = timeoutMs } = {}) {
    const envelope = await fetchBoundedJson(endpoint, {
      fetchImpl: observingFetch,
      method: 'POST',
      body: { method: 'gcr_routine', params: [{ method: 'getIdentities', params: [normalizeDemosAddress(address)] }] },
      headers: UNSIGNED_SDK_HEADERS,
      timeoutMs: Math.min(timeoutMs, readTimeoutMs),
      maxBytes: DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes,
      expectedOrigin: endpoint.origin,
    });
    if (envelope === null || typeof envelope !== 'object' || envelope.result !== 200 || !Object.hasOwn(envelope, 'response')) {
      throw new OutboundError('unavailable', 'Demos RPC gcr_routine getIdentities returned a non-200 result');
    }
    try {
      assertDemosCciResponseBounds(envelope);
    } catch (error) {
      throw new OutboundError('invalid', `getIdentities response rejected: ${String(error?.message ?? error).slice(0, 120)}`, { cause: error });
    }
    return envelope;
  }

  return Object.freeze({
    ...reads,
    network,
    rpcOrigin: endpoint.origin,
    pinnedIdentity: chainReads?.pinnedIdentity ?? null,
    get evidenceMode() {
      return markedSimulated || chainReads?.evidenceMode === SIMULATED ? SIMULATED : PUBLIC_READ;
    },
    getIdentities,
  });
}
