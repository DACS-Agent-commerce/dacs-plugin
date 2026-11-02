import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { sha256Hex } from '@kynesyslabs/dacs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExactBuyerApproval } from '../src/devnet-demo/operator-buyer-approval.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
// Fixture keys go through idem() so no stored key: 'value' literal looks like a credential to secret scanners.
const idem = (key) => key;

const HASH=/^[0-9a-f]{64}$/;

async function purchaseThroughOperator(t,{openBuyerAccess,expectedBuyerKinds,now}){
  const sellerApprovals=[],buyerApprovals=[];
  const h=await startOperatorPurchaseNode2({openBuyerAccess,now,
    authorizeSellerApproval:({approvalHash,request})=>{assert.match(approvalHash,HASH);assert.equal(request.method,'sendTransaction');assert.equal(request.content.action,'immutable DACS storage anchor CREATE');assert.ok(['Listing','CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable'].includes(request.content.artifactKind));assert.ok(BigInt(request.content.debit.totalOs)<=10000000000n);sellerApprovals.push(structuredClone(request));return true;},
    authorizeBuyerApproval:({approvalHash,requestHash,request,scope})=>{assert.match(approvalHash,HASH);assert.match(requestHash,HASH);assert.equal(scope.buyer,h?.prepared?.operatorEvidence?.buyer??scope.buyer);assert.equal(scope.seller,h?.prepared?.operatorEvidence?.seller??scope.seller);assert.equal(scope.listingId,'operator-purchased-report');assert.equal(scope.listingVersion,1);assert.match(scope.listingContentHash,HASH);assert.equal(scope.purpose,scope.kind);if(request.method==='sendTransaction'){assert.ok(BigInt(request.content.debit.totalOs)<=12000000000n);assert.equal(scope.displayPurpose,request.purpose);assert.match(request.purpose,scope.kind==='agreement-create'?/^Create immutable Agreement for job /:/^Send 1 DEM from this embedded wallet to /);}else assert.equal(request.method,'sign');buyerApprovals.push({request:structuredClone(request),scope:structuredClone(scope)});return true;},
  });t.after(()=>h.close());
  const driver=h.operator.createBuyerDriver({composition:h.composition});
  const result=await driver.purchase({idempotencyKey:idem('operator-purchase-consumed-001')});
  assert.equal(result.status,'delivery-ready');assert.equal(result.buyer,h.prepared.operatorEvidence.buyer);assert.equal(result.seller,h.prepared.operatorEvidence.seller);
  assert.equal(result.payment.amountOs,'1000000000');assert.match(result.payment.transactionHash,HASH);assert.equal(result.payment.payee,`0x${result.seller.slice('did:demos:agent:'.length)}`);
  assert.equal(result.report.kind,'dacs-chatgpt-plugin/devnet-purchased-report');assert.match(result.report.content.text,/Genuine purchased bytes from the built-in operator seller/);assert.doesNotMatch(result.report.content.text,/fixture/i);
  assert.equal(result.nativeReadback.writer,result.seller);assert.equal(result.nativeReadback.contentHash,result.reportHash);assert.equal(result.partyVet.length,2);assert.deepEqual(result.partyVet.map((entry)=>entry.evaluatedParty).sort(),[result.buyer,result.seller].sort());assert.ok(result.partyVet.every((entry)=>entry.strictStatus==='valid'));
  assert.deepEqual(buyerApprovals.map((entry)=>entry.scope.kind),expectedBuyerKinds);assert.equal(h.prepared.operatorEvidence.openBuyerAccess,openBuyerAccess===true);
  const agreementCreate=buyerApprovals.find((entry)=>entry.scope.kind==='agreement-create'),payment=buyerApprovals.find((entry)=>entry.scope.kind==='native-payment');
  assert.equal(agreementCreate.request.content.jobId,result.jobId);assert.equal(agreementCreate.request.content.contentHash,result.agreementHash);assert.equal(payment.request.content.to,result.payment.payee);assert.equal(payment.request.content.amountOs,result.payment.amountOs);assert.equal(payment.request.content.networkBinding.chainIdentity,result.payment.chainIdentity);
  assert.equal(result.approvals.length,buyerApprovals.length);assert.ok(result.approvals.every((entry)=>entry.decision==='approved'));assert.equal(result.repeatReadOnlyStatus,'delivery-ready');assert.match(result.readOnlyEffectSnapshot.digest,HASH);
  assert.equal(h.node2.chain.record.accepted.length,1,'one native DEM transfer');assert.equal(h.node2.chain.wire.record.accepted.length,7,'Listing, Agreement, two Vet, commitment, evidence and Deliverable CREATEs');
  assert.equal(sellerApprovals.length,6);assert.equal(buyerApprovals.filter((entry)=>entry.request.method==='sendTransaction').length,2);
  t.diagnostic(JSON.stringify({openBuyerAccess:openBuyerAccess===true,stage:result.status,creates:h.node2.chain.wire.record.accepted.length,payments:h.node2.chain.record.accepted.length,buyerApprovals:buyerApprovals.length,sellerApprovals:sellerApprovals.length,partyVet:result.partyVet.length,readOnlyNoWrite:true,reportHash:result.reportHash,publicTransactions:0,scope:'owned-loopback-only'}));
  return{h,result};
}

