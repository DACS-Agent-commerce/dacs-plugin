import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {autoAdvancePortalPage,autoAdvancePortalSource} from '../src/portal/auto-advance-assets.mjs';
import {createPurchaseAutoAdvance,createPurchaseWalletIdle,purchasePhase} from '../src/portal/purchase-auto-advance.mjs';
import {mountEmbeddedWallet} from '../public/portal/embedded-wallet/ui.mjs';
import {Node,fakeDocument,fakeClock,flush} from './helpers/portal-auto-dom.mjs';
import {portalHarness,tabStorage} from './helpers/portal-auto-harness.mjs';

const pending=(stage='agreement-anchored',status='agreement_pending')=>({status,autoAdvance:{requiresSignature:false},evidence:{protocol:{stage}}});
const ready=()=>({status:'awaiting_approval',autoAdvance:{requiresSignature:true}});

test('every read-only stage advances to the next screen with capped backoff and no wallet request',async()=>{
  const cases=[pending('agreement-signing'),pending(),pending('committed','settled_verified'),pending('seller-committed','settled_verified'),pending('awaiting-claim','settled_verified'),pending('native-payment-evidence-held','settled_verified'),{...pending('payment-observed','settled_verified'),evidence:{protocol:{stage:'payment-observed',nativePayment:{subsequentProtocol:'native-evidence-readback-required'}}}},pending('payment-evidenced','settled_verified'),pending('delivery-ready','settled_verified'),pending('delivered','settled_verified'),pending('awaiting-countersignature','settled_verified'),...['payment_handoff','broadcast_reported','payment_uncertain'].map(status=>({status}))];
  for(const initial of cases){
    const clock=fakeClock(),shown=[];let count=0;
    const auto=createPurchaseAutoAdvance({...clock,read:async()=>++count<7?initial:ready(),render:v=>shown.push(v)});
    auto.observe(initial);
    const delays=[];
    while(clock.timers.size){const timer=[...clock.timers.values()][0];delays.push(timer.ms);await clock.advance(timer.ms);}
    assert.equal(count,7,initial.evidence?.protocol?.stage??initial.status);assert.equal(shown.at(-1).status,'awaiting_approval');
    assert.deepEqual(delays,[500,1000,2000,4000,8000,8000,8000]);auto.destroy();
  }
});

test('an ambiguous 409 and unknown outcomes automatically recheck, retain only a public hash, and serialize reads with actions',async()=>{
  for(const error of [{status:409,code:'invalid_state'},{code:'outcome_unknown'},{indeterminate:true},{code:'upstream_unavailable'}]){
    const clock=fakeClock(),shown=[];let count=0,resolve;
    const auto=createPurchaseAutoAdvance({...clock,read:async(hash)=>{count++;assert.equal(hash,'a'.repeat(64));return new Promise(r=>resolve=r);},render:v=>shown.push(v)});
    auto.observe(ready());assert.equal(clock.timers.size,0);auto.markWrite();auto.rememberHash('a'.repeat(64));auto.rememberHash('untrusted hash');
    assert.equal(auto.recover(error),true);await clock.advance(500);assert.equal(count,1);
    const shared=auto.check(),pause=auto.pause();await flush();assert.equal(count,1);assert.equal(clock.timers.size,0);
    resolve(ready());await shared;await pause;assert.equal(shown.length,0,'an old poll cannot overwrite an action screen');
    auto.resume();await clock.advance([...clock.timers.values()][0].ms);assert.equal(count,2);resolve({status:'payment_uncertain'});await flush();
    assert.equal(auto.readbackOnly(ready()),true,'an attempted send cannot offer another payment approval');auto.destroy();
  }
});

test('fresh identity, Agreement and bundle signatures wait for the buyer; terminal and held purchases end',()=>{
  const clock=fakeClock();let calls=0,ends=0;
  const auto=createPurchaseAutoAdvance({...clock,read:()=>calls++,render(){},end:()=>ends++});
  for(const view of [pending('identity'),{...pending('agreement-signing'),autoAdvance:{requiresSignature:true}},ready(),{status:'approved'}, {...pending('awaiting-countersignature','settled_verified'),autoAdvance:{requiresSignature:true}}]){
    assert.equal(purchasePhase(view),'approval');auto.observe(view);assert.equal(clock.timers.size,0);
  }
  for(const view of [{status:'cancelled'},pending('completed','settled_verified'),pending('delivery-rejected','settled_verified'),{status:'settled_verified'}, {...pending('delivered','settled_verified'),evidence:{protocol:{stage:'delivered',limits:{bundleFinalization:'DACS-5 finalization deferred'}}}}]){
    assert.equal(purchasePhase(view),'ended');auto.observe(view);assert.equal(clock.timers.size,0);
  }
  assert.equal(calls,0);assert.equal(ends,5);
});

test('poll failures back off; a permanent failure stops and remains visible as text',async()=>{
  const clock=fakeClock(),notices=[];let calls=0,ends=0;
  const auto=createPurchaseAutoAdvance({...clock,read:async()=>{calls++;throw calls===1?{status:409,code:'invalid_state'}:new Error('<img src=x onerror=alert(1)>');},render(){},notice:(...v)=>notices.push(v),end:()=>ends++});
  auto.observe(pending());await clock.advance(500);assert.equal([...clock.timers.values()][0].ms,1000);
  await clock.advance(1000);assert.equal(ends,1);assert.equal(clock.timers.size,0);assert.deepEqual(notices.at(-1),['<img src=x onerror=alert(1)>','bad']);
});

test('enabled purchase renderer advances by reads, keeps approval buttons idle, and renders hostile seller text as text',async()=>{
  const h=portalHarness(pending(),async(path,_body,enrich)=>({ok:true,data:enrich(ready())}));
  await h.start();await h.clock.advance(500);
  assert.equal(h.requests.at(-1).path,'/portal/api/purchase/TEST/auto/recheck');assert.match(h.document.getElementById('flow').text,/Approve exact terms/);assert.equal(h.wallet.length,0);h.destroy();
  const malicious='<script>TEST-seller</script>';
  const other=portalHarness({status:'payment_uncertain',evidence:{next:malicious}},async(_path,_body,enrich)=>({ok:true,data:enrich({status:'payment_failed',evidence:{next:malicious}})}));
  await other.start();await other.clock.advance(500);assert.ok(other.document.getElementById('flow').querySelectorAll('p').some(n=>n.children.some(c=>c.tag==='#text'&&c.value===malicious)));assert.equal(other.wallet.length,0);other.destroy();
});

