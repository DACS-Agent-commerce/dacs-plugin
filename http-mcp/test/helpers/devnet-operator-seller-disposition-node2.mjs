import net from 'node:net';
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './synthetic-finality-app.mjs';
import { createDevnetDemoComposition } from '../../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './devnet-operator-node2.mjs';

const METHODS=new Set(['submitPayment','reconcileTransport']);
const ERROR_NAMES=new Set(['Error','SellerAgentError','TypeError']);
const ERROR_CODES=new Set(['delivery_readback_invalid','evidence_hash_mismatch','native_delivery_reconciliation_required','native_evidence_held','native_evidence_invalid','not_committed','seller_native_evidence_conflict','seller_read_only_reconciliation','seller_reconciliation_required']);
const DISPOSITIONS=new Set(['present','indeterminate','rejected','absent']);
const STATUSES=new Set(['delivered','delivery-ready','held','indeterminate','payment-evidenced','rejected']);
const REASONS=new Set(['original native Deliverable CREATE is not authenticated on fresh readback','retained SDK delivery recovery authority differs from the native payment intake','retained native delivery recovery binding differs from the SDK fulfilment intent','seller_native_delivery_context_mismatch','seller_native_delivery_readback_required','seller_payment_context_mismatch','seller_read_only_reconciliation','seller_readback_indeterminate','seller_transport_context_mismatch','seller_transport_reconciliation_unsupported']);
const safe=(value,allowed)=>typeof value==='string'&&allowed.has(value)?value:null;
const reason=(value)=>typeof value!=='string'?null:REASONS.has(value)?value:value.startsWith('native delivery reconciliation readback is unavailable:')?'native delivery reconciliation readback is unavailable':null;
const EVENT_KEYS=['deliveryStatus','disposition','elapsedMs','errorCode','errorName','format','input','method','outcome','processPid','reason','sequence','startedAt','status'];
const INPUT_KEYS=['argumentCount','jobIdPresent','nativePaymentEvidencePresent','objectPresent','payerPayingKeyPresent','paymentRoute','txHashPresent'];
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
const probe=(read)=>{try{return read();}catch{return undefined;}};

function validEvent(event){
  return exact(event,EVENT_KEYS)&&event.format==='dacs-test-seller-public-disposition/v1'&&Number.isSafeInteger(event.sequence)&&event.sequence>0&&Number.isSafeInteger(event.processPid)&&event.processPid>0
    &&METHODS.has(event.method)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.startedAt)&&Number.isSafeInteger(event.elapsedMs)&&event.elapsedMs>=0
    &&['returned','rejected'].includes(event.outcome)&&(event.errorName===null||ERROR_NAMES.has(event.errorName))&&(event.errorCode===null||ERROR_CODES.has(event.errorCode))
    &&(event.disposition===null||DISPOSITIONS.has(event.disposition))&&(event.reason===null||REASONS.has(event.reason)||event.reason==='native delivery reconciliation readback is unavailable')
    &&(event.status===null||STATUSES.has(event.status))&&(event.deliveryStatus===null||STATUSES.has(event.deliveryStatus))&&exact(event.input,INPUT_KEYS)
    &&Number.isSafeInteger(event.input.argumentCount)&&event.input.argumentCount>=0&&['objectPresent','jobIdPresent','txHashPresent','payerPayingKeyPresent','nativePaymentEvidencePresent','paymentRoute'].every((key)=>typeof event.input[key]==='boolean');
}

export function createSellerDispositionSink({path}){
  const target=resolve(path),parent=dirname(target),parentInfo=lstatSync(parent);
  if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink()||(parentInfo.mode&0o077)!==0||realpathSync(parent)!==parent)throw new Error('seller disposition sink parent must be a canonical private directory');
  const fd=openSync(target,'wx',0o600);let closed=false;
  return Object.freeze({
    append(event){if(closed)throw new Error('seller disposition sink is closed');if(!validEvent(event))throw new TypeError('seller disposition event does not match the strict public schema');writeSync(fd,`${JSON.stringify(event)}\n`);fsyncSync(fd);},
    close(){if(closed)return;closed=true;try{fsyncSync(fd);}finally{closeSync(fd);}},
  });
}

