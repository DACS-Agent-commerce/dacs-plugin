// Independently observable source-capability decisions, offline.
// Every fetch goes to an injected .invalid stub; no sockets or live writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as transport from '../src/wallet/devnet-native-transport.mjs';
import { CHAIN, ENDPOINT, NETWORK, PIN, TRANSPORT, WALLET, admittedTransport, json, layoutAdmission, layoutChain, memoryJournal, mutableOwner } from './helpers/claude-node2-current-coverage-fixture.mjs';
import { PAYER, PAYEE, inclusionAnswers, intentKey, issuedRow, laneKey, node2Projection, sdkHeaders, signTransaction, signedContent } from './helpers/claude-native-readback-current-fixture.mjs';
import { nativePayloadDigest } from '../public/portal/embedded-wallet/sdk-provider.mjs';

const settlement=()=>({policy:'dacs-native-settlement-publication/v1',artifactKind:'SettlementEvidence',phase:'pay-dem',phaseIndex:2,railId:'demos-native:DEM',authority:'TEST-sweep'});
const delivery=()=>({policy:'dacs-native-delivery-publication/v1',artifactKind:'Deliverable',phase:'deliver-storage-program',phaseIndex:3,authority:'TEST-sweep'});
const demo=()=>({policy:'dacs-devnet-demo-artifacts/v1',artifactKinds:['CompositeVerificationRecord','Deliverable','FinalityCommitmentRecord','Listing'],authority:'TEST-RUN-sweep-coverage'});
const options=()=>({expected:{network:NETWORK,chainIdentity:CHAIN,endpoint:ENDPOINT,pinVersion:PIN,transportAuthority:TRANSPORT},transportOwner:mutableOwner(),journal:memoryJournal(),
  fetchImpl:async()=>{throw new Error('constructor tests must not fetch');}});
const constructors=[transport.createDevnetNativeTransport,transport.createDevnetAgreementTransport,transport.createDevnetSettlementTransport,transport.createDevnetDeliveryTransport,transport.createDevnetDemoTransport];
const guards=[transport.isDevnetNativeTransport,transport.isDevnetAgreementTransport,transport.isDevnetSettlementTransport,transport.isDevnetDeliveryTransport,transport.isDevnetDemoTransport];
const profileOptions=(index)=>({...options(),...(index>=2?{settlementPublication:settlement()}:{}),...(index>=3?{deliveryPublication:delivery()}:{}),...(index>=4?{demoArtifactPublication:demo()}:{})});

test('every constructor grants exactly its declared opaque capability',async()=>{
  for(const fake of [null,undefined,false,{}, {approved:true}, {profile:'devnet-agreement'}])for(const guard of guards)assert.equal(guard(fake),false);
  for(const [index,construct] of constructors.entries()){
    const c=construct(profileOptions(index));
    try{
      assert.deepEqual(guards.map(guard=>guard(c)),[index===0,index>=1,index>=2,index>=3,index>=4]);
      assert.deepEqual(c.profile('https://portal.invalid').capabilities,{native:true,identity:false,publication:false,agreementCreate:index>=1,settlementEvidenceCreate:index>=2,deliverableCreate:index>=3,demoArtifactCreate:index>=4});
      assert.equal(typeof c.recoverStorageWrite,index>=2?'function':'undefined');
      assert.equal(typeof c.nativeTransferCancelled,index>=1?'function':'undefined');
      assert.deepEqual(c.settlementPublication,index>=2?settlement():undefined);
      assert.deepEqual(c.deliveryPublication,index>=3?delivery():undefined);
      assert.deepEqual(c.demoArtifactPublication,index>=4?demo():undefined);
      const profile=c.profile('https://portal.invalid');
      assert.equal(profile.rpcUrl,'https://portal.invalid/portal/api/devnet-native-wallet-rpc');
      assert.equal(profile.bindingUrl,'https://portal.invalid/portal/api/devnet-native-wallet-binding');
      assert.equal(profile.network,NETWORK);assert.equal(profile.authority,TRANSPORT);
      assert.equal(profile.evidenceMode,'explicit-pinned-transport-single-node');
    }finally{await c.close();}
  }
});

