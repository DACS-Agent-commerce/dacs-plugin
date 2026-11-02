import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outputPath=process.env.DACS_TEST_SELLER_OBSERVER_PATH;
const configuredOrigin=process.env.DACS_TEST_SELLER_ORIGIN;
if(typeof outputPath!=='string'||!outputPath.startsWith('/')||typeof configuredOrigin!=='string')throw new Error('TEST seller observer requires its private output path and exact seller origin');
const sellerOrigin=new URL(configuredOrigin);
if(sellerOrigin.origin!==configuredOrigin||sellerOrigin.protocol!=='https:'||!['127.0.0.1','localhost','[::1]','::1'].includes(sellerOrigin.hostname)||sellerOrigin.pathname!=='/'||sellerOrigin.search||sellerOrigin.hash)throw new Error('TEST seller observer requires one canonical loopback HTTPS origin');

const routes=new Map([
  ['/dacs/v1/agreements/proposals','AGREEMENT_PROPOSAL'],
  ['/dacs/v1/agreements/state','AGREEMENT_STATE'],
  ['/dacs/v1/commitments','COMMITMENT'],
  ['/dacs/v1/payments','PAYMENT'],
  ['/dacs/v1/bundles/request','BUNDLE_REQUEST'],
  ['/dacs/v1/bundles/countersignature','BUNDLE_COUNTERSIGNATURE'],
  ['/dacs/v1/bundles/buyer-copy','BUNDLE_BUYER_COPY'],
]);
const publicErrorCodes=new Set([
  'agreement_anchor_invalid','agreement_not_anchored','agreement_substituted','bad_json','bad_request','body_interrupted','body_timeout','body_too_large','bundle_invalid','buyer_bundle_invalid','buyer_bundle_unauthenticated','buyer_mismatch','encoded_body_unsupported','job_invalid','job_taken','json_required','loopback_only','method_not_allowed','no_bundle_request','no_seller_copy','not_agreed','not_committed','not_delivered','not_found','operation_uncertain','payment_already_recorded','peer_agreement_mismatch','peer_audience_wrong','peer_envelope_invalid','peer_expired','peer_job_conflict','peer_job_mismatch','peer_listing_mismatch','peer_nonce_conflict','peer_operation_conflict','peer_payment_conflict','peer_payment_mismatch','peer_proposal_invalid','peer_proposal_mismatch','peer_reconciliation_conflict','peer_reconciliation_invalid','peer_request_mismatch','peer_response_mismatch','peer_response_too_large','peer_signature_invalid','peer_signer_wrong','peer_store_capacity','peer_store_conflict','peer_unknown_job','self_dealing','seller_rate_limited','unknown_job',
]);
const safeErrorNames=new Set(['AbortError','Error','TimeoutError','TypeError']);
const safeTransportCodes=new Set(['ABORT_ERR','ECONNABORTED','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET']);
const targetPath=resolve(outputPath);
const originalFetch=globalThis.fetch;
const maxErrorBytes=4096;
const observationTimeoutMs=50;
let sequence=0;

function append(value){
  try{appendFileSync(targetPath,`${JSON.stringify(value)}\n`,{encoding:'utf8',flag:'a',mode:0o600});}catch{/* Observation failure must not alter the seller request or response. */}
}

function cancelReader(reader){
  try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{/* Cancellation is best effort and never awaited. */}
}

function boundedErrorCode(response){
  if(response.status<400)return Promise.resolve(null);
  let reader;
  try{reader=response.body?.getReader();}catch{return Promise.resolve(null);}
  if(!reader)return Promise.resolve(null);
  return new Promise((resolveCode)=>{
    let settled=false;
    const finish=(value)=>{if(settled)return;settled=true;clearTimeout(timer);resolveCode(value);};
    const timer=setTimeout(()=>{cancelReader(reader);finish(null);},observationTimeoutMs);
    (async()=>{
      const chunks=[];let size=0;
      for(;;){
        const {done,value}=await reader.read();if(done)break;
        if(!(value instanceof Uint8Array)){cancelReader(reader);return null;}
        size+=value.byteLength;if(size>maxErrorBytes){cancelReader(reader);return null;}chunks.push(value);
      }
      const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      return publicErrorCodes.has(parsed?.error)?parsed.error:null;
    })().then(finish,()=>finish(null));
  });
}

function methodFor(input,options){
  try{return String(options?.method??((typeof input==='object'&&input?.method)||'GET')).toUpperCase();}catch{return'UNKNOWN';}
}

function captureResponseObservation(response){
  let status=null,authHeaderPresent=null,clone=null;
  try{
    status=Number.isInteger(response?.status)?response.status:null;
    authHeaderPresent=typeof response?.headers?.has==='function'?response.headers.has('x-dacs-seller-peer'):null;
    if(status!==null&&status>=400&&typeof response?.clone==='function')clone=response.clone();
  }catch{/* Preserve the response and record only metadata obtained safely. */}
  return{status,authHeaderPresent,clone};
}

function responseObservation(base,{status,authHeaderPresent,clone}){
  const record=(errorCode)=>append({...base,status,authHeaderPresent,errorCode,transportErrorName:null,transportErrorCode:null});
  if(!clone)return record(null);
  boundedErrorCode(clone).then(record,()=>record(null));
}

function transportObservation(base,error){
  const name=safeErrorNames.has(error?.name)?error.name:'Error';
  const code=safeTransportCodes.has(error?.code)?error.code:null;
  append({...base,status:null,authHeaderPresent:null,errorCode:null,transportErrorName:name,transportErrorCode:code});
}

globalThis.fetch=(input,options)=>{
  let url;
  try{url=typeof input==='string'||input instanceof URL?new URL(input):new URL(input.url);}catch{return originalFetch(input,options);}
  const route=routes.get(url.pathname);
  if(url.origin!==sellerOrigin.origin||url.search||url.hash||!route)return originalFetch(input,options);
  const id=++sequence,start=process.hrtime.bigint(),startedAt=new Date().toISOString(),method=methodFor(input,options);
  let fetched;
  try{fetched=originalFetch(input,options);}catch(error){
    transportObservation({format:'dacs-test-seller-http-observation/v1',sequence:id,processPid:process.pid,startedAt,elapsedMs:Number((process.hrtime.bigint()-start)/1000000n),method,route},error);
    throw error;
  }
  return Promise.resolve(fetched).then((response)=>{
    const base={format:'dacs-test-seller-http-observation/v1',sequence:id,processPid:process.pid,startedAt,elapsedMs:Number((process.hrtime.bigint()-start)/1000000n),method,route};
    const observation=captureResponseObservation(response);
    setImmediate(()=>responseObservation(base,observation));
    return response;
  },(error)=>{
    transportObservation({format:'dacs-test-seller-http-observation/v1',sequence:id,processPid:process.pid,startedAt,elapsedMs:Number((process.hrtime.bigint()-start)/1000000n),method,route},error);
    throw error;
  });
};