export function createSellerDispositionObserver({onEvent=()=>{},now=()=>Date.now()}={}){
  let sequence=0;
  const emit=(event)=>{try{onEvent(Object.freeze(event));}catch{/* diagnostic observation cannot alter the product call */}};
  return Object.freeze({
    wrap(agent){
      const wrappers=new Map();
      return new Proxy(agent,{get(target,property){
        const original=Reflect.get(target,property,target);
        if(typeof original!=='function')return original;
        if(!METHODS.has(property))return original.bind(target);
        if(wrappers.has(property))return wrappers.get(property);
        const wrapped=async(...args)=>{
          const started=probe(()=>now()),input=args[0];let base=null;
          try{if(!Number.isFinite(started))throw new TypeError('observer clock is not finite');base={format:'dacs-test-seller-public-disposition/v1',sequence:++sequence,processPid:process.pid,method:property,startedAt:new Date(started).toISOString(),input:{argumentCount:args.length,objectPresent:Boolean(input&&typeof input==='object'&&!Array.isArray(input)),jobIdPresent:typeof probe(()=>(input?.request?.jobId??input?.jobId))==='string',txHashPresent:typeof probe(()=>(input?.body?.txHash??input?.txHash))==='string',payerPayingKeyPresent:typeof probe(()=>(input?.body?.payerPayingKey??input?.payerPayingKey))==='string',nativePaymentEvidencePresent:Boolean(probe(()=>(input?.body?.nativePaymentEvidence??input?.nativePaymentEvidence))),paymentRoute:probe(()=>input?.request?.path)==='/dacs/v1/payments'}};}catch{/* malformed diagnostic input or clock cannot alter the product call */}
          const elapsed=()=>{const finished=probe(()=>now());return Number.isFinite(finished)?Math.max(0,Math.trunc(finished-started)):0;};
          try{
            const value=await Reflect.apply(original,target,args);
            if(base)emit({...base,elapsedMs:elapsed(),outcome:'returned',errorName:null,errorCode:null,disposition:safe(probe(()=>value?.disposition),DISPOSITIONS),reason:reason(probe(()=>(value?.reason??value?.delivery?.reason))),status:safe(probe(()=>value?.status),STATUSES),deliveryStatus:safe(probe(()=>value?.delivery?.status),STATUSES)});
            return value;
          }catch(error){
            if(base)emit({...base,elapsedMs:elapsed(),outcome:'rejected',errorName:safe(probe(()=>error?.name),ERROR_NAMES),errorCode:safe(probe(()=>error?.code),ERROR_CODES),disposition:null,reason:null,status:null,deliveryStatus:null});
            throw error;
          }
        };
        wrappers.set(property,wrapped);return wrapped;
      }});
    },
  });
}

const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});

