import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exactSequentialApprovals } from './helpers/devnet-operator-sequential-node2.mjs';
import { createOperatorPaymentRecoveryNode2, paymentRecoveryEffects, buyerTransactionApprovals, buyerNativePaymentApprovals } from './helpers/devnet-operator-payment-recovery-node2.mjs';

const HASH=/^[0-9a-f]{64}$/;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const lostResultHook=()=>{let lost=false;return{hook:async result=>{assert.equal(result.success,true);assert.match(result.transactionHash,HASH);lost=true;throw Object.assign(new Error('TEST own-local wallet result lost before driver hash persistence'),{code:'TEST_WALLET_RESULT_LOST'});},get lost(){return lost;}};};
const exactApprovals=({decline=false,failBeforeSend=false}={})=>{
  const approvals=exactSequentialApprovals(),authorize=approvals.authorizeBuyerApproval;
  approvals.authorizeBuyerApproval=(input)=>{
    if(input.scope.kind==='native-payment'&&failBeforeSend)throw new Error('TEST buyer approval channel ended before native send');
    const valid=authorize(input);return input.scope.kind==='native-payment'&&decline?false:valid;
  };
  return approvals;
};

test('original packaged-wallet payment survives post-return observer loss and same-process service recreation without resend or another transaction approval',{timeout:300000},async t=>{
  const approvals=exactApprovals(),h=await createOperatorPaymentRecoveryNode2(approvals);t.after(()=>h.close());
  const first=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'payment-recovery-first'});assert.equal(first.status,'delivery-ready');
  const loss=lostResultHook(),beforeNativeApprovals=buyerNativePaymentApprovals(approvals.buyer),beforeTransactionApprovals=buyerTransactionApprovals(approvals.buyer);
  await assert.rejects(h.operator.createBuyerDriver({composition:h.composition,testOnlyAfterNativeWalletResult:loss.hook}).purchase({idempotencyKey:'payment-recovery-second'}),/wallet result lost before driver hash persistence/);
  assert.equal(loss.lost,true);assert.deepEqual(paymentRecoveryEffects(h),{creates:11,payments:2});assert.equal(buyerNativePaymentApprovals(approvals.buyer),beforeNativeApprovals+1);
  const issued=await h.issuedNativeTransfers();assert.equal(issued.length,2);const beforeReceipt=await h.readBuyerReceipt('payment-recovery-second'),privateRun=await h.readPrivateBuyerRun('payment-recovery-second');
  assert.equal(beforeReceipt.stage,'payment-handoff');assert.equal(beforeReceipt.payment,null);assert.match(beforeReceipt.paymentIntent.payloadHash,HASH);assert.equal(beforeReceipt.paymentIntent.nonce,privateRun.paymentIntent.nonce);assert.equal(privateRun.payment,undefined);
  const secondIssued=issued.find(({value})=>value.nonce===beforeReceipt.paymentIntent.nonce&&value.signedTransaction.content.from===beforeReceipt.paymentIntent.payer);assert.ok(secondIssued);assert.equal(secondIssued.value.hash,secondIssued.value.signedTransaction.hash);
  await h.restart();const beforeOlderResume=await h.nativeLaneSnapshot({hash:secondIssued.value.hash,payer:beforeReceipt.paymentIntent.payer}),old=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'payment-recovery-first'}),afterOlderResume=await h.nativeLaneSnapshot({hash:secondIssued.value.hash,payer:beforeReceipt.paymentIntent.payer});
  assert.equal(old.reportHash,first.reportHash);assert.deepEqual(afterOlderResume,beforeOlderResume);assert.deepEqual(paymentRecoveryEffects(h),{creates:11,payments:2});
  const firstReceiptPath=join(h.root,'state','buyer-runs',`${sha('dacs-node2-operator-buyer-run\0payment-recovery-first')}.receipt.json`),firstReceiptHash=sha(await readFile(firstReceiptPath));
  const beforeRecoveryApprovals=buyerTransactionApprovals(approvals.buyer),recovered=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'payment-recovery-second'});
  assert.equal(recovered.status,'delivery-ready');assert.equal(recovered.payment.transactionHash,secondIssued.value.hash);assert.equal(recovered.nativeReadback.contentHash,recovered.reportHash);assert.deepEqual(paymentRecoveryEffects(h),{creates:13,payments:2});
  assert.equal(recovered.operationId,beforeReceipt.operationId);assert.equal(recovered.jobId,beforeReceipt.jobId);assert.equal(recovered.agreementHash,beforeReceipt.agreementHash);
  assert.equal(buyerTransactionApprovals(approvals.buyer),beforeRecoveryApprovals);assert.equal(buyerTransactionApprovals(approvals.buyer),beforeTransactionApprovals+2);assert.equal(await h.readBuyerReceipt('payment-recovery-second').then((r)=>r.paymentRecovery.transactionHash),secondIssued.value.hash);assert.equal(sha(await readFile(firstReceiptPath)),firstReceiptHash);
  t.diagnostic(JSON.stringify({case:'original-issued-recovery',first:{operationId:first.operationId,jobId:first.jobId,paymentHash:first.payment.transactionHash,reportHash:first.reportHash},recovered:{operationId:recovered.operationId,jobId:recovered.jobId,paymentHash:recovered.payment.transactionHash,reportHash:recovered.reportHash,nonce:beforeReceipt.paymentIntent.nonce,intentHash:beforeReceipt.paymentIntent.payloadHash},effectsBeforeRecovery:{creates:11,payments:2},effectsAfterRecovery:paymentRecoveryEffects(h),additionalTransactionApprovals:buyerTransactionApprovals(approvals.buyer)-beforeRecoveryApprovals,olderResumePreservedNewerJournal:afterOlderResume.digest===beforeOlderResume.digest,noResend:true,publicTransactions:0}));
});

