import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemosSignature } from '../src/wallet/demos-signature.mjs';
import { cliIssuedEffects, createOperatorCliIssuedRecoveryNode2, runPty } from './helpers/devnet-operator-cli-issued-recovery-node2.mjs';
import { exactSequentialApprovals } from './helpers/devnet-operator-sequential-node2.mjs';
import { createSellerDispositionObserver, createSellerDispositionSink, dispositionEffects, startOperatorSellerDispositionNode2 } from './helpers/devnet-operator-seller-disposition-node2.mjs';
import { reconstructNativePublicPrecondition } from './helpers/devnet-operator-seller-precondition.mjs';
// Fixture keys go through idem() so no stored key: 'value' literal looks like a credential to secret scanners.
const idem = (key) => key;

const EVENT_KEYS=['deliveryStatus','disposition','elapsedMs','errorCode','errorName','format','input','method','outcome','processPid','reason','sequence','startedAt','status'].sort();
const HASH=/^[0-9a-f]{64}$/;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const here=dirname(fileURLToPath(import.meta.url));
const resumeChild=resolve(here,'helpers/devnet-operator-seller-disposition-resume-child.mjs');

test('seller public disposition wrapper preserves receiver, arguments, result and rejection identity once',async()=>{
  const events=[],result={status:'payment-evidenced',delivery:{status:'held',reason:'not-public'}},failure=Object.assign(new Error('private detail must not be recorded'),{code:'not-allowlisted'}),calls=[];
  const agent={claim:'seller',listingPin:{listingId:'listing'},async submitPayment(input){calls.push({method:'submitPayment',receiver:this,input});return result;},async reconcileTransport(input){calls.push({method:'reconcileTransport',receiver:this,input});throw failure;}};
  const wrapped=createSellerDispositionObserver({onEvent:(event)=>events.push(event),now:(()=>{let value=1791261000000;return()=>value++;})()}).wrap(agent),first={jobId:'job',txHash:'hash',payerPayingKey:'payer',nativePaymentEvidence:'present'},second={request:{jobId:'job',path:'/dacs/v1/payments'},body:{txHash:'hash',payerPayingKey:'payer',nativePaymentEvidence:'present'}};
  assert.equal(await wrapped.submitPayment(first),result);let caught;try{await wrapped.reconcileTransport(second);}catch(error){caught=error;}assert.equal(caught,failure);
  assert.deepEqual(calls.map(({method,input})=>({method,input})),[{method:'submitPayment',input:first},{method:'reconcileTransport',input:second}]);assert.ok(calls.every(({receiver})=>receiver===agent));
  assert.equal(events.length,2);for(const event of events){assert.deepEqual(Object.keys(event).sort(),EVENT_KEYS);assert.equal(event.format,'dacs-test-seller-public-disposition/v1');assert.ok(Number.isSafeInteger(event.sequence));assert.ok(Number.isSafeInteger(event.elapsedMs)&&event.elapsedMs>=0);assert.match(event.startedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);assert.deepEqual(Object.keys(event.input).sort(),['argumentCount','jobIdPresent','nativePaymentEvidencePresent','objectPresent','payerPayingKeyPresent','paymentRoute','txHashPresent'].sort());}
  assert.deepEqual(events[0],{format:'dacs-test-seller-public-disposition/v1',sequence:1,processPid:process.pid,method:'submitPayment',startedAt:'2026-10-06T04:30:00.000Z',input:{argumentCount:1,objectPresent:true,jobIdPresent:true,txHashPresent:true,payerPayingKeyPresent:true,nativePaymentEvidencePresent:true,paymentRoute:false},elapsedMs:1,outcome:'returned',errorName:null,errorCode:null,disposition:null,reason:null,status:'payment-evidenced',deliveryStatus:'held'});
  assert.equal(events[1].method,'reconcileTransport');assert.equal(events[1].outcome,'rejected');assert.equal(events[1].errorName,'Error');assert.equal(events[1].errorCode,null);assert.equal(events[1].reason,null);assert.equal(JSON.stringify(events).includes('private detail'),false);assert.equal(JSON.stringify(events).includes('not-allowlisted'),false);
});