test('409 after signing recovers in the shipped action wrapper without repeating the wallet approval',async()=>{
  let checks=0;
  const h=portalHarness(ready(),async(path,_body,enrich)=>path.endsWith('/challenge')?{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge'}}:path.endsWith('/approve')?{ok:false,status:409,data:{error:'invalid_state',message:'TEST conflict'}}:{ok:true,data:enrich(++checks===1?{status:'approved'}:ready())});
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');
  assert.equal(h.wallet.length,1);assert.equal(h.wallet[0].method,'sign');assert.doesNotMatch(h.document.getElementById('log').text,/TEST conflict/);
  await h.clock.advance(500);assert.equal(checks,1);assert.equal(h.wallet.length,1);assert.match(h.document.getElementById('flow').text,/Send payment from wallet/);assert.equal(h.clock.timers.size,0);h.destroy();
});

test('indeterminate wallet send and lost report recheck its hash; no second payment approval is offered',async()=>{
  const h=portalHarness({status:'approved'},async(path,_body,enrich)=>path.endsWith('/handoff')?{ok:true,data:{...enrich({status:'payment_handoff'}),payload:{TEST:'transaction'}}}:path.endsWith('/report')?Promise.reject(new TypeError('TEST dropped HTTP response')):{ok:true,data:enrich(ready())});
  h.context.fakeProvider.request=async req=>{h.wallet.push(req);return{success:false,data:{hash:'a'.repeat(64)},error:{code:'outcome_unknown'}};};
  await h.start();const oldButton=h.document.getElementById('flow').querySelector('button[data-action]');await oldButton.fire('click');assert.equal(oldButton.disabled,true);const before=h.requests.length;await oldButton.fire('click');assert.equal(h.requests.length,before);await h.clock.advance(500);
  await oldButton.fire('click');assert.equal(h.wallet.length,1);assert.equal(h.wallet[0].method,'sendTransaction');assert.equal(h.requests.find(req=>req.path.endsWith('/auto/recheck')).body.txHash,'a'.repeat(64));
  assert.doesNotMatch(h.document.getElementById('flow').text,/Approve exact terms|Send payment from wallet/);assert.doesNotMatch(h.document.getElementById('log').text,/TEST dropped HTTP/);h.destroy();
});

test('asset hook drift fails closed instead of silently losing a guard',()=>{
  const source=readFileSync(new URL('../public/portal/portal.js',import.meta.url),'utf8');
  assert.throws(()=>autoAdvancePortalSource(source.replace('const $ = (id)','const lookup = (id)')),/hook drift/);
});

async function unlockedWallet(document){
  globalThis.document=document;globalThis.Node=Node;
  let notify;const activated=new Promise(resolve=>notify=resolve),material=new Uint8Array(randomBytes(32));let locked=0,approve;
  const account={address:'0x'+'1'.repeat(64),publicKey:'2'.repeat(64),network:'TEST',evidenceMode:'local-key-only'};
  const session={create:async()=>account,importMnemonic:async()=>account,exportMnemonicForUser:async()=>randomBytes(32).toString('hex'),request:args=>approve(args),lock(){material.fill(0);locked++;}};
  const root=document.getElementById('wallet');
  const handle=mountEmbeddedWallet(root,{sessionFactory:async options=>{approve=options.approve;return session;},onProviderReady:provider=>notify(provider)});
  await handle.ready;
  const form=root.querySelector('form');for(const input of form.querySelectorAll('input'))input.value=randomBytes(24).toString('hex');
  const inputs=form.querySelectorAll('input');inputs[1].value=inputs[0].value;await form.fire('submit');const provider=await activated;
  return{handle,root,provider,material,locked:()=>locked};
}

test('five-minute idle and purchase end call the existing wallet lock, clear keys/phrase/fields and cancel an approval',async()=>{
  for(const finish of ['idle','end']){
    const document=fakeDocument(),clock=fakeClock(),w=await unlockedWallet(document);
    const idle=createPurchaseWalletIdle({...clock,document,wallet:()=>w.handle});idle.unlocked();
    const approval=w.provider.request({method:'sign',params:['TEST content']});await flush();assert.equal(w.root.querySelectorAll('dialog').length,1);
    if(finish==='idle'){await clock.advance(299999);assert.equal(w.handle.getPublicState().locked,false);await clock.advance(1);}else{const auto=createPurchaseAutoAdvance({read(){},render(){},end:()=>idle.end()});auto.observe(pending('completed','settled_verified'));}
    assert.equal(w.locked(),1);assert.ok(w.material.every(b=>b===0));assert.equal(w.handle.getPublicState().locked,true);assert.equal(await approval,false);assert.equal(w.root.querySelectorAll('dialog').length,0);
    assert.ok(w.root.querySelectorAll('[data-sensitive]').every(n=>n.value===''));assert.doesNotMatch(w.root.text,/Write down your new recovery phrase/);assert.equal(clock.timers.size,0);idle.destroy();w.handle.destroy();
  }
});

test('only trusted foreground activity extends idle; hidden tabs lock at the limit even with throttled timers',async()=>{
  for(const throttled of [false,true]){
    const document=fakeDocument(),clock=fakeClock();let locked=false,locks=0;
    const handle={lock(){locked=true;locks++;},getPublicState:()=>({locked})},idle=createPurchaseWalletIdle({...clock,document,wallet:()=>handle});idle.unlocked();
    await clock.advance(200000);await document.fire('pointerdown',{isTrusted:false});await clock.advance(99999);assert.equal(locked,false);
    await document.fire('keydown',{isTrusted:true});await clock.advance(200000);assert.equal(locked,false);
    document.hidden=true;await document.fire('visibilitychange');await clock.advance(300000,!throttled);
    if(throttled){assert.equal(locked,false);document.hidden=false;await document.fire('visibilitychange');}
    assert.equal(locked,true);assert.equal(locks,1);assert.equal(clock.timers.size,0);idle.destroy();
    assert.ok([...document.events.values()].every(fns=>fns.length===0));
  }
});

test('the shipped receipt renderer progresses through claim, evidence, delivery and bundle readbacks to a fresh approval screen',async()=>{
  const stages=['awaiting-claim','payment-evidenced','delivery-ready','delivered','awaiting-countersignature'];let i=0;
  const h=portalHarness(pending('committed','settled_verified'),async(_path,_body,enrich)=>({ok:true,data:enrich({...pending(stages[i++],'settled_verified'),autoAdvance:{requiresSignature:i===stages.length}})}));
  await h.start();
  for(const stage of stages){await h.clock.advance([...h.clock.timers.values()][0].ms);assert.match(h.document.getElementById('flow').text,new RegExp(stage));assert.equal(h.wallet.length,0);}
  assert.match(h.document.getElementById('flow').text,/Counter-sign completed bundle/);assert.equal(h.clock.timers.size,0);h.destroy();
});

test('recorded Agreement and bundle signatures show readback or a new explicit CREATE approval without signing again',async()=>{
  const agreement=portalHarness(pending('agreement-signing'),async(_path,_body,enrich)=>({ok:true,data:enrich(ready())}));
  vm.runInContext('offlineAgreementBroker={approveOne:async()=>{throw new Error("TEST must wait for buyer");}}',agreement.context);
  await agreement.start();assert.doesNotMatch(agreement.document.getElementById('flow').text,/Sign the DACS Agreement/);assert.match(agreement.document.getElementById('flow').text,/Approve Agreement CREATE/);assert.equal(agreement.wallet.length,0);agreement.destroy();
  const h=portalHarness({...pending('awaiting-countersignature','settled_verified'),autoAdvance:{requiresSignature:true}},async(path,_body,enrich)=>path.endsWith('/completion/request')?{ok:true,data:{signRequest:{bundleHash:'TEST-bundle',bundleMessage:'TEST-bundle-message',anchorMessage:'TEST-anchor'}}}:{ok:true,data:enrich(pending(path.endsWith('/completion/countersign')?'awaiting-countersignature':'completed','settled_verified'))});
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');assert.equal(h.wallet.length,2);assert.doesNotMatch(h.document.getElementById('flow').text,/Counter-sign completed bundle/);
  await h.clock.advance(500);assert.match(h.document.getElementById('flow').text,/completed/);assert.equal(h.wallet.length,2);assert.equal(h.clock.timers.size,0);h.destroy();
});

test('wallet unlocked after purchase end is immediately locked through the existing lifecycle',async()=>{
  const document=fakeDocument(),clock=fakeClock();let handle=null;
  const idle=createPurchaseWalletIdle({...clock,document,wallet:()=>handle});idle.end();
  const w=await unlockedWallet(document);handle=w.handle;
  assert.equal(idle.unlocked(),false);assert.equal(w.handle.getPublicState().locked,true);assert.ok(w.material.every(b=>b===0));assert.equal(clock.timers.size,0);idle.destroy();w.handle.destroy();
});

test('an indeterminate truncated result is rechecked rather than rendering an empty purchase or repeating an approval',async()=>{
  const h=portalHarness(ready(),async(path,_body,enrich)=>path.endsWith('/challenge')?{ok:true,brokenJson:true}:{ok:true,data:enrich(ready())});
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await h.clock.advance(500);
  assert.equal(h.requests.at(-1).path,'/portal/api/purchase/TEST/auto/recheck');assert.doesNotMatch(h.document.getElementById('log').text,/TEST truncated/);assert.equal(h.wallet.length,0);h.destroy();
});

test('synthetic events, hidden activity and delayed unlock callbacks cannot extend the idle or hidden deadline',async()=>{
  for(const mode of ['synthetic','hidden-activity','delayed-unlock']){
    const document=fakeDocument(),clock=fakeClock();let locked=false;
    const idle=createPurchaseWalletIdle({...clock,document,wallet:()=>({lock(){locked=true;},getPublicState:()=>({locked})})});idle.unlocked();
    await clock.advance(200000);
    if(mode==='synthetic'){await document.fire('pointerdown',{isTrusted:false});await clock.advance(100000);}
    else{
      document.hidden=true;await document.fire('visibilitychange');
      if(mode==='hidden-activity'){
        await clock.advance(99000);await document.fire('keydown',{isTrusted:true});document.hidden=false;await document.fire('visibilitychange');await clock.advance(1000);
      }else{await clock.advance(300001,false);idle.unlocked();}
    }
    assert.equal(locked,true,mode);idle.destroy();
  }
});

test('the shipped action wrapper drains the outstanding automatic read before a user recheck and the next approval',async()=>{
  let resolve,reads=0;
  const h=portalHarness(pending(),async(path,_body,enrich)=>path.endsWith('/auto/recheck')&&++reads===1?new Promise(r=>resolve=()=>r({ok:true,data:enrich(ready())})):path.endsWith('/challenge')?{ok:true,data:{message:'TEST-message',challengeId:'TEST-id'}}:{ok:true,data:enrich(ready())});
  await h.start();await h.clock.advance(500);
  const click=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
  assert.equal(h.requests.length,2,'only the initial view and recovery read are in flight');assert.equal(h.wallet.length,0);
  resolve();await click;assert.equal(h.requests.length,3);await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');assert.equal(h.wallet.length,1);h.destroy();
});

test('hashless uncertain payments remain readback-only and explain how to supply the missing public pointer',async()=>{
  const h=portalHarness({status:'payment_uncertain'},async(_path,_body,enrich)=>({ok:true,data:enrich({status:'payment_uncertain',verification:{outcome:'hash_required'}})}));
  await h.start();await h.clock.advance(500);assert.match(h.document.getElementById('flow').text,/wallet history and verify_deal/);assert.equal(h.wallet.length,0);h.destroy();
});

test('every enabled HTTP request has a ten-second timeout so a lost response cannot hold polling forever',async()=>{
  const deadlines=[],h=portalHarness(pending(),async(_path,_body,enrich)=>({ok:true,data:enrich(ready())}));
  h.context.AbortSignal={timeout(ms){deadlines.push(ms);return 'TEST-timeout';}};
  await h.start();await h.clock.advance(500);assert.deepEqual(deadlines,[10000,10000]);assert.ok(h.requests.every(req=>req.deadline==='TEST-timeout'));h.destroy();
});

test('a pending CREATE approval with an unknown outcome is never repeated through its stale button',async()=>{
  let calls=0,sessions=0;
  const h=portalHarness(pending('agreement-signing'),async(_path,_body,enrich)=>({ok:true,data:enrich(pending('agreement-signing'))}));
  h.context.fakeBroker={authenticate:async()=>{sessions++;},approveOne:async provider=>{calls++;await provider.request({method:'TEST-create'});throw new Error('TEST wallet outcome unknown');}};vm.runInContext('offlineAgreementBroker=fakeBroker',h.context);
  await h.start();const button=h.document.getElementById('flow').querySelector('button[data-action]');await button.fire('click');assert.equal(calls,1);assert.equal(button.disabled,true);
  await h.clock.advance(500);assert.doesNotMatch(h.document.getElementById('flow').text,/Approve Agreement CREATE/);await button.fire('click');assert.equal(calls,1);assert.equal(sessions,1);assert.deepEqual(h.wallet.map(req=>req.method),['TEST-create']);h.destroy();
});

test('a signature whose POST was lost is requested once: recovery and a reload of the tab stay readback-only',async t=>{
  const lost=()=>Promise.reject(new TypeError('TEST lost POST'));
  const kinds=[
    // The plan presentation and the Agreement signature are claimed as separate steps.
    {kind:'agreement',keys:['agreement-plan-presentation','agreement-signature'],label:/Sign the DACS Agreement/,calls:3,initial:{status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'identity'}}},
      reply:path=>path.endsWith('/agreement/identity')?{message:'TEST-identity'}:path.endsWith('/agreement/plan')?{summary:{amount:'1',amountOs:'1',payee:'TEST-payee',deadline:'TEST'},agreementHash:'TEST-agreement',agreementMessage:'TEST-agreement-message',anchorMessage:'TEST-anchor'}:null,post:'/agreement/sign'},
    // A saved plan: the page signs no presentation, so the Agreement signature is the claimed first request.
    {kind:'agreement',keys:['agreement-signature'],name:'agreement from a saved plan',label:/Sign the DACS Agreement/,calls:2,initial:{status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'agreement-signing'}}},
      reply:path=>path.endsWith('/agreement/identity')?{message:'TEST-identity'}:path.endsWith('/agreement/plan')?{summary:{amount:'1',amountOs:'1',payee:'TEST-payee',deadline:'TEST'},agreementHash:'TEST-agreement',agreementMessage:'TEST-agreement-message',anchorMessage:'TEST-anchor'}:null,post:'/agreement/sign'},
    {kind:'approval',label:/Approve exact terms/,calls:1,initial:ready(),reply:path=>path.endsWith('/challenge')?'challenge':null,post:'/approve'},
    {kind:'bundle',label:/Counter-sign completed bundle/,calls:2,initial:{...pending('awaiting-countersignature','settled_verified'),autoAdvance:{requiresSignature:true}},
      reply:path=>path.endsWith('/completion/request')?{bundleHash:'TEST-bundle',bundleMessage:'TEST-bundle-message',anchorMessage:'TEST-bundle-anchor'}:null,post:'/completion/countersign'},
  ];
  for(const {kind,keys=[kind],name=kind,label,calls,initial,reply,post} of kinds)await t.test(name,async()=>{
    const answer=async(path,_body,enrich)=>{
      if(path.endsWith(post))return lost();
      const r=reply(path);
      return r==='challenge'?{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge'}}:r?{ok:true,data:{signRequest:r}}:{ok:true,data:enrich(initial)};
    };
    const signButton=h=>h.document.getElementById('flow').querySelectorAll('button[data-action]').find(b=>label.test(b.text));
    const storage=tabStorage(),first=portalHarness(initial,answer,{storage});
    await first.start();await signButton(first).fire('click');
    assert.equal(first.wallet.length,calls,kind);assert.doesNotMatch(first.document.getElementById('log').text,/TEST lost POST/,kind);
    for(let i=0;i<3;i++){
      assert.ok(first.clock.timers.size>0,`${kind}: recovery keeps reading back`);await first.clock.advance([...first.clock.timers.values()][0].ms);
      const again=signButton(first);if(again)await again.fire('click');
    }
    assert.equal(first.wallet.length,calls,`${kind}: recovery never asks the wallet again`);assert.match(first.document.getElementById('flow').text,/will not be requested again/,kind);first.destroy();
    const reloaded=portalHarness(initial,answer,{storage});await reloaded.start();
    const again=signButton(reloaded);if(again)await again.fire('click');
    assert.equal(reloaded.wallet.length,0,`${kind}: a reload never asks the wallet again`);assert.match(reloaded.document.getElementById('flow').text,/will not be requested again/,kind);
    assert.ok(reloaded.clock.timers.size>0,`${kind}: the reloaded tab keeps reading back`);reloaded.destroy();
    const messages=first.wallet.map(req=>req.params[0]);assert.equal(new Set(messages).size,calls,`${kind}: each wallet message is requested exactly once`);
    assert.deepEqual(storage.keys().filter(k=>k.startsWith('dacs:auto:')).sort(),keys.map(key=>`dacs:auto:TEST:${key}`).sort(),kind);
  });
});