test('cancelling a handoff whose native payment was issued is refused and the original hash still recovers without resend',{timeout:300000},async t=>{
  const approvals=exactApprovals(),h=await createOperatorPaymentRecoveryNode2(approvals);t.after(()=>h.close());
  const loss=lostResultHook();
  await assert.rejects(h.operator.createBuyerDriver({composition:h.composition,testOnlyAfterNativeWalletResult:loss.hook}).purchase({idempotencyKey:'payment-recovery-cancel-refused'}),/wallet result lost before driver hash persistence/);
  const receipt=await h.readBuyerReceipt('payment-recovery-cancel-refused');assert.equal(receipt.stage,'payment-handoff');assert.equal(receipt.payment,null);
  const {account_id:accountId}=h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(receipt.operationId);
  const refused=await h.application.services.purchases.cancel({accountId,operationId:receipt.operationId});
  assert.equal(refused.cancelled,false);assert.equal(refused.operation.status,'payment_uncertain');assert.equal(paymentRecoveryEffects(h).payments,1);
  const recovered=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'payment-recovery-cancel-refused'});
  assert.equal(recovered.status,'delivery-ready');assert.equal(paymentRecoveryEffects(h).payments,1);assert.equal((await h.issuedNativeTransfers()).length,1);
});

test('unavailable original readback stays held and authentic restored readback recovers the same issued hash',{timeout:240000},async t=>{
  const approvals=exactApprovals(),h=await createOperatorPaymentRecoveryNode2(approvals);t.after(()=>h.close());const loss=lostResultHook();
  await assert.rejects(h.operator.createBuyerDriver({composition:h.composition,testOnlyAfterNativeWalletResult:loss.hook}).purchase({idempotencyKey:'payment-recovery-unavailable'}),/wallet result lost/);assert.deepEqual(paymentRecoveryEffects(h),{creates:5,payments:1});
  const issued=(await h.issuedNativeTransfers())[0];assert.ok(issued);const collision=await h.injectUnauthenticatedAmbiguousJournalCandidate();await h.restart();h.makeOriginalPaymentReadbackUnavailable();const before=paymentRecoveryEffects(h),beforeApprovals=buyerTransactionApprovals(approvals.buyer);
  const held=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'payment-recovery-unavailable'}),heldEffects=paymentRecoveryEffects(h);assert.equal(held.status,'held');assert.equal(held.noResend,true);assert.match(held.reason,/readback unavailable/i);assert.deepEqual(heldEffects,before);assert.equal(buyerTransactionApprovals(approvals.buyer),beforeApprovals);
  h.restoreOriginalPaymentReadback();const recovered=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'payment-recovery-unavailable'});assert.equal(recovered.status,'delivery-ready');assert.equal(recovered.payment.transactionHash,issued.value.hash);assert.deepEqual(paymentRecoveryEffects(h),{creates:7,payments:1});assert.equal(buyerTransactionApprovals(approvals.buyer),beforeApprovals);
  t.diagnostic(JSON.stringify({case:'unavailable-then-restored',heldReason:held.reason,originalHash:issued.value.hash,recoveredHash:recovered.payment.transactionHash,ignoredInvalidSignatureHash:collision.untrustedCollisionHash,before,heldEffects,recoveredEffects:paymentRecoveryEffects(h),additionalTransactionApprovals:buyerTransactionApprovals(approvals.buyer)-beforeApprovals,noResend:true,publicTransactions:0}));
});

