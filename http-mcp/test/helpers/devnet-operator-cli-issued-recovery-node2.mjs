import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperatorCliNode2 } from './devnet-operator-cli-node2.mjs';

const here=dirname(fileURLToPath(import.meta.url)),project=resolve(here,'../..');
const node=process.execPath,expect='/usr/bin/expect';
const ptyScript=join(here,'devnet-operator-cli-issued-pty.exp'),fetchPreload=join(here,'devnet-operator-cli-preload.mjs'),observerPreload=join(here,'devnet-operator-cli-seller-observer-preload.mjs'),pidPreload=join(here,'devnet-operator-cli-process-marker-preload.mjs');
const crashChild=join(here,'devnet-operator-cli-issued-crash-child.mjs');
const HASH=/^[0-9a-f]{64}$/,OS=/^(0|[1-9][0-9]*)$/;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const demToOs=(value)=>{assert.match(value,/^(0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/);const[whole,fraction='']=value.split('.');return BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));};
export const readPublicCliStatuses=(transcript)=>[...transcript.matchAll(/"status":"([a-z][a-z0-9_-]{0,63})"/g)].map((match)=>match[1]);

function exactDebit(debit,{amountOs=0n,maxTotalOs}){
  assert.ok(debit&&typeof debit==='object');
  for(const name of ['sellerAmountDem','sdkGasDem','networkFeeDem','rpcFeeDem','additionalFeeDem','totalDem','totalOs'])assert.equal(typeof debit[name],'string');
  assert.match(debit.totalOs,OS);
  const seller=demToOs(debit.sellerAmountDem),storage=debit.storageFeeDem===undefined?0n:demToOs(debit.storageFeeDem),gas=demToOs(debit.sdkGasDem),network=demToOs(debit.networkFeeDem),rpc=demToOs(debit.rpcFeeDem),additional=demToOs(debit.additionalFeeDem),total=BigInt(debit.totalOs);
  assert.equal(seller,amountOs);assert.equal(total,seller+storage+gas+network+rpc+additional);assert.equal(demToOs(debit.totalDem),total);assert.ok(total<=BigInt(maxTotalOs));return total;
}

function validateApproval(value,state){
  assert.match(value.approvalHash,HASH);const request=value.request;assert.ok(request&&typeof request==='object');
  if(value.scope){
    assert.match(value.requestHash,HASH);assert.equal(value.requestHash,sha(JSON.stringify(request)));assert.equal(value.approvalHash,sha(JSON.stringify({scope:value.scope,request})));
    const scope=value.scope;assert.equal(scope.buyer,state.buyer);assert.equal(scope.seller,state.seller);assert.equal(scope.listingId,state.listingId);assert.equal(scope.listingVersion,1);assert.equal(scope.listingContentHash,state.listingHash);assert.equal(scope.purpose,scope.kind);assert.equal(request.address,state.buyerAddress);
    if(scope.jobId){state.jobId??=scope.jobId;assert.equal(scope.jobId,state.jobId);}if(scope.agreementHash){assert.match(scope.agreementHash,HASH);state.agreementHash??=scope.agreementHash;assert.equal(scope.agreementHash,state.agreementHash);}
    if(request.method==='sign'){
      assert.equal(typeof request.message,'string');assert.ok(request.message.length>0);
      if(scope.kind==='oauth-wallet-login'){assert.equal(scope.jobId,undefined);assert.equal(scope.agreementHash,undefined);assert.equal(scope.network,undefined);}
      else{assert.equal(scope.jobId,state.jobId);assert.equal(scope.network,'demos-devnet');assert.equal(scope.chainIdentity,state.chainIdentity);if(['agreement-identity','seller-session-delegation'].includes(scope.kind))assert.equal(scope.agreementHash,undefined);else assert.ok(['broker-authentication','agreement-signature','payment-terms'].includes(scope.kind));}
    }else{
      assert.equal(request.method,'sendTransaction');assert.equal(scope.network,'demos-devnet');assert.equal(scope.chainIdentity,state.chainIdentity);assert.equal(scope.displayPurpose,request.purpose);assert.equal(request.content.network,'demos-devnet');assert.equal(request.content.networkBinding.chainIdentity,state.chainIdentity);
      if(scope.kind==='agreement-create'){
        assert.equal(request.content.action,'immutable DACS storage anchor CREATE');assert.equal(request.content.artifactKind,'Agreement');assert.equal(request.content.owner,state.buyer);assert.equal(request.content.wallet,state.buyerAddress);assert.equal(request.content.jobId,state.jobId);assert.equal(request.content.contentHash,state.agreementHash);exactDebit(request.content.debit,{maxTotalOs:'12000000000'});
      }else{
        assert.equal(scope.kind,'native-payment');assert.equal(request.content.action,'native DEM transfer');assert.equal(request.content.from,state.buyerAddress);assert.equal(request.content.to,state.sellerAddress);assert.equal(scope.payee,state.sellerAddress);assert.equal(scope.amountOs,'1000000000');assert.equal(request.content.amountOs,scope.amountOs);exactDebit(request.content.debit,{amountOs:1000000000n,maxTotalOs:'12000000000'});
      }
      assert.equal(scope.totalOs,request.content.debit.totalOs);
    }
    const normalized={kind:scope.kind,approvalHash:value.approvalHash,requestHash:value.requestHash,method:request.method,totalOs:scope.totalOs??null,decision:'approved'};state.buyerApprovals.push(normalized);return;
  }
  assert.equal(value.approvalHash,sha(JSON.stringify(request)));assert.equal(request.method,'sendTransaction');assert.equal(request.address,state.sellerAddress);assert.equal(request.content.action,'immutable DACS storage anchor CREATE');assert.equal(request.content.wallet,state.sellerAddress);assert.equal(request.content.owner,state.seller);assert.equal(request.content.network,'demos-devnet');assert.equal(request.content.networkBinding.chainIdentity,state.chainIdentity);assert.match(request.content.contentHash,HASH);assert.match(request.content.envelopeHash,HASH);
  assert.ok(['Listing','CompositeVerificationRecord','FinalityCommitmentRecord','SettlementEvidence','Deliverable'].includes(request.content.artifactKind));
  if(request.content.artifactKind==='Listing'){assert.equal(request.content.jobId,`listing:${state.listingId}`);state.listingHash??=request.content.contentHash;}else assert.equal(request.content.jobId,state.jobId);
  exactDebit(request.content.debit,{maxTotalOs:'10000000000'});state.sellerApprovals.push({kind:request.content.artifactKind,approvalHash:value.approvalHash,method:request.method,totalOs:request.content.debit.totalOs,decision:'approved'});
}

