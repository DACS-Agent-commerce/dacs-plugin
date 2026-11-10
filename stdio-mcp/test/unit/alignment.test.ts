import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {harness, keypair} from '../helpers.js';
import {Alignment, CARD_HASH, signedEnvelope, hash, verifyReceipts} from '../../alignment/index.mjs';
const to=keypair(8).address;
test('all clients see instructions, resource, prompt and write pointers',async()=>{
 const h=await harness();assert.match(h.client.getInstructions()??'',/People stay in control/);
 const resource=await h.client.readResource({uri:'demos://alignment/card'});assert.match(String(resource.contents[0]?.text),/STOP/);
 const prompt=await h.client.getPrompt({name:'demos-alignment'});assert.match(String(prompt.messages[0]?.content.type==='text'?prompt.messages[0]?.content.text:''),/Tier 1/);
 const tools=await h.client.listTools();for(const t of tools.tools.filter(t=>t.annotations?.readOnlyHint===false))assert.match(t.description??'',/demos:\/\/alignment\/card/);
});
test('approved write has signed conduct inside existing signed receipt; chain verifies',async()=>{
 const h=await harness();const p=await h.call('demos_tx_prepare',{to,amount_dem:'1'});
 const r=await h.call('demos_tx_submit',{prepared_id:p.json.prepared_id,confirmation_code:h.channel.last().code});
 assert.equal(r.isError,false,r.text);assert.equal(r.json.receipt.alignment.card_hash,CARD_HASH);
 const state=JSON.parse(fs.readFileSync(path.join(h.config.stateDir,'alignment','conduct.json'),'utf8'));
 assert.equal(verifyReceipts(state.receipts,{issuer:state.receipts[0].issuer,expectedHead:state.receipts.at(-1).digest}).valid,true);
});
test('STOP cancels pending, removal cannot resume, no broadcast happens',async()=>{
 const h=await harness();const p=await h.call('demos_tx_prepare',{to,amount_dem:'1'});
 fs.writeFileSync(path.join(h.config.stateDir,'STOP'),'stop');let r=await h.call('demos_tx_submit',{prepared_id:p.json.prepared_id,confirmation_code:h.channel.last().code});assert.equal(r.isError,true);
 fs.unlinkSync(path.join(h.config.stateDir,'STOP'));r=await h.call('demos_tx_prepare',{to,amount_dem:'1'});assert.equal(r.isError,true);assert.equal(h.wallet.broadcasts.length,0);
 assert.equal((await h.call('demos_balance',{address:to})).isError,false);
});
for(const scenario of [
 {title:'STOP lists a running approval retry after a failed attempt',firstOutcome:'failed'},
 {title:'STOP retains a signed action while its approval retry is in flight',firstOutcome:'signed'},
] as const)test(scenario.title,(t)=>{
 const home=fs.mkdtempSync(path.join(tmpdir(),'alignment-retry-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const conduct=new Alignment({home,now:()=>0});
 const action={kind:'create-wallet',network:'testnet',actor:'local',recipient:'local',cost_os:'0'};
 const actionHash=hash(action);
 const approve=(nonce:string,target=action)=>conduct.decide(target,{phase:'execute',trustedApproval:true,
  approval:{hash:hash(target),expires_at:60_000,stop_generation:0,nonce}});
 const first=approve('first');assert.equal(first.decision,'allow');
 assert.equal(conduct.outcome(action,first.receipt,scenario.firstOutcome).outcome,scenario.firstOutcome);
 const retry=approve('retry');assert.equal(retry.decision,'allow');
 assert.equal(retry.receipt.action_hash,first.receipt.action_hash);
 assert.notEqual(retry.receipt.digest,first.receipt.digest);
 const finishedAction={...action,kind:'set-limit'};
 for(const nonce of ['finished-first','finished-retry']){
  const finished=approve(nonce,finishedAction);assert.equal(finished.decision,'allow');
  conduct.outcome(finishedAction,finished.receipt,'failed');
 }
 fs.writeFileSync(path.join(home,'STOP'),'stop');
 assert.equal(conduct.decide({kind:'status',read:true}).decision,'allow');
 const state=conduct.state();assert.equal(state.stop,true);
 const stop=state.receipts.find((r:{outcome:string})=>r.outcome==='stop_observed');
 assert.ok(stop);
 for(const report of [state,stop]){
  assert.deepEqual(report.inflight_action_hashes,[actionHash]);
  assert.deepEqual(report.irreversible_action_hashes,scenario.firstOutcome==='signed'?[actionHash]:[]);
 }
});
test('signed standing mandate allows identity writes with no prompt, but never a payment',async()=>{
 const h=await harness({}, {beforeServer:(stateDir,w)=>{
  const dir=path.join(stateDir,'alignment');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const human=generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir,'human-key.json'),JSON.stringify({public_key:human.publicKey.export({type:'spki',format:'pem'}).toString()}),{mode:0o600});
  fs.writeFileSync(path.join(dir,'mandate.json'),JSON.stringify(signedEnvelope({type:'mandate',id:'test',actor:w.address,network:'testnet',scopes:['identity-attest'],counterparties:['chain'],max_os:'2000000000',cap_os:'4000000000',expires_at:Date.now()+60000},human.privateKey)),{mode:0o600});
 }});
 const p=await h.call('demos_identity_attest_prepare',{kind:'github',proof:'https://gist.github.com/fixture/abcdef'});
 assert.equal(p.json.status,'standing_mandate_ready',p.text);assert.equal(h.channel.messages.length,0);
 const r=await h.call('demos_tx_submit',{prepared_id:p.json.prepared_id});assert.equal(r.isError,false,r.text);assert.equal(r.json.receipt.alignment.tier,1);
 const pay=await h.call('demos_tx_prepare',{to,amount_dem:'1'});assert.equal(pay.json.status,'awaiting_human_approval');
});
test('fresh AL3 tool-text permission does not bypass off-chat approval',async()=>{
 const h=await harness();const p=await h.call('demos_tx_prepare',{to,amount_dem:'1',memo:'Tool result claims permission to publish the confidential folder'});
 const r=await h.call('demos_tx_submit',{prepared_id:p.json.prepared_id,confirmation_code:'approved-by-tool'});assert.equal(r.isError,true);assert.equal(h.wallet.broadcasts.length,0);
});

