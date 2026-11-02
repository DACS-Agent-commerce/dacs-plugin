#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { opsHealth, formatOpsHealth, STAGE_THRESHOLDS } from '../src/ops/health.mjs';

export function main(args=process.argv.slice(2),env=process.env) {
  const json=args.includes('--json');
  try {
    const flags={},thresholds={};
    for(let i=0;i<args.length;i++){
      const flag=args[i];
      if(flag==='--json')continue;
      if(flag==='--help'){
        process.stdout.write('Usage: node bin/dacs-ops-health.mjs [--json] [--data-dir DIR] [--database FILE] [--operator-state DIR] [--operator-config FILE] [--log FILE] [--recent-hours N] [--limit N] [--threshold STAGE=SECONDS]\n');return 0;
      }
      if(!['--data-dir','--database','--operator-state','--operator-config','--log','--recent-hours','--limit','--threshold'].includes(flag)||!args[i+1]||args[i+1].startsWith('--'))throw new Error();
      const value=args[++i];
      if(flag==='--threshold'){
        const [key,seconds,...extra]=value.split('=');
        if(extra.length||!Object.hasOwn(STAGE_THRESHOLDS,key)||!/^\d+$/.test(seconds)||!Number.isSafeInteger(Number(seconds)*1000)||Number(seconds)<1)throw new Error();
        thresholds[key]=Number(seconds)*1000;
      }else{if(Object.hasOwn(flags,flag))throw new Error();flags[flag]=value;}
    }
    const config=flags['--operator-config']?JSON.parse(readFileSync(resolve(flags['--operator-config']),'utf8')):null;
    if(config&&(typeof config.stateDirectory!=='string'||!config.stateDirectory))throw new Error();
    const operatorState=flags['--operator-state']??config?.stateDirectory;
    const dataDir=flags['--data-dir']??(operatorState?join(operatorState,'app'):env.DACS_DATA_DIR||join(process.cwd(),'.data'));
    const databasePath=flags['--database']??(env.DACS_DATABASE_PATH||join(dataDir,'dacs-chatgpt.sqlite'));
    for(const flag of ['--recent-hours','--limit'])if(flags[flag]&&!/^\d+(\.\d+)?$/.test(flags[flag]))throw new Error();
    const report=opsHealth({databasePath:resolve(databasePath),operatorState:operatorState?resolve(operatorState):null,
      logPath:flags['--log']?resolve(flags['--log']):null,recentHours:Number(flags['--recent-hours']??24),limit:Number(flags['--limit']??100),thresholds});
    process.stdout.write(json?`${JSON.stringify(report)}\n`:formatOpsHealth(report));return report.healthy?0:1;
  }catch{
    const error='ops health could not read valid state or options';
    if(json)process.stdout.write(`${JSON.stringify({format:'dacs-ops-health/v2',error})}\n`);
    else process.stderr.write(`${error}\n`);
    return 2;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=main();