async function waitForDead(pid){
  for(let attempt=0;attempt<40;attempt++){
    try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return true;throw error;}
    await new Promise((resolveWait)=>setTimeout(resolveWait,25));
  }
  return false;
}

export async function runPty(h,{entrypoint,args,receipt=null,expectCrash=false,observerPath=null,returnFailure=false}){
  const state={buyer:h.buyer.claim,seller:h.seller.claim,buyerAddress:h.buyer.address,sellerAddress:h.seller.address,listingId:h.config.listing.listingId,
    listingHash:receipt?.listing?.contentHash??null,chainIdentity:h.admission.chainIdentity,jobId:receipt?.jobId??null,agreementHash:receipt?.agreementHash??null,buyerApprovals:[],sellerApprovals:[]};
  const nodeArgv=[node,'--import',fetchPreload,...(observerPath?['--import',observerPreload]:[]),'--import',pidPreload,entrypoint,...args],argv=['-N','-n','-f',ptyScript,...nodeArgv];
  // The preload trusts the TEST CA for fetch only; the operator's seller TLS probe
  // (tls.connect) reads the process CA store, which NODE_EXTRA_CA_CERTS extends.
  const child=spawn(expect,argv,{cwd:project,env:{...process.env,NODE_EXTRA_CA_CERTS:h.sellerCertificatePath,DACS_TEST_CLI_CA_PATH:h.sellerCertificatePath,DACS_TEST_CLI_HTTPS_ORIGINS:JSON.stringify([new URL(h.node2.endpoint).origin,new URL(h.config.sellerOrigin).origin]),...(observerPath?{DACS_TEST_SELLER_OBSERVER_PATH:observerPath,DACS_TEST_SELLER_ORIGIN:new URL(h.config.sellerOrigin).origin}:{})},stdio:['pipe','pipe','pipe']});
  let transcript='',buffer='',result=null,application=null,ptyWait=null,settled=false;const publicEvents=[];
  const finishLine=(raw)=>{const line=raw.replace(/\r/g,'').trim();if(line.startsWith('DACS_TEST_PTY_WAIT ')){ptyWait=line.slice('DACS_TEST_PTY_WAIT '.length).split('|');return;}if(!line.startsWith('{'))return;let value;try{value=JSON.parse(line);}catch{return;}
    if(value?.kind==='dacs-test-application-process'){assert.equal(value.entrypoint,entrypoint);assert.ok(Number.isSafeInteger(value.pid)&&value.pid>0);application=value;publicEvents.push(value);}
    else if(value?.approvalHash&&value?.request){validateApproval(value,state);child.stdin.write(`APPROVE ${value.approvalHash}\n`);}
    else if(typeof value?.status==='string'&&['delivery-ready','declined','held'].includes(value.status))result=value;};
  const collect=(chunk)=>{const text=chunk.toString();transcript+=text;buffer+=text;const lines=buffer.split('\n');buffer=lines.pop()??'';for(const line of lines)finishLine(line);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timeout=setTimeout(()=>{if(!settled)child.kill('SIGTERM');},240000);
  const outcome=await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',(exitCode,signal)=>{settled=true;clearTimeout(timeout);finishLine(buffer);resolveExit({exitCode,signal});});});
  assert.ok(application,'application process marker was not observed');assert.ok(ptyWait,'PTY did not expose the child wait status');
  if(outcome.signal==='SIGTERM')throw new Error(`PTY exceeded its bounded runtime; last output ${transcript.slice(-2000)}`);
  if(expectCrash){assert.ok(ptyWait.includes('CHILDKILLED'));assert.ok(ptyWait.includes('SIGKILL'));assert.equal(await waitForDead(application.pid),true,'crash child application PID remained alive');}
  else if(!returnFailure){assert.equal(outcome.signal,null);assert.equal(outcome.exitCode,0,`unchanged CLI exited ${outcome.exitCode}; last output ${transcript.slice(-3000)}`);assert.equal(ptyWait.length,4);assert.equal(ptyWait[2],'0');assert.equal(ptyWait[3],'0');assert.ok(result,'unchanged CLI emitted no final public result');}
  else{assert.equal(outcome.signal,null);assert.equal(ptyWait.length,4);assert.equal(ptyWait[2],'0');assert.equal(Number(ptyWait[3]),outcome.exitCode);}
  const statuses=readPublicCliStatuses(transcript),stages=[...transcript.matchAll(/"stage":"([a-z-]+)"/g)].map((match)=>match[1]);
  const failure=returnFailure&&outcome.exitCode!==0?Object.freeze({kind:'nonzero-exit',exitCode:outcome.exitCode,signal:outcome.signal,status:statuses.at(-1)??null,stage:stages.at(-1)??null,sellerDeliveryNull:/"sellerDelivery":null/.test(transcript),returnedPublicResult:result!==null}):null;
  return Object.freeze({argv:[expect,...argv],nodeArgv,expectPid:child.pid,applicationPid:application.pid,outcome,ptyWait,result,failure,listingHash:state.listingHash,buyerApprovals:state.buyerApprovals,sellerApprovals:state.sellerApprovals,
    transcript:{persisted:false,redaction:'raw PTY bytes deliberately not persisted; safe normalized approvals and public lifecycle evidence are returned',sha256:sha(transcript),bytes:Buffer.byteLength(transcript)},publicEvents});
}

const receiptPath=(h,key)=>join(h.config.stateDirectory,'buyer-runs',`${sha(`dacs-node2-operator-buyer-run\0${key}`)}.receipt.json`);
const readJson=async(path)=>JSON.parse(await readFile(path,'utf8'));

export async function createOperatorCliIssuedRecoveryNode2(){
  const h=await createOperatorCliNode2(),crashRecordPath=join(h.root,'issued-crash.public.json'),observerPath=join(h.root,'seller-observer.public.ndjson');
  return Object.freeze({
    ...h,crashRecordPath,observerPath,
    readBuyerReceipt:(key)=>readJson(receiptPath(h,key)),
    readBuyerReceiptBytes:(key)=>readFile(receiptPath(h,key)),
    async readBuyerApprovalEvidence(){const text=await readFile(join(h.config.stateDirectory,'evidence','buyer-approvals.jsonl'),'utf8');return text.trim().split('\n').filter(Boolean).map(JSON.parse);},
    async readSellerApprovalEvidence(){const text=await readFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8');return text.trim().split('\n').filter(Boolean).map(JSON.parse);},
    async readSellerObserverEvents(){const text=await readFile(observerPath,'utf8');return text.trim().split('\n').filter(Boolean).map(JSON.parse);},
    crashAfterIssued:(key)=>runPty(h,{entrypoint:crashChild,args:[`--config=${h.configPath}`,`--idempotency-key=${key}`,`--crash-record=${crashRecordPath}`],expectCrash:true}),
    readCrashRecord:()=>readJson(crashRecordPath),
  });
}

export const cliIssuedEffects=(h)=>({creates:h.node2.chain.wire.record.accepted.length,payments:h.node2.chain.record.accepted.length});