for(const [name,patch,pattern] of [
  ['missing owner',{transportOwner:null},/transport-owner/],
  ['missing context reader',{transportOwner:{acquireConnectionFence(){}}},/transport-owner/],
  ['missing connection fence',{transportOwner:{getContext(){}}},/transport-owner/],
  ['missing journal',{journal:null},/journal/],
  ...['get','put','entries','withWalletLock'].map(key=>[`missing journal ${key}`,{journal:{...memoryJournal(),[key]:null}},/journal/]),
  ...[999,60001,1000.5,NaN,'1000'].map(leaseMs=>[`invalid lease ${leaseMs}`,{leaseMs},/lease/]),
  ...[-1,300001,0.5,'0'].map(inclusionWaitMs=>[`invalid inclusion wait ${inclusionWaitMs}`,{inclusionWaitMs},/inclusion wait/]),
  ...[0,0.5,'1'].map(inclusionPollMs=>[`invalid inclusion poll ${inclusionPollMs}`,{inclusionPollMs},/inclusion wait/]),
  ['invalid sleeper',{sleep:null},/inclusion wait/],
  ['unknown block-zero policy',{blockZeroErrorEnvelope:'TEST'},/block-zero/],
  ['block-zero policy without fallback',{blockZeroErrorEnvelope:'node2-result-400-error-require-reply-false-block-number-not-provided/v1'},/fallback/],
  ['unknown layout policy',{blockOneLayout:'TEST'},/block-one/],
  ['layout without fallback',{blockOneLayout:'node2-number-id-plus-one-empty-extra/v1'},/fallback/],
  ['noncanonical reviewed hash',{reviewedBlockTwoHash:'E'.repeat(64)},/canonical/],
  ['reviewed hash without layout',{reviewedBlockTwoHash:'e'.repeat(64)},/layout/],
])test(`constructor refuses ${name}`,()=>{
  assert.throws(()=>transport.createDevnetNativeTransport({...options(),...patch}),pattern);
});

test('lease and inclusion boundaries are accepted',async()=>{
  for(const leaseMs of [1000,60000])for(const inclusionWaitMs of [0,300000]){
    const c=transport.createDevnetNativeTransport({...options(),leaseMs,inclusionWaitMs,inclusionPollMs:1});await c.close();
  }
});

test('demo authority boundaries and the optional settlement artifact set are accepted exactly',async()=>{
  for(const size of [8,80])for(const extra of [[],['SettlementEvidence']]){
    const declaration={...demo(),authority:`TEST-RUN-${'a'.repeat(size)}`,artifactKinds:[...demo().artifactKinds,...extra]};
    const c=transport.createDevnetDemoTransport({...profileOptions(4),demoArtifactPublication:declaration});
    assert.deepEqual(c.demoArtifactPublication,declaration);await c.close();
  }
  for(const size of [7,81])assert.throws(()=>transport.createDevnetDemoTransport({...profileOptions(4),demoArtifactPublication:{...demo(),authority:`TEST-RUN-${'a'.repeat(size)}`}}),/run-scoped/);
  const c=transport.createDevnetDeliveryTransport({...profileOptions(3),deliveryPublication:{...delivery(),phaseIndex:0}});await c.close();
});

