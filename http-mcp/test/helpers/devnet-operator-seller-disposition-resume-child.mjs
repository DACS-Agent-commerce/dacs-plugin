import { resolve } from 'node:path';
import { createApp } from './synthetic-finality-app.mjs';
import { createDevnetDemoComposition } from '../../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../../src/devnet-demo/operator.mjs';
import { createSellerDispositionObserver, createSellerDispositionSink } from './devnet-operator-seller-disposition-node2.mjs';

const value=(name)=>process.argv.slice(2).find((entry)=>entry.startsWith(`--${name}=`))?.slice(name.length+3);
const configPath=value('config'),idempotencyKey=value('resume'),safeEventPath=value('safe-event-path');
if(!configPath||!idempotencyKey||!safeEventPath)throw new Error('usage: disposition-resume-child --config=/absolute/operator.json --resume=key --safe-event-path=/absolute/events.ndjson');

const sink=createSellerDispositionSink({path:resolve(safeEventPath)});
const operator=await createDevnetDemoOperator({configPath:resolve(configPath)});
let application=null,composition=null,running=null;
try{
  const prepared=await operator.prepareDevnetDemo();
  composition=await createDevnetDemoComposition(prepared.composition);
  const logger=Object.freeze({debug(){},info(){},warn(){},error(){}});
  application=await createApp({config:prepared.config,dacsProtocol:{...composition.dacsProtocol,verifyCommitmentFinality:async()=> 'valid'},devnetAgreementTransport:prepared.devnetAgreementTransport,
    ...(prepared.fetchImpl?{fetchImpl:prepared.fetchImpl}:{}),...(prepared.now?{now:prepared.now}:{}),logger});
  const observer=createSellerDispositionObserver({onEvent:(event)=>sink.append(event),...(prepared.now?{now:prepared.now}:{})});
  await operator.attachSellerAgent({sellerAgent:observer.wrap(composition.sellerAgent),application,composition});
  running=await operator.listen({application,composition});
  const result=await operator.createBuyerDriver({composition}).resume({idempotencyKey});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}finally{
  sink.close();
  await running?.close?.();await application?.close?.();composition?.sellerAgent?.close?.();await operator.close();
}