test('absent or ambiguous original issuance remains held with zero additional effects',{timeout:300000},async t=>{
  const absentApprovals=exactApprovals({failBeforeSend:true}),absent=await createOperatorPaymentRecoveryNode2(absentApprovals);t.after(()=>absent.close());
  const first=await absent.operator.createBuyerDriver({composition:absent.composition}).purchase({idempotencyKey:'payment-recovery-absent'});assert.equal(first.status,'held');assert.deepEqual(paymentRecoveryEffects(absent),{creates:5,payments:0});assert.equal((await absent.issuedNativeTransfers()).length,0);
  await absent.restart();const absentBefore=paymentRecoveryEffects(absent),absentResumed=await absent.operator.createBuyerDriver({composition:absent.composition}).resume({idempotencyKey:'payment-recovery-absent'});assert.equal(absentResumed.status,'held');assert.match(absentResumed.reason,/approved native payment evidence count is 0|original issued payment is absent/);assert.deepEqual(paymentRecoveryEffects(absent),absentBefore);

  const ambiguousApprovals=exactApprovals(),ambiguous=await createOperatorPaymentRecoveryNode2(ambiguousApprovals);t.after(()=>ambiguous.close());const loss=lostResultHook();
  await assert.rejects(ambiguous.operator.createBuyerDriver({composition:ambiguous.composition,testOnlyAfterNativeWalletResult:loss.hook}).purchase({idempotencyKey:'payment-recovery-ambiguous'}),/wallet result lost/);const duplicated=await ambiguous.duplicateLastBuyerApprovalEvidence(),ambiguousBefore=paymentRecoveryEffects(ambiguous),approvalBefore=buyerTransactionApprovals(ambiguousApprovals.buyer);
  await ambiguous.restart();const ambiguousResumed=await ambiguous.operator.createBuyerDriver({composition:ambiguous.composition}).resume({idempotencyKey:'payment-recovery-ambiguous'});assert.equal(ambiguousResumed.status,'held');assert.match(ambiguousResumed.reason,/approved native payment evidence count is 2/);assert.deepEqual(paymentRecoveryEffects(ambiguous),ambiguousBefore);assert.equal(buyerTransactionApprovals(ambiguousApprovals.buyer),approvalBefore);
  t.diagnostic(JSON.stringify({case:'absent-ambiguous-hold',absent:{effects:absentBefore,reason:absentResumed.reason},ambiguous:{effects:ambiguousBefore,reason:ambiguousResumed.reason,duplicatedGenuineApprovalHash:duplicated.approvalHash},additionalEffects:0,additionalTransactionApprovals:0,noResend:true,publicTransactions:0}));
});

test('normal exact decline remains declined and is never interpreted as recoverable issuance',{timeout:180000},async t=>{
  const approvals=exactApprovals({decline:true}),h=await createOperatorPaymentRecoveryNode2(approvals);t.after(()=>h.close());const declined=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'payment-recovery-decline'});
  assert.equal(declined.status,'declined');assert.deepEqual(paymentRecoveryEffects(h),{creates:5,payments:0});assert.equal((await h.issuedNativeTransfers()).length,0);const beforeApprovals=buyerTransactionApprovals(approvals.buyer);await h.restart();const resumed=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:'payment-recovery-decline'});
  assert.equal(resumed.status,'declined');assert.deepEqual(paymentRecoveryEffects(h),{creates:5,payments:0});assert.equal(buyerTransactionApprovals(approvals.buyer),beforeApprovals);
  t.diagnostic(JSON.stringify({case:'decline-not-recovered',decision:'rejected',effects:paymentRecoveryEffects(h),additionalTransactionApprovals:buyerTransactionApprovals(approvals.buyer)-beforeApprovals,noResend:true,publicTransactions:0}));
});