export async function startOperatorSellerDispositionNode2({authorizeSellerApproval,authorizeBuyerApproval,onEvent}){
  const node2=await startOperatorNode2(),root=await mkdtemp(join(tmpdir(),'devnet-operator-seller-disposition-'));
  let operator=null,composition=null,application=null,running=null,closed=false;
  try{
    const [appPort,sellerPort,directoryPort]=await Promise.all([freePort(),freePort(),freePort()]);
    const publicOrigin=`http://127.0.0.1:${appPort}`,sellerOrigin=`https://127.0.0.1:${sellerPort}`,directoryOrigin=`http://127.0.0.1:${directoryPort}`;
    const custodyDirectory=join(root,'custody'),stateDirectory=join(root,'state');await bootstrapTestWalletCustody({directory:custodyDirectory,publicOrigin});
    const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl});
    const authority='TEST-RUN-operator-seller-disposition-001',admission=admitObservedNode2Identity({observation,authority,transportAuthority:'TEST-owned-operator-seller-disposition-node2',pinVersion:'TEST-operator-seller-disposition-pin-v1',reviewedChainIdentity:observation.chainIdentity});
    const admissionPath=join(root,'admission.json'),sellerKeyPath=join(root,'seller-key.pem'),sellerCertificatePath=join(root,'seller-cert.pem');
    await writeFile(admissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});await writeFile(sellerKeyPath,node2.key,{mode:0o600});await writeFile(sellerCertificatePath,node2.cert,{mode:0o600});
    const config={format:'dacs-node2-demo-operator/v1',authority,publicOrigin,sellerOrigin,sellerTls:{keyPath:sellerKeyPath,certificatePath:sellerCertificatePath},directoryOrigin,stateDirectory,custodyDirectory,networkAdmissionPath:admissionPath,
      listing:{listingId:'operator-recovery-report',listingVersion:1,displayName:'Operator Recovery Seller',title:'Recoverable purchased Node2 operator report',description:'Fresh seller bytes through one durable purpose-bound buyer run.',category:'services.market-report',tags:['report','operator','recovery'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
      sellerFeeBudget:{maxTotalOs:'10000000000'},buyerFeeBudget:{maxTotalOs:'12000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Genuine recoverable purchased bytes from the built-in operator seller.'}};
    const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
    const observedBlockTimes=new Map();let latestBlockTime=0;
    const fetchImpl=async(url,options)=>{
      if(new URL(url).protocol!=='https:')return fetch(url,options);
      const response=await node2.fetchImpl(url,options);let text=await response.text();
      try{const call=JSON.parse(options?.body??'{}')?.params?.[0],body=JSON.parse(text),value=body?.response;if(call?.message==='getBlockByNumber'&&Number.isSafeInteger(value?.number)&&Number.isSafeInteger(value?.content?.timestamp)){
        let timestamp=observedBlockTimes.get(value.number);if(timestamp===undefined){timestamp=Math.max(value.content.timestamp,latestBlockTime+1,Math.ceil(Date.now()/1000)+1);observedBlockTimes.set(value.number,timestamp);latestBlockTime=timestamp;}
        value.content.timestamp=timestamp;text=JSON.stringify(body);const wait=timestamp*1000-Date.now();if(wait>0){if(wait>30000)throw new Error('operator disposition source clock exceeded its bounded wait');await new Promise((resolve)=>setTimeout(resolve,wait));}
      }}catch(error){if(error.message==='operator disposition source clock exceeded its bounded wait')throw error;}
      return new Response(text,{status:response.status,headers:response.headers});
    };
    const now=()=>Date.now();operator=await createDevnetDemoOperator({configPath,fetchImpl,authorizeSellerApproval,authorizeBuyerApproval,now});
    const prepared=await operator.prepareDevnetDemo();composition=await createDevnetDemoComposition(prepared.composition);
    application=await createApp({config:prepared.config,dacsProtocol:{...composition.dacsProtocol,verifyCommitmentFinality:async()=> 'valid'},devnetAgreementTransport:prepared.devnetAgreementTransport,fetchImpl,now:prepared.now});
    const observer=createSellerDispositionObserver({onEvent,now}),sellerAgent=observer.wrap(composition.sellerAgent);
    await operator.attachSellerAgent({sellerAgent,application,composition});running=await operator.listen({application,composition});
    const close=async()=>{if(closed)return;closed=true;await running?.close?.();await application?.close?.();composition?.sellerAgent?.close?.();await operator?.close?.();await node2.close();await rm(root,{recursive:true,force:true});};
    return Object.freeze({root,node2,config,configPath,prepared,composition,application,operator,running,fetchImpl,close});
  }catch(error){await running?.close?.();await application?.close?.();composition?.sellerAgent?.close?.();await operator?.close?.();await node2.close();await rm(root,{recursive:true,force:true});throw error;}
}

export const dispositionEffects=(h)=>({creates:h.node2.chain.wire.record.accepted.length,payments:h.node2.chain.record.accepted.length});