for(const [index,field,valid] of [[2,'settlementPublication',settlement],[3,'deliveryPublication',delivery],[4,'demoArtifactPublication',demo]]){
  const vectors=[['missing',()=>null],['extra key',()=>({...valid(),extra:1})],
    ...Object.keys(valid()).map(key=>[`missing ${key}`,()=>{const v=valid();delete v[key];return v;}]),
    ...Object.keys(valid()).map(key=>[`wrong ${key}`,()=>({...valid(),[key]:key==='phaseIndex'?-1:'TEST'})])];
  for(const [name,value] of vectors)test(`${field} rejects ${name}`,()=>{
    assert.throws(()=>constructors[index]({...profileOptions(index),[field]:value()}),/explicit|run-scoped/);
  });
  test(`narrower constructor cannot accept ${field}`,()=>{
    assert.throws(()=>constructors[index-1]({...profileOptions(index-1),[field]:valid()}),/separate/);
  });
}

for(const [refusal,codes] of [[transport.rpcAuthRefusal,['wallet_auth_stale','wallet_auth_replayed','wallet_auth_busy']],
  [transport.transferRefusal,['payment_cancelled','transfer_mismatch','transfer_unreadable']]])test(`${refusal.name} returns the exact nonretryable relay envelope`,()=>{
  for(const code of codes){
    const [status,body]=refusal({code,message:'TEST untrusted error text'});
    assert.equal(status,409);assert.equal(body.result,409);assert.equal(body.error,code);
    assert.equal(typeof body.message,'string');assert.ok(body.message.length>20);
    assert.equal(body.response,body.message);assert.equal(body.require_reply,false);assert.equal(body.extra,null);
    assert.doesNotMatch(body.message,/TEST untrusted/);
  }
  for(const error of [null,undefined,{}, {code:'TEST'}, {code:'toString'}, {code:'constructor'}])assert.equal(refusal(error),null);
});

test('reserving an existing identity at full reserved capacity is idempotent',async t=>{
  const run=admittedTransport(await layoutAdmission(),layoutChain());t.after(()=>run.capability.close());
  const wallets=[WALLET,...['a','b','c'].map(x=>`0x${x.repeat(64)}`)];
  for(const wallet of wallets)assert.equal(run.capability.reserveRpcAuth(wallet),undefined);
  for(const wallet of wallets)assert.equal(run.capability.reserveRpcAuth(wallet),undefined,'existing reservation does not consume another slot');
  assert.throws(()=>run.capability.reserveRpcAuth(`0x${'d'.repeat(64)}`),/only for the operator/);
  assert.throws(()=>run.capability.reserveRpcAuth('TEST'),/wallet address/);
  assert.deepEqual(run.stub.calls,[]);assert.deepEqual(run.journal.puts,[]);
});

test('wallet binding rejects server-only proofs and closed transports reject new work',async()=>{
  const run=admittedTransport(await layoutAdmission(),layoutChain()),c=run.capability;
  try{
    for(const key of ['failedNonceFence','consumedByHash'])await assert.rejects(c.walletBinding({phase:'readback',address:WALLET,[key]:0},{}),e=>e.code==='invalid_params');
    await assert.rejects(c.binding({phase:'bind',address:'TEST'}),e=>e.code==='invalid_params');
    await assert.rejects(c.binding({phase:'TEST',address:WALLET}),e=>e.code==='invalid_params');
    assert.equal(await c.isWalletIdle(WALLET),true);
  }finally{await c.close();}
  await assert.rejects(c.binding({phase:'bind',address:WALLET}),e=>e.code==='transport_closed');
  assert.deepEqual(run.stub.calls,[]);assert.deepEqual(run.journal.puts,[]);
});

