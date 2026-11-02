#!/usr/bin/env node
import { readAdmittedRecipientBalance } from '../src/devnet-demo/recipient-balance.mjs';

function argumentsFor(argv){
  const values={};
  for(const entry of argv){
    const match=/^--(admission|address)=(.+)$/.exec(entry);
    if(!match||Object.hasOwn(values,match[1]))throw new TypeError('usage: devnet-demo-recipient-balance.mjs --admission=/absolute/node2-admission.json --address=0x<64-lowercase-hex>');
    values[match[1]]=match[2];
  }
  if(argv.length!==2||!values.admission||!values.address)throw new TypeError('usage: devnet-demo-recipient-balance.mjs --admission=/absolute/node2-admission.json --address=0x<64-lowercase-hex>');
  return values;
}

try{
  const input=argumentsFor(process.argv.slice(2));
  const result=await readAdmittedRecipientBalance({admissionPath:input.admission,address:input.address});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}catch(error){
  const code=typeof error?.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'recipient_balance_refused';
  process.stderr.write(`${JSON.stringify({status:'held',code,message:code==='recipient_balance_refused'?'recipient balance request was refused':String(error.message)})}\n`);
  process.exitCode=1;
}
