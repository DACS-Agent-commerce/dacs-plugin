import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { createOperatorSellerSessions, SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { claimForAddress } from '../src/wallet/demos-signature.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { retainedAnswerFixture } from './helpers/retained-answer-fixture.mjs';

function seed(h,time,id,{status='expired',stage,extra=()=>({})}={}){
  const ops=h.application.services.ops,buyer=createEphemeralWallet();
  h.application.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(id,'TEST',id,new Date(time).toISOString());
  const operation=ops.createIdempotent({accountId:id,kind:'purchase',idempotencyKey:id,request:{id},status:'agreement_pending',terms:{buyer:{wallet:buyer.address},seller:{claim:h.prepared.operatorEvidence.seller},listing:h.composition.published.listingPin,protocol:{jobId:generateCanonicalJobId()}},termsHash:'a'.repeat(64),expiresAt:new Date(time+3600000).toISOString(),state:{protocol:{stage:'identity',listing:h.composition.listing}}}).operation;
  const sessions=createOperatorSellerSessions({directory:join(h.config.stateDirectory,'seller-sessions'),now:()=>time}),request=sessions.request(operation);
  const state={protocol:{...operation.state.protocol,...(stage?{stage}:{}),...extra(operation,buyer),sessionDelegation:{payload:request.payload}}};
  ops.transition(operation.id,'agreement_pending',status,{state,event:'TEST_ended'});
  return{operation,key:join(h.config.stateDirectory,'seller-sessions',`${sha256Hex(operation.id)}.json`),marker:join(h.config.stateDirectory,'seller-sessions',`${sha256Hex(operation.id)}.retired.json`)};
}

test('restart with open access off retires existing keys at startup and periodically, reports failures and keeps delegation disabled',{timeout:180000},async t=>{
  let time;const callbacks=[],cancelled=[];
  const timer={every:(run,ms)=>{assert.equal(ms,5*60000);callbacks.push(run);return run;},cancel:(handle)=>cancelled.push(handle)};
  const h=await startOperatorPurchaseNode2({openBuyerAccess:true,now:()=>time??Date.now(),sessionSweepTimer:timer,authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true});t.after(()=>h.close());
  // Freeze after setup so the newly generated certificate is already valid.
  time=Date.now();assert.equal(h.prepared.operatorEvidence.sellerTls.status,'ready');
  const [malformed,early]=[seed(h,time,'0'),seed(h,time,'1')].sort((a,b)=>a.key.localeCompare(b.key)),failed=seed(h,time,'2');
  h.application.db.prepare("UPDATE operations SET terms = '{}' WHERE id = ?").run(malformed.operation.id);
  // Final stage without the verified delivery a seller-free readback needs.
  const malformedFinal=seed(h,time,'5',{status:'settled_verified',stage:'delivery-ready'});
  // Final rows with a verified delivery whose retained answer is missing (a
  // legacy row) or names another delivery status. No valid seller signature is
  // needed: both are refused before the projection is checked.
  const verified=(operation,buyer,edit)=>{const claim=operation.terms.seller.claim,seller={claim,address:`0x${claim.slice(16)}`,signHex:()=>`0x${'0'.repeat(128)}`};
    const fields=retainedAnswerFixture({buyer:{claim:claimForAddress(buyer.address)},seller,jobId:operation.terms.protocol.jobId,id:operation.id,time});edit(fields);return fields;};
  const legacyFinal=seed(h,time,'6',{status:'settled_verified',stage:'delivery-ready',extra:(operation,buyer)=>verified(operation,buyer,(fields)=>{delete fields.sellerAnswer;})});
  const mismatchedFinal=seed(h,time,'7',{status:'settled_verified',stage:'delivery-ready',extra:(operation,buyer)=>verified(operation,buyer,(fields)=>{fields.sellerAnswer.delivery.status='pending';})});
  time+=SELLER_SESSION_KEY_GRACE_MS;
  const late=seed(h,time,'3'),brokenDecision=seed(h,time,'4');
  writeFileSync(h.configPath,JSON.stringify({...h.config,openBuyerAccess:false}),{mode:0o600});
  const errors=[],write=process.stderr.write;process.stderr.write=(chunk)=>{errors.push(String(chunk));return true;};t.after(()=>{process.stderr.write=write;});
  // A nonempty directory at the key path is unreadable and must be reported.
  const record=readFileSync(failed.key);rmSync(failed.key);mkdirSync(failed.key,{mode:0o700});writeFileSync(join(failed.key,'blocked'),'TEST');
  await h.restart();
  assert.equal(existsSync(early.key),false,'startup sweep works with access off');
  assert.equal(existsSync(malformed.key),true,'startup retains a malformed purchase without aborting attachment');
  assert.equal(existsSync(malformed.marker),false,'a malformed purchase is never retired');
  assert.equal(existsSync(late.key),true,'grace period is retained');
  assert.equal(typeof callbacks.at(-1),'function','periodic cleanup is scheduled with access off');
  assert.equal(h.prepared.composition.sellerTransport.sessionDelegation,null);
  assert.throws(()=>h.prepared.composition.sellerTransport.authenticationFor(early.operation),/buyer differs/);
  assert.ok(errors.some(line=>line.includes('unreadable record')),'per-record failure is reported');
  assert.ok(errors.some(line=>line.includes('purchase differs from the session key scope')),'malformed purchase is reported at startup');
  assert.equal(existsSync(malformedFinal.key),true,'a final stage without verified delivery data keeps its key');
  assert.equal(existsSync(malformedFinal.marker),false);
  assert.ok(errors.some(line=>line.includes('final purchase record is malformed: no verified delivery-ready delivery')),'malformed final purchase is reported at startup');
  for(const kept of [legacyFinal,mismatchedFinal]){assert.equal(existsSync(kept.key),true);assert.equal(existsSync(kept.marker),false);}
  // With DACS_BUYER_CHAIN_READBACK=on a row with no answer is also checked on its own Agreement, and this
  // fixture's Agreement names the test Listing, not this purchase's, so it is kept and reported as malformed.
  const legacyReason=h.prepared.config.buyerChainReadback==='on'?'final purchase record is malformed: the retained Agreement differs from the purchase terms (listing)':'final purchase has no retained signed payment projection';
  assert.ok(errors.some(line=>line.includes(`${legacyFinal.operation.id}: ${legacyReason}`)),'a legacy final row is reported, not kept silently');
  assert.ok(errors.some(line=>line.includes(`${mismatchedFinal.operation.id}: final purchase's retained seller answer cannot authenticate it: its delivery status differs`)),'a mismatched retained answer is reported');
  rmSync(failed.key,{recursive:true});writeFileSync(failed.key,record,{mode:0o600});
  // Use a nonempty key directory only during unlink, via lookup's side effect.
  const ops=h.application.services.ops,get=ops.get;ops.get=(account,id)=>{const op=get(account,id);if(id===failed.operation.id){rmSync(failed.key);mkdirSync(failed.key,{mode:0o700});writeFileSync(join(failed.key,'blocked'),'TEST');}if(id===brokenDecision.operation.id)Object.defineProperty(op,'updatedAt',{get(){throw new Error('TEST unreadable final state');}});return op;};
  time+=SELLER_SESSION_KEY_GRACE_MS;callbacks.at(-1)();
  assert.equal(existsSync(late.key),false,'periodic sweep also works with access off');
  assert.equal(existsSync(malformed.key),true,'periodic cleanup continues past the retained malformed purchase');
  assert.ok(errors.some(line=>line.includes('deletion incomplete')),'deletion failure is reported');
  assert.ok(errors.some(line=>line.includes('record processing failed: TEST unreadable final state')),'unexpected per-record failures are reported');
  assert.equal(existsSync(brokenDecision.key),true);assert.equal(existsSync(brokenDecision.marker),false);
  assert.equal(existsSync(failed.marker),true,'a failed unlink still leaves the key retired');
  assert.ok(h.application.services.ops.history(late.operation.id).some(event=>event.type==='seller_session_key_deleted'));
  await h.close();assert.ok(cancelled.includes(callbacks.at(-1)),'shutdown cancels periodic cleanup');
});
