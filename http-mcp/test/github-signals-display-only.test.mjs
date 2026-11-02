// GitHub signals are display only: every GitHub
// signal label opens with the not-Vet prefix, and every signals object opens
// with the plugin-fixed vetStatus, on every branch and every surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, toolRaw, seedSellerListing, portal, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createGithubSignals, GITHUB_DISPLAY_ONLY_PREFIX, GITHUB_VET_STATUS } from '../src/identity-signals/github.mjs';
import { createGithubQueue } from '../src/identity-signals/github-http.mjs';
import { createSellerIdentityReader, sellerIdentityText } from '../src/seller-identities.mjs';
import { sellerIdentityPanel } from '../public/portal/seller-identity.mjs';
import { ESC_HELPER, LISTINGS_RENDER } from '../src/mcp/ui.mjs';

// Literal on purpose: a changed constant must fail here too.
const PREFIX='Display only — not a DACS Vet result; nothing recorded on chain.';
const login='fixture-seller', gistId='abcdef123';
const deadline=()=>performance.now()+1000;
const profile={id:42,login,type:'User',created_at:'2010-01-02T03:04:05Z',followers:0};
const repo=(id,stars=1,extra={})=>({id,owner:{id:42},fork:false,archived:false,name:`repo-${id}`,stargazers_count:stars,...extra});
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const next=(page)=>`<https://api.github.com/users/${login}/repos?type=owner&per_page=100&sort=full_name&direction=asc&page=${page}>; rel="next"`;
const el=(tag,props,...children)=>({tag,props,children});
function fixture({now,respond,content}={}) {
  const wallet=createEphemeralWallet();
  const entry={username:login,proof:`https://gist.github.com/${login}/${gistId}`};
  const gist={owner:{login,id:42},files:{proof:{truncated:false,content:content?.(wallet)??`demos:dw2p:ed25519:${wallet.signHex(`demos-web2:v1:github:${login}:${wallet.address}`)}`}}};
  const fetchImpl=async(url)=>respond?respond(url,gist):json(url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/42'?profile:[repo(1,10),repo(2,3,{archived:true})]);
  const service=createGithubSignals({config:{},fetchImpl,queue:createGithubQueue({now}),now});
  service.observe('test',wallet.address,[entry]);
  return {wallet,entry,service,get:(e=entry)=>service.signals('test',wallet.address,e,login,{deadline:deadline()})};
}
function assertDisplayOnly(signals,expectedLabel,where) {
  assert.deepEqual(Object.keys(signals).slice(0,2),['vetStatus','label'],`${where}: fixed fields come before any GitHub data`);
  assert.equal(signals.vetStatus,'not-vet',where);
  assert.equal(signals.label,expectedLabel,where);
  assert.ok(signals.label.startsWith(`${PREFIX} `),`${where}: prefix comes first`);
  const identity={status:'observed',label:'chain',identities:{github:[{value:login,url:`https://github.com/${login}`,signals}],x:[],domains:[]},otherAssociations:0,unrecognizedEntries:0,evidence:{mode:'test',network:'test',rpcOrigin:null,observedAt:'now',note:'note',readLimits:{authority:'node'}}};
  assert.ok(sellerIdentityText(identity).includes(`"signals":{"vetStatus":"not-vet","label":${JSON.stringify(expectedLabel)},`),`${where}: model text opens the signals with vetStatus and the prefixed label`);
}

test('the exported prefix and vetStatus are the fixed plugin values',()=>{
  assert.equal(GITHUB_DISPLAY_ONLY_PREFIX,PREFIX);assert.equal(GITHUB_VET_STATUS,'not-vet');
});

test('every label branch opens with the display-only prefix, keeps its caveats word for word and carries vetStatus',async()=>{
  let time=Date.parse('2026-10-10T00:00:00Z'),fail=false;const now=()=>time,at=new Date(time).toISOString();
  const bound=fixture({now,respond:(url,gist)=>{if(fail)throw Error('unavailable');return json(url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/42'?profile:[repo(1,10),repo(2,3,{archived:true})]);}});
  const complete=`${PREFIX} GitHub account and public repository statistics checked by this plugin server at ${at}. Original proof gist checked; GitHub account ID 42. Chain link is one node's read. 13 stars across 2 public, non-fork repositories currently owned by this GitHub account. Stars may be purchased; repository ownership does not prove authorship. GitHub account created 2010-01-02. This is account age, not this seller's tenure. 0 followers reported; private profiles may report zero to other users.`;
  assertDisplayOnly(await bound.get(),complete,'bound, complete');
  assertDisplayOnly(bound.service.cached('test',bound.wallet.address,bound.entry,login),complete,'bound, cache read');
  time+=3600001;fail=true;
  assertDisplayOnly(await bound.get(),`${complete} Cached result last checked ${at}; refresh unavailable.`,'bound, stale cache');
  assertDisplayOnly(bound.service.cached('test',bound.wallet.address,bound.entry,login),`${complete} Cached result last checked ${at}; refresh unavailable.`,'bound, stale cached()');
  bound.service.observe('test',bound.wallet.address,[]);
  const notChecked=`${PREFIX} Not checked yet. GitHub account binding could not be checked; statistics withheld.`;
  assertDisplayOnly(bound.service.cached('test',bound.wallet.address,bound.entry,login),notChecked,'removed link, cached()');
  assertDisplayOnly(await bound.get(),notChecked,'removed link, signals()');

  const expired=fixture({now,respond:()=>{assert.fail('an expired deadline must not fetch GitHub');}});
  assertDisplayOnly(await expired.service.signals('test',expired.wallet.address,expired.entry,login,{deadline:performance.now()-1}),notChecked,'deadline already passed');

  const partial=fixture({now,respond:(url,gist)=>{
    if(url.pathname.startsWith('/gists/'))return json(gist);if(url.pathname==='/user/42')return json(profile);
    return url.searchParams.get('page')?json({},500):json([repo(1,10)],200,{link:next(2)});
  }});
  assertDisplayOnly(await partial.get(),`${PREFIX} GitHub account and public repository statistics checked by this plugin server at ${new Date(time).toISOString()}. Original proof gist checked; GitHub account ID 42. Chain link is one node's read. at least 10 stars across 1 checked repositories. Stars may be purchased; repository ownership does not prove authorship. GitHub account created 2010-01-02. This is account age, not this seller's tenure. 0 followers reported; private profiles may report zero to other users.`,'bound, at-least');

  const unavailable=fixture({now,respond:(url,gist)=>url.pathname.startsWith('/gists/')?json(gist):json({},500)});
  assertDisplayOnly(await unavailable.get(),`${PREFIX} Identity statistics unavailable from GitHub. No conclusion about this seller. Original proof gist checked.`,'bound, statistics unavailable');

  const legacy=fixture({now,content:(wallet)=>`demos:dw2p:ed25519:${wallet.signHex('dw2p')}`});
  assertDisplayOnly(await legacy.get(),`${PREFIX} GitHub account binding could not be checked: this link uses the old Demos proof format, which does not name the account. Statistics withheld.`,'legacy-proof');

  const tlsn=fixture({now}),tlsnEntry={username:login,proofType:'tlsn',proof:{presentation:'unchecked'}};tlsn.service.observe('test',tlsn.wallet.address,[tlsnEntry]);
  assertDisplayOnly(await tlsn.get(tlsnEntry),`${PREFIX} Linked with TLSNotary. This plugin does not check TLSNotary proofs yet, so statistics are withheld.`,'tlsn-unchecked');

  const other=fixture({now,content:()=>`demos:dw2p:ed25519:${createEphemeralWallet().signHex('x')}`});
  assertDisplayOnly(await other.get(),`${PREFIX} GitHub account binding could not be checked; statistics withheld.`,'unresolved');
  assertDisplayOnly(await other.get({username:login}),`${PREFIX} GitHub account binding could not be checked; statistics withheld.`,'unresolved, no proof URL');

  const padded=fixture({now,content:(wallet)=>`demos:dw2p:ed25519:${wallet.signHex(`demos-web2:v1:github:${login}:${wallet.address}`)} `});
  assertDisplayOnly(await padded.get(),`${PREFIX} GitHub account binding could not be checked; statistics withheld. Proof content must be exact, with at most one trailing LF.`,'unresolved with reason');

  assertDisplayOnly(bound.service.notChecked(),`${PREFIX} Not checked yet. GitHub account binding could not be checked; statistics withheld.`,'not checked yet');
});

test('present keeps the fixed display-only fields even if future statistics add fields with the same names',()=>{
  // Exercise the actual private presenter with a future collector result. Today's
  // collector allowlists its fields, so adding raw HTTP fields cannot reach this case.
  const source=readFileSync(new URL('../src/identity-signals/github.mjs',import.meta.url),'utf8');
  const wording=source.slice(source.indexOf('const label ='),source.indexOf('export function createGithubSignals'));
  const start=source.indexOf('  function present(binding, stats) {'),end=source.indexOf('  function cached(',start);
  assert.ok(start>=0&&end>start,'private presenter boundaries');
  const time=Date.parse('2026-10-10T00:00:00Z'),at=new Date(time).toISOString();
  const context={GITHUB_DISPLAY_ONLY_PREFIX,GITHUB_VET_STATUS,SOURCE:'GitHub REST API (plugin server HTTPS)',
    binding:{bindingStatus:'bound',accountId:42,time,cache:'fresh'},
    stats:{time,cache:'fresh',createdAt:profile.created_at,stars:{total:10,repositories:1,complete:true,top:[]},vetStatus:'pass',label:'Verified seller'}};
  const signals=vm.runInNewContext(`${wording}${source.slice(start,end)};present(binding,stats)`,context);
  assertDisplayOnly(signals,`${PREFIX} GitHub account and public repository statistics checked by this plugin server at ${at}. Original proof gist checked; GitHub account ID 42. Chain link is one node's read. 10 stars across 1 public, non-fork repositories currently owned by this GitHub account. Stars may be purchased; repository ownership does not prove authorship. GitHub account created 2010-01-02. This is account age, not this seller's tenure.`,'future statistics fields');
});

test('signals on: search_agents, prepare_purchase, portal, v4 App and schemas show the prefix and vetStatus before any GitHub number',async()=>{
  const h=await startHarness({env:{DACS_SELLER_IDENTITIES:'on',DACS_IDENTITY_GITHUB_SIGNALS:'on'}});
  try {
    const seller=createEphemeralWallet(),name='checked-seller',listingId='github-display-only';
    seedSellerListing(h,seller,{listingId});
    h.chain.seedWeb2Identity(seller.address,'github',{username:name,proof:`https://gist.github.com/${name}/abcdef`});
    const gist={owner:{login:name,id:123},files:{proof:{truncated:false,content:`demos:dw2p:ed25519:${seller.signHex(`demos-web2:v1:github:${name}:${seller.address}`)}`}}};
    const fetchImpl=async(url)=>json(url.pathname.startsWith('/gists/')?gist:url.pathname==='/user/123'?{id:123,login:name,type:'User',created_at:'2012-01-01T00:00:00Z'}:[{id:1,owner:{id:123},fork:false,archived:false,name:'work',stargazers_count:17}]);
    Object.assign(h.app.services.sellerIdentities,createSellerIdentityReader({config:h.config,chain:h.app.services.chain,githubSignals:createGithubSignals({config:h.config,queue:createGithubQueue({}),fetchImpl})}));
    const opening=`"signals":{"vetStatus":"not-vet","label":"${PREFIX} GitHub account and public repository statistics checked by this plugin server at `;
    const check=(signals,text,where)=>{
      assert.deepEqual(Object.keys(signals).slice(0,2),['vetStatus','label'],where);assert.equal(signals.vetStatus,'not-vet',where);
      assert.ok(signals.label.startsWith(`${PREFIX} GitHub account and public`),where);assert.match(signals.label,/17 stars across 1 public, non-fork repositories currently owned by this GitHub account\. Stars may be purchased; repository ownership does not prove authorship\. GitHub account created 2012-01-01\. This is account age, not this seller's tenure\.$/,where);
      const start=text.indexOf(opening);assert.ok(start>=0,`${where}: model text carries vetStatus and the prefixed label`);
      for(const number of ['"stars":','"createdAt":','"accountId":'])assert.ok(text.indexOf(number)>start,`${where}: ${number} follows the prefix`);
    };
    const search=await toolRaw(h,null,'search_agents',{});assert.ok(!search.isError,search.content?.[0]?.text);
    const row=search.structuredContent.results.find(r=>r.listingId===listingId);
    check(row.sellerIdentity.identities.github[0].signals,search.content[0].text,'search_agents');
    const node={innerHTML:''};vm.runInNewContext(`${ESC_HELPER}${LISTINGS_RENDER};render(data)`,{document:{getElementById:()=>node},data:search.structuredContent});
    assert.ok(node.innerHTML.includes(`<span>${PREFIX} GitHub account`),'v4 App shows the prefix');assert.ok(node.innerHTML.indexOf(PREFIX)<node.innerHTML.indexOf('17 stars'),'v4 App: prefix before the numbers');

    const user=await linkedUser(h),prepared=await toolRaw(h,user,'prepare_purchase',{seller:seller.claim,listingId,version:1,idempotencyKey:'github-display-only'});assert.ok(!prepared.isError,prepared.content?.[0]?.text);
    check(prepared.structuredContent.sellerIdentity.identities.github[0].signals,prepared.content[0].text,'prepare_purchase');

    const view=await portal(h,`/portal/api/purchase/${prepared.structuredContent.operationId}/view`,{token:tokenFrom(prepared.structuredContent.approvalUrl)});
    const portalSignals=view.sellerIdentity.identities.github[0].signals;assert.equal(portalSignals.vetStatus,'not-vet');assert.ok(portalSignals.label.startsWith(`${PREFIX} `));
    const panel=JSON.stringify(sellerIdentityPanel(view.sellerIdentity,el));assert.ok(panel.includes(`" ${PREFIX} GitHub account`),'portal shows the prefix');assert.ok(panel.indexOf(PREFIX)<panel.indexOf('17 stars'),'portal: prefix before the numbers');

    const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');const client=new Client({name:'github-display-only',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl)));
    try {
      const tools=Object.fromEntries((await client.listTools()).tools.map(t=>[t.name,t]));
      for(const identity of [tools.search_agents.outputSchema.properties.results.items.properties.sellerIdentity,tools.prepare_purchase.outputSchema.properties.sellerIdentity]) {
        const signals=identity.properties.identities.anyOf.find(v=>v.type==='object').properties.github.items.properties.signals;
        assert.deepEqual(Object.keys(signals.properties).slice(0,2),['vetStatus','label']);assert.equal(signals.properties.vetStatus.const,'not-vet');
        assert.ok(signals.required.includes('vetStatus')&&signals.required.includes('label'));assert.ok(signals.properties.vetStatus.description.endsWith(PREFIX));
      }
    } finally {await client.close();}
  } finally {await h.close();}
});
