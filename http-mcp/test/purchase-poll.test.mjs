import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPurchasePoll } from '../src/portal/purchase-poll.mjs';

test('one-second fake-clock purchase polls share one in-flight workflow; lost HTTP responses do not restart it',async()=>{
  const timers=new Map();let time=0,seq=0,calls=0,complete;
  const poll=createPurchasePoll({setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:time+ms});return id;},clearTimer:id=>timers.delete(id)});
  const work=()=>{calls++;return new Promise(resolve=>complete=resolve);},current=()=>({stage:'pending'});
  const first=poll.poll('purchase',work,current);await Promise.resolve();
  assert.equal(calls,1);assert.equal([...timers.values()][0].at,1000);
  time=1000;for(const timer of [...timers.values()])timer.fn();
  assert.deepEqual(await first,{pending:true,result:{stage:'pending'}});
  const second=poll.poll('purchase',work,current);await Promise.resolve();assert.equal(calls,1);
  time=2000;for(const timer of [...timers.values()])timer.fn();await second;
  const third=poll.poll('purchase',work,current);complete({stage:'verified'});
  assert.deepEqual(await third,{pending:false,result:{stage:'verified'}});
  assert.equal(calls,1);assert.equal(timers.size,0);await poll.drain();
});

// Fake clock: timers fire only when the test advances time.
function fakeClock(){
  const timers=new Map();let time=0,seq=0;
  return{now:()=>time,setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:time+ms});return id;},clearTimer:id=>timers.delete(id),timers,
    advance(ms){time+=ms;for(const [id,timer] of [...timers])if(timer.at<=time){timers.delete(id);timer.fn();}}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('a workflow that settles between two one-second polls is handed to the next poll, not thrown away and started again',async()=>{
  const clock=fakeClock();let calls=0,complete;
  const poll=createPurchasePoll(clock);
  const work=()=>{calls++;return new Promise(resolve=>complete=resolve);},current=()=>({stage:'pending'});
  const first=poll.poll('purchase',work,current);await tick();
  clock.advance(1000);assert.deepEqual(await first,{pending:true,result:{stage:'pending'}});
  // Settles at 1.5 s, while no poll is waiting.
  clock.advance(500);complete({stage:'seller-committed'});await tick();
  clock.advance(500);
  assert.deepEqual(await poll.poll('purchase',work,current),{pending:false,result:{stage:'seller-committed'}});
  assert.equal(calls,1,'the settled workflow is delivered once; no second copy started');
  // Consumed: the next poll is a new, user-initiated recheck.
  const next=poll.poll('purchase',work,current);await tick();assert.equal(calls,2);
  complete({stage:'seller-committed'});assert.equal((await next).pending,false);assert.equal(clock.timers.size,0);
});

test('a failure between polls stays a failure for the next poll; uncollected outcomes expire after 30 s and are never served stale',async()=>{
  const clock=fakeClock();let calls=0,settle;
  const poll=createPurchasePoll(clock);
  const work=()=>{calls++;return new Promise((resolve,reject)=>settle={resolve,reject});},current=()=>({stage:'pending'});
  const first=poll.poll('purchase',work,current);await tick();clock.advance(1000);assert.equal((await first).pending,true);
  settle.reject(Object.assign(new Error('seller unavailable'),{code:'seller_agent_unavailable'}));await tick();
  await assert.rejects(poll.poll('purchase',work,current),{code:'seller_agent_unavailable'});assert.equal(calls,1);
  // A settled outcome that no poll collects within 30 s is dropped.
  const again=poll.poll('purchase',work,current);await tick();assert.equal(calls,2);
  clock.advance(1000);assert.equal((await again).pending,true);
  settle.resolve({stage:'old'});await tick();
  clock.advance(30001);
  const fresh=poll.poll('purchase',work,current);await tick();
  assert.equal(calls,3,'an expired outcome starts a fresh workflow');
  settle.resolve({stage:'current'});assert.deepEqual(await fresh,{pending:false,result:{stage:'current'}});
  // Outcomes are kept per purchase.
  const pollA=poll.poll('a',work,current);await tick();const settleA=settle;
  const pollB=poll.poll('b',work,current);await tick();const settleB=settle;assert.equal(calls,5);
  clock.advance(1000);assert.equal((await pollA).pending,true);assert.equal((await pollB).pending,true);
  settleA.resolve({stage:'a-done'});await tick();
  const laterB=poll.poll('b',work,current);await tick();assert.equal(calls,5,'b keeps sharing its own in-flight workflow');
  clock.advance(1000);assert.deepEqual(await laterB,{pending:true,result:{stage:'pending'}});
  assert.deepEqual(await poll.poll('a',work,current),{pending:false,result:{stage:'a-done'}});
  settleB.resolve({stage:'b-done'});await tick();
  assert.deepEqual(await poll.poll('b',work,current),{pending:false,result:{stage:'b-done'}});
  assert.equal(calls,5);
});

