import { readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedTests, killed, runNodeTest } from './node-test-child.mjs';

const source=readFileSync(new URL('../../src/wallet/write-batch.mjs',import.meta.url),'utf8');
const mutations=[
  ['nonce-read','clean three-write','await readNonce(scope)','10'],
  ['reserved-nonce-clash','stale nonce',"!nonceValid(baseNonce)||!Number.isSafeInteger(baseNonce+plans.length)\n        ||(previous&&(!nonceValid(lastNonce)||baseNonce<lastNonce))\n        ||!plans.every((plan,index)=>plan.content.nonce===baseNonce+index+1)",'false'],
  ['retained-nonce-floor','shared wallet lock','(previous&&(!nonceValid(lastNonce)||baseNonce<lastNonce))','false'],
  ['durable-reservation-floor','single-write nonce check','floor.reservedNonce,floor.chainNonce','0,floor.chainNonce'],
  ['durable-reservation-persistence','single-write nonce check','await retainFloor(journal,lane,record.writes.at(-1).nonce);',''],
  ['authenticated-chain-floor','highest authenticated absence nonce','floor.reservedNonce,floor.chainNonce','floor.reservedNonce,0'],
  ['authenticated-chain-persistence','highest authenticated absence nonce','chainNonce:Math.max(prior.chainNonce,chainNonce)','chainNonce:prior.chainNonce'],
  ['exact-floor-readback','nonce floor persistence failure','JSON.stringify(await journal.get(floorKey(lane)))!==JSON.stringify(floor)','false'],
  ['floor-integrity','nonce floor persistence failure','||!nonceValid(floor.reservedNonce)||!nonceValid(floor.chainNonce)',''],
  ['single-reservation-validation','single reservation validates','await checkWalletWriteNonce({journal,network,chainIdentity,wallet,baseNonce,nonce});',''],
  ['single-reservation-persistence','single reservations','await retainFloor(journal,lane,nonce);',''],
  ['single-reservation-value','single reservation validates','await retainFloor(journal,lane,nonce);','await retainFloor(journal,lane,nonce-1);'],
  ['single-reservation-exact-readback','single reservation persistence errors','JSON.stringify(await journal.get(floorKey(lane)))!==JSON.stringify(floor)','false'],
  ['single-reservation-write-error','single reservation persistence errors','await retainFloor(journal,lane,nonce);','try { await retainFloor(journal,lane,nonce); } catch {}'],
  ['single-reservation-chain-floor','single reservation refuses stale authenticated','floor.reservedNonce,floor.chainNonce','floor.reservedNonce,0'],
  ['sign-order','clean three-write','for(const plan of plans){','for(const plan of plans.toReversed()){'],
  ['sign-all-before-send','clean three-write','signedWrites.push(write);','await broadcast({...scope,hash:write.hash,nonce,signedBytes});signedWrites.push(write);'],
  ['journal-before-send','clean three-write','await retain(record);',''],
  ['exact-journal-readback','journal write failure','JSON.stringify(await journal.get(lane))!==JSON.stringify(record)','false'],
  ['unknown-suffix','timeout at write two',"disposition:'indeterminate'","disposition:'submitted'"],
  ['stop-on-timeout','timeout at write two','} catch { break; }','} catch { continue; }'],
  ['first-write-unknown','unknown first write','} catch { break; }','} catch { continue; }'],
  ['stop-on-malformed-reply','dropped connection',"if(!exact(reply,['disposition','hash'])||reply.disposition!=='submitted'||reply.hash!==write.hash) break;",'if(false) break;'],
  ['reply-hash','dropped connection','||reply.hash!==write.hash',''],
  ['new-signing-fence','timeout at write two',"if(previous&&previous.stage!=='broadcast-accepted')","if(false)"],
  ['batch-replay','resolved history','if(await prior(batchId))','if(false)'],
  ['shared-wallet-lock','shared wallet lock','journal.withWalletLock(lane,async()=>{','(async(_lane,work)=>work())(lane,async()=>{'],
  ['restart-fence','process crash after durable',"if(previous&&previous.stage!=='broadcast-accepted')","if(false)"],
  ['journal-recording-stops-suffix','failure recording a broadcast answer','await retain(record);\n      }','try { await retain(record); } catch {}\n      }'],
  ['signed-nonce','wrong signed bytes','signed.content?.nonce===write.nonce','true'],
  ['signed-wallet','wrong signed bytes','signed.content?.from===wallet','true'],
  ['signed-hash','wrong signed bytes',"!HASH.test(write.hash ?? '')",'false'],
  ['approved-scope','wrong signed bytes','await verifySigned({...scope,transaction:structuredClone(plan),signedBytes,hash:write.hash,nonce})!==true','false'],
  ['included-proof','unverified inclusion','await verifyIncluded({...request,observation})===true','true'],
  ['readback-identity','unverified inclusion','observation?.hash===write.hash&&observation.wallet===wallet&&observation.nonce===write.nonce','true'],
  ['readback-outage','unverified inclusion','} catch { /* Unavailable or unverifiable readback leaves the original fence. */ }',"} catch { disposition='included'; }"],
  ['whole-batch-resolution','absence needs','record.writes.every(terminal))record','record.writes.some(terminal))record'],
  ['absence-nonce','absence needs','nonceValid(observation.chainNonce)','true'],
  ['strictly-past-nonce','absence needs','observation.chainNonce>write.nonce','observation.chainNonce>=write.nonce'],
  ['absence-proof','absence needs','await absencePolicy.verify({...request,observation})===true','true'],
  ['explicit-absence-policy','absence needs','absencePolicy&&',''],
  ['bytes-integrity','reopened journals','write.bytesHash!==digest(write.signedBytes)','false'],
  ['resolved-stage-integrity','reopened journals',"||(record.stage==='broadcast-accepted')!==record.writes.every(terminal)",''],
  ['resolved-history','resolved history','await journal.put(archiveKey(record.batchId),record);',''],
  ['archive-recovery','committed resolved archive','if(current.stage!==\'broadcast-accepted\')await retain(archived);',''],
  ['archive-identity','archive recovery requires','JSON.stringify(resolved)!==JSON.stringify(archived)','false'],
  ['archive-terminal-consistency','archive recovery requires','current.writes.some((write,index)=>terminal(write)&&write.disposition!==archived.writes[index].disposition)','false'],
];
export async function checkMutation(name, pattern, path, { cwd = process.cwd(), env = process.env } = {}) {
  const onSpawn=(pid)=>console.log(`${name}: process group ${pid}`);
  const {DACS_BATCH_TEST_MODULE,...unmutatedEnv}=env;
  // Each mutant run must report every test that the unmutated module's run of the same pattern reports.
  const expected=await expectedTests('test/wallet-write-batch.test.mjs',{cwd,args:[`--test-name-pattern=${pattern}`],env:unmutatedEnv,timeoutMs:30000,maxBuffer:1024*1024,onSpawn});
  const result=await runNodeTest('test/wallet-write-batch.test.mjs',
    {cwd,args:[`--test-name-pattern=${pattern}`],env:{...env,DACS_BATCH_TEST_MODULE:path},timeoutMs:30000,maxBuffer:1024*1024,expected,onSpawn});
  const caught=killed(result);
  const errors=[...result.tap.matchAll(/^\s+error: '([^']+)'$/gm)].map(match=>match[1]);
  const record={name,pattern,killed:caught,file:result.file,nodeVersion:result.nodeVersion,exit:result.exit,tests:result.tests,pass:result.pass,fail:result.fail,incomplete:result.incomplete,errors};
  return { ...record, stdout: result.stdout, stderr: result.stderr };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const directory=mkdtempSync(join(tmpdir(),'wallet-batch-mutants-'));
const output=process.argv[2];
if(output)writeFileSync(output,'');
let failures=0;
try {
  for(const [name,pattern,from,to] of mutations){
    // The resolution mutation changes both the validator and transition.
    let mutant;
    if(name==='whole-batch-resolution')mutant=source.replaceAll('record.writes.every(terminal)','record.writes.some(terminal)');
    else if(name==='explicit-absence-policy')mutant=source.replace('absencePolicy&&','').replace('await absencePolicy.verify({...request,observation})','await (absencePolicy?.verify ?? (async()=>true))({...request,observation})');
    else {
      if(!source.includes(from))throw new Error(`mutation ${name} has no matching source`);
      mutant=source.replace(from,to);
    }
    const path=join(directory,`${name}.mjs`);writeFileSync(path,mutant);
    const {stdout,stderr,...record}=await checkMutation(name,pattern,path);
    const caught=record.killed;
    console.log(JSON.stringify(record));if(output)appendFileSync(output,JSON.stringify(record)+'\n');
    if(['new-signing-fence','restart-fence','batch-replay','single-reservation-persistence'].includes(name)
      &&!record.errors.includes('Missing expected rejection.'))throw new Error(`${name} must be caught by admitting a forbidden fresh plan, not a different rejection`);
    if(!caught){failures+=1;console.error(stdout,stderr);}
  }
} finally {rmSync(directory,{recursive:true,force:true});}
process.exitCode=failures?1:0;
}
