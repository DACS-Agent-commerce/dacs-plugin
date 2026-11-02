// Relay and connection-lease regressions for closed buyer access.
// Offline: the Node2 source is an injected stub, the relay listens on loopback.
// New APIs are imported inside each test, so on an older tree every test
// fails for its own reason rather than at file load.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHash } from 'node:crypto';
import { admittedTransport, blockZeroAdmission, zeroBlock, NOW, json } from './helpers/claude-node2-current-coverage-fixture.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import * as buyerAccessModule from '../src/devnet-demo/buyer-access.mjs';
import { relayedCall, createWalletRpcRouter } from '../src/portal/wallet-rpc.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
// RPC auth headers are single-use and fresh against the transport clock (NOW):
// every set gets its own timestamp. signer defaults to the named wallet.
let stamp=NOW;
const authFor=(wallet,timestamp=String(++stamp),signer=wallet)=>{const identity=`ed25519:${wallet.address}`;return{identity,timestamp,signature:signer.signHex(sha(`${identity}:${timestamp}`))};};
const custody=createEphemeralWallet(),seller=createEphemeralWallet(),foreign=createEphemeralWallet();
const closedAccess=(extra={})=>createOperatorBuyerAccess({custodyBuyer:custody.claim,custodySeller:seller.claim,...extra});
const source=async(extra={})=>{let clock=NOW;const run=admittedTransport(await blockZeroAdmission(),{0:zeroBlock(),...extra},{now:()=>clock});return{...run,advance:(ms)=>{clock+=ms;}};};

test('bind and signature need the sender RPC auth headers before any source call',async()=>{
  const run=await source();
  for(const phase of ['bind','signature'])for(const headers of [{},authFor(foreign),{...authFor(custody),identity:`ed25519:${foreign.address}`},authFor(foreign,undefined,custody)]){
    await assert.rejects(run.capability.walletBinding({phase,address:custody.address,binding:{}},headers),{code:'wallet_auth_required'});
  }
  assert.equal(run.stub.calls.length,0,'nothing was read');
  const bound=await run.capability.walletBinding({phase:'bind',address:custody.address},authFor(custody));
  const lease=await run.capability.walletBinding({phase:'signature',address:custody.address,binding:bound.binding},authFor(custody));
  assert.match(lease.leaseId,/^[0-9a-f]{32}$/);
  // Release needs the lease's secret id, not a key: a wrong id releases nothing.
  await run.capability.walletBinding({phase:'release',address:custody.address,leaseId:'0'.repeat(32)});
  await assert.rejects(run.capability.walletBinding({phase:'signature',address:custody.address,binding:bound.binding},authFor(custody)),{code:'wallet_fenced'});
  await run.capability.walletBinding({phase:'release',address:custody.address,leaseId:lease.leaseId});
});

test('an expired connection lease frees the exclusive fence; an unexpired one keeps it',async()=>{
  const run=await source(),{binding}=await run.capability.binding({phase:'bind',address:foreign.address});
  await run.capability.binding({phase:'signature',address:foreign.address,binding});
  await assert.rejects(run.capability.binding({phase:'bind',address:custody.address}),/already fenced/);
  run.advance(29000);
  await assert.rejects(run.capability.binding({phase:'bind',address:custody.address}),/already fenced/,'still held before expiry');
  run.advance(1000);
  assert.equal((await run.capability.binding({phase:'bind',address:custody.address})).binding.network,'demos-devnet','another wallet gets the connection');
  // Second cycle: the same wallet asks for a new lease straight after expiry.
  await run.capability.binding({phase:'signature',address:foreign.address,binding});
  run.advance(30000);
  const again=await run.capability.binding({phase:'signature',address:foreign.address,binding});
  assert.match(again.leaseId,/^[0-9a-f]{32}$/,'the expired lease no longer fences its wallet either');
});

test('a lease is never released at expiry while a confirm runs under it',async()=>{
  let open;const gate=new Promise((resolve)=>{open=resolve;});
  const run=await source({'GET /':async()=>{await gate;return json({result:200,response:{data:{valid:false}},require_reply:false,extra:null});}});
  const {binding}=await run.capability.binding({phase:'bind',address:foreign.address});
  await run.capability.binding({phase:'signature',address:foreign.address,binding});
  const content={type:'native',from:foreign.address,to:custody.address,amount:1,nonce:1,timestamp:1,data:['native',{nativeOperation:'send',args:[custody.address,1]}]};
  const hash=sha(JSON.stringify(content)),tx={content,hash,signature:{type:'ed25519',data:foreign.signHex(hash)}};
  const confirm=run.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:tx}]},authFor(foreign));
  while(!run.stub.calls.some((call)=>call.message==='confirmTx'))await new Promise((resolve)=>setTimeout(resolve,5));
  run.advance(60000);
  await assert.rejects(run.capability.binding({phase:'bind',address:custody.address}),/already fenced/,'the running confirm keeps its connection');
  open();assert.equal((await confirm).response.data.valid,false);
  assert.equal((await run.capability.binding({phase:'bind',address:custody.address})).binding.network,'demos-devnet','released once the confirm settled');
});

test('public relays never act for the custody seller, in either access mode',()=>{
  for(const access of [closedAccess(),createOperatorBuyerAccess({openBuyerAccess:true,custodySeller:seller.claim})]){
    assert.throws(()=>access.assertRelayWallet(seller.address),{code:'seller_wallet_in_process'});
    assert.doesNotThrow(()=>access.assertRelayWallet(custody.address));
  }
  assert.throws(()=>closedAccess().assertRelayWallet(foreign.address),{code:'buyer_access_closed'});
  assert.throws(()=>buyerAccessModule.assertBootstrapRelay(closedAccess(),true,{phase:'bind',address:seller.address}),{code:'seller_wallet_in_process'});
  assert.throws(()=>buyerAccessModule.assertBootstrapRelay(closedAccess(),false,{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:seller.address}}]}),{code:'seller_wallet_in_process'});
});