test('refusal lookup distinguishes cancellation terms from the exact refused payload',async t=>{
  const run=admittedTransport(await layoutAdmission(),layoutChain());t.after(()=>run.capability.close());
  const c=run.capability,payload={content:signedContent()},content=payload.content;
  const terms={nonce:content.nonce,to:PAYEE,amountOs:content.amount,payloadDigest:await nativePayloadDigest(content)};
  const key=kind=>`devnet/${kind}/${JSON.stringify([NETWORK,CHAIN,PAYER])}`;
  assert.equal(await c.nativeTransferRefused(PAYER,payload),null);
  run.journal.seed(key('cancelled-payments'),{transfers:[{...terms,operationId:'TEST',cancelledAt:new Date(0).toISOString()}]});
  assert.deepEqual(await c.nativeTransferRefused(PAYER,payload),{cancelled:true,refusal:null});
  run.journal.seed(key('refused-transfers'),{refusals:[{...terms,gate:'confirmTx',refusedAt:new Date(0).toISOString()}]});
  assert.deepEqual(await c.nativeTransferRefused(PAYER,payload),{cancelled:true,refusal:{gate:'confirmTx',refusedAt:new Date(0).toISOString()}});
  run.journal.seed(key('cancelled-payments'),{transfers:[]});
  assert.deepEqual(await c.nativeTransferRefused(PAYER,payload),{cancelled:false,refusal:{gate:'confirmTx',refusedAt:new Date(0).toISOString()}});
  const changed=structuredClone(payload);changed.content.timestamp++;
  assert.equal(await c.nativeTransferRefused(PAYER,changed),null,'a refusal names exact prepared bytes');
  for(const [wallet,bad] of [[PAYER,null],['TEST',payload],[WALLET,payload]])await assert.rejects(c.nativeTransferRefused(wallet,bad),e=>e.code==='invalid_params');
  assert.deepEqual(run.stub.calls,[]);assert.deepEqual(run.journal.puts,[]);
});

for(const [name,key,change,expected] of [
  ['observed intent',r=>intentKey(r.hash),()=>{},'included'],
  ['observed wallet lane',()=>laneKey(PAYER),()=>{},'included'],
  ['different observed settlement terms',r=>intentKey(r.hash),r=>{r.signedTransaction.content.to=WALLET;r.signedTransaction.content.data[1].args[0]=WALLET;},'different'],
  ['failed intent',r=>intentKey(r.hash),r=>{r.stage='failed';},null],
  ['unrelated key',()=>'TEST',()=>{},null],
  ['another wallet lane',()=>laneKey(WALLET),()=>{},null],
  ['another payer',r=>intentKey(r.hash),r=>{r.signedTransaction.content.from=WALLET;},null],
  ['another nonce',r=>intentKey(r.hash),r=>{r.nonce++;},null],
  ['malformed hash',r=>intentKey(r.hash),r=>{r.hash='TEST';},null],
  ['another network',r=>intentKey(r.hash),r=>{r.networkBinding.network='foreign';},null],
  ['another chain',r=>intentKey(r.hash),r=>{r.networkBinding.chainIdentity='e'.repeat(64);},null],
  ['missing binding',r=>intentKey(r.hash),r=>{delete r.networkBinding;},null],
  ['pending readback',r=>intentKey(r.hash),r=>{r.stage='broadcast-started';},'pending'],
])test(`nonce consumer handles ${name} without resending`,async t=>{
  const run=admittedTransport(await layoutAdmission(),{...layoutChain(),getTransactionStatus:{result:200,response:{state:'unknown'}}});t.after(()=>run.capability.close());
  const signed=signTransaction(signedContent()),binding={network:NETWORK,chainIdentity:CHAIN},row=issuedRow(signed,binding,'observed');
  change(row);run.journal.seed(key(row),row);const before=await run.journal.entries();
  const result=await run.capability.nativeNonceConsumer(PAYER,{content:signedContent()});
  assert.deepEqual(result,expected==='included'||expected==='different'?{hash:signed.hash,sameTerms:expected==='included'}:expected);
  assert.deepEqual(await run.journal.entries(),before);assert.deepEqual(run.journal.puts,[]);
  assert.ok(run.stub.calls.every(c=>!['confirmTx','broadcastTx'].includes(c.message)));
});