test('a 202 from the plan step, then a saved plan: the same tab asks for the Agreement signature once',async()=>{
  const view={status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'identity'}}};
  let saved=false;
  const storage=tabStorage();
  const h=portalHarness(view,async(path,body,enrich)=>{
    if(path.endsWith('/agreement/identity'))return{ok:true,data:{signRequest:{message:'TEST-identity'}}};
    if(path.endsWith('/agreement/plan'))return body.signature!==undefined&&!saved?{ok:true,status:202,data:{error:'plan_in_progress',message:'TEST plan step still running'}}
      :{ok:true,data:{signRequest:{summary:{amount:'1',amountOs:'1',payee:'TEST-payee',deadline:'TEST'},agreementHash:'TEST-agreement',agreementMessage:'TEST-agreement-message',anchorMessage:'TEST-anchor'}}};
    if(path.endsWith('/agreement/sign'))return{ok:true,data:enrich({...view,autoAdvance:{requiresSignature:false}})};
    return{ok:true,data:enrich(view)};
  },{storage});
  const signButton=()=>h.document.getElementById('flow').querySelectorAll('button[data-action]').find(b=>/Sign the DACS Agreement/.test(b.text));
  await h.start();await signButton().fire('click');
  assert.equal(h.wallet.length,1,'the presentation only');
  // The step still runs: this tab only reads back.
  await h.clock.advance([...h.clock.timers.values()][0].ms);
  assert.equal(signButton(),undefined);assert.match(h.document.getElementById('flow').text,/will not be requested again/);
  // The step saves its plan; the same tab may now ask for the Agreement signature, once.
  saved=true;view.evidence={protocol:{stage:'agreement-signing'}};
  await h.clock.advance([...h.clock.timers.values()][0].ms);
  await signButton().fire('click');
  assert.deepEqual(h.wallet.map(req=>req.params[0]),['TEST-identity','TEST-agreement-message','TEST-anchor']);
  assert.deepEqual(storage.keys().filter(k=>k.startsWith('dacs:auto:')).sort(),['dacs:auto:TEST:agreement-plan-presentation','dacs:auto:TEST:agreement-signature']);
  h.destroy();
});

