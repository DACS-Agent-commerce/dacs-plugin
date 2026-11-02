#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';

const args=Object.fromEntries(process.argv.slice(2).map((entry)=>{const index=entry.indexOf('=');return index<0?[entry.replace(/^--/,''),true]:[entry.slice(2,index),entry.slice(index+1)];}));
const command=process.argv[2];
const required=(name)=>{const value=args[name];if(typeof value!=='string'||!value)throw new Error(`--${name}=... is required`);return value;};
const optional=(name)=>{const value=args[name];if(value!==undefined&&(typeof value!=='string'||!value))throw new Error(`--${name}=... requires a value`);return value;};
const save=async(path,value)=>writeFile(resolve(path),`${JSON.stringify(value,null,2)}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});

if(command==='wallets'){
  const config=JSON.parse(await readFile(resolve(required('config')),'utf8'));
  const result=await bootstrapTestWalletCustody({directory:config.custodyDirectory,publicOrigin:config.publicOrigin});
  process.stdout.write(`${JSON.stringify({status:'created',custodyDirectory:result.directory,wallets:result.wallets,note:result.note})}\n`);
}else if(command==='observe'){
  // Opt-in only: --block-zero-unavailable=literal-error. Absent, block zero must be valid.
  const blockZeroUnavailable=optional('block-zero-unavailable');
  if(blockZeroUnavailable!==undefined&&blockZeroUnavailable!=='literal-error')throw new Error('--block-zero-unavailable accepts only literal-error');
  const blockOneLayout=optional('block-one-layout');
  const observation=await observeNode2Identity({endpoint:required('endpoint'),network:required('network'),...(blockZeroUnavailable?{blockZeroUnavailable}:{}),...(blockOneLayout?{blockOneLayout}:{})});
  await save(required('out'),observation);
  process.stdout.write(`${JSON.stringify({status:'observed',path:resolve(args.out),chainIdentity:observation.chainIdentity,...(observation.identitySource?{identitySource:observation.identitySource,blockOneHash:observation.blockOneHash,scope:observation.scope}:{}),trust:'single-node TEST observation only; review before admission'})}\n`);
}else if(command==='admit'){
  const observation=JSON.parse(await readFile(resolve(required('observation')),'utf8'));
  const admission=admitObservedNode2Identity({observation,authority:required('authority'),transportAuthority:required('transport-authority'),pinVersion:required('pin-version'),reviewedChainIdentity:required('reviewed-chain-identity'),
    reviewedIdentitySource:optional('reviewed-identity-source'),reviewedBlockOneHash:optional('reviewed-block-one-hash'),reviewedBlockZeroEnvelope:optional('reviewed-block-zero-envelope'),
    reviewedBlockOneLayout:optional('reviewed-block-one-layout'),reviewedBlockTwoHash:optional('reviewed-block-two-hash')});
  await save(required('out'),admission);
  process.stdout.write(`${JSON.stringify({status:'admitted',path:resolve(args.out),chainIdentity:admission.chainIdentity,...(admission.identitySource?{identitySource:admission.identitySource,blockOneHash:admission.blockOneHash}:{}),trust:admission.trust})}\n`);
}else{
  throw new Error('usage: devnet-demo-operator-bootstrap.mjs wallets --config=/abs/operator.json | observe --endpoint=https://.../ --network=... [--block-zero-unavailable=literal-error --block-one-layout=node2-number-id-plus-one-empty-extra/v1] --out=/abs/observation.json | admit --observation=/abs/observation.json --authority=TEST-RUN-... --transport-authority=... --pin-version=... --reviewed-chain-identity=<64hex> [--reviewed-identity-source=confirmed-block-one-predecessor --reviewed-block-one-hash=<64hex> --reviewed-block-zero-envelope=<recorded-envelope> --reviewed-block-one-layout=<recorded-layout> --reviewed-block-two-hash=<64hex>] --out=/abs/admission.json');
}