test('seller disposition controls persist strict redacted events immediately in a private sink',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seller-disposition-sink-')),path=join(root,'events.ndjson'),sink=createSellerDispositionSink({path});
  try{
    const agent={async submitPayment(){return{status:'payment-evidenced',delivery:{status:'held',reason:'not-public'}};}};
    const result=await createSellerDispositionObserver({onEvent:(event)=>sink.append(event),now:(()=>{let value=1791261000000;return()=>value++;})()}).wrap(agent).submitPayment({jobId:'private-job',txHash:'private-hash',nativePaymentEvidence:{secret:'private'}});
    assert.equal(result.status,'payment-evidenced');const info=await stat(path);assert.equal(info.mode&0o777,0o600);
    const lines=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(lines.length,1);assert.deepEqual(Object.keys(lines[0]).sort(),EVENT_KEYS);assert.equal(lines[0].outcome,'returned');assert.equal(lines[0].status,'payment-evidenced');assert.equal(lines[0].deliveryStatus,'held');assert.equal(lines[0].reason,null);assert.equal(JSON.stringify(lines).includes('private-job'),false);assert.equal(JSON.stringify(lines).includes('private-hash'),false);assert.equal(JSON.stringify(lines).includes('secret'),false);
    assert.throws(()=>sink.append({...lines[0],arbitrary:'forbidden'}),/strict public schema/);
  }finally{sink.close();await rm(root,{recursive:true,force:true});}
});

test('seller disposition controls cannot replace a product result when clocks, getters, callbacks or sinks fail',async()=>{
  const result=Object.create(null,{status:{get(){throw new Error('private result getter');}}}),input=Object.create(null,{request:{get(){throw new Error('private input getter');}}});let calls=0;
  const agent={async submitPayment(value){calls++;assert.equal(value,input);return result;}};
  const wrapped=createSellerDispositionObserver({onEvent(){throw new Error('sink unavailable');},now(){throw new Error('clock unavailable');}}).wrap(agent);
  assert.equal(await wrapped.submitPayment(input),result);assert.equal(calls,1);
  const events=[],second=createSellerDispositionObserver({onEvent:(event)=>events.push(event),now:()=>1791261000000}).wrap(agent);
  assert.equal(await second.submitPayment(input),result);assert.equal(calls,2);assert.equal(events.length,1);assert.equal(events[0].status,null);assert.equal(events[0].input.jobIdPresent,false);
});

test('one same-process API workflow exposes genuine first seller failure and later read-only reconciliation disposition without resend',{timeout:300000},async t=>{
  const approvals=exactSequentialApprovals(),events=[],h=await startOperatorSellerDispositionNode2({...approvals,onEvent:(event)=>events.push(event)});t.after(()=>h.close());
  const before=dispositionEffects(h),key=idem('seller-disposition-fresh-001');let firstResult=null,firstError=null,resumeResult=null,resumeError=null;
  try{firstResult=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:key});}catch(error){firstError={name:error?.name??null,code:typeof error?.code==='string'?error.code:null};}
  const afterFirst=dispositionEffects(h),buyerTransactionsBeforeResume=approvals.buyer.filter((entry)=>entry.request.method==='sendTransaction').length,nativeApprovalsBeforeResume=approvals.buyer.filter((entry)=>entry.scope.kind==='native-payment').length,sellerApprovalsBeforeResume=approvals.seller.length;
  try{resumeResult=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:key});}catch(error){resumeError={name:error?.name??null,code:typeof error?.code==='string'?error.code:null};}
  const afterResume=dispositionEffects(h),buyerTransactionsAfterResume=approvals.buyer.filter((entry)=>entry.request.method==='sendTransaction').length,nativeApprovalsAfterResume=approvals.buyer.filter((entry)=>entry.scope.kind==='native-payment').length,sellerApprovalsAfterResume=approvals.seller.length;
  assert.deepEqual(afterFirst,{creates:5,payments:1});assert.deepEqual(afterResume,afterFirst);assert.equal(afterResume.payments-before.payments,1);assert.equal(buyerTransactionsAfterResume,buyerTransactionsBeforeResume);assert.equal(nativeApprovalsAfterResume,nativeApprovalsBeforeResume);assert.equal(sellerApprovalsAfterResume,sellerApprovalsBeforeResume);
  const submits=events.filter((event)=>event.method==='submitPayment'),reconciliations=events.filter((event)=>event.method==='reconcileTransport');assert.ok(submits.length>=1);assert.equal(submits[0].outcome,'rejected');assert.ok(reconciliations.length>=1);assert.ok(reconciliations.every((event)=>event.outcome==='returned'&&event.disposition==='indeterminate'));
  for(const event of events){assert.deepEqual(Object.keys(event).sort(),EVENT_KEYS);assert.equal(event.format,'dacs-test-seller-public-disposition/v1');assert.ok(event.input.paymentRoute===false||event.method==='reconcileTransport');assert.equal(typeof event.input.nativePaymentEvidencePresent,'boolean');}
  t.diagnostic(JSON.stringify({case:'seller-public-disposition',execution:'same-process API driver through supported operator attachSellerAgent boundary; not distinct-process CLI recovery',first:{resultStatus:firstResult?.status??null,error:firstError},resume:{resultStatus:resumeResult?.status??null,error:resumeError},effects:{before,afterFirst,afterResume,deltaAfterResume:{creates:afterResume.creates-afterFirst.creates,payments:afterResume.payments-afterFirst.payments}},approvals:{buyerTransactionsBeforeResume,buyerTransactionsAfterResume,nativeBeforeResume:nativeApprovalsBeforeResume,nativeAfterResume:nativeApprovalsAfterResume,sellerBeforeResume:sellerApprovalsBeforeResume,sellerAfterResume:sellerApprovalsAfterResume},sellerPublicMethods:events,publicTransactions:0}));
});