test('a tab holding an earlier page\'s shared agreement claim stays readback-only for both Agreement steps',async()=>{
  for(const stage of ['identity','agreement-signing']){
    const storage=tabStorage();storage.setItem('dacs:auto:TEST:agreement','asked');
    const view={status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage}}};
    const h=portalHarness(view,async(_path,_body,enrich)=>({ok:true,data:enrich(view)}),{storage});
    await h.start();
    assert.equal(h.document.getElementById('flow').querySelectorAll('button[data-action]').find(b=>/Sign the DACS Agreement/.test(b.text)),undefined,stage);
    assert.match(h.document.getElementById('flow').text,/will not be requested again/,stage);
    assert.deepEqual(storage.keys().filter(k=>k.startsWith('dacs:auto:')),['dacs:auto:TEST:agreement'],`${stage}: nothing new claimed`);
    h.destroy();
  }
});

test('a recorded signature ends readback-only for that step, and the next step still asks the buyer',async()=>{
  const storage=tabStorage();let recorded=false;
  const h=portalHarness(ready(),async(path,_body,enrich)=>path.endsWith('/challenge')?{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge'}}:path.endsWith('/approve')?Promise.reject(new TypeError('TEST lost POST')):{ok:true,data:enrich(recorded?{status:'approved'}:ready())},{storage});
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');assert.equal(h.wallet.length,1);
  recorded=true;await h.clock.advance([...h.clock.timers.values()][0].ms);
  assert.match(h.document.getElementById('flow').text,/Send payment from wallet/);assert.equal(h.wallet.length,1);h.destroy();
});

test('a tab that cannot record the wallet request asks nothing',async()=>{
  const h=portalHarness(ready(),async(path,_body,enrich)=>path.endsWith('/challenge')?{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge'}}:{ok:true,data:enrich(ready())},{storage:{getItem:()=>null,setItem(){}}});
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');
  assert.equal(h.wallet.length,0);assert.match(h.document.getElementById('log').text,/could not record the wallet request/);h.destroy();
});

test('pending reads that differ only in observation times, deadline projections, poll metadata or attempt notes back off',async()=>{
  const clock=fakeClock();let n=0;
  const view=()=>{n++;return{status:'broadcast_reported',evidence:{reportedTxHash:'a'.repeat(64),protocol:{stage:'committed',lastAttempt:{at:n,outcome:'indeterminate'},deliveryDeadline:{pastDueMs:n,message:`TEST ${n} seconds ago`}}},verification:{outcome:'awaiting_inclusion',observedAt:new Date(n).toISOString()},poll:{pending:n%2===0,afterMs:1000}};};
  const auto=createPurchaseAutoAdvance({...clock,read:async()=>view(),render(){}});auto.observe(view());
  const delays=[];for(let i=0;i<6;i++){const timer=[...clock.timers.values()][0];delays.push(timer.ms);await clock.advance(timer.ms);}
  assert.deepEqual(delays,[500,1000,2000,4000,8000,8000]);
  auto.destroy();
  const progressed=[v=>({...v,status:'payment_uncertain'}),v=>({...v,verification:{...v.verification,outcome:'settled'}}),v=>({...v,evidence:{...v.evidence,reportedTxHash:'b'.repeat(64)}}),v=>({...v,evidence:{...v.evidence,protocol:{...v.evidence.protocol,stage:'awaiting-claim'}}})];
  for(const progress of progressed){
    const c=fakeClock();let reads=0;
    const fast=createPurchaseAutoAdvance({...c,read:async()=>++reads<3?view():progress(view()),render(){}});fast.observe(view());
    const seen=[];for(let i=0;i<4;i++){const timer=[...c.timers.values()][0];seen.push(timer.ms);await c.advance(timer.ms);}
    assert.deepEqual(seen,[500,1000,2000,500],String(progress));fast.destroy();
  }
});

test('an embedded wallet unlocked while boot waited is idle-locked after five minutes with no further input',async()=>{
  const h=portalHarness(ready(),async(_path,_body,enrich)=>({ok:true,data:enrich(ready())}));
  const w=await unlockedWallet(h.document);h.context.bootWallet=w.handle;vm.runInContext('embedded=bootWallet',h.context);
  await h.start();await h.clock.advance(299999);assert.equal(w.handle.getPublicState().locked,false);
  await h.clock.advance(1);assert.equal(w.locked(),1);assert.equal(w.handle.getPublicState().locked,true);assert.ok(w.material.every(b=>b===0));
  h.destroy();w.handle.destroy();
});

test('the enabled HTML entry needs exactly one script anchor: missing, renamed or duplicated anchors fail closed',()=>{
  const page=readFileSync(new URL('../public/portal/index.html',import.meta.url),'utf8'),script='<script type="module" src="/portal/assets/portal.js"></script>';
  assert.equal(autoAdvancePortalPage(page),page.replace('/portal/assets/portal.js','/portal/assets/auto-portal.js'));
  for(const drifted of [page.replace(script,''),page.replace(script,script.replace('portal.js','portal-v2.js')),page.replace(script,script+script),page.replace('</head>','<link rel="modulepreload" href="/portal/assets/portal.js"></head>'),page.replace(script,script.replace(' type="module"',''))])
    assert.throws(()=>autoAdvancePortalPage(drifted),/entry drift/);
});

test('in the same page a lost Agreement submission keeps its broker session: the CREATE asks for no second session signature',async()=>{
  let sessions=0,creates=0;
  const held={status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'identity',limits:{payment:'held'}}}},recorded={...held,autoAdvance:{requiresSignature:false},evidence:{protocol:{stage:'agreement-signing',limits:{payment:'held'}}}};
  let submitted=false;
  const h=portalHarness(held,async(path,_body,enrich)=>path.endsWith('/agreement/identity')?{ok:true,data:{signRequest:{message:'TEST-identity'}}}
    :path.endsWith('/agreement/plan')?{ok:true,data:{signRequest:{summary:{amount:'1',amountOs:'1',payee:'TEST-payee',deadline:'TEST'},agreementHash:'TEST-agreement',agreementMessage:'TEST-agreement-message'}}}
    :path.endsWith('/agreement/sign')?(submitted=true,Promise.reject(new TypeError('TEST lost POST'))):{ok:true,data:enrich(submitted?recorded:held)});
  h.context.fakeBroker={authenticate:async({sign})=>{sessions++;await sign('TEST-session');},approveOne:async provider=>{creates++;await provider.request({method:'TEST-create'});}};
  vm.runInContext('offlineAgreementBroker=fakeBroker',h.context);
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');
  assert.equal(sessions,1);assert.deepEqual(h.wallet.map(req=>req.params?.[0]),['TEST-identity','TEST-agreement-message','TEST-session']);
  await h.clock.advance([...h.clock.timers.values()][0].ms);
  const create=h.document.getElementById('flow').querySelectorAll('button[data-action]').find(b=>/Approve Agreement CREATE/.test(b.text));assert.ok(create,h.document.getElementById('flow').text);
  await create.fire('click');assert.equal(creates,1);assert.equal(sessions,1);assert.equal(h.wallet.length,4);assert.equal(h.wallet[3].method,'TEST-create');h.destroy();
});

test('a sent payment whose report is lost is verified by its public hash, without another payment approval',async()=>{
  const h=portalHarness({status:'approved'},async(path,_body,enrich)=>path.endsWith('/handoff')?{ok:true,data:{...enrich({status:'payment_handoff'}),payload:{TEST:'transaction'}}}:path.endsWith('/report')?Promise.reject(new TypeError('TEST dropped HTTP response')):{ok:true,data:enrich({status:'approved'})});
  await h.start();await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await h.clock.advance(500);
  assert.equal(h.wallet.length,1);assert.equal(h.requests.find(req=>req.path.endsWith('/auto/recheck')).body.txHash,'a'.repeat(64));
  assert.doesNotMatch(h.document.getElementById('flow').text,/Send payment from wallet/);h.destroy();
});

test('the embedded wallet unlocked during a purchase is idle-locked; at purchase end it locks, and a later unlock is refused as the page wallet',async()=>{
  let locked=true,locks=0;const handle={lock(){locked=true;locks++;},getPublicState:()=>({locked})};
  const h=portalHarness(pending(),async(_path,_body,enrich)=>({ok:true,data:enrich(pending('completed','settled_verified'))}));
  h.context.handle=handle;vm.runInContext("embedded=handle;walletSource='embedded'",h.context);await h.start();
  locked=false;h.context.unlockedProvider={TEST:'unlocked'};vm.runInContext('onEmbeddedProvider(unlockedProvider)',h.context);
  assert.equal(vm.runInContext('provider',h.context),h.context.unlockedProvider);assert.ok([...h.clock.timers.values()].some(t=>t.ms===300000),'unlock arms the idle lock');
  await h.clock.advance(500);assert.equal(locked,true,'purchase end locks');const ended=locks;
  locked=false;h.context.lateProvider={TEST:'late'};vm.runInContext('onEmbeddedProvider(lateProvider)',h.context);
  assert.equal(locked,true);assert.equal(locks,ended+1);assert.notEqual(vm.runInContext('provider',h.context),h.context.lateProvider);h.destroy();
});

test('a CREATE refused before the broker hands it to the wallet claims nothing; the next approval opens a new session and asks once',async()=>{
  let sessions=0,claims=0;
  const h=portalHarness(pending('agreement-signing'),async(_path,_body,enrich)=>({ok:true,data:enrich(pending('agreement-signing'))}));
  h.context.fakeBroker={authenticate:async()=>{sessions++;},approveOne:async provider=>{if(++claims===1)throw Object.assign(new Error('TEST broker session expired'),{code:'broker_session_missing'});await provider.request({method:'TEST-create'});return{state:'completed'};}};
  vm.runInContext('offlineAgreementBroker=fakeBroker',h.context);
  await h.start();const create=()=>h.document.getElementById('flow').querySelectorAll('button[data-action]').find(b=>/Approve Agreement CREATE/.test(b.text));
  await create().fire('click');
  assert.match(h.document.getElementById('log').text,/TEST broker session expired/);assert.equal(h.wallet.length,0);assert.equal(h.storage.getItem('dacs:auto:TEST:create'),null);assert.equal(create().disabled,false);
  await create().fire('click');
  assert.equal(sessions,2,'a refused claim needs a new session');assert.deepEqual(h.wallet.map(req=>req.method),['TEST-create']);assert.equal(h.storage.getItem('dacs:auto:TEST:create'),'asked');assert.equal(create(),undefined);h.destroy();
});

test('teardown is final: a late action failure after pagehide cannot restart polling or rendering',async()=>{
  const clock=fakeClock(),shown=[];let reads=0,resolve;
  const auto=createPurchaseAutoAdvance({...clock,read:()=>{reads++;return new Promise(r=>resolve=r);},render:v=>shown.push(v)});
  auto.observe(pending());await clock.advance(500);assert.equal(reads,1);
  auto.destroy();assert.equal(auto.recover({status:409}),true);auto.resume();resolve(pending('committed','settled_verified'));await flush();
  assert.equal(clock.timers.size,0);assert.equal(shown.length,0);await clock.advance(10000);assert.equal(reads,1);
});

test('the page hash is retired once the server holds a pointer or reports a conflict',async()=>{
  const clock=fakeClock(),sent=[];let next=[{status:'broadcast_reported',evidence:{reportedTxHash:'b'.repeat(64)}},{status:'broadcast_reported',evidence:{reportedTxHash:'b'.repeat(64)}}];
  const auto=createPurchaseAutoAdvance({...clock,read:async hash=>{sent.push(hash);return next.shift();},render(){}});
  auto.rememberHash('a'.repeat(64));auto.observe({status:'payment_uncertain'});await clock.advance(500);await clock.advance(1000);
  assert.deepEqual(sent,['a'.repeat(64),null]);auto.destroy();
  const other=createPurchaseAutoAdvance({...clock,read:async hash=>{sent.push(hash);throw Object.assign(new Error('TEST conflict'),{code:'hash_conflict',status:409});},render(){}});
  sent.length=0;other.rememberHash('a'.repeat(64));other.observe({status:'payment_uncertain'});await clock.advance(500);await clock.advance(1000);
  assert.deepEqual(sent,['a'.repeat(64),null]);other.destroy();
});

// Teardown also stops action continuations that succeed late.
const countersignable={status:'settled_verified',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'awaiting-countersignature'}}};
const bundleRequest={ok:true,data:{signRequest:{bundleHash:'TEST-bundle',bundleMessage:'TEST-message',anchorMessage:'TEST-anchor'}}};

