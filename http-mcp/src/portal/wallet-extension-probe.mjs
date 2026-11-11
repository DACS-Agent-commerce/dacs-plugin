import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeDemosAddress } from '../wallet/demos-signature.mjs';

// The portal mounts the probe router under this prefix in every mode, so a
// request for any other path never enters it and takes main's exact route.
export const WALLET_EXTENSION_PROBE_PATH='/portal/wallet-extension-probe';

export function createWalletExtensionProbeRouter({ config, authServer, accounts, authenticateBearer, chain, logger }) {
  const router=express.Router();
  if(config.walletExtensionProbe!==true) return router;
  // Built-in sign-in only. An external issuer has no browser session, and the
  // page's module and fetch subrequests never carry a bearer header, so no probe
  // byte is served there; nothing links to the probe. It returns the same empty
  // router as switch-off, so requests take exactly the switch-off route.
  if(config.authMode!=='builtin') {
    logger?.warn('wallet_extension_probe_requires_builtin_sign_in');
    return router;
  }
  router.use(async(req,res,next)=>{
    try {
      const owner=accounts.getAccount(config.walletExtensionProbeOwnerAccount);
      if(!owner) throw new Error('owner_unconfigured');
      if(req.headers.authorization!==undefined) {
        const auth=await authenticateBearer(req.headers.authorization);
        if(auth.extra?.issuer!==owner.auth_issuer||auth.extra?.subject!==owner.auth_subject) throw new Error('not_owner');
      } else {
        if(!authServer||owner.auth_issuer!==config.builtinIssuer) throw new Error('session_unavailable');
        const session=await authServer.provider.Session.get(authServer.provider.createContext(req,res));
        if(session.accountId!==owner.id) throw new Error('not_owner');
      }
      next();
    } catch {
      // The session lookup may clear a stale cookie; switch-off never does.
      res.removeHeader('set-cookie');
      res.status(404).json({error:'not_found'});
    }
  });
  const dir=fileURLToPath(new URL('../../public/wallet-extension-probe/',import.meta.url));
  router.get('/',(_req,res)=>res.type('html').send(readFileSync(`${dir}index.html`,'utf8')));
  router.get('/assets/tx-signature.mjs',(_req,res)=>res.sendFile(fileURLToPath(new URL('../../public/portal/embedded-wallet/tx-signature.mjs',import.meta.url))));
  router.use('/assets',express.static(dir,{index:false,fallthrough:false,maxAge:0}));
  router.get('/nonce/:address',async(req,res)=>{
    try {
      const address=normalizeDemosAddress(req.params.address);
      if(accounts.walletOwner(address)!==config.walletExtensionProbeOwnerAccount) return res.status(404).json({error:'not_found'});
      const currentNonce=await chain.getAddressNonce(address);
      if(!Number.isSafeInteger(currentNonce)||currentNonce<0||currentNonce>=Number.MAX_SAFE_INTEGER) throw new Error('nonce_unavailable');
      const balance=await chain.getAddressBalance(address,{encoding:config.demAmountEncoding});
      res.json({address,currentNonce,nextNonce:currentNonce+1,balanceOs:balance.toString()});
    } catch { res.status(500).json({error:'nonce_unavailable'}); }
  });
  // The configured node's own network answer, for the form of a transaction signature.
  router.get('/network',async(_req,res)=>{
    try {
      const info=await chain.getNetworkInfo();
      if(info===null||typeof info!=='object'||Array.isArray(info)) throw new Error('network_unavailable');
      res.json(info);
    } catch { res.status(500).json({error:'network_unavailable'}); }
  });
  return router;
}
