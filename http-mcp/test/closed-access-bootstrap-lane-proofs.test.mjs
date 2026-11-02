// The operator's bootstrap relay serves the source's walletBinding() before
// listen. Like the application route, it never forwards the server-only lane
// proofs (failedNonceFence, consumedByHash). Owned-loopback Node2 and TEST
// custody only; nothing is signed, confirmed or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

for(const openBuyerAccess of [false,true])test(`bootstrap relay refuses server-only lane proofs: ${openBuyerAccess?'open':'closed'} buyer access`,{timeout:180000},async t=>{
  const rpcRequests=[],h=await startOperatorPurchaseNode2({listen:false,openBuyerAccess,authorizeSellerApproval:()=>true,rpcFault:input=>{rpcRequests.push(input);return null;}});t.after(()=>h.close());
  assert.equal(h.running,null);
  const source=h.prepared.devnetAgreementTransport,buyer=`0x${h.prepared.operatorEvidence.buyer.slice('did:demos:agent:'.length)}`,hash='ab'.repeat(32);
  const relay=async body=>{const response=await fetch(`${h.config.publicOrigin}/portal/api/devnet-native-wallet-binding`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{http:response.status,body:await response.json()};};
  const before=await source.journal.entries(),reads=rpcRequests.length;
  for(const address of openBuyerAccess?[buyer,createEphemeralWallet().address]:[buyer]){
    for(const proof of [{failedNonceFence:6},{consumedByHash:'cd'.repeat(32)},{failedNonceFence:null}]){
      const refused=await relay({phase:'readback',address,hash,...proof});
      assert.equal(refused.body.error,'invalid_params',JSON.stringify(refused));assert.equal(refused.http,422);
    }
  }
  assert.equal(rpcRequests.length,reads,'nothing reached the node');
  assert.deepEqual(await source.journal.entries(),before,'the transport journal is unchanged');
  // The same body without the proofs still reaches the source transport.
  const plain=await relay({phase:'readback',address:buyer,hash});
  assert.equal(plain.body.error,'not_issued',JSON.stringify(plain));
});
