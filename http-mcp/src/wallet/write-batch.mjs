import { createHash } from 'node:crypto';

const FORMAT='dacs-wallet-write-batch/v1';
const FLOOR_FORMAT='dacs-wallet-write-batch-nonce/v1';
const HASH=/^[a-f0-9]{64}$/;
const ADDRESS=/^0x[a-f0-9]{64}$/;
const terminal=(write)=>['included','not-landed'].includes(write.disposition);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const digest=(value)=>createHash('sha256').update(value).digest('hex');
const label=(value)=>typeof value==='string'&&value.length>0&&value.length<=128&&!value.includes('\0');
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every((key)=>Object.hasOwn(value,key));
const nonceValid=(value)=>Number.isSafeInteger(value)&&value>=0;
const floorKey=(lane)=>`wallet-batch-nonce/${digest(lane)}`;
const laneFor=({journal,network,chainIdentity,wallet})=>{
  if(!journal||!/^[a-f0-9]{32}$/.test(journal.journalId ?? '')
    ||!['get','put','entries','withWalletLock'].every((key)=>typeof journal[key]==='function')) throw new TypeError('an explicit durable wallet journal is required');
  if(!label(network)||!label(chainIdentity)||!ADDRESS.test(wallet ?? '')) throw new TypeError('an explicit network, chain identity and public wallet are required');
  return JSON.stringify([network,chainIdentity,wallet]);
};
async function readFloor(journal,lane) {
  const floor=await journal.get(floorKey(lane));
  if(floor===undefined)return {format:FLOOR_FORMAT,lane,reservedNonce:0,chainNonce:0};
  if(!exact(floor,['format','lane','reservedNonce','chainNonce'])||floor.format!==FLOOR_FORMAT||floor.lane!==lane
    ||!nonceValid(floor.reservedNonce)||!nonceValid(floor.chainNonce)) fail('batch-journal-invalid','the durable wallet nonce floor is malformed');
  return floor;
}
async function retainFloor(journal,lane,reservedNonce,chainNonce=0) {
  const prior=await readFloor(journal,lane);
  const floor={...prior,reservedNonce:Math.max(prior.reservedNonce,reservedNonce),chainNonce:Math.max(prior.chainNonce,chainNonce)};
  await journal.put(floorKey(lane),floor);
  if(JSON.stringify(await journal.get(floorKey(lane)))!==JSON.stringify(floor)) fail('batch-journal-error','the wallet nonce floor was not retained exactly');
}

// Read-only preflight, also used by batch submission. This does not reserve a
// nonce; single-write adapters must use reserveWalletWriteNonce below.
export async function checkWalletWriteNonce({journal,network,chainIdentity,wallet,baseNonce,nonce}={}) {
  const lane=laneFor({journal,network,chainIdentity,wallet});
  const floor=await readFloor(journal,lane);
  if(!nonceValid(baseNonce)||!nonceValid(nonce)||nonce!==baseNonce+1
    ||baseNonce<Math.max(floor.reservedNonce,floor.chainNonce)) fail('batch-nonce-clash','the nonce read or reservation is below the durable wallet floor');
  return true;
}

// Required for single-write adapters, inside their existing wallet lock,
// after the pinned chain nonce read and before signing or broadcasting.
// The caller must hold that lock through signing, lane retention and its one
// send. Do not reacquire this non-reentrant lock here. A successful reservation
// is consumed even if signing or sending never happens; never roll it back.
export async function reserveWalletWriteNonce({journal,network,chainIdentity,wallet,baseNonce,nonce}={}) {
  const lane=laneFor({journal,network,chainIdentity,wallet});
  await checkWalletWriteNonce({journal,network,chainIdentity,wallet,baseNonce,nonce});
  await retainFloor(journal,lane,nonce);
  return true;
}

