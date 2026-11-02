import assert from 'node:assert/strict';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './flows.mjs';
import { post } from './public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';
import { createSellerTransportClientAuth } from '../../src/dacs/seller-transport-auth.mjs';

export async function runNativeSellerTimeoutFlow(t,h){
  globalThis.location=new URL(h.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${h.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  let client;
  const buyerActor=await createEphemeralPackagedSeller({network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin))});
  t.after(()=>buyerActor.close());
  const wallet=buyerActor.walletFactory({anchorJournal:{get:(key)=>client.anchorJournal.get(key),put:(key,value)=>client.anchorJournal.put(key,value),withWalletLock:(key,work)=>client.anchorJournal.withWalletLock(key,work)}});
  const buyer=await linkPackagedWallet(h,wallet),address=wallet.getPublicAccount().address;
  const sign=async(message)=>{const answer=await wallet.request({method:'sign',params:[message]});assert.equal(answer.success,true);return answer.data.signature;};
  h.authenticationRegistry.set(h.sellerActor.signer.claim,createSellerTransportClientAuth({buyerSigner:{claim:buyerActor.signer.claim,sign:(bytes)=>buyerActor.signer.signBytes(bytes)},seller:h.sellerActor.signer.claim,resolveJob:(jobId)=>h.jobContexts.get(jobId)}));
  const prepared=await tool(h,buyer,'prepare_purchase',{listingId:h.composition.listing.listingId,version:1,seller:h.sellerActor.signer.claim,idempotencyKey:`native-seller-timeout-${Date.now()}`,protocol:'dacs-sr2-wallet-agreement'});
  assert.equal(prepared.status,'agreement_pending',JSON.stringify(prepared));
  const id=prepared.operationId,token=tokenFrom(prepared.approvalUrl),api=(part,body={})=>post(`${h.origin}/portal/api/purchase/${id}/${part}`,{token,...body},h.origin);
  client=createOfflineAgreementBrokerClient({id,token,api:async(path,body)=>{const answer=await post(`${h.origin}${path}`,body,h.origin);if(answer.httpStatus!==200)throw Object.assign(new Error(answer.message),{code:answer.error});return answer;}});
  const account=h.app.services.accounts.walletOwner(address),operation=()=>h.app.services.ops.get(account,id);
  const identity=await api('agreement/identity',{address}),planned=await api('agreement/plan',{signature:await sign(identity.signRequest.message)});assert.equal(planned.httpStatus,200,JSON.stringify(planned));
  h.jobContexts.set(operation().terms.protocol.jobId,{listingPin:planned.signRequest.summary.listing,agreementHash:planned.signRequest.agreementHash});
  await client.authenticate({address,sign});
  const signed=await api('agreement/sign',{agreementSignature:await sign(planned.signRequest.agreementMessage)});assert.equal(signed.httpStatus,200,JSON.stringify(signed));
  const agreementApproval=await client.approveOne(wallet);assert.equal(agreementApproval.state,'completed',JSON.stringify(agreementApproval));
  const committed=await tool(h,buyer,'verify_deal',{operationId:id});assert.equal(committed.protocol?.stage,'seller-committed',JSON.stringify(committed));
  const challenge=await api('challenge',{address}),handoff=await api('approve',{challengeId:challenge.challengeId,signature:await sign(challenge.message)});assert.equal(handoff.status,'payment_handoff',JSON.stringify(handoff));
  client.useNativePaymentLane();const sent=await wallet.request({method:'sendTransaction',params:[handoff.payload]});assert.equal(sent.success,true,JSON.stringify(sent));
  return{buyerActor,buyer,wallet,address,id,api,operation,sent,jobId:operation().terms.protocol.jobId,verify:()=>tool(h,buyer,'verify_deal',{operationId:id})};
}
