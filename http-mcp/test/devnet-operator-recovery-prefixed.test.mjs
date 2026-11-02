import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createOperatorRecoveryNode2 } from './helpers/devnet-operator-recovery-node2.mjs';

const HASH=/^[0-9a-f]{64}$/;
const CLAIM=/^did:demos:agent:[0-9a-f]{64}$/;

function exactApprovals({declinePayment=false,declineFirstPayments=0}={}){
  const seller=[],buyer=[];let declinesLeft=declineFirstPayments;
  return{
    seller,buyer,
    authorizeSellerApproval:({approvalHash,request})=>{
      assert.match(approvalHash,HASH);assert.equal(request.method,'sendTransaction');assert.equal(request.content.action,'immutable DACS storage anchor CREATE');
      assert.ok(['Listing','CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable'].includes(request.content.artifactKind));assert.ok(BigInt(request.content.debit.totalOs)<=10000000000n);
      seller.push(structuredClone(request));return request.address===request.content.wallet&&request.content.network==='demos-devnet';
    },
    authorizeBuyerApproval:({approvalHash,requestHash,request,scope})=>{
      assert.match(approvalHash,HASH);assert.match(requestHash,HASH);assert.match(scope.buyer,CLAIM);assert.match(scope.seller,CLAIM);assert.equal(scope.listingId,'operator-recovery-report');assert.equal(scope.listingVersion,1);assert.match(scope.listingContentHash,HASH);assert.equal(scope.purpose,scope.kind);
      if(scope.kind!=='oauth-wallet-login'){assert.ok(scope.jobId);if(['broker-authentication','agreement-signature','payment-terms','agreement-create','native-payment'].includes(scope.kind))assert.match(scope.agreementHash,HASH);}
      if(request.method==='sendTransaction'){
        assert.ok(BigInt(request.content.debit.totalOs)<=12000000000n);assert.equal(scope.displayPurpose,request.purpose);assert.equal(request.content.network,'demos-devnet');assert.match(request.content.networkBinding.chainIdentity,HASH);
        if(scope.kind==='native-payment'){assert.equal(request.content.action,'native DEM transfer');assert.equal(scope.amountOs,'1000000000');assert.equal(request.content.amountOs,scope.amountOs);assert.equal(request.content.to,scope.payee);}
        else{assert.equal(scope.kind,'agreement-create');assert.equal(request.content.artifactKind,'Agreement');assert.equal(request.content.jobId,scope.jobId);assert.equal(request.content.contentHash,scope.agreementHash);}
      }else{assert.equal(request.method,'sign');assert.ok(request.message);}
      const decline=scope.kind==='native-payment'&&(declinePayment||(declinesLeft>0&&declinesLeft-->0));
      buyer.push({request:structuredClone(request),scope:structuredClone(scope),decision:decline?'rejected':'approved'});
      return !decline;
    },
  };
}

const effects=(h)=>({creates:h.node2.chain.wire.record.accepted.length,payments:h.node2.chain.record.accepted.length});
const txApprovals=(evidence)=>evidence.filter((entry)=>entry.request.method==='sendTransaction').length;

test('completed buyer run survives full app, seller and operator restart and resumes by authentic current readback without another effect',{timeout:180000},async t=>{
  const approvals=exactApprovals(),h=await createOperatorRecoveryNode2(approvals);t.after(()=>h.close());
  const first=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-complete-001'});
  assert.equal(first.status,'delivery-ready');const before=effects(h),beforeTx=txApprovals(approvals.buyer),beforeSeller=approvals.seller.length;
  await h.restart();const resumed=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'operator-recovery-complete-001'});
  assert.equal(resumed.status,'delivery-ready');assert.equal(resumed.operationId,first.operationId);assert.equal(resumed.jobId,first.jobId);assert.equal(resumed.agreementHash,first.agreementHash);assert.equal(resumed.payment.transactionHash,first.payment.transactionHash);assert.equal(resumed.reportHash,first.reportHash);assert.deepEqual(resumed.report,first.report);assert.deepEqual(effects(h),before);assert.equal(txApprovals(approvals.buyer),beforeTx);assert.equal(approvals.seller.length,beforeSeller);
  const runDirectory=join(h.root,'state','buyer-runs'),files=await readdir(runDirectory),receiptName=files.find((name)=>name.endsWith('.receipt.json')),privateName=files.find((name)=>name.endsWith('.private.json'));
  assert.ok(receiptName);assert.ok(privateName);assert.equal((await lstat(join(runDirectory,receiptName))).mode&0o777,0o600);assert.equal((await lstat(join(runDirectory,privateName))).mode&0o777,0o600);
  const publicBytes=await readFile(join(runDirectory,receiptName),'utf8');assert.doesNotMatch(publicBytes,/token|cookie|oauth|mnemonic|seed|private/i);assert.equal(JSON.parse(publicBytes).reportHash,first.reportHash);
  t.diagnostic(JSON.stringify({case:'completed-restart',operationId:first.operationId,jobId:first.jobId,reportHash:first.reportHash,before,after:effects(h),additionalTransactionApprovals:txApprovals(approvals.buyer)-beforeTx,publicReceiptSecretTerms:0,publicTransactions:0}));
});