// Standalone opt-in seam. The caller supplies chain-bound signing/proof
// verifiers; this module owns sequencing, durable fences and single sends.
export function createWalletWriteBatch({journal,network,chainIdentity,wallet,readNonce,sign,verifySigned,broadcast,readback,verifyIncluded,absencePolicy}={}) {
  const lane=laneFor({journal,network,chainIdentity,wallet});
  if(![readNonce,sign,verifySigned,broadcast,readback,verifyIncluded].every((fn)=>typeof fn==='function')) throw new TypeError('chain-bound nonce, signing, broadcast and inclusion callbacks are required');
  if(absencePolicy!==undefined&&(!exact(absencePolicy,['id','verify'])||!label(absencePolicy.id)||typeof absencePolicy.verify!=='function')) throw new TypeError('an explicit verified absence policy is required');
  const scope=Object.freeze({network,chainIdentity,wallet});
  const archiveKey=(batchId)=>`wallet-batch/${digest(JSON.stringify([lane,batchId]))}`;

  function signedValid(write) {
    if(!exact(write,['nonce','hash','signedBytes','bytesHash','disposition'])||!nonceValid(write.nonce)||!HASH.test(write.hash ?? '')
      ||typeof write.signedBytes!=='string'||write.bytesHash!==digest(write.signedBytes)
      ||!['indeterminate','submitted','included','not-landed'].includes(write.disposition)) return false;
    try {
      const signed=JSON.parse(write.signedBytes);
      return signed?.hash===write.hash&&signed.content?.nonce===write.nonce&&signed.content?.from===wallet;
    } catch { return false; }
  }
  function checked(record) {
    if(!exact(record,['format','lane','stage','batchId','step','baseNonce','writes'])||record.format!==FORMAT||record.lane!==lane
      ||!label(record.batchId)||!label(record.step)||!nonceValid(record.baseNonce)||!Array.isArray(record.writes)||!record.writes.length||record.writes.length>64
      ||!record.writes.every((write,index)=>signedValid(write)&&write.nonce===record.baseNonce+index+1)
      ||new Set(record.writes.map((write)=>write.hash)).size!==record.writes.length
      ||!['batch-unresolved','broadcast-accepted'].includes(record.stage)
      ||(record.stage==='broadcast-accepted')!==record.writes.every(terminal)) fail('batch-journal-invalid','the retained batch is malformed; the wallet stays fenced');
    return record;
  }
  async function retain(record) {
    checked(record);
    await journal.put(lane,record);
    if(JSON.stringify(await journal.get(lane))!==JSON.stringify(record)) fail('batch-journal-error','the complete batch was not retained exactly; nothing further may be sent');
  }
  async function prior(batchId) {
    const current=await journal.get(lane);
    if(current?.format===FORMAT)checked(current);
    const archived=await journal.get(archiveKey(batchId));
    if(archived){
      checked(archived);
      if(archived.batchId!==batchId||archived.stage!=='broadcast-accepted')fail('batch-journal-invalid','the archived batch identity or resolution differs');
      if(current?.format===FORMAT&&current.batchId===batchId){
        const resolved={...current,stage:'broadcast-accepted',writes:current.writes.map((write,index)=>({...write,disposition:archived.writes[index]?.disposition}))};
        if(JSON.stringify(resolved)!==JSON.stringify(archived)
          ||current.writes.some((write,index)=>terminal(write)&&write.disposition!==archived.writes[index].disposition)) fail('batch-journal-invalid','the resolved archive does not exactly match the retained lane');
        if(current.stage!=='broadcast-accepted')await retain(archived);
      }
      return archived;
    }
    if(current?.format===FORMAT&&current.batchId===batchId)return current;
    return null;
  }
  const view=(record)=>structuredClone({...record,noResend:true});

  async function submit({batchId,step,writes}={}) {
    if(!label(batchId)||!label(step)||!Array.isArray(writes)||!writes.length||writes.length>64) fail('batch-invalid','one bounded, identified purchase-step batch is required');
    const plans=structuredClone(writes);
    if(!plans.every((plan)=>plan&&nonceValid(plan.content?.nonce)&&plan.content?.from===wallet)) fail('batch-invalid','every unsigned write must name this wallet and an explicit nonce');
    return journal.withWalletLock(lane,async()=>{
      if(await prior(batchId)) fail('batch-replay','this batch was already journaled; use readback, never sign or send it again');
      const previous=await journal.get(lane);
      if(previous?.format===FORMAT)checked(previous);
      if(previous&&previous.stage!=='broadcast-accepted') fail('batch-blocked','an unresolved write owns this wallet lane; no new write may be signed');
      const baseNonce=await readNonce(scope);
      const lastNonce=previous?.format===FORMAT?previous.writes.at(-1).nonce:previous?.nonce;
      if(!nonceValid(baseNonce)||!Number.isSafeInteger(baseNonce+plans.length)
        ||(previous&&(!nonceValid(lastNonce)||baseNonce<lastNonce))
        ||!plans.every((plan,index)=>plan.content.nonce===baseNonce+index+1)) fail('batch-nonce-clash','the reserved sequential nonces differ from the chain or retained wallet lane; nothing was signed');
      await checkWalletWriteNonce({journal,...scope,baseNonce,nonce:plans[0].content.nonce});
      const signedWrites=[];
      for(const plan of plans){
        const nonce=plan.content.nonce;
        const signed=await sign(structuredClone(plan),{...scope,nonce});
        const signedBytes=JSON.stringify(signed);
        const write={nonce,hash:signed?.hash,signedBytes,bytesHash:typeof signedBytes==='string'?digest(signedBytes):null,disposition:'indeterminate'};
        if(!signedValid(write)||await verifySigned({...scope,transaction:structuredClone(plan),signedBytes,hash:write.hash,nonce})!==true) fail('batch-signed-mismatch','a signed write differs from its reserved approved scope; nothing was broadcast');
        signedWrites.push(write);
      }
      let record={format:FORMAT,lane,stage:'batch-unresolved',batchId,step,baseNonce,writes:signedWrites};
      await retain(record);
      await retainFloor(journal,lane,record.writes.at(-1).nonce);
      for(let index=0;index<record.writes.length;index+=1){
        const write=record.writes[index];
        let reply;
        try { reply=await broadcast({...scope,hash:write.hash,nonce:write.nonce,signedBytes:write.signedBytes}); } catch { break; }
        if(!exact(reply,['disposition','hash'])||reply.disposition!=='submitted'||reply.hash!==write.hash) break;
        record={...record,writes:record.writes.map((entry,i)=>i===index?{...entry,disposition:'submitted'}:entry)};
        await retain(record);
      }
      return view(record);
    });
  }

  async function reconcile({batchId}={}) {
    if(!label(batchId)) fail('batch-invalid','an exact retained batch id is required');
    return journal.withWalletLock(lane,async()=>{
      let record=await prior(batchId);
      if(!record) fail('batch-not-found','there is no retained batch with this id');
      if(record.stage==='broadcast-accepted')return view(record);
      let chainNonce=0;
      for(let index=0;index<record.writes.length;index+=1){
        const write=record.writes[index];
        if(terminal(write))continue;
        const request={...scope,hash:write.hash,nonce:write.nonce,signedBytes:write.signedBytes};
        let disposition='indeterminate';
        try {
          const observation=await readback(request);
          if(observation?.hash===write.hash&&observation.wallet===wallet&&observation.nonce===write.nonce){
            if(observation.disposition==='included'&&await verifyIncluded({...request,observation})===true){
              disposition='included';chainNonce=Math.max(chainNonce,write.nonce);
            }
            if(observation.disposition==='absent'&&absencePolicy&&nonceValid(observation.chainNonce)
              &&await absencePolicy.verify({...request,observation})===true){
              chainNonce=Math.max(chainNonce,observation.chainNonce);
              if(observation.chainNonce>write.nonce)disposition='not-landed';
            }
          }
        } catch { /* Unavailable or unverifiable readback leaves the original fence. */ }
        record={...record,writes:record.writes.map((entry,i)=>i===index?{...entry,disposition}:entry)};
      }
      // Persist authenticated nonce evidence before any disposition can release
      // the lane. Journal errors must escape the readback catch above.
      await retainFloor(journal,lane,record.writes.at(-1).nonce,chainNonce);
      if(record.writes.every(terminal)){
        record={...record,stage:'broadcast-accepted'};
        await journal.put(archiveKey(record.batchId),record);
        if(JSON.stringify(await journal.get(archiveKey(record.batchId)))!==JSON.stringify(record)) fail('batch-journal-error','the resolved batch history was not retained exactly');
      }
      await retain(record);
      return view(record);
    });
  }
  return Object.freeze({submit,reconcile});
}