test('nonce consumer prefers the intent over its duplicate lane and finds included work after a pending candidate',async t=>{
  const run=admittedTransport(await layoutAdmission(),layoutChain());t.after(()=>run.capability.close());
  const signed=signTransaction(signedContent()),row=issuedRow(signed,{network:NETWORK,chainIdentity:CHAIN},'observed');
  run.journal.seed(intentKey('e'.repeat(64)),{...row,hash:'e'.repeat(64),stage:'broadcast-started'});
  run.journal.seed(intentKey(signed.hash),row);
  const duplicate=structuredClone(row);duplicate.signedTransaction.content.to=WALLET;duplicate.signedTransaction.content.data[1].args[0]=WALLET;
  run.journal.seed(laneKey(PAYER),duplicate);
  assert.deepEqual(await run.capability.nativeNonceConsumer(PAYER,{content:signedContent()}),{hash:signed.hash,sameTerms:true});
  assert.deepEqual(run.journal.puts,[]);assert.ok(run.stub.calls.every(c=>!['confirmTx','broadcastTx'].includes(c.message)));
  for(const [wallet,payload] of [[PAYER,null],['TEST',{content:signedContent()}],[WALLET,{content:signedContent()}]])await assert.rejects(run.capability.nativeNonceConsumer(wallet,payload),e=>e.code==='invalid_params');
});

async function leasedNative(t,{confirmation=a=>a,broadcast=tx=>({result:200,response:{hash:tx.hash}})}={}){
  const signed=signTransaction(signedContent()),run=admittedTransport(await layoutAdmission(),{
    ...layoutChain(),...inclusionAnswers(signed.hash,node2Projection(signed.content,signed.hash)),getAddressNonce:{result:200,response:6},
    'GET /':entry=>json(entry.message==='confirmTx'?confirmation({result:200,response:{data:{valid:true,transaction:signed}}}):broadcast(signed)),
  });
  t.after(()=>run.capability.close());
  const c=run.capability,{binding}=await c.binding({phase:'bind',address:PAYER});
  const lease=await c.binding({phase:'signature',address:PAYER,binding});
  const confirm=()=>c.rpc({method:'execute',params:[{extra:'confirmTx',data:signed}]},sdkHeaders());
  const prepare=()=>c.binding({phase:'broadcast',address:PAYER,leaseId:lease.leaseId,hash:signed.hash});
  return {run,c,signed,lease,confirm,prepare,broadcast:answer=>c.rpc({method:'execute',params:[{extra:'broadcastTx',data:answer}]},sdkHeaders())};
}

for(const result of [200,400,500])test(`native dispatch result ${result} is retained once and never authorizes a resend`,async t=>{
  const w=await leasedNative(t,{broadcast:tx=>({result,response:{hash:tx.hash}})});
  const notices=[];w.c.onPurchaseStep(()=>{throw new Error('TEST ignored listener');});
  const off=w.c.onPurchaseStep(e=>notices.push(e));
  const confirmation=await w.confirm();await w.prepare();
  const answer=await w.broadcast(confirmation);assert.equal(answer.result,result);
  assert.equal(w.run.stub.calls.filter(c=>c.message==='broadcastTx').length,1);
  const row=await w.run.journal.get(intentKey(w.signed.hash));
  assert.equal(row.stage,result===200?'broadcast-accepted':'broadcast-answered');assert.deepEqual(row.signedTransaction,w.signed);
  assert.deepEqual(await w.run.journal.get(laneKey(PAYER)),row);
  assert.ok(notices.some(e=>e.step==='sign'&&e.phase==='complete'&&e.jobId===null&&e.artifactKind==='native-transfer'));
  off();assert.throws(()=>w.c.onPurchaseStep(null),/listener/);
  await assert.rejects(w.c.binding({phase:'signature',address:PAYER,binding:row.networkBinding}),e=>e.code==='outcome_unknown');
  if(result===200){assert.equal(answer.writeProof.disposition,'included');assert.equal(answer.writeProof.receipt.hash,w.signed.hash);}
});

