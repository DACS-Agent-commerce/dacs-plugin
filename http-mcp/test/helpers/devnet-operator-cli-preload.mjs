import https from 'node:https';
import { readFile } from 'node:fs/promises';

const caPath=process.env.DACS_TEST_CLI_CA_PATH;
const allowed=JSON.parse(process.env.DACS_TEST_CLI_HTTPS_ORIGINS??'[]');
if(typeof caPath!=='string'||!Array.isArray(allowed)||allowed.length!==2)throw new Error('TEST CLI preload requires its exact CA and two HTTPS origins');
const ca=await readFile(caPath),origins=new Set(allowed),originalFetch=globalThis.fetch,observedBlockTimes=new Map();let latestBlockTime=0;

async function exactHttpsFetch(url,options={}){
  const target=new URL(url),method=options.method??'GET',headers=options.headers instanceof Headers?Object.fromEntries(options.headers):options.headers;
  const response=await new Promise((resolve,reject)=>{
    const request=https.request(target,{method,headers,ca,signal:options.signal,agent:false},incoming=>{const chunks=[];incoming.on('data',(chunk)=>chunks.push(chunk));incoming.on('end',()=>resolve({status:incoming.statusCode,headers:incoming.headers,body:Buffer.concat(chunks)}));incoming.on('error',reject);});
    request.on('error',reject);if(options.body!=null)request.write(options.body);request.end();
  });
  let body=response.body;
  try{
    const call=JSON.parse(typeof options.body==='string'?options.body:'{}')?.params?.[0],value=JSON.parse(body)?.response;
    if(call?.message==='getBlockByNumber'&&Number.isSafeInteger(value?.number)&&Number.isSafeInteger(value?.content?.timestamp)){
      let timestamp=observedBlockTimes.get(value.number);
      if(timestamp===undefined){timestamp=Math.max(value.content.timestamp,latestBlockTime+1,Math.ceil(Date.now()/1000)+1);observedBlockTimes.set(value.number,timestamp);latestBlockTime=timestamp;}
      value.content.timestamp=timestamp;const parsed=JSON.parse(body);parsed.response=value;body=Buffer.from(JSON.stringify(parsed));
      const wait=timestamp*1000-Date.now();if(wait>0){if(wait>30000)throw new Error('TEST CLI source clock exceeded its bounded wait');await new Promise((resolve)=>setTimeout(resolve,wait));}
    }
  }catch(error){if(error.message==='TEST CLI source clock exceeded its bounded wait')throw error;}
  return new Response(body,{status:response.status,headers:response.headers});
}

globalThis.fetch=(input,options)=>{
  const url=typeof input==='string'||input instanceof URL?new URL(input):new URL(input.url);
  return origins.has(url.origin)?exactHttpsFetch(url,options):originalFetch(input,options);
};