test('a bundle request answered after pagehide asks neither the extension nor the embedded wallet, claims nothing and posts nothing',async()=>{
  for(const source of ['extension','embedded']){
    let release;
    const h=portalHarness(countersignable,async(path,_body,enrich)=>path.endsWith('/completion/request')?new Promise(r=>release=()=>r(bundleRequest)):{ok:true,data:enrich(countersignable)});
    if(source==='extension')vm.runInContext("walletSource='extension';delete fakeProvider.isDacsEmbeddedWallet",h.context);
    await h.start();const before=h.document.getElementById('flow').text;
    const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.ok(release,source);h.destroy();release();await action;
    assert.equal(h.wallet.length,0,source);assert.equal(h.storage.getItem('dacs:auto:TEST:bundle'),null,source);
    assert.ok(!h.requests.some(r=>r.path.endsWith('/completion/countersign')),source);assert.equal(h.document.getElementById('flow').text,before,source);
  }
});

test('pagehide between the two bundle signatures stops before the second wallet request',async()=>{
  let signed=null;
  const h=portalHarness(countersignable,async(path,_body,enrich)=>path.endsWith('/completion/request')?bundleRequest:{ok:true,data:enrich(countersignable)});
  // Only the first signature is held; any later one answers at once.
  h.context.fakeProvider.request=req=>{h.wallet.push(req);const answer={success:true,data:'TEST-signature'};if(signed)return Promise.resolve(answer);return new Promise(r=>signed=()=>r(answer));};
  await h.start();
  const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
  assert.equal(h.wallet.length,1);h.destroy();signed();await action;
  assert.deepEqual(h.wallet.map(r=>r.params[0]),['TEST-message'],'the anchor signature is not requested');
  assert.ok(!h.requests.some(r=>r.path.endsWith('/completion/countersign')));
});