test('a lost native dispatch reply keeps the exact issued intent readback-only',async t=>{
  const w=await leasedNative(t,{broadcast:()=>{throw new Error('TEST lost reply');}}),confirmation=await w.confirm();await w.prepare();
  await assert.rejects(w.broadcast(confirmation));
  const row=await w.run.journal.get(intentKey(w.signed.hash));
  assert.equal(row.stage,'broadcast-started');assert.deepEqual(row.signedTransaction,w.signed);
  assert.deepEqual(await w.run.journal.get(laneKey(PAYER)),row);
  await assert.rejects(w.c.binding({phase:'signature',address:PAYER,binding:row.networkBinding}),e=>e.code==='outcome_unknown');
  assert.equal(w.run.stub.calls.filter(c=>c.message==='broadcastTx').length,1);
});

test('a consumed nonce refuses native dispatch before writing an intent',async t=>{
  const w=await leasedNative(t),confirmation=await w.confirm();await w.prepare();
  w.run.stub.set({getAddressNonce:{result:200,response:7}});
  await assert.rejects(w.broadcast(confirmation),e=>e.code==='nonce_consumed');
  assert.equal(await w.run.journal.get(intentKey(w.signed.hash)),undefined);
  assert.equal(w.run.stub.calls.filter(c=>c.message==='broadcastTx').length,0);
});

test('broadcast requires both exact confirmation and a fresh prebroadcast binding',async t=>{
  const w=await leasedNative(t),confirmation=await w.confirm();
  await assert.rejects(w.broadcast(confirmation),e=>e.code==='native_confirmation_required');
  await assert.rejects(w.c.binding({phase:'broadcast',address:PAYER,leaseId:'TEST',hash:w.signed.hash}),e=>e.code==='native_confirmation_required');
  await w.prepare();const changed=structuredClone(confirmation);changed.response.data.transaction.status='TEST';
  await assert.rejects(w.broadcast(changed),e=>e.code==='native_confirmation_required');
  assert.equal(w.run.stub.calls.filter(c=>c.message==='broadcastTx').length,0);
});

for(const valid of [false,true])test(`confirmation with ${valid?'changed signed bytes':'false validity'} cannot authorize dispatch`,async t=>{
  const w=await leasedNative(t,{confirmation:a=>{a=structuredClone(a);if(valid)a.response.data.transaction.status='TEST';else a.response.data.valid=false;return a;}});
  if(valid)await assert.rejects(w.confirm(),e=>e.code==='signed_bytes_changed');else assert.equal((await w.confirm()).response.data.valid,false);
  await assert.rejects(w.prepare(),e=>e.code==='native_confirmation_required');
  assert.equal(w.run.stub.calls.filter(c=>c.message==='broadcastTx').length,0);
  assert.equal(await w.run.journal.get(intentKey(w.signed.hash)),undefined);
});

for(const [name,change] of [
  ['content changed under retained hash',tx=>{tx.content.timestamp++;}],
  ['invalid signature',tx=>{tx.signature.data='f'.repeat(128);}],
  ['wrong signature type',tx=>{tx.signature.type='TEST';}],
  ['missing signature',tx=>{delete tx.signature;}],
  ['wrong send tag',tx=>{tx.content.data[0]='TEST';}],
  ['wrong send operation',tx=>{tx.content.data[1].nativeOperation='TEST';}],
  ['wrong send target',tx=>{tx.content.data[1].args[0]=WALLET;}],
])test(`native relay rejects ${name} before acquiring a lease or contacting the node`,async t=>{
  const run=admittedTransport(await layoutAdmission(),layoutChain());t.after(()=>run.capability.close());
  let tx=signTransaction(signedContent());change(tx);
  if(name.startsWith('wrong send'))tx=signTransaction(tx.content);
  await assert.rejects(run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:tx}]},sdkHeaders()),e=>e.code==='native_only');
  assert.deepEqual(run.stub.calls,[]);assert.deepEqual(run.journal.puts,[]);
});