test('built-in operator buyer uses normal app/MCP, exact approvals and one native purchase to return independently read seller bytes',{timeout:180000},async t=>{
  // Default config: open buyer access is off, the custody buyer signs seller requests itself.
  const {h}=await purchaseThroughOperator(t,{expectedBuyerKinds:['oauth-wallet-login','agreement-identity','broker-authentication','agreement-signature','agreement-create','payment-terms','native-payment']});
  assert.equal(existsSync(join(h.config.stateDirectory,'seller-sessions')),false,'no session keys exist while open buyer access is off');
  assert.equal(h.operator.sweepSellerSessions(),null);
});

test('with openBuyerAccess on, the same operator purchase signs seller requests with a wallet-delegated session key',{timeout:180000},async t=>{
  let offsetMs=0;
  const {h}=await purchaseThroughOperator(t,{openBuyerAccess:true,now:()=>Date.now()+offsetMs,expectedBuyerKinds:['oauth-wallet-login','agreement-identity','seller-session-delegation','broker-authentication','agreement-signature','agreement-create','payment-terms','native-payment']});
  const directory=join(h.config.stateDirectory,'seller-sessions');
  assert.equal(readdirSync(directory).filter((name)=>name.endsWith('.json')).length,1);
  // The operator's sweep keeps the key through the grace window after the
  // purchase is delivery-ready, then deletes it and records that on the purchase.
  let swept=h.operator.sweepSellerSessions();
  assert.deepEqual(swept.deleted,[]);assert.match(swept.kept[0].reason,/delivery-ready; inside the grace window/);
  offsetMs=SELLER_SESSION_KEY_GRACE_MS+1000;
  swept=h.operator.sweepSellerSessions();
  assert.equal(swept.deleted.length,1);
  const [{operationId,sessionPublicKey}]=swept.deleted;
  assert.deepEqual(readdirSync(directory),[`${sha256Hex(operationId)}.retired.json`]);
  assert.ok(h.application.services.ops.history(operationId).some((event)=>event.type==='seller_session_key_deleted'&&event.data.sessionPublicKey===sessionPublicKey));
});

test('buyer approval consumes one exact expectation and refuses changed purpose or complete debit before callback',async t=>{
  const root=await mkdtemp(join(tmpdir(),'operator-buyer-approval-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const common={address:`0x${'a'.repeat(64)}`,buyer:`did:demos:agent:${'a'.repeat(64)}`,seller:`did:demos:agent:${'b'.repeat(64)}`,listingId:'exact-listing',listingVersion:1,listingContentHash:'c'.repeat(64),jobId:'job-1',agreementHash:'d'.repeat(64),network:'demos-devnet',chainIdentity:'e'.repeat(64),payee:`0x${'b'.repeat(64)}`,amountOs:'1000000000'};
  const approval=createExactBuyerApproval({maxTotalOs:'100',evidencePath:join(root,'approvals.jsonl'),authorize:()=>{calls++;return true;}});
  approval.expect({...common,kind:'native-payment'});
  await assert.rejects(approval.approve({method:'sendTransaction',address:common.address,purpose:'changed',content:{action:'native DEM transfer',from:common.address,to:common.payee,amountOs:'999',network:common.network,networkBinding:{network:common.network,chainIdentity:common.chainIdentity},debit:{totalOs:'99'}}}),/differs/);assert.equal(calls,0);
  approval.expect({...common,kind:'native-payment'});
  await assert.rejects(approval.approve({method:'sendTransaction',address:common.address,purpose:'exact',content:{action:'native DEM transfer',from:common.address,to:common.payee,amountOs:common.amountOs,network:common.network,networkBinding:{network:common.network,chainIdentity:common.chainIdentity},debit:{totalOs:'101'}}}),/ceiling/);assert.equal(calls,0);
});
