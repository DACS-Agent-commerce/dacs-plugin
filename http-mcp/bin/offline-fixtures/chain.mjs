// SIMULATED Demos RPC for the offline tester (loopback only). Every response
// carries x-dacs-simulation: fixture, so the plugin labels evidence from it as
// simulated. It is NOT a Demos node, has no consensus, balances, gas or fees,
// and keeps all state in memory for one run.
//
// Read surface: the nodeCall/storage-program/gcr_routine calls the plugin and
// the bundled pay-DEM observer use, plus getNetworkInfo for the SDK fork check.
//
// Write surface ("execute" confirmTx/broadcastTx, the shape the bundled
// demosdk 4.0.16 posts): the fixture accepts a transaction only when
//   - hash == sha256(JSON.stringify(content)) (the SDK's own hashing),
//   - signature is ed25519 over the UTF-8 hash string, verified with
//     node:crypto against the public key in content.from,
//   - content.nonce == current nonce + 1 for that sender,
//   - it is a native DEM send, a GitHub/Twitter web2 identity assign/remove,
//     or a storage-program CREATE (the seller's listing publication).
// broadcastTx re-checks all of this itself (it never trusts the client's copy
// of the confirm result), then records the transaction in a new block so the
// plugin's independent readback (getTransactionStatus/getTxByHash/
// getBlockByNumber/getIdentities and GET /storage-program/<stor-…>) can
// observe it.
//
// Storage-program CREATE: the target address must be the Community
// dacs-directory@074f040 derivation stor-sha256("<from>:<programName>:<nonce>:
// <salt>")[0..40] for the sender and this transaction's nonce, nothing may
// already exist there, and encoding must be json with an object payload. The
// stored bytes are exactly content.data[1].data, owned by content.from, so the
// plugin's readback compares the canonical bytes the seller signed. Nothing
// here interprets or validates the listing itself.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createLoopbackServer, listenLoopback, closeServer, readJson, sendJson } from './http.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const ADDRESS = /^0x[0-9a-f]{64}$/;
const HASH = /^(0x)?[0-9a-f]{64}$/;
const SIG = /^(0x)?[0-9a-f]{128}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const IDENTITY_CONTEXTS = new Set(['github', 'twitter']);
const HANDLE = /^[A-Za-z0-9_-]{1,39}$/;
const LOCATOR = /^stor-[0-9a-f]{40}$/;
const MAX_TXS = 1000;
const MAX_STORAGE_PROGRAMS = 200;
const MAX_STORAGE_BYTES = 64 * 1024;

const normHash = (h) => String(h).toLowerCase().replace(/^0x/, '');
const normAddr = (a) => String(a ?? '').toLowerCase();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Community dacs-directory@074f040 src/catalog/chain.ts deriveStorageAddress.
export function deriveStorageAddress(owner, programName, nonce, salt = '') {
  return `stor-${sha256(`${normAddr(owner)}:${programName}:${nonce}:${salt}`).slice(0, 40)}`;
}

export function verifyEd25519Hex(publicKeyHex, messageUtf8, signatureHex) {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex.replace(/^0x/, ''), 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(messageUtf8, 'utf8'), key, Buffer.from(signatureHex.replace(/^0x/, ''), 'hex'));
  } catch {
    return false;
  }
}

