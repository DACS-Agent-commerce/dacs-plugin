import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { createOperatorRecoveryNode2 } from './devnet-operator-recovery-node2.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');

export async function createOperatorPaymentRecoveryNode2(approvals){
  const harness=await createOperatorRecoveryNode2(approvals),sourceFetch=harness.node2.fetchImpl;
  let unavailable=false;
  harness.node2.fetchImpl=async(url,options)=>{
    let call=null;try{call=JSON.parse(options?.body??'{}')?.params?.[0]??null;}catch{}
    if(unavailable&&['getTransactionStatus','getTxByHash','getBlockByNumber'].includes(call?.message))throw Object.assign(new Error('TEST exact original native payment readback unavailable'),{code:'TEST_PAYMENT_READBACK_UNAVAILABLE'});
    return sourceFetch(url,options);
  };
  const runPath=(idempotencyKey,kind)=>join(harness.root,'state','buyer-runs',`${sha(`dacs-node2-operator-buyer-run\0${idempotencyKey}`)}.${kind}.json`);
  const transportEntries=()=>harness.prepared.devnetAgreementTransport.journal.entries();
  return Object.freeze({
    root:harness.root,node2:harness.node2,config:harness.config,configPath:harness.configPath,fetchImpl:harness.fetchImpl,
    start:()=>harness.start(),stop:()=>harness.stop(),restart:()=>harness.restart(),close:()=>harness.close(),
    readBuyerReceipt:async(idempotencyKey)=>JSON.parse(await readFile(runPath(idempotencyKey,'receipt'),'utf8')),
    readPrivateBuyerRun:async(idempotencyKey)=>JSON.parse(await readFile(runPath(idempotencyKey,'private'),'utf8')),
    async transportSnapshot(){const entries=await transportEntries();return{count:entries.length,digest:sha(canonicalize(entries))};},
    async nativeLaneSnapshot({hash,payer}){const entries=(await transportEntries()).filter(([key,value])=>key===`devnet/native-transfer/${hash}`||(key.startsWith('devnet/native-wallet/')&&value?.signedTransaction?.content?.from===payer));return{count:entries.length,digest:sha(canonicalize(entries))};},
    async issuedNativeTransfers(){return(await transportEntries()).filter(([key,value])=>key===`devnet/native-transfer/${value?.hash}`&&value?.signedTransaction?.content?.type==='native').map(([key,value])=>({key,value:structuredClone(value)}));},
    async injectUnauthenticatedAmbiguousJournalCandidate(){
      const records=await this.issuedNativeTransfers();if(records.length!==1)throw new Error(`expected one genuine native issued record before ambiguous control, got ${records.length}`);
      const invalid=structuredClone(records[0].value),content=invalid.signedTransaction.content;
      content.transaction_fee.rpc_address=`0x${'ab'.repeat(32)}`;invalid.hash=sha(JSON.stringify(content));invalid.signedTransaction.hash=invalid.hash;
      await harness.prepared.devnetAgreementTransport.journal.put(`devnet/native-transfer/${invalid.hash}`,invalid);
      return{genuineHash:records[0].value.hash,untrustedCollisionHash:invalid.hash};
    },
    async duplicateLastBuyerApprovalEvidence(){
      const path=join(harness.config.stateDirectory,'evidence','buyer-approvals.jsonl'),lines=(await readFile(path,'utf8')).trim().split('\n').filter(Boolean);
      if(lines.length===0)throw new Error('no genuine buyer approval evidence is available to duplicate as a negative corruption control');
      await appendFile(path,`${lines.at(-1)}\n`,{encoding:'utf8',mode:0o600});return JSON.parse(lines.at(-1));
    },
    makeOriginalPaymentReadbackUnavailable(){unavailable=true;},restoreOriginalPaymentReadback(){unavailable=false;},
    get sourceReadbackUnavailable(){return unavailable;},get operator(){return harness.operator;},get composition(){return harness.composition;},get application(){return harness.application;},get prepared(){return harness.prepared;},
  });
}

export const paymentRecoveryEffects=(h)=>({creates:h.node2.chain.wire.record.accepted.length,payments:h.node2.chain.record.accepted.length});
export const buyerTransactionApprovals=(entries)=>entries.filter((entry)=>entry.request.method==='sendTransaction').length;
export const buyerNativePaymentApprovals=(entries)=>entries.filter((entry)=>entry.scope.kind==='native-payment').length;