// The transport dispatches on method, then message or extra (relayedCall's order).
const mismatched={method:'execute',params:[{message:'getAddressNonce',extra:'confirmTx',data:{address:custody.address,content:{from:foreign.address}}}]};
test('the relay wallet follows relayedCall dispatch, including a mismatched method/message body',()=>{
  const {nativeRelayWallet}=buyerAccessModule;
  assert.equal(relayedCall(mismatched),'execute:confirmTx');assert.equal(nativeRelayWallet(mismatched),foreign.address);
  const nodeCall={method:'nodeCall',params:[{message:'getAddressNonce',extra:'confirmTx',data:{address:custody.address,content:{from:foreign.address}}}]};
  assert.equal(relayedCall(nodeCall),'nodeCall:getAddressNonce');assert.equal(nativeRelayWallet(nodeCall),custody.address);
  assert.equal(nativeRelayWallet({method:'nodeCall',params:[{message:'getNetworkInfo',data:{}}]}),null);
  for(const body of [{method:'execute',params:{length:1,0:mismatched.params[0]}},{method:'nodeCall',params:[{message:'getTxByHash',data:{}}]},{method:'execute',params:[{extra:'confirmTx',data:'x'}]},null])
    assert.throws(()=>nativeRelayWallet(body),{code:'native_only'},JSON.stringify(body));
  assert.throws(()=>buyerAccessModule.assertBootstrapRelay(closedAccess(),false,mismatched),{code:'buyer_access_closed'});
});

test('the native relay refuses a mismatched method/message body for the wallet the transport would act for',async t=>{
  const run=await source(),app=express();
  app.use(createWalletRpcRouter({config:{publicOrigin:'http://127.0.0.1:1'},nativeTransport:run.capability,buyerAccess:closedAccess()}));
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const post=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{http:r.status,...await r.json()};};
  for(const body of [mismatched,{method:'nodeCall',params:[{message:'getAddressNonce',data:{}}]}]){
    const refused=await post('/portal/api/devnet-native-wallet-rpc',body);
    assert.equal(refused.http,409,JSON.stringify(refused));assert.equal(refused.error,'buyer_access_closed');
  }
  for(const phase of ['bind','signature']){
    const unsigned=await post('/portal/api/devnet-native-wallet-binding',{phase,address:custody.address,binding:{}});
    assert.equal(unsigned.error,'wallet_auth_required',JSON.stringify(unsigned));
  }
  assert.equal(run.stub.calls.length,0,'no source call');
});

test('the in-process seller relay answers only inside a seller wallet request and only for the seller',async t=>{
  const {createInProcessSellerRelay}=await import('../src/devnet-demo/seller-relay.mjs');
  const network=[],server=http.createServer((req,res)=>{network.push(req.url);res.writeHead(200,{'content-type':'application/json'});res.end('{"network":true}');});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const origin=`http://127.0.0.1:${server.address().port}`,calls=[];
  const sourceCapability={walletBinding:async(body,headers)=>{calls.push(['binding',body.phase,headers.identity??null]);return{ok:body.phase};},rpc:async(body)=>{calls.push(['rpc',body.method]);return{result:200,response:7};}};
  const relay=createInProcessSellerRelay({sourceCapability,address:seller.address,publicOrigin:origin});
  const post=(path,body,headers={})=>fetch(`${origin}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}).then(async(r)=>({http:r.status,...await r.json()}));
  assert.deepEqual(await post('/portal/api/devnet-native-wallet-binding',{phase:'bind',address:seller.address}),{http:200,network:true},'outside a seller request the network fetch is unchanged');
  await relay.run(async()=>{
    assert.deepEqual(await post('/portal/api/devnet-native-wallet-binding',{phase:'bind',address:seller.address},authFor(seller)),{http:200,ok:'bind'});
    assert.equal((await post('/portal/api/devnet-native-wallet-binding',{phase:'bind',address:foreign.address})).error,'seller_relay_wallet');
    assert.deepEqual(await post('/portal/api/devnet-native-wallet-rpc',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:seller.address}}]}),{http:200,result:200,response:7});
    assert.equal((await post('/portal/api/devnet-native-wallet-rpc',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:foreign.address}}]})).http,500);
    assert.deepEqual(await post('/other',{}),{http:200,network:true},'other URLs still use the network');
  });
  assert.deepEqual(await post('/portal/api/devnet-native-wallet-binding',{phase:'bind',address:seller.address}),{http:200,network:true},'after a seller request, other callers still use the network');
  // Something replaces the global fetch later: the seller still never reaches the network.
  const replaced=globalThis.fetch,seen=[];globalThis.fetch=(input,init)=>{seen.push(String(input?.url??input));return replaced(input,init);};
  t.after(()=>{globalThis.fetch=replaced;});
  await relay.run(async()=>assert.deepEqual(await post('/portal/api/devnet-native-wallet-binding',{phase:'release',address:seller.address,leaseId:'x'}),{http:200,ok:'release'}));
  assert.deepEqual(seen,[],'the replacement saw no seller relay request');
  assert.deepEqual(calls,[['binding','bind',`ed25519:${seller.address}`],['rpc','nodeCall'],['binding','release',null]]);
  assert.deepEqual(network,['/portal/api/devnet-native-wallet-binding','/other','/portal/api/devnet-native-wallet-binding']);
});