test('a recheck that answers after pagehide renders nothing and makes no fallback read, whether it succeeds or fails',async()=>{
  for(const outcome of ['success','failure']){
    let release;
    const h=portalHarness(pending(),async(_path,_body,enrich)=>new Promise((r,fail)=>release=()=>outcome==='success'?r({ok:true,data:enrich(ready())}):fail(new TypeError('TEST lost response'))));
    await h.start();const before=h.document.getElementById('flow').text;
    const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    const asked=h.requests.length;h.destroy();release();await action;await h.clock.advance(10000);
    assert.equal(h.document.getElementById('flow').text,before,`late ${outcome} must not render`);
    assert.equal(h.requests.length,asked,`no /view fallback or later read after ${outcome}`);assert.equal(h.wallet.length,0);
  }
});

test('a payment report already under way after pagehide is still sent, but its answer renders nothing',async()=>{
  let sent;
  const answer=async(path,_body,enrich)=>path.endsWith('/handoff')?{ok:true,data:{...enrich({status:'payment_handoff'}),payload:{TEST:'transaction'}}}:{ok:true,data:enrich({status:'broadcast_reported'})};
  const h=portalHarness({status:'approved'},answer);
  h.context.fakeProvider.request=req=>{h.wallet.push(req);return new Promise(r=>sent=()=>r({success:true,data:{hash:'a'.repeat(64)}}));};
  await h.start();const before=h.document.getElementById('flow').text;
  const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
  assert.equal(h.wallet.length,1);h.destroy();sent();await action;
  assert.deepEqual(h.requests.filter(r=>r.path.endsWith('/report')).map(r=>r.body.txHash),['a'.repeat(64)],'the wallet result is reported once');
  assert.equal(h.document.getElementById('flow').text,before,'the late report answer must not render');assert.equal(h.wallet.length,1);
});

