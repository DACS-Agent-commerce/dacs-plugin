import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './synthetic-finality-app.mjs';
import { createDevnetDemoComposition } from '../../src/devnet-demo/composition.mjs';
import { createDevnetDemoOperator } from '../../src/devnet-demo/operator.mjs';

const value=(name)=>process.argv.slice(2).find((entry)=>entry.startsWith(`--${name}=`))?.slice(name.length+3);
const configPath=value('config'),idempotencyKey=value('idempotency-key'),crashRecord=value('crash-record');
if(!configPath||!idempotencyKey||!crashRecord)throw new Error('usage: crash-child --config=/absolute/operator.json --idempotency-key=key --crash-record=/absolute/public.json');

const operator=await createDevnetDemoOperator({configPath:resolve(configPath)});
let application=null,composition=null,running=null;
try{
  const prepared=await operator.prepareDevnetDemo();
  composition=await createDevnetDemoComposition(prepared.composition);
  application=await createApp({config:prepared.config,dacsProtocol:{...composition.dacsProtocol,verifyCommitmentFinality:async()=> 'valid'},devnetAgreementTransport:prepared.devnetAgreementTransport,
    ...(prepared.fetchImpl?{fetchImpl:prepared.fetchImpl}:{}),...(prepared.now?{now:prepared.now}:{}),...(prepared.logger?{logger:prepared.logger}:{})});
  await operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition});
  running=await operator.listen({application,composition});
  const driver=operator.createBuyerDriver({composition,testOnlyAfterNativeWalletResult:async result=>{
    const record={format:'dacs-test-cli-issued-crash/v1',processPid:process.pid,terminationSignal:'SIGKILL',observedAt:new Date().toISOString(),...result};
    const fd=openSync(resolve(crashRecord),'wx',0o600);
    try{writeSync(fd,`${JSON.stringify(record)}\n`);fsyncSync(fd);}finally{closeSync(fd);}
    process.kill(process.pid,'SIGKILL');
    await new Promise(()=>{});
  }});
  await driver.purchase({idempotencyKey});
  throw new Error('TEST crash child returned after its required SIGKILL boundary');
}finally{
  await running?.close?.();await application?.close?.();composition?.sellerAgent?.close?.();await operator.close();
}