export async function startFixtureChain({ proofs = null, now = () => Date.now() } = {}) {
  const nonces = new Map();
  const storage = new Map();
  const txs = new Map();
  const blocks = [];
  const identities = new Map(); // address -> { web2: {context: [entry]}, xm: {} }
  const counters = { confirmAccepted: 0, confirmRejected: 0, broadcastAccepted: 0, broadcastRejected: 0, unknownMethods: new Map() };
  let clock = Math.floor(now() / 1000);

  const identityEntry = (address) => {
    const key = normAddr(address);
    if (!identities.has(key)) identities.set(key, { web2: {}, xm: {} });
    return identities.get(key);
  };

  // Validation shared by confirm and broadcast. Returns { ok, reason, tx }.
  function validate(tx) {
    if (!tx || typeof tx !== 'object' || !tx.content || typeof tx.content !== 'object') return { ok: false, reason: 'transaction is malformed' };
    const content = tx.content;
    const from = normAddr(content.from);
    if (!ADDRESS.test(from)) return { ok: false, reason: 'content.from is not an ed25519 address' };
    if (content.from_ed25519_address !== undefined && normAddr(content.from_ed25519_address) !== from) {
      return { ok: false, reason: 'alternate signing keys are not simulated by this fixture' };
    }
    if (typeof tx.hash !== 'string' || !HASH.test(tx.hash)) return { ok: false, reason: 'hash is malformed' };
    if (normHash(tx.hash) !== sha256(JSON.stringify(content))) return { ok: false, reason: 'hash does not match content' };
    const sig = tx.signature;
    if (!sig || sig.type !== 'ed25519' || typeof sig.data !== 'string' || !SIG.test(sig.data)) return { ok: false, reason: 'signature must be ed25519 hex' };
    if (!verifyEd25519Hex(from, tx.hash, sig.data)) return { ok: false, reason: 'signature does not verify for content.from' };
    const expected = (nonces.get(from) ?? 0) + 1;
    if (content.nonce !== expected) return { ok: false, reason: `nonce ${content.nonce} rejected; expected ${expected}` };
    const effect = classify(content, from);
    if (!effect.ok) return effect;
    return { ok: true, from, hash: normHash(tx.hash), effect };
  }

  function classify(content, from) {
    if (content.type === 'native') {
      const op = Array.isArray(content.data) ? content.data[1] : null;
      if (content.data?.[0] !== 'native' || op?.nativeOperation !== 'send' || !Array.isArray(op.args) || op.args.length !== 2) {
        return { ok: false, reason: 'only native DEM send is simulated' };
      }
      if (!ADDRESS.test(normAddr(content.to)) || normAddr(op.args[0]) !== normAddr(content.to)) return { ok: false, reason: 'native send recipient is inconsistent' };
      return { ok: true, kind: 'native-send' };
    }
    if (content.type === 'identity') {
      const op = Array.isArray(content.data) ? content.data[1] : null;
      const payload = op?.payload;
      if (op?.context !== 'web2' || !payload || !IDENTITY_CONTEXTS.has(payload.context) || !HANDLE.test(String(payload.username ?? ''))) {
        return { ok: false, reason: 'only GitHub/Twitter web2 identity changes are simulated' };
      }
      if (op.method === 'web2_identity_remove') {
        const present = (identityEntry(from).web2[payload.context] ?? []).some((e) => e.username.toLowerCase() === payload.username.toLowerCase());
        return present ? { ok: true, kind: 'identity-remove', context: payload.context, username: payload.username } : { ok: false, reason: 'identity is not associated' };
      }
      if (op.method === 'web2_identity_assign') {
        if (!proofs) return { ok: false, reason: 'no public proof fixture is configured' };
        const checked = proofs.checkProof({ context: payload.context, proofUrl: payload.proof, username: payload.username, address: from });
        if (!checked.ok) return { ok: false, reason: checked.reason };
        return { ok: true, kind: 'identity-add', context: payload.context, username: payload.username, userId: payload.userId ?? checked.userId ?? null, proof: payload.proof };
      }
      return { ok: false, reason: 'identity method is not simulated' };
    }
    if (content.type === 'storageProgram') {
      const op = Array.isArray(content.data) && content.data[0] === 'storageProgram' ? content.data[1] : null;
      if (!isPlainObject(op) || op.operation !== 'CREATE_STORAGE_PROGRAM') return { ok: false, reason: 'only storage-program CREATE is simulated' };
      const target = String(op.storageAddress ?? '');
      if (!LOCATOR.test(target) || normAddr(content.to) !== target) return { ok: false, reason: 'storage address is malformed or differs from content.to' };
      if (typeof op.programName !== 'string' || op.programName.length < 1 || op.programName.length > 256) return { ok: false, reason: 'storage program name is malformed' };
      const salt = op.salt ?? '';
      if (typeof salt !== 'string' || salt.length > 64) return { ok: false, reason: 'storage program salt is malformed' };
      if (op.encoding !== 'json' || !isPlainObject(op.data)) return { ok: false, reason: 'only json storage programs with an object payload are simulated' };
      if (Buffer.byteLength(JSON.stringify(op.data)) > MAX_STORAGE_BYTES) return { ok: false, reason: 'storage program payload is too large for the fixture' };
      if (deriveStorageAddress(from, op.programName, content.nonce, salt) !== target) return { ok: false, reason: 'storage address does not match the sender, program name and nonce' };
      if (storage.has(target)) return { ok: false, reason: 'a storage program already exists at that address' };
      if (storage.size >= MAX_STORAGE_PROGRAMS) return { ok: false, reason: 'fixture storage program limit reached' };
      return { ok: true, kind: 'storage-create', target, programName: op.programName, data: op.data };
    }
    return { ok: false, reason: `transaction type ${String(content.type).slice(0, 32)} is not simulated` };
  }

  function apply(tx, checked) {
    const content = structuredClone(tx.content);
    nonces.set(checked.from, (nonces.get(checked.from) ?? 0) + 1);
    clock = Math.max(clock + 1, Math.floor(now() / 1000));
    const block = { number: blocks.length, txs: [checked.hash], timestamp: clock };
    blocks.push(block);
    txs.set(checked.hash, { hash: checked.hash, content, signature: structuredClone(tx.signature), blockNumber: block.number });
    const { effect } = checked;
    if (effect.kind === 'identity-add') {
      const entry = identityEntry(checked.from);
      entry.web2[effect.context] = [...(entry.web2[effect.context] ?? []), { proof: effect.proof, userId: effect.userId, username: effect.username, proofHash: sha256(String(effect.proof)), timestamp: clock }];
    } else if (effect.kind === 'identity-remove') {
      const entry = identityEntry(checked.from);
      entry.web2[effect.context] = (entry.web2[effect.context] ?? []).filter((e) => e.username.toLowerCase() !== effect.username.toLowerCase());
    } else if (effect.kind === 'storage-create') {
      storage.set(effect.target, { data: structuredClone(effect.data), owner: checked.from, programName: effect.programName });
    }
  }

  function nodeCall(message, data) {
    switch (message) {
      case 'getAddressNonce':
        return nonces.get(normAddr(data?.address)) ?? 0;
      case 'getLastBlockNumber':
        return Math.max(blocks.length - 1, 0);
      case 'getNetworkInfo':
        return { network: 'offline-fixture', simulated: true, forks: { osDenomination: { activated: true, activationHeight: 0 } } };
      case 'getNetworkParameters':
        // The SDK reads these for fee display; the fixture charges no fees.
        return { networkFee: 0, rpcFee: 0, simulated: true };
      case 'getTransactionStatus': {
        const tx = txs.get(normHash(data?.hash));
        return tx ? { state: 'included', blockNumber: tx.blockNumber } : { state: 'not-found' };
      }
      case 'getTxByHash': {
        const tx = txs.get(normHash(data?.hash));
        return tx ? { hash: tx.hash, content: tx.content, signature: tx.signature, status: 'confirmed', blockNumber: tx.blockNumber } : null;
      }
      case 'getBlockByNumber': {
        const block = blocks[data?.blockNumber];
        return block ? { number: block.number, status: 'confirmed', content: { ordered_transactions: block.txs, timestamp: block.timestamp } } : null;
      }
      case 'getTweet':
        return proofs ? proofs.tweet(String(data?.tweetUrl ?? data?.url ?? '')) : { success: false, error: 'no public proof fixture' };
      default:
        return undefined;
    }
  }

  // SDK 4.0.16 response envelope: {result, response, require_reply, extra}.
  const envelope = (result, response) => ({ result, response, require_reply: false, extra: null });
  // Confirm answer in the node's shape. The fixture holds no node key, so the
  // validity signature is empty; broadcast re-validates instead of trusting it.
  const validity = (valid, message, tx) => envelope(200, {
    data: { valid, reference_block: blocks.length, message, gas_operation: null, transaction: structuredClone(tx ?? null), simulated: true },
    signature: { type: 'ed25519', data: '' },
    rpc_public_key: '',
  });

  function execute(call) {
    const phase = call?.extra;
    if (phase === 'confirmTx') {
      const checked = validate(call?.data);
      if (!checked.ok) {
        counters.confirmRejected += 1;
        return validity(false, checked.reason, call?.data);
      }
      counters.confirmAccepted += 1;
      return validity(true, 'offline fixture: transaction is valid (SIMULATED)', call.data);
    }
    if (phase === 'broadcastTx') {
      // The validity object comes back from the client; re-validate the
      // transaction it carries instead of trusting its "valid" flag.
      const tx = call?.data?.response?.data?.transaction;
      const checked = validate(tx);
      if (!checked.ok || txs.size >= MAX_TXS) {
        counters.broadcastRejected += 1;
        return envelope(400, { message: checked.ok ? 'fixture transaction limit reached' : checked.reason, simulated: true });
      }
      apply(tx, checked);
      counters.broadcastAccepted += 1;
      return envelope(200, { message: 'offline fixture: recorded (SIMULATED, not settlement)', txHash: checked.hash, hash: checked.hash, simulated: true });
    }
    return envelope(400, 'unknown execute phase');
  }

  const server = createLoopbackServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const storageMatch = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && storageMatch) {
      const entry = storage.get(storageMatch[1]);
      if (!entry) return sendJson(res, 404, { success: false, error: 'not found' });
      return sendJson(res, 200, { success: true, data: entry.data, owner: entry.owner, programName: entry.programName });
    }
    // Demos.connect(rpc_url) probes the RPC URL with a plain GET.
    if (req.method === 'GET' && url.pathname === '/') return sendJson(res, 200, envelope(200, { simulated: true, note: 'SIMULATED offline fixture Demos RPC (not Demos testnet)' }));
    if (req.method !== 'POST' || url.pathname !== '/') return sendJson(res, 404, { error: 'not found' });
    const parsed = await readJson(req);
    const call = Array.isArray(parsed?.params) ? parsed.params[0] : undefined;
    if (parsed?.method === 'gcr_routine') {
      if (call?.method !== 'getIdentities') return sendJson(res, 200, envelope(400, 'unknown routine'));
      const entry = identities.get(normAddr(call?.params?.[0])) ?? { web2: {}, xm: {} };
      return sendJson(res, 200, envelope(200, { xm: structuredClone(entry.xm), web2: structuredClone(entry.web2), ud: [], pqc: {} }));
    }
    if (parsed?.method === 'execute') return sendJson(res, 200, execute(call));
    if (parsed?.method === 'nodeCall') {
      const response = nodeCall(call?.message, call?.data ?? {});
      if (response === undefined) {
        const name = String(call?.message ?? '').slice(0, 64);
        if (counters.unknownMethods.size < 64 || counters.unknownMethods.has(name)) counters.unknownMethods.set(name, (counters.unknownMethods.get(name) ?? 0) + 1);
        return sendJson(res, 200, envelope(400, 'method not simulated by the offline fixture'));
      }
      return sendJson(res, 200, envelope(200, response));
    }
    return sendJson(res, 200, envelope(400, 'unknown method'));
  });
  const port = await listenLoopback(server);

  return {
    url: `http://127.0.0.1:${port}`,
    seedStorage(locator, { data, owner, programName = 'offline-fixture' }) {
      storage.set(locator, { data: structuredClone(data), owner: normAddr(owner), programName });
    },
    seedSellerIdentities(address) {
      identities.set(normAddr(address), { xm: {}, web2: {
        github: [{ username: 'dacs-fixture-seller' }],
        twitter: [{ username: 'dacs_fixture' }],
        domain: [{ username: 'seller.example' }],
      } });
    },
    // The public storage-program read (same answer as GET /storage-program/…),
    // for the in-process fixture directory; null when absent.
    readStorage(locator) {
      const entry = LOCATOR.test(String(locator)) ? storage.get(locator) : null;
      return entry ? { data: structuredClone(entry.data), owner: entry.owner, programName: entry.programName } : null;
    },
    nonceOf: (address) => nonces.get(normAddr(address)) ?? 0,
    // Public counts only (no transaction bodies or signatures).
    stats() {
      return {
        blocks: blocks.length,
        transactions: txs.size,
        storagePrograms: storage.size,
        confirmAccepted: counters.confirmAccepted,
        confirmRejected: counters.confirmRejected,
        broadcastAccepted: counters.broadcastAccepted,
        broadcastRejected: counters.broadcastRejected,
        unknownNodeCalls: Object.fromEntries(counters.unknownMethods),
      };
    },
    close: () => closeServer(server),
  };
}
