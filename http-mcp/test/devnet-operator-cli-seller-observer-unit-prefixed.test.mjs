import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const preload=path.join(sourceRoot,'test/helpers/devnet-operator-cli-seller-observer-preload.mjs');
const child=path.join(sourceRoot,'test/helpers/devnet-operator-cli-seller-observer-unit-child.mjs');
const sentinels=['BODY_SENTINEL_DO_NOT_RECORD','HEADER_SENTINEL_DO_NOT_RECORD','QUERY_SENTINEL_DO_NOT_RECORD','CAPABILITY_SENTINEL_DO_NOT_RECORD','TRANSPORT_SENTINEL_DO_NOT_RECORD'];

function runChild(mode,outputPath){
  return spawnSync(process.execPath,[child,mode,outputPath,preload],{
    cwd:sourceRoot,
    env:{...process.env},
    encoding:'utf8',
    timeout:5000,
    maxBuffer:1024*1024,
  });
}

test('devnet observer unit: exact targets are metadata-only and non-target fetch is identity passthrough',()=>{
  const directory=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'dacs-observer-unit-'));
  try{
    const output=path.join(directory,'observations.ndjson');
    const result=runChild('main',output);
    assert.equal(result.signal,null);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stderr,'');
    const summary=JSON.parse(result.stdout.trim());
    assert.deepEqual(summary,{mode:'main',calls:14,nonTargets:3,targetCalls:11});

    const text=fs.readFileSync(output,'utf8');
    for(const sentinel of sentinels)assert.equal(text.includes(sentinel),false,`observer output contains ${sentinel}`);
    assert.equal((fs.statSync(output).mode&0o777).toString(8),'600');
    const events=text.trim().split('\n').map((line)=>JSON.parse(line)).sort((a,b)=>a.sequence-b.sequence);
    assert.equal(events.length,11);
    assert.deepEqual(events.map(({sequence,method,route,status,authHeaderPresent,errorCode,transportErrorName,transportErrorCode})=>({sequence,method,route,status,authHeaderPresent,errorCode,transportErrorName,transportErrorCode})),[
      {sequence:1,method:'GET',route:'AGREEMENT_STATE',status:200,authHeaderPresent:true,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:2,method:'POST',route:'COMMITMENT',status:204,authHeaderPresent:false,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:3,method:'PATCH',route:'BUNDLE_REQUEST',status:200,authHeaderPresent:false,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:4,method:'POST',route:'PAYMENT',status:503,authHeaderPresent:true,errorCode:'operation_uncertain',transportErrorName:null,transportErrorCode:null},
      {sequence:5,method:'POST',route:'BUNDLE_COUNTERSIGNATURE',status:422,authHeaderPresent:false,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:6,method:'POST',route:'BUNDLE_BUYER_COPY',status:503,authHeaderPresent:false,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:7,method:'POST',route:'AGREEMENT_PROPOSAL',status:503,authHeaderPresent:true,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:8,method:'POST',route:'AGREEMENT_PROPOSAL',status:503,authHeaderPresent:true,errorCode:null,transportErrorName:null,transportErrorCode:null},
      {sequence:9,method:'POST',route:'PAYMENT',status:null,authHeaderPresent:null,errorCode:null,transportErrorName:'TypeError',transportErrorCode:'ECONNRESET'},
      {sequence:10,method:'POST',route:'PAYMENT',status:null,authHeaderPresent:null,errorCode:null,transportErrorName:'Error',transportErrorCode:null},
      {sequence:11,method:'POST',route:'PAYMENT',status:null,authHeaderPresent:null,errorCode:null,transportErrorName:'TypeError',transportErrorCode:'ETIMEDOUT'},
    ]);
    for(const event of events){
      assert.equal(event.format,'dacs-test-seller-http-observation/v1');
      assert.equal(Number.isInteger(event.processPid)&&event.processPid>0,true);
      assert.equal(Number.isInteger(event.elapsedMs)&&event.elapsedMs>=0,true);
      assert.equal(Number.isNaN(Date.parse(event.startedAt)),false);
      assert.deepEqual(Object.keys(event).sort(),['authHeaderPresent','elapsedMs','errorCode','format','method','processPid','route','sequence','startedAt','status','transportErrorCode','transportErrorName'].sort());
    }
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('devnet observer unit: recording failure cannot replace true response or rejection',()=>{
  const directory=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'dacs-observer-unit-write-failure-'));
  try{
    const result=runChild('recording-failure',directory);
    assert.equal(result.signal,null);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout.trim()),{mode:'recording-failure',responseIdentity:true,rejectionIdentity:true,calls:2});
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
