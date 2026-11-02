import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { auth, discoverAuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { decodeJwt } from 'jose';
import { startHarness } from './helpers/harness.mjs';
import { TestOAuthProvider, completeAuthorizationInBrowser } from './helpers/oauth.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

let h,metadata;
before(async()=>{h=await startHarness();metadata=await discoverAuthorizationServerMetadata(`${h.origin}/oauth`);});
after(async()=>h.close());
const refresh=(provider,refreshToken=provider.tokens().refresh_token)=>fetch(metadata.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:provider.clientInformation().client_id,resource:h.mcpUrl})});
const nowSeconds=()=>Math.floor(Date.now()/1000);
const DAY=24*60*60;
// Ends the sign-in Session the refresh token was issued under, as its ~24 h TTL would.
const endSignInSession=(sessionUid)=>{
  const changed=h.app.db.prepare("UPDATE oidc_models SET expires_at=? WHERE model='Session' AND uid=?").run(nowSeconds()-1,sessionUid).changes;
  assert.equal(changed,1,'exactly one sign-in session row');
};
async function link(scope='dacs.account.read',ProviderCtor=TestOAuthProvider){
  const provider=new ProviderCtor({scope});assert.equal(await auth(provider,{serverUrl:h.mcpUrl,scope}),'REDIRECT');
  // The MCP SDK adds offline_access; use the exact requested scope as ChatGPT does.
  provider.authorizationUrl.searchParams.set('scope',scope);
  const callback=await completeAuthorizationInBrowser({authorizationUrl:provider.authorizationUrl,wallet:createEphemeralWallet(),origin:h.origin});
  assert.equal(callback.view.scopes.some(s=>s.scope==='offline_access'),scope.split(' ').includes('offline_access')&&provider.clientMetadata.grant_types.includes('refresh_token'));
  assert.equal(await auth(provider,{serverUrl:h.mcpUrl,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss'),scope}),'AUTHORIZED');
  return provider;
}

// Refresh tokens are issued whenever the client allows the refresh_token grant.
// Their stored expiry is 30 days, but without offline_access (ChatGPT never
// requests it) they are bound to the ~24 h sign-in session and stop working
// when it ends. Only an offline_access token can last the full 30 days.
for(const [scope,sessionBound] of [['dacs.account.read',true],['openid offline_access dacs.account.read',false]])test(`refresh-capable client receives a refresh token (stored expiry 30 days, ${sessionBound?'bound to the ~24 h sign-in session':'not session-bound'}) and can refresh (${scope})`,async()=>{
  const provider=await link(scope),tokens=provider.tokens();
  assert.ok(tokens.refresh_token);
  const token=await h.app.authServer.provider.RefreshToken.find(tokens.refresh_token);assert.ok(token);
  assert.equal(token.exp-token.iat,30*DAY);assert.equal(Boolean(token.expiresWithSession),sessionBound);
  const row=h.app.db.prepare("SELECT payload,expires_at FROM oidc_models WHERE model='RefreshToken' AND id=?").get(token.jti);assert.ok(row);
  assert.equal(row.expires_at-JSON.parse(row.payload).iat,30*DAY);
  const response=await refresh(provider),next=await response.json();assert.equal(response.status,200,next.error);
  assert.ok(next.refresh_token);assert.notEqual(next.refresh_token,tokens.refresh_token);
  const rotated=await h.app.authServer.provider.RefreshToken.find(next.refresh_token);assert.ok(rotated);
  assert.equal(Boolean(rotated.expiresWithSession),sessionBound,'rotation keeps the session binding');
  assert.equal(decodeJwt(next.access_token).sub,decodeJwt(tokens.access_token).sub);assert.equal(decodeJwt(next.access_token).aud,h.mcpUrl);
  assert.equal(decodeJwt(next.access_token).exp-decodeJwt(next.access_token).iat,900);
});

test('without offline_access, refresh stops working when the ~24 h sign-in session ends, though the token\'s own 30-day expiry has not passed',async()=>{
  const provider=await link('dacs.account.read');
  const issued=await h.app.authServer.provider.RefreshToken.find(provider.tokens().refresh_token);assert.ok(issued?.sessionUid);
  const session=h.app.db.prepare("SELECT expires_at FROM oidc_models WHERE model='Session' AND uid=?").get(issued.sessionUid);assert.ok(session);
  const sessionLeft=session.expires_at-nowSeconds();assert.ok(sessionLeft>DAY-120&&sessionLeft<=DAY,`sign-in session lasts about 24 h (${sessionLeft} s left)`);
  // One refresh inside the session rotates the token; the rotated token stays bound to the same session.
  const first=await refresh(provider),firstBody=await first.json();assert.equal(first.status,200,firstBody.error);
  const rotated=await h.app.authServer.provider.RefreshToken.find(firstBody.refresh_token);assert.equal(rotated.sessionUid,issued.sessionUid);
  endSignInSession(issued.sessionUid);
  const row=h.app.db.prepare("SELECT expires_at FROM oidc_models WHERE model='RefreshToken' AND id=?").get(rotated.jti);
  assert.ok(row.expires_at-nowSeconds()>29*DAY,'the refresh token itself has not expired');
  const response=await refresh(provider,firstBody.refresh_token);assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_grant');
});

test('control: with offline_access, refresh keeps working after the sign-in session ends',async()=>{
  const provider=await link('openid offline_access dacs.account.read');
  const issued=await h.app.authServer.provider.RefreshToken.find(provider.tokens().refresh_token);assert.ok(issued?.sessionUid);
  endSignInSession(issued.sessionUid);
  const response=await refresh(provider),body=await response.json();assert.equal(response.status,200,body.error);assert.ok(body.refresh_token);
});

class CodeOnlyOAuthProvider extends TestOAuthProvider{
  get clientMetadata(){return{...super.clientMetadata,grant_types:['authorization_code']};}
}
test('clients without the refresh_token grant receive no refresh token with or without offline_access',async()=>{
  for(const scope of ['dacs.account.read','openid offline_access dacs.account.read']){
    const provider=await link(scope,CodeOnlyOAuthProvider);
    assert.equal(provider.tokens().refresh_token,undefined);
  }
});

test('revoked refresh tokens fail with invalid_grant',async()=>{
  const provider=await link('openid offline_access dacs.account.read');assert.ok(provider.tokens().refresh_token);
  const revoked=await fetch(metadata.revocation_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({token:provider.tokens().refresh_token,token_type_hint:'refresh_token',client_id:provider.clientInformation().client_id})});
  assert.equal(revoked.status,200);await revoked.text();
  const response=await refresh(provider);assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_grant');
});

test('revoked account grants fail refresh with invalid_grant',async()=>{
  const provider=await link('openid offline_access dacs.account.read');assert.ok(provider.tokens().refresh_token);
  const token=await h.app.authServer.provider.RefreshToken.find(provider.tokens().refresh_token);
  const grant=await h.app.authServer.provider.Grant.find(token.grantId);assert.ok(grant);await grant.destroy();
  const response=await refresh(provider);assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_grant');
});

test('an account with its last wallet unlinked cannot refresh',async()=>{
  const provider=await link('openid offline_access dacs.account.read');assert.ok(provider.tokens().refresh_token);
  const accountId=decodeJwt(provider.tokens().access_token).sub;
  h.app.db.prepare('DELETE FROM wallets WHERE account_id=?').run(accountId);
  assert.ok(h.app.services.accounts.getAccount(accountId));assert.deepEqual(h.app.services.accounts.listWallets(accountId),[]);
  const response=await refresh(provider);assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_grant');
});

test('a removed account cannot refresh',async()=>{
  const provider=await link('openid offline_access dacs.account.read');assert.ok(provider.tokens().refresh_token);
  const accountId=decodeJwt(provider.tokens().access_token).sub;
  h.app.db.prepare('DELETE FROM wallets WHERE account_id=?').run(accountId);h.app.db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
  const response=await refresh(provider);assert.equal(response.status,400);assert.equal((await response.json()).error,'invalid_grant');
});
