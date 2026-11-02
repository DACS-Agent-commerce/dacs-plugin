import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTests, killed, runNodeTest } from './node-test-child.mjs';

const moduleUrl=new URL('../../src/devnet-demo/seller-write-batch.mjs',import.meta.url);
let source=readFileSync(moduleUrl,'utf8');
source=source.replace("'@kynesyslabs/dacs'",JSON.stringify(import.meta.resolve('@kynesyslabs/dacs')))
  .replace("'../wallet/write-batch.mjs'",JSON.stringify(new URL('../wallet/write-batch.mjs',moduleUrl).href));
const mutations=[
  ['boolean-switch','switch and trusted',"typeof enabled!=='boolean'",'false'],
  ['required-seller-verifiers','switch and trusted',"![approve,verifyPrepared,verifyReceipt].every(fn=>typeof fn==='function')",'false'],
  ["input-shape", "prepared plan guards", "!exact(input,['batchId','jobId','railId','paymentPhaseIndex','writes'])", "false"],
  ["batch-label", "prepared plan guards", "!label(input.batchId)", "false"],
  ["batch-count", "prepared plan guards", "![2,3].includes(input.writes.length)", "false"],
  ["plan-shape", "prepared plan guards", "!exact(plan,['artifactKind','logicalAddress','transaction','approval'])", "false"],
  ["sender", "prepared plan guards", "c?.from!==wallet", "false"],
  ["network", "prepared plan guards", "c.network!==network", "false"],
  ["chain", "prepared plan guards", "c.chainIdentity!==chainIdentity", "false"],
  ["unsigned-hash", "prepared plan guards", "plan.transaction?.hash!==''", "false"],
  ["storage-type", "prepared plan guards", "c?.type!=='storageProgram'", "false"],
  ["storage-data-kind", "prepared plan guards", "c?.data?.[0]!=='storageProgram'", "false"],
  ["create-only", "prepared plan guards", "c.data?.[1]?.operation!=='CREATE_STORAGE_PROGRAM'", "false"],
  ["nonce-safe", "prepared plan guards", "!Number.isSafeInteger(c.nonce)", "false"],
  ["nonce-positive", "prepared plan guards", "c.nonce<1", "false"],
  ["nonce-sequential", "prepared plan guards", "(index>0&&c.nonce!==input.writes[0].transaction.content.nonce+index)", "false"],
  ["metadata-locator", "prepared plan guards", "m?.logicalAddress!==plan.logicalAddress", "false"],
  ["metadata-kind", "prepared plan guards", "m.artifactKind!==plan.artifactKind", "false"],
  ["metadata-writer", "prepared plan guards", "m.artifactBinding?.writer!==`did:demos:agent:${wallet.slice(2)}`", "false"],
  // The switch is parsed from src/switches/DACS_SELLER_WRITE_BATCHES.switch by config.mjs's shared switch code.
  ['config-default','runtime switch',"const value = env[s.env] ?? s.default;","const value = env[s.env] ?? s.values.at(-1);",'config'],
  ['config-values','runtime switch',"!s.values.includes(value)",'false','config'],
  ['runtime-held','runtime switch',"  if (config.sellerWriteBatches === 'on') throw new TypeError('seller write batches are held until native SDK preparation and batch transport integration are reviewed');\n",'','app'],
  ['off-delegation','off returns','if(!enabled)return singlePublisher;',''],
  ['prepared-scope','incomplete approval bytes','await verifyPrepared(structuredClone(plan),{jobId:input.jobId,network,chainIdentity,wallet})!==true','false'],
  ['same-job','incomplete approval bytes','||m.artifactBinding?.jobId!==input.jobId',''],
  ['deliverable-first','incomplete approval bytes','plan.logicalAddress!==addresses[index]','false'],
  ['unsigned-only','incomplete approval bytes','plan.transaction?.signature!==null','false'],
  ['exclude-vets','incomplete approval bytes',"plan.artifactKind!==(index===0?'Deliverable':'SettlementEvidence')",'false'],
  ['optional-evidence','delivery evidence off','![2,3].includes(input.writes.length)','input.writes.length!==3'],
  ['all-approved-before-signing','clean batch','const decisions=[];',"const decisions=[];await transport.sign(plans.writes[0].transaction,{nonce:plans.writes[0].transaction.content.nonce});"],
  ['decline-no-signing','manual or policy refusal',"if(accepted!==true)fail('seller-batch-declined','a seller write was refused; no batch write was signed or sent');",''],
  ['exact-approval-log','clean batch','requestBytes,approvalHash:sha(requestBytes)','requestBytes,approvalHash:sha(requestBytes+\'changed\')'],
  ['plan-journal-before-signing','clean batch','await putExact(keyFor(plans.batchId),{format:FORMAT,input:plans});',''],
  ['exact-plan-readback','prepared journal exact','JSON.stringify(await journal.get(key))!==JSON.stringify(value)','false'],
  ['restart-readback-only','restart mid-batch',"if(await journal.get(keyFor(plans.batchId)))fail('seller-batch-replay','retained seller work is readback-only');",''],
  ['original-plan-snapshot','caller and approval callback','prepared(structuredClone(input))','prepared(input)'],
  ['receipt-verification','wrong receipt','await verifyReceipt({plan:structuredClone(plan),...request,observation:structuredClone(observation)})!==true','false'],
  ['retained-receipt-check','wrong receipt','await verifyReceipt({plan:structuredClone(input.writes[index]),...structuredClone(request)})!==true','false'],
  ['job-canonical','prepared plan guards','||!isCanonicalJobId(input.jobId)',''],
  ['rail-label','prepared plan guards','||!label(input.railId)',''],
  ['phase-index','prepared plan guards','||!Number.isSafeInteger(input.paymentPhaseIndex)||input.paymentPhaseIndex<0',''],
  ['transaction-object','prepared plan guards','plan.transaction?.signature!==null','plan.transaction.signature!==null'],
  ['config-held','runtime switch','  "held": {\n    "on": "DACS_SELLER_WRITE_BATCHES=on is held until native SDK preparation and batch transport integration are reviewed"\n  },\n','','switch'],
  ['readback-signed-scope','readback never resolves a retained signed write','await transport.verifySigned({...request,transaction:structuredClone(plan.transaction)})!==true','false'],
  ['readback-inclusion-proof','forged inclusion proof','||await transport.verifyIncluded({...request,observation:structuredClone(observation)})!==true',''],
  ['retained-inclusion-proof','retained inclusion proof no longer verifies','||await transport.verifyIncluded(structuredClone(request))!==true',''],
  ['recovery-skips-prepare','prepare-time authorization has gone stale','return checked(structuredClone(record.input));','return prepared(structuredClone(record.input));'],
  ['recovery-structural-check','structurally changed retained plan','return checked(structuredClone(record.input));','return structuredClone(record.input);'],
  ['submitted-unverified','check failing after broadcast','try { return await view(plans,batch); } catch(error) {','try { return await view(plans,batch); } catch(error) { throw error;'],
  ['proof-journal-fault','failure to retain an inclusion proof','if(journalFault)throw journalFault;',''],
  ['recovered-signed-scope','reopened terminal batch',"await transport.verifySigned({network,chainIdentity,wallet,hash:write.hash,nonce:write.nonce,signedBytes:write.signedBytes,transaction:structuredClone(input.writes[index].transaction)})!==true",'false'],
];
export async function checkMutation(name, pattern, path, target = 'module', { cwd = process.cwd(), env = process.env } = {}) {
  const onSpawn=(pid)=>console.log(`${name}: process group ${pid}`);
  const {DACS_SELLER_BATCH_TEST_MODULE,DACS_SELLER_BATCH_TEST_APP,DACS_SELLER_BATCH_TEST_CONFIG,...unmutatedEnv}=env;
  // Each mutant run must report every test that the unmutated sources' run of the same pattern reports.
  const expected=await expectedTests('test/seller-write-batch.test.mjs',{cwd,args:[`--test-name-pattern=${pattern}`],env:unmutatedEnv,timeoutMs:30000,maxBuffer:1024*1024,onSpawn});
  const result=await runNodeTest('test/seller-write-batch.test.mjs',
    {cwd,args:[`--test-name-pattern=${pattern}`],env:{...env,[target==='module'?'DACS_SELLER_BATCH_TEST_MODULE':target==='app'?'DACS_SELLER_BATCH_TEST_APP':'DACS_SELLER_BATCH_TEST_CONFIG']:path},timeoutMs:30000,maxBuffer:1024*1024,expected,onSpawn});
  const caught=killed(result);
  const errors=[...result.tap.matchAll(/^\s+error: '([^']+)'$/gm)].map(match=>match[1]);
  const record={name,killed:caught,file:result.file,nodeVersion:result.nodeVersion,exit:result.exit,tests:result.tests,pass:result.pass,fail:result.fail,incomplete:result.incomplete,errors};
  return { ...record, stdout: result.stdout, stderr: result.stderr };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const directory=mkdtempSync(join(tmpdir(),'seller-batch-mutants-')),out=process.argv[2];
if(out)writeFileSync(out,'');
let survivors=0;
try {
  for(const [name,pattern,from,to,target='module'] of mutations){
    let original=source,path=join(directory,`${name}.mjs`);
    if(target==='config'||target==='switch'){
      // config.mjs reads its switch files from ./switches/ with ./switch-files.mjs, so each config mutant gets its own copy of all three.
      const dir=join(directory,name);
      mkdirSync(dir);cpSync(new URL('../../src/switches/',import.meta.url),join(dir,'switches'),{recursive:true});
      cpSync(new URL('../../src/switch-files.mjs',import.meta.url),join(dir,'switch-files.mjs'));
      writeFileSync(join(dir,'config.mjs'),readFileSync(new URL('../../src/config.mjs',import.meta.url),'utf8'));
      path=join(dir,target==='switch'?'switches/DACS_SELLER_WRITE_BATCHES.switch':'config.mjs');
      original=readFileSync(path,'utf8');
      if(!original.includes(from))throw new Error(`mutation ${name} has no matching source`);
      writeFileSync(path,original.replace(from,to));
      path=join(dir,'config.mjs');
    }else{
      if(target!=='module'){
        const url=new URL('../../src/app.mjs',import.meta.url);
        // Package imports too: the copy lives under TMPDIR, outside any node_modules.
        original=readFileSync(url,'utf8').replace(/from '([^']+)'/g,(match,specifier)=>`from ${JSON.stringify(specifier.startsWith('.')?new URL(specifier,url).href:import.meta.resolve(specifier))}`);
      }
      if(!original.includes(from))throw new Error(`mutation ${name} has no matching source`);
      writeFileSync(path,original.replace(from,to));
    }
    const {stdout,stderr,...record}=await checkMutation(name,pattern,path,target);
    const caught=record.killed;
    console.log(JSON.stringify(record));if(out)appendFileSync(out,JSON.stringify(record)+'\n');
    if(['prepared-scope','same-job','deliverable-first','unsigned-only','exclude-vets','decline-no-signing','exact-plan-readback','retained-receipt-check','recovered-signed-scope'].includes(name)
      &&!record.errors.includes('Missing expected rejection.'))throw new Error(`${name} did not exercise its guard: it must be caught by admitting what the guard refuses, not by a different rejection`);
    if(!caught){survivors++;console.error(stdout,stderr);}
  }
}finally{rmSync(directory,{recursive:true,force:true});}
process.exitCode=survivors?1:0;
}