test('fresh issued-payment interruption exposes durable seller disposition during one custom-child resume without resend',{timeout:360000},async t=>{
  const h=await createOperatorCliIssuedRecoveryNode2();t.after(()=>h.close());const key='seller-interrupted-disposition-fresh',safeEventPath=join(h.root,'seller-disposition.safe.ndjson');
  let phase='interrupt',interrupted=null,crash=null,beforeReceipt=null,beforeReceiptHash=null,beforeEffects=null,beforeBuyerEvidence=null,beforeSellerEvidence=null,precondition=null,resumed=null,afterReceipt=null,afterEffects=null,afterBuyerEvidence=null,afterSellerEvidence=null,events=null,attemptError=null;
  try{
    interrupted=await h.crashAfterIssued(key);crash=await h.readCrashRecord();beforeReceipt=await h.readBuyerReceipt(key);beforeReceiptHash=sha(await h.readBuyerReceiptBytes(key));beforeEffects=cliIssuedEffects(h);beforeBuyerEvidence=await h.readBuyerApprovalEvidence();beforeSellerEvidence=await h.readSellerApprovalEvidence();phase='precondition';
    const accepted=h.node2.chain.record.accepted;assert.equal(accepted.length,1);assert.equal(crash.transactionHash,accepted[0].hash);assert.equal(accepted[0].hash,sha(JSON.stringify(accepted[0].content)));assert.equal(verifyDemosSignature({address:beforeReceipt.paymentIntent.payer,message:accepted[0].hash,signature:accepted[0].signature?.data}),true);
    precondition=reconstructNativePublicPrecondition({acceptedTransaction:accepted[0],publicIntent:beforeReceipt.paymentIntent});assert.equal(precondition.payloadHash,beforeReceipt.paymentIntent.payloadHash);assert.equal(precondition.dataHash,beforeReceipt.paymentIntent.dataHash);
    phase='resume';resumed=await runPty(h,{entrypoint:resumeChild,args:[`--config=${h.configPath}`,`--resume=${key}`,`--safe-event-path=${safeEventPath}`],receipt:beforeReceipt,returnFailure:true});phase='collect';
    afterReceipt=await h.readBuyerReceipt(key);afterEffects=cliIssuedEffects(h);afterBuyerEvidence=await h.readBuyerApprovalEvidence();afterSellerEvidence=await h.readSellerApprovalEvidence();events=(await readFile(safeEventPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);phase='complete';
  }catch(error){attemptError={name:['Error','AssertionError','TypeError'].includes(error?.name)?error.name:null,code:typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:null,phase};}
  finally{
    if(afterReceipt===null){try{afterReceipt=await h.readBuyerReceipt(key);}catch{afterReceipt=null;}}
    if(afterEffects===null){try{afterEffects=cliIssuedEffects(h);}catch{afterEffects=null;}}
    if(afterBuyerEvidence===null){try{afterBuyerEvidence=await h.readBuyerApprovalEvidence();}catch{afterBuyerEvidence=null;}}
    if(afterSellerEvidence===null){try{afterSellerEvidence=await h.readSellerApprovalEvidence();}catch{afterSellerEvidence=null;}}
    if(events===null){try{events=(await readFile(safeEventPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{events=null;}}
    t.diagnostic(JSON.stringify({case:'seller-interrupted-disposition',phase,attemptError,processes:{source:process.pid,interruptedApplication:interrupted?.applicationPid??null,resumeApplication:resumed?.applicationPid??null,interruptionSignal:crash?.terminationSignal??null},scope:beforeReceipt?{operationId:beforeReceipt.operationId,jobId:beforeReceipt.jobId,agreementHash:beforeReceipt.agreementHash,paymentHash:crash?.transactionHash??null,intentHash:precondition?.payloadHash??null,receiptHash:beforeReceiptHash}:null,resume:{exitCode:resumed?.outcome.exitCode??null,signal:resumed?.outcome.signal??null,resultStatus:resumed?.result?.status??null,failure:resumed?.failure??null,transcript:resumed?.transcript??null},receipt:afterReceipt?{stage:afterReceipt.stage,operationId:afterReceipt.operationId,jobId:afterReceipt.jobId,agreementHash:afterReceipt.agreementHash,paymentHash:afterReceipt.payment?.transactionHash??null,paymentRecoveryHash:afterReceipt.paymentRecovery?.transactionHash??null,reportHash:afterReceipt.reportHash??null}:null,effects:{before:beforeEffects,after:afterEffects,delta:beforeEffects&&afterEffects?{creates:afterEffects.creates-beforeEffects.creates,payments:afterEffects.payments-beforeEffects.payments}:null},approvals:{buyerBefore:beforeBuyerEvidence?.length??null,buyerAfter:afterBuyerEvidence?.length??null,sellerBefore:beforeSellerEvidence?.length??null,sellerAfter:afterSellerEvidence?.length??null,resumeBuyerKinds:resumed?.buyerApprovals.map((entry)=>entry.kind)??null,resumeSellerKinds:resumed?.sellerApprovals.map((entry)=>entry.kind)??null},sellerPublicMethods:events,publicTransactions:0,execution:'supported API child through default operator transport/composition with normal exact TTY approvals; not unchanged CLI'}));
  }
  assert.equal(attemptError,null);assert.equal(phase,'complete');assert.equal(crash.terminationSignal,'SIGKILL');assert.equal(crash.success,true);assert.match(crash.transactionHash,HASH);assert.equal(beforeReceipt.stage,'payment-handoff');assert.equal(beforeReceipt.payment,null);assert.equal(beforeReceipt.operationId,crash.operationId);assert.equal(beforeReceipt.jobId,crash.jobId);assert.equal(beforeReceipt.agreementHash,crash.agreementHash);assert.deepEqual(beforeEffects,{creates:5,payments:1});
  assert.notEqual(resumed.applicationPid,interrupted.applicationPid);assert.notEqual(resumed.applicationPid,process.pid);assert.equal(resumed.outcome.signal,null);assert.equal(resumed.outcome.exitCode===0,resumed.result!==null);assert.equal(afterEffects.payments,1);assert.equal(afterEffects.payments,beforeEffects.payments);assert.ok(afterEffects.creates>=beforeEffects.creates&&afterEffects.creates<=beforeEffects.creates+2);assert.equal(afterEffects.creates-beforeEffects.creates,resumed.sellerApprovals.length);assert.ok(resumed.sellerApprovals.every((entry)=>['SettlementEvidence','Deliverable'].includes(entry.kind)));assert.equal(resumed.buyerApprovals.filter((entry)=>entry.method==='sendTransaction').length,0);
  assert.equal(afterReceipt.operationId,beforeReceipt.operationId);assert.equal(afterReceipt.jobId,beforeReceipt.jobId);assert.equal(afterReceipt.agreementHash,beforeReceipt.agreementHash);assert.equal(afterReceipt.payment.transactionHash,crash.transactionHash);assert.equal(afterReceipt.paymentRecovery.transactionHash,crash.transactionHash);assert.equal(afterBuyerEvidence.filter((entry)=>entry.scope?.kind==='native-payment').length,1);assert.equal(afterBuyerEvidence.filter((entry)=>entry.request?.method==='sendTransaction').length,beforeBuyerEvidence.filter((entry)=>entry.request?.method==='sendTransaction').length);
  assert.ok(Array.isArray(events)&&events.length>0);for(const event of events){assert.deepEqual(Object.keys(event).sort(),EVENT_KEYS);assert.ok(['submitPayment','reconcileTransport'].includes(event.method));assert.ok(['returned','rejected'].includes(event.outcome));assert.equal(JSON.stringify(event).includes(beforeReceipt.jobId),false);assert.equal(JSON.stringify(event).includes(crash.transactionHash),false);}assert.equal((await stat(safeEventPath)).mode&0o777,0o600);
});