test('applied report response loss retains the original payment hash and restart reconciliation never resends',{timeout:180000},async t=>{
  const approvals=exactApprovals(),h=await createOperatorRecoveryNode2(approvals);t.after(()=>h.close());h.loseNextAppliedReportResponse();
  await assert.rejects(h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-lost-response-001'}),/payment response lost after durable hash [0-9a-f]{64}.*without resending/);
  assert.equal(h.droppedReports,1);const before=effects(h),beforeTx=txApprovals(approvals.buyer),beforeSeller=approvals.seller.length;assert.equal(before.payments,1);assert.equal(before.creates,7);
  await h.restart();const resumed=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'operator-recovery-lost-response-001'});
  assert.equal(resumed.status,'delivery-ready');assert.match(resumed.payment.transactionHash,HASH);assert.equal(resumed.nativeReadback.contentHash,resumed.reportHash);assert.deepEqual(effects(h),before);assert.equal(txApprovals(approvals.buyer),beforeTx);assert.equal(approvals.seller.length,beforeSeller);
  t.diagnostic(JSON.stringify({case:'lost-applied-response',droppedResponses:h.droppedReports,retainedHash:resumed.payment.transactionHash,reportHash:resumed.reportHash,before,after:effects(h),additionalTransactionApprovals:txApprovals(approvals.buyer)-beforeTx,noResend:true,publicTransactions:0}));
});

test('normal exact native payment decline is retained and resume performs no payment or source effect',{timeout:180000},async t=>{
  const approvals=exactApprovals({declinePayment:true}),h=await createOperatorRecoveryNode2(approvals);t.after(()=>h.close());
  const declined=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-decline-001'});
  assert.equal(declined.status,'declined');assert.equal(declined.noResend,true);assert.match(declined.reason,/rejected/);assert.equal(effects(h).payments,0);assert.equal(effects(h).creates,5);assert.equal(approvals.buyer.filter((entry)=>entry.scope.kind==='native-payment').length,1);assert.equal(approvals.buyer.at(-1).decision,'rejected');
  const before=effects(h),beforeApprovals=approvals.buyer.length;await h.restart();const resumed=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'operator-recovery-decline-001'});
  assert.equal(resumed.status,'declined');assert.deepEqual(effects(h),before);assert.equal(approvals.buyer.length,beforeApprovals);
  t.diagnostic(JSON.stringify({case:'normal-decline',decision:'rejected',before,after:effects(h),paymentEffects:0,additionalApprovals:approvals.buyer.length-beforeApprovals,noResend:true,publicTransactions:0}));
});

test('a declined native payment is cancelled only from proof that nothing was sent, so the same wallet completes a distinct next purchase',{timeout:240000},async t=>{
  const approvals=exactApprovals({declineFirstPayments:1}),h=await createOperatorRecoveryNode2(approvals);t.after(()=>h.close());
  const declined=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-decline-then-next-a'});
  assert.equal(declined.status,'declined');assert.deepEqual(declined.serverCancellation,{cancelled:true,status:'cancelled'});assert.equal(effects(h).payments,0);
  const next=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-decline-then-next-b'});
  assert.equal(next.status,'delivery-ready');assert.notEqual(next.operationId,declined.operationId);assert.notEqual(next.jobId,declined.jobId);assert.equal(effects(h).payments,1);
  const afterNext=effects(h),beforeResume=approvals.buyer.length;await h.restart();
  const resumed=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'operator-recovery-decline-then-next-a'});
  assert.equal(resumed.status,'declined');assert.deepEqual(resumed.serverCancellation,{cancelled:true,status:'cancelled'});assert.equal(approvals.buyer.length,beforeResume);assert.deepEqual(effects(h),afterNext);
});

test('a deliberately distinct idempotency key completes from authenticated seller readback with its own approvals',{timeout:180000},async t=>{
  const approvals=exactApprovals(),h=await createOperatorRecoveryNode2(approvals);t.after(()=>h.close());
  const first=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-distinct-a'}),afterFirst=effects(h),afterFirstTx=txApprovals(approvals.buyer),afterFirstBuyer=approvals.buyer.length,afterFirstSeller=approvals.seller.length;
  const second=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'operator-recovery-distinct-b'});
  assert.equal(first.status,'delivery-ready');assert.equal(second.status,'delivery-ready');assert.notEqual(second.operationId,first.operationId);assert.notEqual(second.jobId,first.jobId);assert.notEqual(second.agreementHash,first.agreementHash);assert.notEqual(second.payment.transactionHash,first.payment.transactionHash);assert.notEqual(second.reportHash,first.reportHash);assert.deepEqual(afterFirst,{creates:7,payments:1});assert.deepEqual(effects(h),{creates:13,payments:2});assert.equal(txApprovals(approvals.buyer)-afterFirstTx,2);assert.equal(approvals.buyer.length-afterFirstBuyer,7);assert.equal(approvals.seller.length-afterFirstSeller,5);
  t.diagnostic(JSON.stringify({case:'distinct-next-job',outcome:'independent-delivery-ready',first:{operationId:first.operationId,jobId:first.jobId,agreementHash:first.agreementHash,reportHash:first.reportHash},second:{operationId:second.operationId,jobId:second.jobId,agreementHash:second.agreementHash,reportHash:second.reportHash},afterFirst,afterSecond:effects(h),newBuyerApprovals:approvals.buyer.length-afterFirstBuyer,newSellerApprovals:approvals.seller.length-afterFirstSeller,newTransactionApprovals:txApprovals(approvals.buyer)-afterFirstTx,publicTransactions:0}));
});
