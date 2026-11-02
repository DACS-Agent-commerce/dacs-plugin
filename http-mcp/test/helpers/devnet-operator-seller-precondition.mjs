import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { buildNativeTransferPayload } from '../../src/dacs/wallet-transactions.mjs';

const ADDRESS=/^0x[0-9a-f]{64}$/;
const HASH=/^[0-9a-f]{64}$/;
const OS=/^(0|[1-9][0-9]*)$/;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const fail=(message)=>{throw new Error(`native public precondition: ${message}`);};

function wireAmount(value){
  if(typeof value==='string'&&OS.test(value))return{encoding:'os-string',amountOs:BigInt(value)};
  if(Number.isSafeInteger(value)&&value>=0)return{encoding:'dem-number',amountOs:BigInt(value)*1_000_000_000n};
  fail('accepted amount has no supported explicit denomination');
}

export function reconstructNativePublicPrecondition({acceptedTransaction,publicIntent}){
  const signedBefore=canonicalize(acceptedTransaction),content=acceptedTransaction?.content;
  if(!content||content.type!=='native')fail('accepted transaction is not native');
  if(!publicIntent||publicIntent.format!=='dacs-node2-operator-native-payment-intent/v1')fail('public intent format differs');
  if(Object.hasOwn(publicIntent,'timestamp')||Object.hasOwn(publicIntent,'data'))fail('reduced public intent unexpectedly exposes omitted fields');
  if(!ADDRESS.test(publicIntent.payer??'')||!ADDRESS.test(publicIntent.payee??'')||content.from!==publicIntent.payer||content.to!==publicIntent.payee)fail('accepted parties differ from public intent');
  if(!OS.test(publicIntent.amountOs??'')||BigInt(publicIntent.amountOs)<=0n)fail('public amount is invalid');
  if(!Number.isSafeInteger(publicIntent.nonce)||publicIntent.nonce<1||content.nonce!==publicIntent.nonce)fail('accepted nonce differs from public intent');
  if(!Number.isSafeInteger(content.timestamp)||content.timestamp<1)fail('accepted timestamp is not a positive safe integer');
  if(!HASH.test(publicIntent.payloadHash??'')||!HASH.test(publicIntent.dataHash??''))fail('public canonical hash is invalid');
  const wire=wireAmount(content.amount);
  if(wire.amountOs!==BigInt(publicIntent.amountOs))fail('accepted amount differs from public intent');
  const originalPayload=buildNativeTransferPayload({from:content.from,to:content.to,amountOs:publicIntent.amountOs,nonce:content.nonce,timestamp:content.timestamp,encoding:wire.encoding});
  if(canonicalize(content.data)!==canonicalize(originalPayload.content.data))fail('accepted native data differs from rebuilt original');
  const payloadHash=sha(canonicalize(originalPayload)),dataHash=sha(canonicalize(content.data));
  if(payloadHash!==publicIntent.payloadHash)fail('rebuilt original envelope hash differs from public intent');
  if(dataHash!==publicIntent.dataHash)fail('accepted native data hash differs from public intent');
  if(canonicalize(acceptedTransaction)!==signedBefore)fail('accepted signed transaction was mutated');
  return Object.freeze({encoding:wire.encoding,acceptedTimestamp:content.timestamp,payloadHash,dataHash,originalPayload});
}
