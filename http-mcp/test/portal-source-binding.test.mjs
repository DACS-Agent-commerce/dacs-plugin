import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/portal/portal.js',import.meta.url),'utf8');
const start=source.includes('const SOURCE_PUBLICATIONS=')?source.indexOf('const SOURCE_PUBLICATIONS='):source.indexOf('function sameSourceBinding(');
const end=source.indexOf('async function embeddedTransport()',start);
assert.ok(start>=0&&end>start);
const sameSourceBinding=vm.runInNewContext(`${source.slice(start,end)}; sameSourceBinding`);
const binding=()=>({source:'devnet-agreement-transport/v1',bindingVersion:'1',bindingId:'TEST-binding',network:'demos-devnet',chainIdentity:'a'.repeat(64),pinVersion:'TEST-pin',endpoint:'https://127.0.0.1:443/',transportAuthority:'TEST-transport',
  settlementPublication:{policy:'TEST-settlement',artifactKind:'SettlementEvidence',phase:'pay-dem',railId:'demos-native:DEM',phaseIndex:2,authority:'TEST-authority'},
  deliveryPublication:{policy:'TEST-delivery',artifactKind:'Deliverable',phase:'deliver-storage-program',phaseIndex:3,authority:'TEST-authority'},
  demoArtifactPublication:{policy:'TEST-artifacts',artifactKinds:['Listing','CompositeVerificationRecord','FinalityCommitmentRecord'],authority:'TEST-authority'}});
const publications=['settlementPublication','deliveryPublication','demoArtifactPublication'];
const refused=(a,b,label)=>{assert.equal(sameSourceBinding(a,b),false,label);assert.equal(sameSourceBinding(b,a),false,`${label} reversed`);};

test('portal source binding accepts identical complete and optional publication bindings',()=>{
  for(let mask=0;mask<8;mask++){
    const a=binding();for(const [i,k] of publications.entries())if(!(mask&(1<<i)))delete a[k];
    assert.equal(sameSourceBinding(a,structuredClone(a)),true,`publication mask ${mask}`);
  }
});

test('portal source binding refuses a difference in every base and publication field',()=>{
  const a=binding();
  for(const k of Object.keys(a).filter(k=>!publications.includes(k))){const b=binding();b[k]+='-different';refused(a,b,k);}
  for(const block of publications)for(const [k,v] of Object.entries(a[block])){
    const b=binding();b[block][k]=Array.isArray(v)?[...v,'Deliverable']:typeof v==='number'?v+1:`${v}-different`;
    refused(a,b,`${block}.${k}`);
  }
});

test('portal source binding refuses missing, null and extra publication blocks',()=>{
  for(const block of publications){
    const a=binding(),b=binding();delete b[block];refused(a,b,`${block} missing`);
    b[block]=null;refused(a,b,`${block} null`);
    b[block]={...a[block],extra:'TEST-extra'};refused(a,b,`${block} extra key`);
    for(const k of Object.keys(a[block])){b[block]={...a[block]};delete b[block][k];refused(a,b,`${block}.${k} missing`);}
  }
});

test('portal source binding compares artifactKinds by order, length and type',()=>{
  const a=binding();
  for(const kinds of [[...a.demoArtifactPublication.artifactKinds].reverse(),a.demoArtifactPublication.artifactKinds.slice(1),[...a.demoArtifactPublication.artifactKinds,'Deliverable'],a.demoArtifactPublication.artifactKinds.join(','),null]){
    const b=binding();b.demoArtifactPublication.artifactKinds=kinds;refused(a,b,'artifactKinds mismatch');
  }
});

test('portal source binding refuses unknown top-level keys and missing bindings',()=>{
  const a=binding();refused(a,{...a,extra:'TEST-extra'},'extra binding key');
  for(const absent of [undefined,null])refused(a,absent,'missing binding');
});

test('portal source binding refuses extra keys replacing expected keys even on identical malformed bindings',()=>{
  for(const block of publications)for(const k of Object.keys(binding()[block])){
    const a=binding();delete a[block][k];a[block].extra='TEST-extra';refused(a,structuredClone(a),`${block}.${k} replaced`);
  }
  const a=binding();for(const k of Object.keys(a).filter(k=>!publications.includes(k))){
    const b=binding();delete b[k];b.extra='TEST-extra';refused(b,structuredClone(b),`${k} replaced`);
  }
});
