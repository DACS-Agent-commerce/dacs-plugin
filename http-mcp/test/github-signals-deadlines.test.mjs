import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createGithubSignals } from '../src/identity-signals/github.mjs';
import { createGithubQueue } from '../src/identity-signals/github-http.mjs';

// Which failures a shared GitHub job caches, and for how long. A result cut short
// by one caller's deadline is kept for 30 seconds while another current caller
// has longer; GitHub errors and the five-second request ceiling are cached for
// five minutes.
// The clock and timers are controlled, so timer order and Node's truncation of
// fractional delays are exact. As in Node, microtasks run between timer callbacks.

const login='deadline-seller', profile={id:42,login,type:'User',created_at:'2010-01-02T03:04:05Z'};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const turns=async(n=80)=>{for(let i=0;i<n;i++)await Promise.resolve();};
const defer=()=>{let resolve;const promise=new Promise((r)=>{resolve=r;});return {resolve,promise};};

async function clocked(run) {
  const saved={performance:globalThis.performance,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
  const timers=new Map();let mono=1000,seq=0;
  globalThis.performance={now:()=>mono};
  globalThis.setTimeout=(fn,delay,...args)=>{const id=++seq;timers.set(id,{fn:()=>fn(...args),at:mono+Math.trunc(delay)});return id;};
  globalThis.clearTimeout=(id)=>timers.delete(id);
  try {
    await run({
      set:(t)=>{mono=t;},
      fire:async(at)=>{mono=at;for(const [id,t] of [...timers])if(t.at<=at&&timers.has(id)){timers.delete(id);t.fn();await turns();}},
    });
  } finally { Object.assign(globalThis,saved); }
}

// Two sellers bound to the same GitHub account; their statistics failed during
// setup and that five-minute entry has expired, so the next call fetches.
async function setup() {
  let time=Date.now(),mode='fail',hang=false,gate=null,calls=0,gists=0;
  const wallets=[createEphemeralWallet(),createEphemeralWallet()];
  const entries=wallets.map((w,i)=>({username:login,proof:`https://gist.github.com/${login}/${i+1}`}));
  const proofs=wallets.map((w)=>({owner:{id:42,login},files:{p:{truncated:false,content:`demos:dw2p:ed25519:${w.signHex(`demos-web2:v1:github:${login}:${w.address}`)}`}}}));
  const fetchImpl=async(url,{signal}={})=>{
    calls++;
    if(hang==='abortable')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
    if(url.pathname.startsWith('/gists/')){gists++;if(hang==='gists')return new Promise(()=>{});return json(proofs[Number(url.pathname.slice(-1))-1]);}
    if(hang===true||(hang==='repos'&&url.pathname.includes('/repos')))return new Promise(()=>{});
    if(gate&&url.pathname==='/user/42'){const g=gate;g.started.resolve();await g.release.promise;}
    return json(mode==='fail'?{}:url.pathname==='/user/42'?profile:[],mode==='fail'?500:200);
  };
  const service=createGithubSignals({now:()=>time,queue:createGithubQueue({now:()=>time}),fetchImpl});
  wallets.forEach((w,i)=>service.observe('test',w.address,[entries[i]]));
  const get=(i,deadline)=>service.signals('test',wallets[i].address,entries[i],login,{deadline});
  for(const i of [0,1])assert.equal((await get(i,performance.now()+60_000)).bindingStatus,'bound');
  time+=300_001;mode='ok';
  return {get,service,calls:()=>calls,gists:()=>gists,advance:(ms)=>{time+=ms;},hang:(how=true)=>{hang=how;},hangRepos:()=>{hang='repos';},fail:()=>{mode='fail';},ok:()=>{hang=false;mode='ok';},
    gate:()=>(gate={started:defer(),release:defer()}),ungate:()=>{gate=null;}};
}

test('a cutoff at the starter\'s deadline is kept only 30 seconds while another seller has longer, even when the timer fires early',async()=>{
  await clocked(async(clock)=>{
    const f=await setup();f.hang();
    // Node truncates the 100.5 ms delay, so the cutoff fires at 1100, before the deadline.
    const a=f.get(0,1100.5);await turns();const b=f.get(1,3000);await turns();
    assert.equal(f.service.retainedSize().pendingWaiters,2);
    await clock.fire(1100);
    assert.equal((await a).stars,undefined);assert.equal((await b).stars,undefined);
    f.ok();const n=f.calls();
    assert.equal((await f.get(1,3000)).stars,undefined);assert.equal(f.calls(),n,'kept for 30 seconds');
    f.advance(30_001);const retry=await f.get(1,3000);
    assert.equal(retry.stars.total,0);assert.equal(f.calls(),n+2,'the call after 30 seconds fetched profile and repositories again');
  });
});

test('the five-second request ceiling is cached, before or after the starter\'s deadline',async()=>{
  for(const at of [6000,12000]) await clocked(async(clock)=>{
    const f=await setup();f.hang();
    const a=f.get(0,11000);await turns();const b=f.get(1,21000);await turns();
    await clock.fire(at);
    assert.equal((await a).stars,undefined);assert.equal((await b).stars,undefined);
    f.ok();const n=f.calls();
    assert.equal((await f.get(1,21000)).stars,undefined);assert.equal(f.calls(),n,`ceiling at ${at} cached`);
  });
});

test('a GitHub error processed after the starter\'s deadline is cached',async()=>{
  await clocked(async(clock)=>{
    const f=await setup();const g=f.gate();
    const a=f.get(0,1100.5);await g.started.promise;const b=f.get(1,3000);await turns();
    // No timer fires: the 500 arrives before the cutoff and is handled after it.
    f.fail();clock.set(1200);g.release.resolve();
    assert.equal((await a).stars,undefined);assert.equal((await b).stars,undefined);
    f.ungate();f.ok();const n=f.calls();
    assert.equal((await f.get(1,3000)).stars,undefined);assert.equal(f.calls(),n,'GitHub error cached for five minutes');
  });
});

test('repositories cut by the starter\'s deadline give partial statistics kept only 30 seconds while another seller has longer',async()=>{
  await clocked(async(clock)=>{
    const f=await setup();f.hangRepos();
    const a=f.get(0,1100.5);await turns();const b=f.get(1,3000);await turns();
    await clock.fire(1101);
    await a;const out=await b;
    assert.equal(out.stars.total,0);assert.equal(out.stars.complete,false);assert.match(out.label,/at least 0 stars/);
    assert.equal(JSON.stringify(out).includes('cutoff'),false,'the cutoff never reaches the result');
    f.ok();const n=f.calls(),kept=await f.get(1,3000);
    assert.equal(kept.stars.complete,false);assert.equal(f.calls(),n,'partial statistics kept for 30 seconds');
    assert.equal(JSON.stringify(kept).includes('cutoff'),false);
    f.advance(30_001);const retry=await f.get(1,3000);
    assert.equal(retry.stars.complete,true);assert.equal(f.calls(),n+2);
  });
});

test('repositories cut by the only waiter\'s deadline are cached as partial for five minutes',async()=>{
  await clocked(async(clock)=>{
    const f=await setup();f.hangRepos();
    const a=f.get(0,1100.5);await turns();
    await clock.fire(1101);
    // A's own deadline has passed, so its call returns without statistics.
    assert.equal((await a).stars,undefined);
    f.ok();const n=f.calls(),retry=await f.get(0,3000);
    assert.equal(retry.stars.complete,false);assert.equal(f.calls(),n);
    assert.equal(JSON.stringify(retry).includes('cutoff'),false);
  });
});

test('an aborted request is a cutoff when the caller\'s deadline ended it',async()=>{
  await clocked(async(clock)=>{
    const f=await setup();f.hang('abortable');
    const a=f.get(0,1100.5);await turns();const b=f.get(1,3000);await turns();
    await clock.fire(1100);
    assert.equal((await a).stars,undefined);assert.equal((await b).stars,undefined);
    f.ok();const n=f.calls();
    assert.equal((await f.get(1,3000)).stars,undefined);assert.equal(f.calls(),n,'the aborted cutoff was kept for 30 seconds');
    f.advance(30_001);
    assert.equal((await f.get(1,3000)).stars.total,0);assert.equal(f.calls(),n+2,'then fetched again');
  });
});

test('a gist check cut by the deadline is kept only 30 seconds while the same link waits with more time',async()=>{
  await clocked(async(clock)=>{
    const f=await setup();f.advance(900_001);f.hang('gists');
    const a=f.get(0,1100.5);await turns();const again=f.get(0,3000);await turns();
    assert.equal(f.service.retainedSize().pendingWaiters,1);
    await clock.fire(1100);
    assert.equal((await a).bindingStatus,'bound');assert.equal((await again).cache,'stale');
    f.ok();const n=f.gists();
    await f.get(0,3000);assert.equal(f.gists(),n,'kept for 30 seconds');
    f.advance(30_001);
    await f.get(0,3000);assert.equal(f.gists(),n+1,'the call after 30 seconds checked the gist again');
  });
});

// Sellers X and Y name the same gist URL (only X signed it), so their binding
// jobs share one HTTP request. Y's own deadline cuts Y's wait on that request;
// only that outer race can name the cutoff, because X's request runs on.
test('a joined HTTP request cut by the joiner\'s deadline is a cutoff, kept only 30 seconds while that link waits longer',async()=>{
  await clocked(async(clock)=>{
    const gl='join-seller',entry={username:gl,proof:`https://gist.github.com/${gl}/1`};
    const [x,y]=[createEphemeralWallet(),createEphemeralWallet()];
    const gist={owner:{id:42,login:gl},files:{p:{truncated:false,content:`demos:dw2p:ed25519:${x.signHex(`demos-web2:v1:github:${gl}:${x.address}`)}`}}};
    let time=Date.now(),gate=null,gists=0;
    const fetchImpl=async(url)=>{
      if(url.pathname.startsWith('/gists/')){gists++;if(gate)await gate.promise;return json(gist);}
      return json({},500);
    };
    const service=createGithubSignals({now:()=>time,queue:createGithubQueue({now:()=>time}),fetchImpl});
    for(const w of [x,y])service.observe('test',w.address,[entry]);
    const get=(w,deadline)=>service.signals('test',w.address,entry,gl,{deadline});
    assert.equal((await get(x,performance.now()+60_000)).bindingStatus,'bound');
    assert.notEqual((await get(y,performance.now()+60_000)).bindingStatus,'bound');
    time+=900_001;gate=defer();const before=gists;
    const fx=get(x,4000);await turns();
    const fy=get(y,1100.5);await turns();const fy2=get(y,4000);await turns();
    await clock.fire(1100);
    await fy;await fy2;
    assert.equal(gists,before+1,'one shared gist request');
    gate.resolve();gate=null;assert.equal((await fx).bindingStatus,'bound');
    const n=gists;
    await get(y,4000);assert.equal(gists,n,'kept for 30 seconds');
    time+=30_001;
    await get(y,4000);assert.equal(gists,n+1,'Y checked the gist again after 30 seconds');
  });
});

test('the queue names the caller deadline when a waiting job expires, and only then',async()=>{
  await clocked(async(clock)=>{
    const queue=createGithubQueue(),held=[defer(),defer()],error=(p)=>p.then(()=>null,(e)=>e);
    held.forEach((h)=>queue.schedule(()=>h.promise,60_000,'anonymous'));
    // Both slots are busy, so these wait. Neither expiry timer fires before the pump runs.
    const cut=error(queue.schedule(async()=>'ran',2000,'anonymous',2000));
    const ceiling=error(queue.schedule(async()=>'ran',2000,'anonymous'));
    clock.set(2500);held[0].resolve('done');await turns();
    assert.equal((await cut).cutoff,2000);assert.equal((await ceiling).cutoff,undefined);
    const timed=error(queue.schedule(async()=>new Promise(()=>{}),4000,'anonymous',4000));
    const queued=error(queue.schedule(async()=>'ran',4000,'anonymous',4000));
    await clock.fire(4000);
    assert.equal((await timed).cutoff,4000);assert.equal((await queued).cutoff,4000);
  });
});

test('a seller arriving between a job stopping and settling starts a new job instead of joining it',async()=>{
  let time=Date.now(),mode='fail',gate=null,armed=false,hook=null,joined;
  const wallets=[createEphemeralWallet(),createEphemeralWallet()],calls=[];
  const entries=wallets.map((w,i)=>({username:login,proof:`https://gist.github.com/${login}/${i+1}`}));
  const gists=wallets.map((w)=>({owner:{id:42,login},files:{p:{truncated:false,content:`demos:dw2p:ed25519:${w.signHex(`demos-web2:v1:github:${login}:${w.address}`)}`}}}));
  const now=()=>{const h=hook;hook=null;h?.();return time;};
  const fetchImpl=async(url)=>{
    calls.push(url.pathname);
    if(url.pathname.startsWith('/gists/'))return json(gists[Number(url.pathname.slice(-1))-1]);
    if(url.pathname==='/user/42'){
      if(gate){gate.started.resolve();await gate.release.promise;}
      // The profile's age check reads the clock: remove seller A there, so the job
      // stops at its next validity check, and let seller B arrive a microtask later.
      if(armed){armed=false;hook=()=>{service.observe('test',wallets[0].address,[]);queueMicrotask(()=>{joined=get(1);});};}
      return json(mode==='ok'?profile:{},mode==='ok'?200:500);
    }
    return json([{id:1,owner:{id:42},fork:false,archived:false,name:'work',stargazers_count:7}]);
  };
  const service=createGithubSignals({now,fetchImpl,queue:{schedule:(run)=>Promise.resolve().then(run),observe:()=>{}}});
  wallets.forEach((w,i)=>service.observe('test',w.address,[entries[i]]));
  const get=(i)=>service.signals('test',wallets[i].address,entries[i],login,{deadline:performance.now()+60_000});
  for(const i of [0,1])assert.equal((await get(i)).bindingStatus,'bound');
  time+=300_001;mode='ok';
  gate={started:defer(),release:defer()};const a=get(0);await gate.started.promise;
  armed=true;gate.release.resolve();gate=null;
  assert.notEqual((await a).bindingStatus,'bound');
  assert.ok(joined);assert.equal((await joined).stars.total,7);
  assert.equal(calls.filter((x)=>x==='/user/42').length,3,'setup, the stopped job and its replacement');
  const n=calls.length;assert.equal((await get(1)).stars.total,7);assert.equal(calls.length,n,'the replacement was cached');
});
