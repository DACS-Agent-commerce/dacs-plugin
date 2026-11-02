import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const snapshot = (dir) => Object.fromEntries(readdirSync(dir,{withFileTypes:true}).filter((e)=>!['node_modules','.git'].includes(e.name)).flatMap((e)=> {
  const path=join(dir,e.name);
  return e.isDirectory()?Object.entries(snapshot(path)).map(([k,v])=>[`${e.name}/${k}`,v]):[[e.name,createHash('sha256').update(readFileSync(path)).digest('hex')]];
}));
test('mutant helper leaves project byte-identical even when SIGKILL interrupts an active mutation', async () => {
  const stage=mkdtempSync(join(tmpdir(),'probe-kill-')),project=join(stage,'http-mcp');
  cpSync(resolve('.'),project,{recursive:true,filter:(p)=>!p.split('/').includes('node_modules')});
  symlinkSync(resolve('node_modules'),join(project,'node_modules'),'dir');
  const before=snapshot(project),source=join(project,'src/config.mjs');
  const child=spawn(process.execPath,['test/helpers/wallet-extension-probe-mutants.mjs',join(stage,'mutants.jsonl')],{cwd:project,detached:true,stdio:['ignore','pipe','pipe','ipc']});
  let active=false,privateRoot;
  child.on('message',(m)=>{if(m.event==='mutated'){active=true;privateRoot=m.projectRoot;}});
  let output='';child.stdout.on('data',(d)=>{output+=d;});child.stderr.on('data',(d)=>{output+=d;});
  const closed=new Promise((r)=>child.on('close',r));
  try {
    const deadline=Date.now()+10000;
    while(!active&&Date.now()<deadline&&child.exitCode===null) {
      if(createHash('sha256').update(readFileSync(source)).digest('hex')!==before['src/config.mjs']) active=true;
      else await new Promise((r)=>setTimeout(r,10));
    }
    assert.equal(active,true,`must interrupt an actual source mutation: ${output}`);
    if(privateRoot) {
      assert.notEqual(privateRoot,project);
      assert.equal(statSync(privateRoot).mode&0o777,0o700);
      const denied=spawnSync(process.execPath,['--permission','--allow-fs-read=*',`--allow-fs-write=${privateRoot}/src`,'--input-type=module','-e',`import {openSync,closeSync} from 'node:fs';try{closeSync(openSync(${JSON.stringify(privateRoot+'/node_modules/oidc-provider/package.json')},'r+'));process.exit(1);}catch(e){process.exit(e.code==='ERR_ACCESS_DENIED'?0:2);}`],{encoding:'utf8'});
      assert.equal(denied.status,0,'linked dependencies cannot be opened for writing');
    }
    process.kill(-child.pid,'SIGKILL');await closed;
    assert.deepEqual(snapshot(project),before,'killed helper must leave every project byte unchanged');
  } finally {
    if(child.exitCode===null) {try{process.kill(-child.pid,'SIGKILL');}catch{} await closed;}
    rmSync(stage,{recursive:true,force:true});
  }
});

function stageProject(prefix) {
  const stage=mkdtempSync(join(tmpdir(),prefix)),project=join(stage,'http-mcp');
  cpSync(resolve('.'),project,{recursive:true,filter:(p)=>!p.split('/').includes('node_modules')});
  symlinkSync(resolve('node_modules'),join(project,'node_modules'),'dir');
  return {stage,project};
}
// Each output aliases the checkout: a path in it, or a symlink, parent-folder
// symlink or hardlink that lexically sits in the private TMPDIR.
const aliases = {
  'an existing checkout file': (stage,project)=>join(project,'src/config.mjs'),
  'a new checkout file': (stage,project)=>join(project,'src/mutants.jsonl'),
  'an output symlink to a checkout file': (stage,project)=>{symlinkSync(join(project,'src/config.mjs'),join(stage,'result.jsonl'));return join(stage,'result.jsonl');},
  'a parent-folder symlink into the checkout': (stage,project)=>{symlinkSync(join(project,'src'),join(stage,'out'),'dir');return join(stage,'out','result.jsonl');},
  'a hardlink alias of a checkout file': (stage,project)=>{linkSync(join(project,'src/config.mjs'),join(stage,'result.jsonl'));return join(stage,'result.jsonl');},
};
for (const [name, alias] of Object.entries(aliases)) {
  test(`mutant helper refuses ${name} as output before writing any bytes`, async () => {
    const {stage,project}=stageProject('probe-output-');
    const before=snapshot(project),out=alias(stage,project);
    const child=spawn(process.execPath,['test/helpers/wallet-extension-probe-mutants.mjs',out],{cwd:project,detached:true,stdio:['ignore','pipe','pipe','ipc']});
    let mutated=false;
    child.on('message',()=>{mutated=true;try{process.kill(-child.pid,'SIGKILL');}catch{}});
    const closed=new Promise((r)=>child.on('close',r)),timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);
    try {
      const status=await closed;
      assert.equal(mutated,false,'invalid output must be rejected before mutation');assert.notEqual(status,0);
      assert.deepEqual(snapshot(project),before);
    } finally {clearTimeout(timer);rmSync(stage,{recursive:true,force:true});}
  });
}
test('mutant helper appends only through the descriptor it created, never by path', async () => {
  const {stage,project}=stageProject('probe-append-'),out=join(stage,'mutants.jsonl'),moved=join(stage,'moved.jsonl'),canary=join(stage,'canary');
  writeFileSync(canary,'canary\n');
  const child=spawn(process.execPath,['test/helpers/wallet-extension-probe-mutants.mjs',out],{cwd:project,detached:true,stdio:['ignore','pipe','pipe','ipc']});
  let swapped=false;
  child.on('message',()=>{if(!swapped){swapped=true;renameSync(out,moved);symlinkSync(canary,out);}});
  const closed=new Promise((r)=>child.on('close',r));
  try {
    const deadline=Date.now()+60000;
    while(Date.now()<deadline&&child.exitCode===null&&readFileSync(canary,'utf8')==='canary\n'&&!(swapped&&readFileSync(moved,'utf8'))) await new Promise((r)=>setTimeout(r,20));
    assert.equal(swapped,true,'helper must start mutating');
    assert.equal(readFileSync(canary,'utf8'),'canary\n','a path swapped in after creation must not receive records');
    assert.match(readFileSync(moved,'utf8'),/^\{"id":"/,'the first record goes to the file the helper created');
  } finally {
    try{process.kill(-child.pid,'SIGKILL');}catch{} await closed;
    rmSync(stage,{recursive:true,force:true});
  }
});