test('after pagehide a stale approval button does nothing: no challenge request and no wallet request',async()=>{
  const h=portalHarness(ready(),async(_path,_body,enrich)=>({ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge',...enrich(ready())}}));
  await h.start();const asked=h.requests.length;h.destroy();
  await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');
  assert.equal(h.requests.length,asked);assert.equal(h.wallet.length,0);
});

test('after destroy the controller starts no check, claims nothing, ignores views and absorbs late errors silently',async()=>{
  const clock=fakeClock(),storage=tabStorage(),notices=[];let reads=0,ends=0,fail;
  const auto=createPurchaseAutoAdvance({...clock,storage,key:'TEST',read:()=>{reads++;return new Promise((_r,f)=>fail=f);},render(){},notice:m=>notices.push(m),end:()=>ends++});
  auto.observe(pending());await clock.advance(500);assert.equal(reads,1);
  auto.destroy();fail(Object.assign(new Error('TEST late failure'),{status:500}));await flush();
  assert.deepEqual(notices,[],'a read failing after teardown is silent');assert.equal(ends,0);
  assert.equal(await auto.check(),null);assert.equal(reads,1);
  assert.throws(()=>auto.claim('bundle'),err=>err.code==='page_closed');assert.throws(()=>auto.markWrite(),err=>err.code==='page_closed');assert.deepEqual(storage.keys(),[]);
  assert.throws(()=>auto.live(),err=>err.code==='page_closed');
  auto.observe({status:'cancelled'});auto.resume();assert.equal(ends,0,'a late view does not end the purchase');assert.equal(clock.timers.size,0);
  assert.equal(auto.recover({status:409}),true);assert.equal(auto.recover(new Error('TEST late failure')),true);assert.deepEqual(notices,[]);
  await clock.advance(10000);assert.equal(reads,1);
});

// Continuations that resume after pagehide submit nothing.
const native={protocol:{stage:'payment-held',nativePayment:{}}};
const held={status:'agreement_pending',autoAdvance:{requiresSignature:true},evidence:{protocol:{stage:'identity',limits:{payment:'held'}}}};
const agreementAnswer=(path,enrich)=>path.endsWith('/agreement/identity')?{ok:true,data:{signRequest:{message:'TEST-identity'}}}
  :path.endsWith('/agreement/plan')?{ok:true,data:{signRequest:{summary:{amount:'1',amountOs:'1',payee:'TEST-payee',deadline:'TEST'},agreementHash:'TEST-agreement',agreementMessage:'TEST-agreement-message'}}}
  :{ok:true,data:enrich(held)};
// The wallet answers at once, except its request number `at`, which waits for release().
function holdWallet(h,at){
  const hold={release:null};
  h.context.fakeProvider.request=req=>{h.wallet.push(req);const answer={success:true,data:'TEST-signature'};if(h.wallet.length!==at)return Promise.resolve(answer);return new Promise(r=>hold.release=()=>r(answer));};
  return hold;
}

test('a payment step answered after pagehide asks the wallet nothing and reports no wallet error',async()=>{
  const cases={
    handoff:{initial:{status:'approved'},answer:(path,enrich,late)=>path.endsWith('/handoff')?late({...enrich({status:'payment_handoff'}),payload:{TEST:'transaction'}}):{ok:true,data:enrich({status:'payment_uncertain'})}},
    'native approval':{initial:ready(),answer:(path,enrich,late)=>path.endsWith('/challenge')?{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge'}}:path.endsWith('/approve')?late({...enrich({status:'payment_handoff',evidence:native}),payload:{TEST:'transaction'}}):{ok:true,data:enrich({status:'payment_uncertain'})}},
  };
  for(const [name,{initial,answer}] of Object.entries(cases)){
    let release;
    const h=portalHarness(initial,async(path,_body,enrich)=>answer(path,enrich,data=>new Promise(r=>release=()=>r({ok:true,data}))));
    await h.start();
    const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.ok(release,name);h.destroy();release();await action;await flush();
    assert.equal(h.wallet.filter(r=>r.method==='sendTransaction').length,0,name);assert.equal(h.storage.getItem('dacs:auto:TEST:payment'),null,name);
    assert.deepEqual(h.requests.filter(r=>r.path.endsWith('/report')).map(r=>r.body),[],`${name}: no wallet error for a request never made`);
  }
});

test('a wallet error is reported whatever its code, before or after pagehide, once the wallet was asked',async()=>{
  for(const late of [false,true]){
    let answerWallet;
    const h=portalHarness({status:'approved'},async(path,_body,enrich)=>path.endsWith('/handoff')?{ok:true,data:{...enrich({status:'payment_handoff'}),payload:{TEST:'transaction'}}}:{ok:true,data:enrich({status:'payment_failed'})});
    h.context.fakeProvider.request=req=>{h.wallet.push(req);return new Promise(r=>answerWallet=()=>r({success:false,error:{code:'page_closed',message:'TEST wallet window closed'}}));};
    await h.start();
    const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.ok(answerWallet,`late=${late}: the wallet was asked`);
    if(late)h.destroy();
    answerWallet();await action;await flush();
    assert.equal(h.wallet.length,1);
    assert.deepEqual(h.requests.filter(r=>r.path.endsWith('/report')).map(r=>r.body.walletError),['TEST wallet window closed'],`late=${late}`);
    if(!late)h.destroy();
  }
});

test('an action waiting for an in-flight read when pagehide comes starts no request and asks no wallet',async()=>{
  let release;
  const h=portalHarness(ready(),async(path,_body,enrich)=>path.endsWith('/auto/recheck')?new Promise(r=>release=()=>r({ok:true,data:enrich(ready())})):{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge',...enrich(ready())}});
  await h.start();
  const read=vm.runInContext('purchaseAuto.check()',h.context);await flush();assert.ok(release);
  const asked=h.requests.length;
  const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
  h.destroy();release();await read;await action;
  assert.equal(h.requests.length,asked,'no challenge after the read drains');assert.equal(h.wallet.length,0);assert.equal(h.storage.getItem('dacs:auto:TEST:approval'),null);
});

test('a signature that returns after pagehide is not submitted',async()=>{
  const cases={
    approval:{initial:ready(),at:1,answer:(path,enrich)=>path.endsWith('/challenge')?{ok:true,data:{message:'TEST-message',challengeId:'TEST-challenge'}}:{ok:true,data:enrich({status:'approved'})},after:'/approve'},
    'bundle anchor':{initial:countersignable,at:2,answer:(path,enrich)=>path.endsWith('/completion/request')?bundleRequest:{ok:true,data:enrich(countersignable)},after:'/completion/countersign'},
    'Agreement presentation':{initial:held,at:1,answer:(path,enrich)=>agreementAnswer(path,enrich),after:'/agreement/plan'},
  };
  for(const [name,{initial,at,answer,after}] of Object.entries(cases)){
    const h=portalHarness(initial,async(path,_body,enrich)=>answer(path,enrich)),hold=holdWallet(h,at);
    await h.start();const before=h.document.getElementById('flow').text;
    const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
    assert.ok(hold.release,name);h.destroy();hold.release();await action;await flush();
    assert.equal(h.wallet.length,at,`${name}: no further wallet request`);
    assert.ok(!h.requests.some(r=>r.path.endsWith(after)),`${name}: ${after} is not posted`);
    assert.equal(h.document.getElementById('flow').text,before,name);assert.doesNotMatch(h.document.getElementById('log').text,/page was closed/,name);
  }
});

test('a broker session that completes after pagehide submits no Agreement',async()=>{
  let release;
  const h=portalHarness(held,async(path,_body,enrich)=>agreementAnswer(path,enrich));
  h.context.fakeBroker={authenticate:async({sign})=>{await sign('TEST-session');await new Promise(r=>release=r);},approveOne:async()=>{throw new Error('TEST no CREATE');}};
  vm.runInContext('offlineAgreementBroker=fakeBroker',h.context);
  await h.start();
  const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
  assert.ok(release);assert.deepEqual(h.wallet.map(req=>req.params?.[0]),['TEST-identity','TEST-agreement-message','TEST-session']);
  h.destroy();release();await action;await flush();
  assert.ok(!h.requests.some(r=>r.path.endsWith('/agreement/sign')),'the Agreement is not submitted');assert.equal(h.wallet.length,3);
});

test('an Agreement plan answered after pagehide asks the wallet for no further signature',async()=>{
  let release;
  const h=portalHarness(held,async(path,_body,enrich)=>path.endsWith('/agreement/plan')?new Promise(r=>release=()=>r(agreementAnswer(path,enrich))):agreementAnswer(path,enrich));
  await h.start();
  const action=h.document.getElementById('flow').querySelector('button[data-action]').fire('click');await flush();
  assert.ok(release);assert.deepEqual(h.wallet.map(req=>req.params?.[0]),['TEST-identity']);
  h.destroy();release();await action;await flush();
  assert.deepEqual(h.wallet.map(req=>req.params?.[0]),['TEST-identity'],'the Agreement itself is not requested');
  assert.ok(!h.requests.some(r=>r.path.endsWith('/agreement/sign')));
});
