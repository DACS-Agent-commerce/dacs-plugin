import { pathToFileURL } from 'node:url';
import { directoryBinding, temporaryJournal, recipientScenario, unavailableScenario, lostScenario, deliveryScenario } from '../test/helpers/showcase-safety-fixture.mjs';
import { restartScenario } from '../test/helpers/showcase-safety-restart.mjs';

export const scenarios=Object.freeze({recipient:recipientScenario,unavailable:unavailableScenario,'lost-payment':lostScenario,
  restart:(path,identity)=>restartScenario(path,'broadcast',identity),
  'restart-before-broadcast':(path,identity)=>restartScenario(path,'journal',identity),delivery:deliveryScenario});

export async function runShowcase(name='all',print=console.log) {
  const names=name==='all'?Object.keys(scenarios):[name];
  if(names.some(key=>!Object.hasOwn(scenarios,key)))throw new Error(`choose all or ${Object.keys(scenarios).join(', ')}`);
  print('OFFLINE SAFETY SHOWCASE — fake chain/transport callbacks, no network sockets or external requests; no live effects.');
  print(directoryBinding()==='descriptor'
    ? 'Temporary journals are bound to their checked directory through /proc/self/fd.'
    : 'Temporary journals use path checks only (no /proc/self/fd); see Limits in docs/SHOWCASE-SAFETY.md.');
  const results=[];
  for(const key of names){
    const temp=temporaryJournal();
    let result;
    try{result=await scenarios[key](temp.path,temp.identity);}
    catch(error){
      // A cleanup failure must not hide the scenario's own error.
      try{temp.close();}catch(cleanup){if(error instanceof Error)error.suppressed=cleanup;}
      throw error;
    }
    temp.close();
    print(`\n[${key}]`);for(const line of result.lines)print(line);
    results.push({name:key,...result});
  }
  return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length>3)throw new Error('use one scenario name');
  await runShowcase(process.argv[2]);
}
