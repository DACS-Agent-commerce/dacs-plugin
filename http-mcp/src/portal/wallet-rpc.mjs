import { readIssuedWallet } from '../devnet-demo/issued-readback.mjs';
import { nativeRelayWallet, operatorBuyerAccessConfig } from '../devnet-demo/buyer-access.mjs';
// Same-origin RPC relay for the EXPERIMENTAL embedded (extension-free) wallet.
// Enabled only by DACS_EMBEDDED_WALLET_WRITES=simulated-loopback, which config
// accepts only with a loopback DACS_CHAIN_RPC_URL; production/live enabling is
// held for the independent security and live gates.
//
// Why it exists: the portal CSP is connect-src 'self', and the upstream
// @kynesyslabs/demosdk 4.0.16 sends every node call through axios to the
// Demos instance's rpc_url (set by its public connect(rpc_url)). Pointing that
// rpc_url at this route keeps the browser same-origin without CDN, CSP or
// axios changes. The browser keeps the key: it signs locally and this route
// only carries the SDK's own public request bodies.
//
// Narrow by construction:
//  - one fixed destination (the configured chain RPC), no redirects, timeout,
//    request and response byte caps, no retry;
//  - only the SDK calls the embedded wallet makes: nodeCall getNetworkInfo,
//    getNetworkParameters, getAddressNonce, getTweet, and execute
//    confirmTx/broadcastTx (native send, identity change and the
//    storage-program create that publishes a seller listing; the fixture
//    validates each); anything else is refused with 403;
//  - the held testnet profile (DACS_EMBEDDED_WALLET_WRITES=testnet-held) never
//    mounts this relay, so nothing can reach a real node through it;
//  - every upstream answer must carry the fixture simulation header, else
//    nothing is passed through (409 not_simulated);
//  - upstream failure answers HTTP 500, never 502/503/504: the SDK's _doPost
//    automatically retries those statuses, and a broadcast whose outcome is
//    unknown must not be re-sent;
//  - only the SDK's identity/signature/timestamp auth headers are forwarded,
//    and only when well-formed; bodies and headers are never logged.
import express from 'express';
import { fetchBoundedJson, OutboundError } from '../util/http.mjs';
import { SIMULATION_HEADER } from '../dacs/chain.mjs';
import { isDevnetNativeTransport, isDevnetAgreementTransport, DEVNET_NATIVE_RPC_PATH, DEVNET_NATIVE_BINDING_PATH, rpcAuthRefusal, transferRefusal } from '../wallet/devnet-native-transport.mjs';

export const WALLET_RPC_PATH = '/portal/api/wallet-rpc';
const NODE_CALLS = new Set(['getNetworkInfo', 'getNetworkParameters', 'getAddressNonce', 'getTweet']);
const EXECUTE_EXTRAS = new Set(['confirmTx', 'broadcastTx']);
const AUTH_HEADERS = {
  identity: /^(ed25519|falcon|ml-dsa):(0x)?[0-9a-f]*$/i,
  signature: /^(0x)?[0-9a-f]*$/i,
  timestamp: /^[0-9]{0,16}$/,
};
const GITHUB_HANDLE = /^[A-Za-z0-9-]{1,39}$/;
const RESPONSE_LIMIT = 4 * 1024 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Which of the SDK's request bodies may pass, or null.
export function relayedCall(body) {
  const call = Array.isArray(body?.params) && body.params.length === 1 ? body.params[0] : null;
  if (!isObject(body) || !isObject(call)) return null;
  if (body.method === 'nodeCall' && typeof call.message === 'string' && NODE_CALLS.has(call.message)) return `nodeCall:${call.message}`;
  if (body.method === 'execute' && typeof call.extra === 'string' && EXECUTE_EXTRAS.has(call.extra) && isObject(call.data)) return `execute:${call.extra}`;
  return null;
}