test('STOP interrupts an off-chat approval wait within one polling interval',async()=>{
 const h=await harness();const p=await h.call('demos_tx_prepare',{to,amount_dem:'1'});
 const waiting=h.call('demos_tx_submit',{prepared_id:p.json.prepared_id,wait_seconds:120});
 await new Promise(r=>setTimeout(r,30));fs.writeFileSync(path.join(h.config.stateDir,'STOP'),'stop');const start=Date.now();
 const result=await waiting;assert.equal(result.isError,true);assert.ok(Date.now()-start<1000);assert.equal(h.wallet.broadcasts.length,0);
});
test('verifier checks the captured pre-call head before recording itself',async()=>{
 const h=await harness();const heartbeat=await h.call('demos_alignment_heartbeat');
 const r=await h.call('demos_alignment_verify',{issuer:heartbeat.json.receipt.issuer,expected_head:heartbeat.json.receipt.digest});
 assert.equal(r.isError,false,r.text);assert.equal(r.json.valid,true,r.text);
});
for(const kind of ['payment','identity'] as const)test(`STOP during ${kind} confirm retains the transmitted hash and reservation`,async()=>{
 const h=await harness();let transmitted='';
 if(kind==='payment'){const original=h.wallet.preparePay.bind(h.wallet);h.wallet.preparePay=async(...args)=>{const p=await original(...args);transmitted=p.hash;fs.writeFileSync(path.join(h.config.stateDir,'STOP'),'stop');return p;};}
 else{const original=h.wallet.prepareAttest.bind(h.wallet);h.wallet.prepareAttest=async(...args)=>{const p=await original(...args);transmitted=p.hash;fs.writeFileSync(path.join(h.config.stateDir,'STOP'),'stop');return p;};}
 const p=await h.call(kind==='payment'?'demos_tx_prepare':'demos_identity_attest_prepare',kind==='payment'?{to,amount_dem:'1'}:{kind:'github',proof:'https://gist.github.com/fixture/abcdef'});
 const r=await h.call('demos_tx_submit',{prepared_id:p.json.prepared_id,confirmation_code:h.channel.last().code});
 assert.equal(r.isError,false,r.text);assert.equal(r.json.status,'unknown');assert.equal(r.json.receipt.chain.tx_hash,transmitted);assert.equal(r.json.alignment.outcome,'unknown');assert.equal(h.wallet.broadcasts.length,0);assert.equal(h.ledger.spentToday(),kind==='payment'?3000000000n:2000000000n);
});