test('shutdown drain is bounded: a hung workflow cannot hold close() open',async()=>{
  const clock=fakeClock();let complete;
  const poll=createPurchasePoll(clock);
  assert.equal(await poll.drain({timeoutMs:5000}),true,'nothing in flight');
  const hung=poll.poll('purchase',()=>new Promise(resolve=>complete=resolve),()=>({stage:'pending'}));await tick();
  clock.advance(1000);await hung;
  const drained=poll.drain({timeoutMs:5000});await tick();
  clock.advance(4999);await tick();
  let done=false;drained.then(()=>done=true);await tick();assert.equal(done,false);
  clock.advance(1);assert.equal(await drained,false,'drain gives up at its bound');
  const settling=poll.drain({timeoutMs:5000});complete({stage:'done'});assert.equal(await settling,true);
  assert.equal(clock.timers.size,0);
});

function portalRecheck(api,clock){
  const source=readFileSync(new URL('../public/portal/portal.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('async function recheckPurchase('),source.indexOf('const fragment ='));
  const waits=[];
  const context=vm.createContext({api,setTimeout:(fn,ms)=>{waits.push(ms);clock.time+=ms;fn();}});
  vm.runInContext(helper,context);
  return{recheckPurchase:context.recheckPurchase,waits};
}

test('portal repeats only pending protocol polls at one second, shows each pending view as it arrives, and never asks the wallet',async()=>{
  const clock={time:0},requests=[],shown=[];let remaining=2;
  const {recheckPurchase,waits}=portalRecheck(async(path,body)=>{requests.push({path,body});clock.time+=1000;
    return remaining-->0?{poll:{pending:true,afterMs:1000},status:'agreement_pending',evidence:{protocol:{stage:`pending-${remaining}`}}}:{poll:{pending:false,afterMs:1000},status:'awaiting_approval'};},clock);
  const settled=await recheckPurchase('pur-fixture','secret',{onPending:(view)=>shown.push(view.evidence.protocol.stage),now:()=>clock.time});
  assert.equal(settled.status,'awaiting_approval');assert.equal(settled.poll.deadlineReached,undefined);
  assert.deepEqual(waits,[1000,1000]);assert.deepEqual(shown,['pending-1','pending-0']);assert.equal(requests.length,3);
  assert.ok(requests.every(r=>r.path==='/portal/api/purchase/pur-fixture/protocol/recheck'&&r.body.token==='secret'));
});

test('portal recheck polling stops at its overall deadline with the latest pending view marked; the last wait is clamped',async()=>{
  const clock={time:0},requests=[];let shown=0;
  const pending=async(path,body)=>{requests.push({path,body});clock.time+=1000;return{poll:{pending:true,afterMs:1000},status:'agreement_pending',evidence:{protocol:{stage:'seller-commit-requested'}}};};
  const {recheckPurchase,waits}=portalRecheck(pending,clock);
  const view=await recheckPurchase('pur-fixture','secret',{onPending:()=>shown++,now:()=>clock.time});
  assert.equal(view.poll.deadlineReached,true);assert.equal(view.poll.pending,true);assert.equal(view.evidence.protocol.stage,'seller-commit-requested');
  // Each cycle is a 1 s server answer plus a 1 s pause; the default bound is 90 s.
  assert.equal(requests.length,46);assert.equal(shown,45);assert.ok(clock.time>=90000&&clock.time<=92000,String(clock.time));
  assert.ok(requests.every(r=>r.path==='/portal/api/purchase/pur-fixture/protocol/recheck'));
  const short={time:0},shortRun=portalRecheck(async()=>{short.time+=1000;return{poll:{pending:true}};},short);
  assert.equal((await shortRun.recheckPurchase('pur-fixture','secret',{deadlineMs:1500,now:()=>short.time})).poll.deadlineReached,true);
  assert.deepEqual(shortRun.waits,[500],'the final pause never runs past the deadline');
});