export function createWalletRpcRouter({ config, fetchImpl = globalThis.fetch, logger, offlineAgreementBroker = null, nativeTransport = null, buyerAccess = null }) {
  const router = express.Router();
  // Separately mounted by the composition root only for an opaque source
  // capability. This never changes the existing simulated/held profile route.
  if (nativeTransport !== null) {
    if (!isDevnetNativeTransport(nativeTransport) && !isDevnetAgreementTransport(nativeTransport)) throw new TypeError('an explicit trusted native transport capability is required');
    // The Agreement (operator/native-demo) relay always enforces buyer access;
    // only the separate native-payment profile predates it.
    const access = operatorBuyerAccessConfig(buyerAccess);
    if (!access && isDevnetAgreementTransport(nativeTransport)) throw new TypeError('the native Agreement wallet relay requires the operator buyerAccess capability');
    // Buyers only: the operator custody seller's wallet traffic is in-process
    // (devnet-demo/seller-relay.mjs), so a request naming it is refused here.
    const assertRelayWallet = (wallet) => { if (access) access.assertRelayWallet(wallet); };
    const authHeaders = (req) => {
      const headers={};
      for(const [name,pattern] of Object.entries(AUTH_HEADERS)) { const v=req.get(name); if(typeof v === 'string' && v.length <= 512 && pattern.test(v))headers[name]=v; }
      return headers;
    };
    const json = express.json({ limit:'64kb' });
    const sameOrigin = (req,res,next) => !req.get('origin') || req.get('origin') === config.publicOrigin ? next() : res.status(403).json({ error:'wrong_origin' });
    router.post('/portal/api/devnet-native-wallet-profile',sameOrigin,(_req,res) => res.json(nativeTransport.profile(config.publicOrigin)));
    router.get(DEVNET_NATIVE_RPC_PATH,(_req,res) => res.json({ result:200,response:{ relay:'dacs-native-only',profile:'devnet-native' } }));
    router.post(DEVNET_NATIVE_BINDING_PATH,sameOrigin,json,async (req,res) => {
      // Lane-resolution proofs are server-only (cancel/settlement); the browser reads back {phase,address,hash}.
      if (req.body && typeof req.body === 'object' && ['failedNonceFence','consumedByHash'].some((k) => Object.hasOwn(req.body,k))) return res.status(400).json({ error:'invalid_params' });
      try {
        try{assertRelayWallet(req.body?.address);}
        catch(error){
          if(error.code==='buyer_access_closed'&&req.body?.phase==='readback'){
            const read=await readIssuedWallet({sourceCapability:nativeTransport,address:req.body.address,hash:req.body.hash});
            if(read)return res.json(read);
          }
          // Releasing a transient connection lease never signs or resends.
          if(error.code!=='buyer_access_closed'||req.body?.phase!=='release')throw error;
        }
        // bind and signature need the wallet's own RPC auth headers.
        return res.json(await nativeTransport.walletBinding(req.body,authHeaders(req)));
      }
      catch(error) {
        logger?.info('native_wallet_binding_held',{ code:error.code ?? 'unavailable' });
        // A refused RPC auth set (stale clock, replay, busy) or a refused
        // transfer (its payment cancelled, or not the one its lease named)
        // says so, as 409.
        const refusal=rpcAuthRefusal(error) ?? transferRefusal(error);
        return refusal ? res.status(refusal[0]).json(refusal[1]) : res.status(500).json({ error:error.code ?? 'network_binding_unavailable',message:'native transport binding/readback is held; nothing is retried' });
      }
    });
    router.post(DEVNET_NATIVE_RPC_PATH,sameOrigin,json,async (req,res) => {
      const headers=authHeaders(req);
      try {
        const wallet=nativeRelayWallet(req.body);
        if(wallet!==null)assertRelayWallet(wallet);
        return res.json(await nativeTransport.rpc(req.body,headers));
      }
      catch(error) {
        if(['buyer_access_closed','seller_wallet_in_process'].includes(error.code))return res.status(409).json({error:error.code,message:error.message});
        logger?.info('native_wallet_rpc_held',{ code:error.code ?? 'unavailable' });
        const refusal=rpcAuthRefusal(error) ?? transferRefusal(error);
        if(refusal)return res.status(refusal[0]).json(refusal[1]);
        // Never a status the SDK automatically retries, especially after send.
        return res.status(500).json({ result:500,response:'native transport held or outcome unknown; read back, never resend',require_reply:false,extra:null });
      }
    });
    return router;
  }
  const enabled = config.embeddedWallet?.writes === 'simulated-loopback' && Boolean(config.chain);
  const rpcUrl = enabled ? config.chain.rpcUrl : null;
  const rpcOrigin = enabled ? new URL(rpcUrl).origin : null;
  const json = express.json({ limit: '64kb' });

  // Public, non-secret description of what this server enables. The held
  // testnet profile is reported (writes stay off) so the portal can say why
  // nothing can be sent; no relay exists for it.
  const testnet = config.embeddedWalletTestnet;
  router.post('/portal/api/embedded-wallet/profile', (_req, res) => {
    if (testnet?.profile === 'held') {
      return res.json({
        writes: 'off',
        testnet: {
          profile: 'held',
          executable: false,
          network: testnet.network,
          reason: 'held. The external security review is on hold. Live gates are not met; no testnet writes in this build.',
          gates: ['external-security-review', 'live-wallet-compatibility', 'testnet-network-identity', 'human-approval'],
        },
      });
    }
    if (!enabled) return res.json({ writes: 'off' });
    return res.json({
      writes: 'simulated-loopback',
      rpcUrl: `${config.publicOrigin}${WALLET_RPC_PATH}`,
      network: config.chain.network,
      evidenceMode: 'simulated-fixture',
      githubLookup: Boolean(config.embeddedWallet.githubApiOrigin),
      label: 'SIMULATED loopback fixture (not Demos testnet)',
      capabilities: { payment: true, identity: config.identityWrites === 'simulated-fixture-only', publication: false },
      ...(offlineAgreementBroker ? { agreementBroker: offlineAgreementBroker.profile } : {}),
    });
  });

  if (!enabled) return router;

  // The SDK's Demos.connect(rpc_url) only needs an HTTP 200 here.
  router.get(WALLET_RPC_PATH, (_req, res) => res.json({ result: 200, response: { relay: 'dacs-embedded-wallet', profile: 'simulated-loopback' } }));

  async function upstream(url, init) {
    let simulated = false;
    const observing = async (input, options) => {
      const response = await fetchImpl(input, options);
      if (response.headers.get(SIMULATION_HEADER)) simulated = true;
      return response;
    };
    const body = await fetchBoundedJson(url, { ...init, fetchImpl: observing, timeoutMs: config.chain.timeoutMs, maxBytes: RESPONSE_LIMIT, expectedOrigin: new URL(url).origin });
    return { body, simulated };
  }

  // A write (execute) is forwarded only after an earlier relayed answer from
  // this chain carried the simulation header; reads establish it first.
  let fixtureObserved = false;
  router.post(WALLET_RPC_PATH, json, async (req, res) => {
    const kind = relayedCall(req.body);
    if (!kind) return res.status(403).json({ result: 403, response: 'not relayed', require_reply: false, extra: null });
    if (kind.startsWith('execute:') && !fixtureObserved) {
      return res.status(409).json({ result: 409, response: 'not_simulated: the configured chain has not been observed as a simulated fixture', require_reply: false, extra: null });
    }
    const headers = {};
    for (const [name, pattern] of Object.entries(AUTH_HEADERS)) {
      const value = req.get(name);
      if (typeof value === 'string' && value.length <= 512 && pattern.test(value)) headers[name] = value;
    }
    try {
      const { body, simulated } = await upstream(rpcUrl, { method: 'POST', body: req.body, headers });
      if (!simulated) {
        logger?.warn('wallet_rpc_not_simulated', { call: kind, rpcOrigin });
        return res.status(409).json({ result: 409, response: 'not_simulated: the configured chain is not a simulated fixture', require_reply: false, extra: null });
      }
      fixtureObserved = true;
      return res.json(body);
    } catch (error) {
      logger?.info('wallet_rpc_upstream_failed', { call: kind, kind: error instanceof OutboundError ? error.kind : 'error' });
      return res.status(500).json({ result: 500, response: 'relay: the configured chain did not answer; the outcome of a sent request is unknown', require_reply: false, extra: null });
    }
  });

  // GitHub user lookup that SDK 4.0.16 addGithubIdentity performs directly
  // against api.github.com (GET /users/<name> -> login, id). The portal CSP
  // forbids that origin, so in this simulated profile the server reads the one
  // configured loopback origin instead and returns only {login, id}.
  router.post(`${WALLET_RPC_PATH}/github-user`, json, async (req, res) => {
    const origin = config.embeddedWallet.githubApiOrigin;
    if (!origin) return res.status(503).json({ error: 'not_configured', message: 'GitHub user lookup is not configured for the simulated profile' });
    const username = String(req.body?.username ?? '');
    if (!GITHUB_HANDLE.test(username)) return res.status(400).json({ error: 'invalid_username', message: 'not a GitHub handle' });
    try {
      const { body, simulated } = await upstream(`${origin}/users/${encodeURIComponent(username)}`, { method: 'GET' });
      if (!simulated) return res.status(409).json({ error: 'not_simulated', message: 'the configured GitHub lookup is not a simulated fixture' });
      if (typeof body?.login !== 'string' || !GITHUB_HANDLE.test(body.login) || !Number.isSafeInteger(body?.id)) {
        return res.status(500).json({ error: 'invalid_response', message: 'GitHub user lookup returned an unexpected shape' });
      }
      return res.json({ login: body.login, id: body.id });
    } catch (error) {
      const status = error instanceof OutboundError && error.kind === 'not-found' ? 404 : 500;
      return res.status(status).json({ error: status === 404 ? 'not_found' : 'upstream_unavailable', message: 'GitHub user lookup failed' });
    }
  });

  return router;
}
