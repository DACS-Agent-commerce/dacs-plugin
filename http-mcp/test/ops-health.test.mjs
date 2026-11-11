import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { canonicalize, contentHash, fixedPriceAgreementLogicalAddress, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { openDatabase } from '../src/store/database.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { openDurableWalletJournal, DURABLE_WALLET_JOURNAL_VERSION } from '../src/wallet/durable-journal.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { PAYER, signTransaction } from './helpers/claude-native-readback-current-fixture.mjs';
import { DENIED_UNSIGNED } from '../src/dacs/demos-sr2-adapter.mjs';
import * as health from '../src/ops/health.mjs';
const { opsHealth, formatOpsHealth, readOnlySnapshot, STAGE_THRESHOLDS } = health;

const INACTIVE_NETWORK={chainId:7,forks:{osDenomination:{activated:true},signatureDomain:{activated:false}}};
const NOW=Date.now(),address=`0x${'a'.repeat(64)}`,buyer=`did:demos:agent:${'b'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
// A wallet-Agreement purchase's scope on the source transport: its terms.domain
// network and chain identity, job, transport binding and planned Agreement.
const WALLET_SCOPE=(()=>{
  const network='demos-devnet',chainIdentity='d'.repeat(64),jobId='01ARZ3NDEKTSV4RRFFQ69G5FAV',agreement={artifactType:'Agreement',jobId,TEST:'fixture Agreement'};
  return {network,chainIdentity,jobId,agreement,agreementHash:contentHash(agreement),transportBinding:{source:'devnet-agreement-transport/v1',network,chainIdentity,pinVersion:'TEST-fixture-pin',endpoint:'https://ops-health.invalid/',bindingId:sha('TEST fixture binding')}};
})();
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'ops-health-')),path=join(root,'app','dacs-chatgpt.sqlite');
  const db=openDatabase(path),clock={now:NOW},accounts=createAccountService({db,builtinIssuer:'test',now:()=>clock.now});
  const account=accounts.resolveFromToken({issuer:'test-external',subject:'fixture'}),ops=createOperationStore({db,handoffSecret:'TEST ONLY '.repeat(4),now:()=>clock.now});
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  // wallet: a wallet-Agreement purchase on the source transport (WALLET_SCOPE),
  // with the wallet CREATE intent protocol-purchases.mjs retains (walletAnchor):
  // retained is its exact Agreement (null: no intent retained). scope replaces
  // any of its terms (buyer, network, chainIdentity, jobId, transportBinding,
  // termsHash) or its account, as a database could hold them.
  const create=({stage='awaiting_approval',status=stage,protocol=false,wallet=false,retained=WALLET_SCOPE.agreement,scope={},at=NOW}={})=>{
    clock.now=at;
    const s={...WALLET_SCOPE,buyer:`0x${'b'.repeat(64)}`,termsHash:'c'.repeat(64),account:account.id,...scope},domain=wallet?{domain:{network:s.network,rail:'demos-native:DEM',mode:'public-chain-read',chainIdentity:s.chainIdentity}}:{};
    if(s.account!==account.id&&!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(s.account))db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(s.account,'TEST',`TEST-${counter}`,new Date(at).toISOString());
    const walletAnchor=retained&&{logicalAddress:fixedPriceAgreementLogicalAddress(s.jobId),artifact:retained,writer:`did:demos:agent:${s.buyer.slice(2)}`,artifactKind:'Agreement',jobId:s.jobId,receiptContentHash:s.agreementHash};
    return ops.createIdempotent({accountId:s.account,kind:'purchase',idempotencyKey:String(counter++),request:{n:counter},status,terms:{buyer:{wallet:s.buyer},seller:{payee:address},...domain,...(protocol||wallet?{protocol:{jobId:s.jobId,...(wallet?{transportBinding:s.transportBinding}:{})}}:{})},termsHash:s.termsHash,expiresAt:new Date(at+3600000).toISOString(),state:protocol||wallet?{protocol:{stage,...(wallet?{planned:{plan:{agreementHash:s.agreementHash}},walletAnchor}:{})}}:{}}).operation;
  };
  let counter=0;
  // The retained failed transfers here are signed over the bare hash, as the node does while its signatureDomain fork is inactive.
  const report=(options={})=>opsHealth({databasePath:path,now:NOW,operatorState:root,networkInfo:INACTIVE_NETWORK,...options});
  const cli=(args=[])=>spawnSync(process.execPath,['scripts/ops-health.mjs','--database',path,'--operator-state',root,...args],{cwd:resolve('.'),encoding:'utf8',timeout:10000});
  const durable=(file)=>{const j=openDurableWalletJournal({path:join(root,file),mode:'create'});t.after(()=>j.close());return j;};
  return {root,path,db,clock,ops,create,report,cli,durable};
}

test('healthy and empty real-schema databases; text and JSON CLI; terminal purchases stay terminal',t=>{
  const h=fixture(t);
  assert.equal(h.report().healthy,true);assert.deepEqual(h.report().purchases,[]);
  const empty=h.cli(['--json']);assert.equal(empty.status,0,empty.stderr);assert.deepEqual(JSON.parse(empty.stdout).purchases,[]);
  assert.match(h.cli().stdout,/recent purchases: none/);
  h.create();h.create({status:'cancelled',stage:'identity',protocol:true,at:NOW-90000000});
  h.create({status:'settled_verified',stage:'completed',protocol:true,at:NOW-90000000});
  h.create({status:'settled_verified',at:NOW-90000000});
  const report=h.report();assert.equal(report.healthy,true);assert.equal(report.purchases.length,1);assert.deepEqual(report.stuck,[]);
});

// The advice each stuck stage gives (the unknown payment stages always need the original write's readback).
const ADVICE={identity:'buyer identity presentation','agreement-signing':'Agreement signature and anchor readback','agreement-anchored':'seller commitment readback',
  committed:'buyer payment approval','seller-committed':'buyer payment approval (profile may hold payment)',agreement_pending:'Agreement progress',awaiting_approval:'buyer payment approval',
  approved:'one-time wallet handoff',payment_handoff:'original payment readback; never resend',broadcast_reported:'original payment readback; never resend',
  payment_uncertain:'original write readback; never resend',unknown:'original write readback; never resend','payment-observed':'payment evidence readback (profile may hold claims)',
  'awaiting-claim':'seller claim acceptance and payment evidence readback','native-payment-evidence-held':'original evidence write readback; never resend','payment-evidenced':'delivery readback',
  'delivery-ready':'delivery evidence readback (profile may defer completion)',delivered:'completed bundle (profile may defer completion)','awaiting-countersignature':'buyer bundle countersignature and copy readback'};
for(const [stage,thresholdMs] of Object.entries(STAGE_THRESHOLDS))test(`stuck boundary and override: ${stage}`,t=>{
  const h=fixture(t),payment=new Set(['agreement_pending','awaiting_approval','approved','payment_handoff','broadcast_reported','payment_uncertain']);
  const protocol=!payment.has(stage),initial=h.create({protocol,status:protocol?'agreement_pending':stage,stage:protocol?'identity':stage,at:NOW-thresholdMs});
  let operation=initial;
  if(protocol){h.clock.now=NOW-thresholdMs;operation=h.ops.transition(initial.id,initial.status,initial.status,{state:{protocol:{stage}},event:'protocol_step',data:{stage}});}
  else h.clock.now=NOW-thresholdMs;
  const entered=NOW-thresholdMs;
  assert.equal(h.report({now:entered+thresholdMs}).stuck.length,0,'exact threshold is healthy');
  const stuck=h.report({now:entered+thresholdMs+1}).stuck;
  assert.equal(stuck.length,1);assert.equal(stuck[0].stage,stage);assert.equal(stuck[0].ageMs,thresholdMs+1);assert.equal(stuck[0].nextExpected,ADVICE[stage]);
  assert.equal(h.report({now:entered+thresholdMs+1,thresholds:{[stage]:thresholdMs+2000}}).stuck.length,0,'override controls the alert');
  h.clock.now=NOW;
  h.ops.transition(operation.id,operation.status,operation.status,{event:protocol?'protocol_step':'payment_readback_pending',data:protocol?{stage}: {reason:'still waiting'}});
  assert.equal(h.report({now:entered+thresholdMs+1}).stuck[0].ageMs,thresholdMs+1,'poll does not reset stage age');
});

test('purchase event timeline and optional logged stages retain timestamps and gaps',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-6000});
  h.clock.now=NOW-4000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing'}},event:'protocol_agreement_planned',data:{stage:'agreement-signing'}});
  h.clock.now=NOW-1000;h.ops.transition(p.id,p.status,p.status,{event:'protocol_step',data:{stage:'agreement-signing'}});
  h.ops.record(p.id,'commitment_recheck_refused',{stage:'pre-approval',reason:'secret not a stage'});
  const log=join(h.root,'server.log');
  writeFileSync(log,JSON.stringify({event:'purchase_timeline',purchaseId:p.id,steps:[{step:'stage-change',timestampMs:NOW-3000,stage:'agreement-signing',token:'FAKE SECRET'}]}));
  const r=h.report({logPath:log}),timeline=r.purchases[0].timeline;
  assert.deepEqual(timeline.map(e=>[e.lane,e.stage,e.gapMs]),[['purchase','agreement_pending',0],['protocol','identity',0],['protocol','agreement-signing',2000],['log','agreement-signing',1000]]);
  assert.equal(r.purchases[0].ageMs,4000);assert.equal(timeline[2].at,new Date(NOW-4000).toISOString());
  assert.match(formatOpsHealth(r),/gapMs=2000 protocol:agreement-signing/);
});

test('logged stages interleave with database stages in timestamp order',t=>{
  const h=fixture(t),p=h.create({at:NOW-900000});
  h.clock.now=NOW-600000;h.ops.transition(p.id,'awaiting_approval','approved');
  const log=join(h.root,'interleaved.log');
  writeFileSync(log,JSON.stringify({event:'purchase_timeline',purchaseId:p.id,steps:[{step:'stage-change',timestampMs:NOW-750000,stage:'approved'}]}));
  const timeline=h.report({logPath:log}).purchases[0].timeline;
  assert.deepEqual(timeline.map(e=>[e.lane,e.at,e.gapMs]),[
    ['purchase',new Date(NOW-900000).toISOString(),0],
    ['log',new Date(NOW-750000).toISOString(),150000],
    ['purchase',new Date(NOW-600000).toISOString(),150000],
  ]);
});

test('an operator root symlink resolves to its real service directory',t=>{
  const h=fixture(t);h.create();
  const alias=join(h.root,'operator-alias');fs.symlinkSync(h.root,alias);
  assert.deepEqual(h.report({operatorState:alias}),h.report());
});

for(const byte of [18,19])test(`WAL header byte ${byte} independently rejects rollback format`,t=>{
  const h=fixture(t);h.create();
  const original=readFileSync(h.path),mixed=Buffer.from(original);
  assert.equal(original[18],2);assert.equal(original[19],2);
  assert.ok(readFileSync(`${h.path}-wal`).length>0);
  mixed[byte]=1;
  try{writeFileSync(h.path,mixed);assert.throws(()=>h.report(),/could not read valid state/);}
  finally{writeFileSync(h.path,original);}
  assert.equal(h.report().healthy,true);
});

test('unknown outcomes require readback, never failure; CLI exit 1 and old purchases remain checked',t=>{
  const h=fixture(t),p=h.create({stage:'payment_uncertain',at:NOW-2*86400000});
  const report=h.report({limit:1});assert.equal(report.purchases.length,0);assert.equal(report.healthy,false);
  assert.equal(report.stuck[0].purchaseId,p.id);assert.equal(report.stuck[0].outcome,'unknown-readback-required');
  assert.match(report.stuck[0].nextExpected,/readback; never resend/);assert.doesNotMatch(formatOpsHealth(report),/failed/);
  const cli=h.cli(['--json']);assert.equal(cli.status,1,cli.stderr);assert.equal(JSON.parse(cli.stdout).stuck[0].outcome,'unknown-readback-required');
});

test('settled payment with unfinished protocol is still monitored',t=>{
  const h=fixture(t),p=h.create({stage:'committed',protocol:true,status:'agreement_pending',at:NOW-600000});
  h.clock.now=NOW-400000;h.ops.transition(p.id,p.status,'settled_verified');
  let r=h.report();assert.equal(r.stuck[0].stage,'awaiting-claim');assert.equal(r.stuck[0].ageMs,400000);
  // Its age is from the settlement, not a later poll.
  h.clock.now=NOW-100000;h.ops.transition(p.id,'settled_verified','settled_verified',{event:'payment_readback_pending',data:{}});
  r=h.report();assert.deepEqual([r.stuck[0].stage,r.stuck[0].ageMs],['awaiting-claim',400000]);
});


test('seller journals show pending writes, exclude buyer transport and verified/denied writes, retain live locks',async t=>{
  const h=fixture(t),artifacts=h.durable('seller-artifacts.sqlite'),wallet=h.durable('seller-wallet.sqlite'),transport=h.durable('node2-transport.sqlite');
  h.create();
  const hash='e'.repeat(64),content={from:address};
  await artifacts.put('demo/artifact/TEST',{stage:'issued',hash,transaction:{content}});
  await artifacts.put('demo/artifact/verified',{stage:'verified',hash:'f'.repeat(64),transaction:{content}});
  await artifacts.put('demo/artifact/denied',{stage:'denied',transaction:{content}});
  await wallet.put('sr2/wallet/TEST',{stage:'sr2-readback-pending',hash,signedTransaction:{content}});
  await wallet.put('sr2/wallet/settled',{stage:'broadcast-accepted',hash:'f'.repeat(64),signedTransaction:{content}});
  await transport.put('seller-transport',{stage:'broadcast-started',hash,signedTransaction:{content}});
  await transport.put('buyer-transport',{stage:'broadcast-started',hash:'b'.repeat(64),signedTransaction:{content:{from:`0x${'b'.repeat(64)}`}}});
  await artifacts.withWalletLock('demo/artifact/TEST',async()=>{
    const locks=artifacts.inspectLocks(),r=h.report();assert.equal(r.seller.unconfirmed.length,3);assert.equal(r.healthy,false);
    assert.deepEqual(r.seller.unconfirmed.map(row=>row.stage),['issued','sr2-readback-pending','broadcast-started']);
    assert.deepEqual(artifacts.inspectLocks(),locks,'health never acquires or removes operator locks');
    assert.equal(h.cli(['--json']).status,1);
  });
  await artifacts.put('demo/artifact/TEST',{stage:'verified',hash,transaction:{content}});
  await wallet.put('sr2/wallet/TEST',{stage:'broadcast-accepted',hash,signedTransaction:{content}});
  await transport.put('seller-transport',{stage:'observed',hash,signedTransaction:{content}});
  assert.equal(h.report().healthy,true);
});

function bytes(root){
  const result={};
  for(const name of readdirSync(root,{withFileTypes:true})){
    const path=join(root,name.name);
    if(name.isDirectory()){for(const [key,value] of Object.entries(bytes(path)))result[`${name.name}/${key}`]=value;}
    else result[name.name]=sha(readFileSync(path));
  }
  return result;
}
test('read-only driver rejects writes; database, WAL, SHM, journals and evidence are byte-identical after CLI',async t=>{
  const h=fixture(t);h.create();const j=h.durable('seller-artifacts.sqlite');await j.put('TEST',{stage:'verified',transaction:{content:{from:address}}});
  mkdirSync(join(h.root,'evidence'));writeFileSync(join(h.root,'evidence','seller-approvals.jsonl'),'');
  const scratch=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('dacs-ops-health-')).sort(),originalScratch=scratch();
  const before=bytes(h.root),cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);assert.deepEqual(bytes(h.root),before);
  assert.throws(()=>readOnlySnapshot(h.path,db=>{db.exec('PRAGMA query_only=OFF');db.exec("UPDATE meta SET value='99' WHERE key='schema_version'");}),/readonly/);
  assert.deepEqual(bytes(h.root),before);
  assert.deepEqual(scratch(),originalScratch,'scratch copies are removed on success and error');
});

test('concurrent WAL writer proceeds while health reads; uncommitted state stays invisible',t=>{
  const h=fixture(t),p=h.create(),writer=new DatabaseSync(h.path);
  t.after(()=>writer.close());
  writer.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  writer.prepare("UPDATE operations SET status='payment_uncertain' WHERE id=?").run(p.id);
  const cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).purchases[0].stage,'awaiting_approval');
  readOnlySnapshot(h.path,()=>{writer.exec('COMMIT');writer.exec('BEGIN IMMEDIATE');writer.exec('COMMIT');});
  assert.equal(h.report().purchases[0].stage,'payment_uncertain');
});

test('redaction: payloads, arbitrary labels, keys, sessions, tokens and error text never escape',async t=>{
  const h=fixture(t),fake='FAKE_PRIVATE_KEY_0x'+'9'.repeat(64),p=h.create();
  h.ops.transition(p.id,p.status,p.status,{state:{privateKey:fake,sessionKey:fake,cookie:fake,token:fake,signedTransaction:{signature:fake}},event:'debug',data:{reason:fake,stage:fake}});
  h.db.prepare('INSERT INTO secrets VALUES (?,?,?)').run('FAKE',fake,new Date(NOW).toISOString());
  const j=h.durable('seller-artifacts.sqlite');await j.put(fake,{stage:'issued',hash:'e'.repeat(64),transaction:{content:{from:address,signature:fake}},input:{artifact:{privateKey:fake}}});
  const log=join(h.root,'server.log');writeFileSync(log,JSON.stringify({event:'purchase_step',purchaseId:p.id,step:'stage-change',stage:'awaiting_approval',timestampMs:NOW,token:fake,sessionKey:fake,signedPayload:fake}));
  const report=h.report({logPath:log});assert.ok(!JSON.stringify(report).includes(fake));assert.ok(!formatOpsHealth(report).includes(fake));
  for(const args of [[],['--json']]){const cli=h.cli([...args,'--log',log]);assert.ok(!`${cli.stdout}${cli.stderr}`.includes(fake));}
  h.db.prepare('UPDATE operations SET status=? WHERE id=?').run(fake,p.id);
  for(const args of [[],['--json']]){const cli=h.cli(args);assert.ok(!`${cli.stdout}${cli.stderr}`.includes(fake));assert.equal(cli.status,2);}
  writeFileSync(log,`{"${fake}":`);
  const invalid=h.cli(['--json','--operator-config',log]);assert.equal(invalid.status,2);assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(fake));
  const missing=h.cli(['--json','--operator-config',join(h.root,fake)]);assert.equal(missing.status,2);assert.ok(!`${missing.stdout}${missing.stderr}`.includes(fake));
});

test('errors never create absent state; invalid flags, schemas and damaged journals return 2',async t=>{
  const h=fixture(t),before=bytes(h.root);
  for(const args of [['--database',join(h.root,'absent.sqlite')],['--threshold','identity=0'],['--threshold','no-stage=5'],['--limit','1.5'],['--bad','secret'],['--recent-hours','0']])assert.equal(h.cli(args).status,2);
  assert.deepEqual(bytes(h.root),before);
  h.db.prepare("UPDATE meta SET value='999' WHERE key='schema_version'").run();assert.equal(h.cli().status,2);
  h.db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
  const j=h.durable('seller-wallet.sqlite');await j.put('TEST',{stage:'verified'});
  const corrupt=new DatabaseSync(join(h.root,'seller-wallet.sqlite'));corrupt.exec(`UPDATE records SET digest='${'0'.repeat(64)}'`);corrupt.close();
  assert.equal(h.cli(['--json']).status,2);
});

test('CLI path selection, filters and threshold flags are explicit; absent database is not created',t=>{
  // Only the CLI reads these, on the wall clock, which can be minutes past NOW by this test on a loaded host.
  const h=fixture(t),wall=Date.now();h.create({at:wall-600000});h.create({at:wall});
  const run=(args,env={})=>spawnSync(process.execPath,['scripts/ops-health.mjs',...args],{cwd:resolve('.'),env:{...process.env,DACS_DATA_DIR:'',DACS_DATABASE_PATH:'',...env},encoding:'utf8',timeout:10000});
  let cli=run(['--data-dir',join(h.root,'app'),'--json','--limit','1','--recent-hours','1','--threshold','awaiting_approval=60']);
  assert.equal(cli.status,1,cli.stderr);assert.equal(JSON.parse(cli.stdout).purchases.length,1);assert.equal(JSON.parse(cli.stdout).stuck.length,1);
  cli=run(['--json'],{DACS_DATABASE_PATH:h.path});assert.equal(cli.status,0,cli.stderr);
  cli=run(['--operator-state',h.root,'--json']);assert.equal(cli.status,0,cli.stderr);
  const before=bytes(h.root),absent=join(h.root,'absent.sqlite');cli=run(['--database',absent,'--json']);assert.equal(cli.status,2);assert.deepEqual(bytes(h.root),before);
});

test('unknown protocol attempts keep their stage and advertise readback only',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-400000});
  h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-anchored',attempts:[{step:'agreement',outcome:'indeterminate',reason:'TEST'}]}},event:'protocol_commit-request',data:{stage:'agreement-anchored'}});
  const stuck=h.report().stuck[0];assert.equal(stuck.stage,'agreement-anchored');assert.equal(stuck.outcome,'unknown-readback-required');assert.match(stuck.nextExpected,/readback; never resend/);
});

test('transport-only seller writes can be attributed from purchase terms; unknown ownership fails closed',async t=>{
  const h=fixture(t),transport=h.durable('node2-transport.sqlite');
  await transport.put('TEST',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  assert.throws(()=>h.report());h.create();assert.equal(h.report().seller.unconfirmed.length,1);
});

test('threshold defaults allow human approvals and multiple block readbacks',()=>{
  const expected={identity:1800000,'agreement-signing':600000,'agreement-anchored':300000,committed:1800000,'seller-committed':1800000,agreement_pending:600000,awaiting_approval:1800000,approved:300000,payment_handoff:300000,broadcast_reported:300000,payment_uncertain:300000,unknown:300000,'payment-observed':300000,'awaiting-claim':300000,'native-payment-evidence-held':300000,'payment-evidenced':300000,'delivery-ready':600000,delivered:600000,'awaiting-countersignature':1800000};
  assert.deepEqual(STAGE_THRESHOLDS,expected);
});

test('a DB/WAL pair changing during the copy fails closed without opening a snapshot',t=>{
  const h=fixture(t),p=h.create(),original=fs.readFileSync;
  let reads=0,opened=false;
  fs.readFileSync=(path,...args)=>{
    if(path===h.path&&++reads===2)h.ops.transition(p.id,p.status,'payment_uncertain');
    return original(path,...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(()=>readOnlySnapshot(h.path,()=>{opened=true;}),/could not read valid state/);assert.equal(opened,false); }
  finally { fs.readFileSync=original;syncBuiltinESMExports(); }
});


test('symlink database includes committed uncheckpointed real WAL',t=>{
  const h=fixture(t);h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const p=h.create({stage:'payment_uncertain',at:NOW-600000});
  const alias=join(h.root,'alias.sqlite');fs.symlinkSync(h.path,alias);
  const before=bytes(h.root),r=h.report({databasePath:alias});
  assert.equal(r.healthy,false);assert.equal(r.stuck[0].purchaseId,p.id);
  assert.deepEqual(bytes(h.root),before);
});

test('cross-service database and operator roots fail closed',async t=>{
  const a=fixture(t),b=fixture(t);a.create();
  assert.throws(()=>a.report({operatorState:b.root}),'even an empty foreign operator root is invalid');
  await b.durable('node2-transport.sqlite').put('other-service',{stage:'broadcast-started',signedTransaction:{content:{from:`0x${'c'.repeat(64)}`}}});
  assert.throws(()=>a.report({operatorState:b.root}));
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',a.path,'--operator-state',b.root,'--json'],{encoding:'utf8'});
  assert.equal(cli.status,2);
});

test('pending transport owners must be known sellers or explicit buyers',async t=>{
  const h=fixture(t);h.create();const j=h.durable('node2-transport.sqlite');
  await j.put('unknown-owner',{stage:'unknown',signedTransaction:{content:{from:`0x${'c'.repeat(64)}`}}});
  assert.throws(()=>h.report());assert.equal(h.cli(['--json']).status,2);
  await j.put('unknown-owner',{stage:'observed',signedTransaction:{content:{from:`0x${'c'.repeat(64)}`}}});
  await j.put('buyer',{stage:'broadcast-started',signedTransaction:{content:{from:`0x${'b'.repeat(64)}`}}});
  assert.equal(h.report().healthy,true);
  await j.put('buyer',{stage:'unknown'});assert.throws(()=>h.report());
});

test('settled artifact wallet namespace clears while transport still needs readback',async t=>{
  const h=fixture(t),j=h.durable('seller-artifacts.sqlite');h.create();
  await j.put('demo/artifact/settled',{stage:'verified',transaction:{content:{from:address}}});
  await j.put('demo/wallet/settled',{stage:'broadcast-accepted',signedTransaction:{content:{from:address}}});
  assert.equal(h.report().healthy,true);
  await j.put('demo/artifact/pending',{stage:'broadcast-accepted',transaction:{content:{from:address}}});
  const transport=h.durable('node2-transport.sqlite');
  await transport.put('pending',{stage:'broadcast-accepted',signedTransaction:{content:{from:address}}});
  assert.equal(h.report().seller.unconfirmed.length,2);
});

test('elapsed approval windows are expired at equality, other outcomes retain readback',t=>{
  const h=fixture(t);
  for(const protocol of [false,true]){
    const p=h.create({protocol,stage:protocol?'identity':'awaiting_approval',status:protocol?'agreement_pending':'awaiting_approval',at:NOW-3600000});
    assert.equal(h.report({now:NOW-1}).purchases.find(row=>row.purchaseId===p.id).stage,protocol?'identity':'awaiting_approval');
    assert.equal(h.report().purchases.find(row=>row.purchaseId===p.id).stage,'expired');
  }
  assert.deepEqual(h.report().stuck,[]);
  h.create({stage:'payment_uncertain',at:NOW-3600000});assert.equal(h.report().stuck[0].stage,'payment_uncertain');
  h.db.exec("UPDATE operations SET expires_at='invalid'");assert.throws(()=>h.report());
});

test('scratch root cannot overlap live state, including symlink aliases',t=>{
  const h=fixture(t);h.create();const before=bytes(h.root);
  for(const scratch of [h.root,join(h.root,'app')]){
    const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:scratch},encoding:'utf8'});
    assert.equal(cli.status,2,'live state cannot host scratch');
    assert.deepEqual(bytes(h.root),before);
  }
  const alias=join(tmpdir(),`scratch-alias-${process.pid}`);fs.symlinkSync(h.root,alias);t.after(()=>rmSync(alias));
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:alias},encoding:'utf8'});
  assert.equal(cli.status,2);
});

async function interruptedSnapshot(t,h,signal){
  const root=mkdtempSync(join(tmpdir(),'interrupt-health-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=`import {readOnlySnapshot} from ${JSON.stringify(new URL('../src/ops/health.mjs',import.meta.url).href)};readOnlySnapshot(process.argv[1],()=>{process.stdout.write('copied\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,h.path],{env:{...process.env,TMPDIR:root},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const closed=new Promise(resolve=>child.once('close',(code,sig)=>resolve({code,sig})));
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(new Error('snapshot child exited before copy')));});
  const dirs=readdirSync(root);assert.equal(dirs.length,1);assert.equal(fs.statSync(join(root,dirs[0])).mode&0o777,0o700);
  assert.equal(fs.statSync(join(root,dirs[0],'state.sqlite')).mode&0o777,0o600);
  child.kill(signal);await closed;
  return root;
}
for(const signal of ['SIGINT','SIGTERM'])test(`${signal} removes private database scratch`,async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,signal);assert.deepEqual(readdirSync(root),[]);
});

test('next run sweeps only owned stale scratch after SIGKILL',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL');
  assert.equal(readdirSync(root).length,1);
  const decoy=join(root,'dacs-ops-health-unrelated');mkdirSync(decoy,{mode:0o700});writeFileSync(join(decoy,'keep'),'unrelated');
  const link=join(root,'dacs-ops-health-symlink');fs.symlinkSync(decoy,link);
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:root},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(readdirSync(root).sort(),['dacs-ops-health-symlink','dacs-ops-health-unrelated']);
});

test('explicit process exit also removes active scratch',async t=>{
  const h=fixture(t);h.create();const root=mkdtempSync(join(tmpdir(),'exit-health-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=`import {readOnlySnapshot} from ${JSON.stringify(new URL('../src/ops/health.mjs',import.meta.url).href)};readOnlySnapshot(process.argv[1],()=>process.exit(7));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source,h.path],{env:{...process.env,TMPDIR:root},encoding:'utf8'});
  assert.equal(child.status,7);assert.deepEqual(readdirSync(root),[]);assert.doesNotMatch(child.stderr,/Error/,'the exit handler removes it cleanly');
});

test('stale sweep preserves live processes, invalid markers, links and unexpected contents',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL');
  const stale=join(root,readdirSync(root)[0]),owner=JSON.parse(readFileSync(join(stale,'owner.json'),'utf8'));
  const keep=[];
  function decoy(pid=owner.pid){
    const directory=mkdtempSync(join(root,`dacs-ops-health-${pid}-`)),name=directory.slice(root.length+1);keep.push(name);
    writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,pid,directory:name}),{mode:0o600});return directory;
  }
  decoy(process.pid);
  let directory=decoy();fs.chmodSync(directory,0o755);
  directory=decoy();writeFileSync(join(directory,'unexpected'),'unrelated',{mode:0o600});
  directory=decoy();fs.symlinkSync(h.path,join(directory,'state.sqlite'));
  directory=decoy();writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,directory:directory.slice(root.length+1),format:'unrelated'}));
  directory=decoy();writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,directory:directory.slice(root.length+1),pid:owner.pid+1}));
  directory=decoy();fs.chmodSync(join(directory,'owner.json'),0o644);
  const before=bytes(h.root),cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{env:{...process.env,TMPDIR:root},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(readdirSync(root).sort(),keep.sort());assert.deepEqual(bytes(h.root),before);
});

test('scratch excludes every journal target before copying any database',async t=>{
  const h=fixture(t);h.create();const external=mkdtempSync(join(tmpdir(),'external-journal-'));t.after(()=>rmSync(external,{recursive:true,force:true}));
  const journalPath=join(external,'journal.sqlite'),j=openDurableWalletJournal({path:journalPath,mode:'create'});t.after(()=>j.close());
  await j.put('TEST',{stage:'verified'});fs.symlinkSync(journalPath,join(h.root,'seller-artifacts.sqlite'));
  const original=fs.writeFileSync;let writes=0;
  fs.writeFileSync=(...args)=>{writes++;return original(...args);};syncBuiltinESMExports();
  const previous=process.env.TMPDIR;process.env.TMPDIR=external;
  try{assert.throws(()=>h.report());assert.equal(writes,0,'reject overlap before creating a scratch marker or copy');}
  finally{process.env.TMPDIR=previous;fs.writeFileSync=original;syncBuiltinESMExports();}
});


test('stale sweep never removes selected state or foreign-owned entries',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL'),stale=join(root,readdirSync(root)[0]);
  const previous=process.env.TMPDIR;process.env.TMPDIR=root;
  try{
    const original=fs.lstatSync;
    fs.lstatSync=(path,...args)=>{const st=original(path,...args);if(path===stale)Object.defineProperty(st,'uid',{value:process.getuid()+1});return st;};syncBuiltinESMExports();
    try{h.report();assert.ok(fs.existsSync(stale),'foreign entry preserved');}
    finally{fs.lstatSync=original;syncBuiltinESMExports();}
    const before=bytes(stale);
    opsHealth({databasePath:join(stale,'state.sqlite'),now:NOW});
    assert.deepEqual(bytes(stale),before,'selected state never swept even with a stale CLI marker');
  }finally{process.env.TMPDIR=previous;}
});

// Live-file reproductions. Each builds its live state, then checks the report
// fails closed (exit 2) or stays unhealthy, and that live files survive.
const cliWith=(args,env={})=>spawnSync(process.execPath,['scripts/ops-health.mjs',...args],{cwd:resolve('.'),env:{...process.env,...env},encoding:'utf8',timeout:10000});
// The schema is checkpointed into the main file; the unresolved purchase is
// committed only to the WAL, so losing the WAL would look like a healthy database.
const unresolvedPurchase=(h)=>{h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return h.create({stage:'payment_uncertain',at:NOW-600000});};

test('stale sweep never deletes a selected WAL reached through a sidecar symlink',async t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const root=await interruptedSnapshot(t,h,'SIGKILL'),stale=join(root,readdirSync(root)[0]),target=join(stale,'state.sqlite-wal');
  rmSync(target,{force:true});fs.renameSync(`${h.path}-wal`,target);fs.chmodSync(target,0o600);fs.symlinkSync(target,`${h.path}-wal`);
  const before=sha(readFileSync(target)),cli=cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:root});
  assert.ok(fs.existsSync(target),'live WAL target retained');assert.equal(sha(readFileSync(target)),before);assert.equal(cli.status,2,cli.stdout);
});

test('symlinked live WAL and SHM are refused before any scratch is created beside them',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const external=mkdtempSync(join(tmpdir(),'external-sidecars-'));t.after(()=>rmSync(external,{recursive:true,force:true}));
  for(const suffix of ['-wal','-shm']){fs.renameSync(`${h.path}${suffix}`,join(external,`live${suffix}`));fs.symlinkSync(join(external,`live${suffix}`),`${h.path}${suffix}`);}
  const original=fs.mkdtempSync;let scratch=0;
  fs.mkdtempSync=(...args)=>{scratch++;return original(...args);};syncBuiltinESMExports();
  const previous=process.env.TMPDIR;process.env.TMPDIR=external;
  try{assert.throws(()=>h.report(),/could not read valid state/);assert.equal(scratch,0,'no scratch directory created');}
  finally{process.env.TMPDIR=previous;fs.mkdtempSync=original;syncBuiltinESMExports();}
  assert.equal(cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:external}).status,2);
  assert.deepEqual(readdirSync(external).sort(),['live-shm','live-wal']);
});

test('a renamed main database whose WAL stays under the old (now alias) name fails closed',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const renamed=join(h.root,'app','renamed.sqlite');fs.renameSync(h.path,renamed);fs.symlinkSync(renamed,h.path);
  assert.throws(()=>h.report({operatorState:null}),/could not read valid state/,'alias WAL is not silently dropped');
  assert.equal(cliWith(['--database',h.path,'--json']).status,2);
});

test('operator mode binds the canonical database name, so a renamed database cannot drop its WAL',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const renamed=join(h.root,'app','renamed.sqlite');fs.renameSync(h.path,renamed);
  assert.throws(()=>h.report({databasePath:renamed}),/could not read valid state/);
  assert.equal(cliWith(['--database',renamed,'--operator-state',h.root,'--json']).status,2);
});

test('a WAL renamed away while SHM remains fails closed instead of reading checkpointed state',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  assert.equal(h.report().healthy,false);
  fs.renameSync(`${h.path}-wal`,`${h.path}-wal.moved`);
  assert.throws(()=>h.report({operatorState:null}),/could not read valid state/);
  assert.equal(cliWith(['--database',h.path,'--json']).status,2);
});

test('a database renamed behind an alias during the copy fails the after-copy file-set check',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const renamed=join(h.root,'app','renamed.sqlite'),original=fs.readFileSync;let reads=0,opened=false;
  fs.readFileSync=(path,...args)=>{
    if(path===h.path&&++reads===2){fs.renameSync(h.path,renamed);fs.symlinkSync(renamed,h.path);}
    return original(path,...args);
  };
  syncBuiltinESMExports();
  try{assert.throws(()=>readOnlySnapshot(h.path,()=>{opened=true;}),/could not read valid state/);assert.equal(opened,false);}
  finally{fs.readFileSync=original;syncBuiltinESMExports();}
});

test('a rollback journal, or WAL state beside a database not in WAL mode, fails closed',t=>{
  const h=fixture(t);h.create();
  writeFileSync(`${h.path}-journal`,'');
  assert.throws(()=>readOnlySnapshot(h.path,()=>{}),/could not read valid state/);rmSync(`${h.path}-journal`);
  const legacy=join(h.root,'legacy.sqlite'),db=new DatabaseSync(legacy);db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t(x)');db.close();
  assert.equal(readOnlySnapshot(legacy,db=>db.prepare('SELECT count(*) AS n FROM t').get().n),0);
  writeFileSync(`${legacy}-wal`,'');
  assert.throws(()=>readOnlySnapshot(legacy,()=>{}),/could not read valid state/);
});

test('scratch is never created in a directory holding a selected database alias',t=>{
  const h=fixture(t);h.create();
  const aliases=mkdtempSync(join(tmpdir(),'alias-dir-'));t.after(()=>rmSync(aliases,{recursive:true,force:true}));
  fs.symlinkSync(h.path,join(aliases,'dacs-chatgpt.sqlite'));
  assert.equal(cliWith(['--database',join(aliases,'dacs-chatgpt.sqlite'),'--json'],{TMPDIR:aliases}).status,2);
  assert.deepEqual(readdirSync(aliases),['dacs-chatgpt.sqlite']);
});

test('journal SHM without WAL, and retained sidecars of an absent journal, fail closed',async t=>{
  const h=fixture(t);h.create();const j=h.durable('seller-wallet.sqlite'),path=join(h.root,'seller-wallet.sqlite');
  const checkpoint=new DatabaseSync(path);checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');checkpoint.close();
  await j.put('sr2/wallet/TEST',{stage:'issued',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  assert.equal(h.report().seller.unconfirmed.length,1);
  fs.renameSync(`${path}-wal`,`${path}-wal.moved`);
  assert.throws(()=>h.report(),/could not read valid state/,'SHM without WAL');
  fs.renameSync(`${path}-wal.moved`,`${path}-wal`);fs.renameSync(path,`${path}.moved`);
  assert.throws(()=>h.report(),/could not read valid state/,'absent journal with retained sidecars');
  assert.equal(h.cli(['--json']).status,2);
});

test('an app/ symlink to another service cannot bind its database to this operator state',async t=>{
  const a=fixture(t),b=fixture(t),sellerB=`0x${'b'.repeat(64)}`;
  a.create();// A's buyer wallet is B's seller address
  await b.durable('node2-transport.sqlite').put('seller-b',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:sellerB}}});
  fs.renameSync(join(b.root,'app'),join(b.root,'app-old'));fs.symlinkSync(join(a.root,'app'),join(b.root,'app'));
  assert.throws(()=>opsHealth({databasePath:join(b.root,'app','dacs-chatgpt.sqlite'),operatorState:b.root,now:NOW}),/could not read valid state/);
  assert.equal(cliWith(['--operator-state',b.root,'--json']).status,2);
});

test('dangling selected journals fail closed and retired ledger links are ignored',t=>{
  const h=fixture(t);h.create();
  fs.symlinkSync(join(h.root,'missing.sqlite'),join(h.root,'seller-wallet.sqlite'));
  assert.throws(()=>h.report(),/could not read valid state/);assert.equal(h.cli(['--json']).status,2);
  rmSync(join(h.root,'seller-wallet.sqlite'));assert.equal(h.report().healthy,true,'real absence stays optional');
  fs.symlinkSync(join(h.root,'missing-evidence'),join(h.root,'evidence'));
  assert.equal(h.report().healthy,true,'retired ledger is not selected');rmSync(join(h.root,'evidence'));
  mkdirSync(join(h.root,'evidence'));fs.symlinkSync(join(h.root,'missing.jsonl'),join(h.root,'evidence','seller-approvals.jsonl'));
  assert.equal(h.report().healthy,true,'retired ledger is not selected');
});

test('logical or persisted expiry never hides an indeterminate write',t=>{
  const h=fixture(t),start=NOW-3600000-400000;
  const p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:start});
  h.clock.now=start+60000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-anchored',attempts:[{step:'agreement',outcome:'indeterminate',reason:'TEST'}]}},event:'protocol_commit-request',data:{stage:'agreement-anchored'}});
  let r=h.report();
  assert.equal(r.purchases[0].stage,'expired','display stage may change');assert.equal(r.healthy,false);
  assert.equal(r.stuck[0].purchaseId,p.id);assert.equal(r.stuck[0].outcome,'unknown-readback-required');assert.match(r.stuck[0].nextExpected,/readback; never resend/);
  assert.equal(h.cli(['--json']).status,1);
  h.clock.now=NOW;h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  r=h.report();assert.equal(r.healthy,false,'persisted expiry keeps the readback alert');assert.equal(r.stuck[0].outcome,'unknown-readback-required');
});

// Attempts recorded the way protocol-purchases.mjs note() records them.
const NO_PROVIDER='CONTEXT_PROVIDER_UNAVAILABLE: no operator Agreement context provider is configured';
// The structured mark note() records where, and only where, no Agreement-context provider was invoked.
const NOT_WRITTEN={written:false};

for(const lane of ['stored','event','both'])test(`undispatched claim and readback preserve earlier writes (${lane})`,t=>{
  const run=(entries)=>{
    const h=fixture(t),p=h.create({protocol:true,status:'settled_verified',stage:'completed'});
    const attempts=lane==='event'?[]:entries.map(e=>({at:new Date(NOW).toISOString(),...e}));
    h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'completed',attempts}},event:'protocol_step',data:{stage:'completed'}});
    if(lane!=='stored')for(const {step,...data} of entries)h.ops.record(p.id,`protocol_${step}`,{stage:'completed',...data});
    return h.report();
  };
  const unsent=run([{step:'claim',outcome:'accepted',dispatched:false}]);
  assert.equal(unsent.healthy,true);assert.deepEqual(unsent.stuck,[]);assert.equal(unsent.purchases[0].outcome,'not-sent');
  const retained=run([{step:'claim',outcome:'accepted',dispatched:true},{step:'payment-evidence',outcome:'verified',dispatched:false}]);
  assert.equal(retained.healthy,false);assert.deepEqual(retained.stuck[0].unresolvedWrites,['claim']);
  const resolved=run([{step:'claim',outcome:'accepted',dispatched:true},{step:'payment-evidence',outcome:'verified',dispatched:true}]);
  assert.equal(resolved.healthy,true);assert.deepEqual(resolved.stuck,[]);
});
const attempt=(step,outcome,reason,extra={})=>({at:new Date(NOW-1000).toISOString(),step,outcome,...(reason?{reason}:{}),...extra});
const expiredWith=(h,step,outcome,stage,reason='TEST',extra={})=>{
  const start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:start});
  h.clock.now=start+60000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage,attempts:[attempt(step,outcome,reason,extra)]}},event:`protocol_${step}`,data:{outcome,reason,...extra}});
  h.clock.now=NOW;return p;
};
const dbOnly=(h,args=['--json'])=>spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,...args],{cwd:resolve('.'),encoding:'utf8',timeout:10000});
// Every pair protocol-purchases.mjs can record, read from that file and its callees.
// A write pair may have issued a write (or asked the seller for one) whose outcome is unknown.
// 'pending' stands for any status of the seller's own choosing (claim: protocol-purchases.mjs:823).
// The buyer copy is written once, then only read back, so its
// absent and rejected readbacks leave that write unresolved.
const WRITE_PAIRS=[['agreement','indeterminate'],['commit-request','unavailable'],['claim','unavailable'],['claim','accepted'],['claim','indeterminate'],['claim','pending'],
  ['buyer-copy','unavailable'],['buyer-copy','absent'],['buyer-copy','rejected'],['seller-copy','unavailable'],['native-evidence','held']];
const OTHER_PAIRS=[['agreement','waiting'],['agreement','rejected'],['agreement','anchored'],['commit-request','refused'],
  ...['verified','rejected','absent','unavailable'].flatMap(outcome=>[['commitment',outcome],['payment-evidence',outcome],['delivery',outcome]]),
  ['commitment','indeterminate'],
  ['claim','rejected'],...['ready','rejected','refused','unavailable'].map(outcome=>['bundle-request',outcome]),['countersign','rejected'],['buyer-copy','anchored'],
  ['seller-copy','verified'],['seller-copy','rejected'],['seller-copy','absent'],['seller-copy','refused'],
  ['seller-confirmation','verified'],['seller-confirmation','unknown'],['seller-confirmation','unavailable'],['seller-confirmation','rejected'],
  ['native-evidence','verified-fixture-native-read'],['agreement-context','indeterminate',NO_PROVIDER,NOT_WRITTEN],
  // DACS_BUYER_CHAIN_READBACK=on: a fresh read that kept an already verified delivery.
  ['chain-readback','indeterminate'],
  ['agreement-context','indeterminate','CONTEXT_PROVIDER_UNAVAILABLE: DEM delivery context capability is absent',NOT_WRITTEN]];
// Recorded after the Agreement-context provider ran: it may have published seller Vet records.
const VET_PAIRS=[['agreement-context','absent'],['agreement-context','rejected'],['agreement-context','indeterminate']];
// Records one attempt exactly as note() does: the stored ten-attempt tail and a protocol_<step> event.
const noted=(h,p,step,outcome,{reason,stage,toStatus,extra={},patch={}}={})=>{
  const current=h.ops.get(p.accountId,p.id),protocol=current.state.protocol;
  const attempts=[...(protocol.attempts??[]).slice(-9),{at:new Date(h.clock.now).toISOString(),step,outcome,...(reason?{reason}:{}),...extra}];
  return h.ops.transition(p.id,current.status,toStatus??current.status,{state:{protocol:{...protocol,...patch,...(stage?{stage}:{}),attempts}},event:`protocol_${step}`,data:{stage:stage??protocol.stage,outcome,...(reason?{reason}:{}),...extra}});
};

test('a missing Agreement-context provider is not a write: its expired purchase raises no readback alert',t=>{
  const h=fixture(t);
  // The exact reason agreement-context-consumer.mjs records when no provider is configured,
  // plus the not-written mark note() records with it.
  const p=expiredWith(h,'agreement-context','indeterminate','identity',NO_PROVIDER,NOT_WRITTEN);
  let r=h.report();
  assert.equal(r.purchases[0].stage,'expired');assert.equal(r.healthy,true,'no write was issued');assert.deepEqual(r.stuck,[]);
  assert.equal(r.purchases[0].outcome,'unresolved-read');assert.doesNotMatch(formatOpsHealth(r),/never resend/);
  assert.equal(h.cli(['--json']).status,0);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  r=h.report();assert.equal(r.healthy,true,'persisted expiry stays healthy');assert.deepEqual(r.stuck,[]);
  r=h.report({operatorState:null});assert.equal(r.healthy,true,'database only: nothing to read back');assert.equal(dbOnly(h).status,0);
});

test('a seller confirmation without a status on a completed purchase raises no alert',t=>{
  const h=fixture(t),p=h.create({status:'settled_verified',stage:'awaiting-countersignature',protocol:true,at:NOW-600000});
  // The buyer's own readback verified the seller copy; the seller's answer to confirmBuyerCopy had no status.
  h.clock.now=NOW-60000;
  h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'completed',attempts:[attempt('buyer-copy','anchored'),attempt('seller-copy','verified'),attempt('seller-confirmation','unknown')]}},event:'protocol_seller-confirmation',data:{outcome:'unknown'}});
  const r=h.report();
  assert.equal(r.purchases[0].stage,'completed');assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);
  assert.equal(r.purchases[0].outcome,'unresolved-read');assert.doesNotMatch(formatOpsHealth(r),/never resend/);
  assert.equal(h.cli(['--json']).status,0);
});

test('an unknown Agreement write on an expired or completed purchase still alerts, readback only',t=>{
  const h=fixture(t),p=expiredWith(h,'agreement','indeterminate','agreement-signing');
  const alert=[[p.id,'expired',0,'unknown-readback-required','original write readback; never resend']];
  const rows=(r)=>r.stuck.map(s=>[s.purchaseId,s.stage,s.thresholdMs,s.outcome,s.nextExpected]);
  let r=h.report();
  assert.equal(r.healthy,false);assert.deepEqual(rows(r),alert);assert.equal(r.purchases[0].outcome,'unknown-readback-required');
  assert.equal(h.cli(['--json']).status,1);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  r=h.report();assert.equal(r.healthy,false,'persisted expiry keeps the alert');assert.deepEqual(rows(r),alert);
  // A completed purchase whose last recorded step is a seller write request with an unknown answer
  // (the real 'unavailable' outcome; protocol-purchases.mjs never records seller-copy/unknown).
  const c=h.create({status:'settled_verified',stage:'awaiting-countersignature',protocol:true,at:NOW-600000});
  h.ops.transition(c.id,c.status,c.status,{state:{protocol:{stage:'completed',attempts:[attempt('seller-copy','unavailable')]}},event:'protocol_seller-copy',data:{outcome:'unavailable'}});
  r=h.report();assert.deepEqual(rows({stuck:r.stuck.filter(s=>s.purchaseId===c.id)}),[[c.id,'completed',0,'unknown-readback-required','original write readback; never resend']]);
});

test('every write pair keeps the terminal readback alert; every other pair does not',t=>{
  // Real (step, outcome) pairs from protocol-purchases.mjs, read from the code independently
  // of the table in health.mjs.
  for(const [step,outcome] of WRITE_PAIRS){
    const h=fixture(t),p=expiredWith(h,step,outcome,'agreement-anchored'),r=h.report();
    assert.equal(r.healthy,false,`${step} ${outcome}`);assert.equal(r.stuck[0]?.purchaseId,p.id,step);assert.equal(r.stuck[0].outcome,'unknown-readback-required',step);
  }
  for(const [step,outcome,reason,extra] of OTHER_PAIRS){
    const h=fixture(t);expiredWith(h,step,outcome,'agreement-anchored',reason,extra);const r=h.report();
    assert.equal(r.healthy,true,`${step} ${outcome}`);assert.deepEqual(r.stuck,[],`${step} ${outcome}`);
    assert.equal(r.purchases[0].outcome,['indeterminate','unknown'].includes(outcome)?'unresolved-read':'recorded',`${step} ${outcome}`);
  }
});

test('an unresolved read before expiry waits on its stage threshold without write-readback advice',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-40*60000});
  h.clock.now=NOW-35*60000;h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'identity',attempts:[attempt('agreement-context','indeterminate',NO_PROVIDER,NOT_WRITTEN)]}},event:'protocol_agreement-context',data:{outcome:'indeterminate',reason:NO_PROVIDER,...NOT_WRITTEN}});
  const stuck=h.report().stuck;
  assert.deepEqual(stuck.map(s=>[s.purchaseId,s.stage,s.outcome,s.nextExpected]),[[p.id,'identity','waiting','buyer identity presentation']]);
  assert.equal(h.report({thresholds:{identity:41*60000}}).healthy,true);
});

test('an unresolved attempt with an unrecognized or missing step fails closed',t=>{
  for(const extra of [{step:'future-step'},{}]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing',attempts:[{at:new Date(NOW).toISOString(),...extra,outcome:'indeterminate'}]}},event:'protocol_step',data:{}});
    assert.throws(()=>h.report(),/could not read valid state/);assert.equal(h.cli(['--json']).status,2);
  }
});

// Classify the whole attempt history against an explicit table.
const UNAVAILABLE='seller agent response is unavailable or unauthenticated; the operation outcome may be unknown';
const READBACK='original write readback; never resend';
const stuckOf=(r,p)=>r.stuck.filter(s=>s.purchaseId===p.id).map(s=>[s.stage,s.thresholdMs,s.outcome,s.nextExpected,s.unresolvedWrites]);
const expiredSeq=(h,pairs,stage='agreement-anchored')=>{
  const start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:start});
  h.clock.now=start+60000;for(const [step,outcome,reason] of pairs)noted(h,p,step,outcome,{reason,stage});
  h.clock.now=NOW;return p;
};

test('a commit request that lost its answer, then an unavailable commitment readback, is not healthy after expiry',t=>{
  const h=fixture(t),start=NOW-3600000-400000,p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});
  h.clock.now=start+60000;
  noted(h,p,'agreement','anchored',{stage:'agreement-anchored'});
  noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});
  noted(h,p,'commitment','unavailable',{reason:'SR-2 read failed: TEST'});
  h.clock.now=NOW;
  for(const r of [h.report(),h.report({operatorState:null})]){
    assert.equal(r.healthy,false);assert.equal(r.purchases[0].outcome,'unknown-readback-required');
    assert.deepEqual(stuckOf(r,p),[['expired',0,'unknown-readback-required',READBACK,['commit-request']]]);
  }
  assert.match(formatOpsHealth(h.report()),/^stuck \S+ stage=expired ageMs=\d+ thresholdMs=0 outcome=unknown-readback-required writes=commit-request next=original write readback; never resend$/m);
  assert.equal(h.cli(['--json']).status,1);assert.equal(dbOnly(h).status,1);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  assert.deepEqual(stuckOf(h.report(),p),[['expired',0,'unknown-readback-required',READBACK,['commit-request']]],'persisted expiry keeps it');
});

test('a later verified commitment readback clears the lost commit answer, even past the stored ten attempts',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-anchored',at:NOW-120000});
  h.clock.now=NOW-100000;
  noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});
  for(let i=0;i<10;i++)noted(h,p,'commitment','absent',{reason:'no finalized commitment at the canonical address yet'});
  h.clock.now=NOW;
  assert.equal(h.ops.get(p.accountId,p.id).state.protocol.attempts.some(a=>a.step==='commit-request'),false,'the stored tail no longer holds it');
  let r=h.report();
  assert.equal(r.healthy,false,'a fresh purchase with an unresolved write is not healthy');
  assert.deepEqual(stuckOf(r,p),[['agreement-anchored',0,'unknown-readback-required',READBACK,['commit-request']]]);
  h.clock.now=NOW-1000;noted(h,p,'commitment','verified',{stage:'committed',toStatus:'awaiting_approval'});h.clock.now=NOW;
  r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);assert.equal(r.purchases[0].outcome,'recorded');
  assert.equal(h.cli(['--json']).status,0);assert.equal(dbOnly(h).status,0);
});

test('a fresh held native-evidence purchase is not healthy until a verified evidence or delivery readback',t=>{
  const h=fixture(t);
  const held=(reason)=>{const p=h.create({status:'settled_verified',stage:'payment-observed',protocol:true,at:NOW-120000});h.clock.now=NOW-60000;noted(h,p,'native-evidence','held',{reason,stage:'native-payment-evidence-held'});h.clock.now=NOW;return p;};
  const evidence=held(UNAVAILABLE),delivery=held('delivery-held');
  let r=h.report();
  assert.equal(r.healthy,false);
  for(const p of [evidence,delivery])assert.deepEqual(stuckOf(r,p),[['native-payment-evidence-held',0,'unknown-readback-required',READBACK,['native-evidence']]]);
  assert.equal(dbOnly(h).status,1);
  h.clock.now=NOW-30000;
  noted(h,evidence,'native-evidence','verified-fixture-native-read',{stage:'payment-evidenced'});
  assert.equal(h.report().healthy,false,'one is still held');
  noted(h,delivery,'delivery','verified',{stage:'delivery-ready'});
  h.clock.now=NOW;
  r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);
  // The CLI reads the wall clock, which can be minutes past NOW by this test on a loaded host;
  // longer thresholds keep its exit code about the readbacks, not the 5-minute stage age.
  const relaxed=['--threshold','payment-evidenced=86400','--threshold','delivery-ready=86400'];
  assert.equal(h.cli(['--json',...relaxed]).status,0);assert.equal(dbOnly(h,['--json',...relaxed]).status,0);
});

test('a readback clears only the write it reads back; a write stays unresolved across later attempts',t=>{
  const stays=[
    [['commit-request','unavailable'],['payment-evidence','verified']],[['claim','unavailable'],['commitment','verified']],
    [['claim','unavailable'],['delivery','verified']],[['buyer-copy','unavailable'],['seller-copy','verified']],
    [['seller-copy','unavailable'],['seller-confirmation','verified']],[['native-evidence','held'],['payment-evidence','verified']],
    [['agreement','indeterminate'],['commitment','verified']],[['agreement','indeterminate'],['agreement','waiting']],
    [['claim','unavailable'],['claim','accepted']],[['claim','accepted'],['payment-evidence','absent']],
    [['commit-request','unavailable'],['commitment','verified'],['commit-request','unavailable'],['commitment','absent']],
  ];
  const clears=[
    [['agreement','indeterminate'],['agreement','anchored']],[['commit-request','unavailable'],['commitment','verified']],
    [['claim','unavailable'],['claim','accepted'],['payment-evidence','verified']],[['buyer-copy','unavailable'],['buyer-copy','anchored']],
    [['seller-copy','unavailable'],['seller-copy','verified']],[['native-evidence','held'],['delivery','rejected']],
  ];
  for(const pairs of stays){
    const h=fixture(t),p=expiredSeq(h,pairs),r=h.report(),label=JSON.stringify(pairs);
    assert.equal(r.healthy,false,label);assert.equal(stuckOf(r,p)[0]?.[2],'unknown-readback-required',label);
  }
  for(const pairs of clears){
    const h=fixture(t);expiredSeq(h,pairs);const r=h.report();
    assert.equal(r.healthy,true,JSON.stringify(pairs));assert.deepEqual(r.stuck,[],JSON.stringify(pairs));
  }
});

test('an Agreement context that may have published seller Vet records is not healthy with --database only',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
  h.clock.now=NOW-30000;noted(h,p,'agreement-context','indeterminate',{reason:'DEM delivery context failed: TEST Vet publish answer lost'});h.clock.now=NOW;
  const r=h.report({operatorState:null});
  assert.equal(r.healthy,false);assert.equal(r.seller.journals,null);
  assert.deepEqual(r.stuck.map(s=>[s.purchaseId,s.stage,s.thresholdMs,s.outcome]),[[p.id,'identity',0,'seller-journal-not-read']]);
  assert.match(r.stuck[0].nextExpected,/seller Vet write readback.*--operator-state.*never resend/);
  assert.equal(r.purchases[0].outcome,'seller-journal-not-read');
  const text=formatOpsHealth(r);
  assert.match(text,/^STUCK /);assert.match(text,/^seller journals: not selected$/m);assert.match(text,new RegExp(`^stuck ${p.id} stage=identity .*outcome=seller-journal-not-read next=`,'m'));
  for(const args of [['--json'],[]]){const cli=dbOnly(h,args);assert.equal(cli.status,1,cli.stderr);}
  // Every disposition recorded after the provider ran, on an expired purchase too.
  for(const outcome of ['absent','rejected','indeterminate']){
    const e=fixture(t);expiredWith(e,'agreement-context',outcome,'identity',`CONTEXT_${outcome.toUpperCase()}: TEST`);
    const x=e.report({operatorState:null});assert.equal(x.healthy,false,outcome);assert.deepEqual(x.stuck.map(s=>[s.stage,s.outcome]),[['expired','seller-journal-not-read']],outcome);
  }
  // Recorded with the not-written mark where no provider was invoked: no alert.
  for(const reason of [NO_PROVIDER,'CONTEXT_PROVIDER_UNAVAILABLE: DEM delivery context capability is absent']){
    const e=fixture(t),q=e.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
    e.clock.now=NOW-30000;noted(e,q,'agreement-context','indeterminate',{reason,extra:NOT_WRITTEN});e.clock.now=NOW;
    const x=e.report({operatorState:null});assert.equal(x.healthy,true,reason);assert.equal(x.purchases[0].outcome,'unresolved-read',reason);assert.equal(dbOnly(e).status,0,reason);
  }
});

test('with --operator-state, the seller journal decides a possibly-written Agreement context',async t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
  h.clock.now=NOW-30000;noted(h,p,'agreement-context','indeterminate',{reason:'DEM delivery context failed: TEST Vet publish answer lost'});h.clock.now=NOW;
  // Operator state without the seller artifact journal cannot decide.
  let r=h.report();
  assert.equal(r.healthy,false);assert.deepEqual(r.seller.journals,[]);assert.deepEqual(r.stuck.map(s=>[s.purchaseId,s.outcome]),[[p.id,'seller-journal-not-read']]);
  assert.equal(h.cli(['--json']).status,1);
  const artifacts=h.durable('seller-artifacts.sqlite'),key='demo/artifact/vet-TEST',content={from:address};
  await artifacts.put(key,{stage:'intent',transaction:{content}});
  r=h.report();
  assert.equal(r.healthy,false,'the retained Vet intent needs readback');assert.deepEqual(r.stuck,[]);
  assert.deepEqual(r.seller.unconfirmed.map(u=>[u.source,u.stage,u.nextExpected]),[['seller-artifacts.sqlite','intent',READBACK]]);
  assert.equal(r.purchases[0].outcome,'seller-journal-checked');
  assert.equal(h.cli(['--json']).status,1);
  await artifacts.put(key,{stage:'verified',hash:'f'.repeat(64),transaction:{content}});
  r=h.report();assert.equal(r.healthy,true,'the seller journal shows the Vet write verified');assert.deepEqual(r.stuck,[]);
  assert.equal(h.cli(['--json']).status,0);
  assert.equal(h.report({operatorState:null}).healthy,false,'the database alone still cannot see the seller journal');
});

test('a (step, outcome) pair missing from the table fails closed, resolved or not',t=>{
  for(const [step,outcome] of [['commit-request','indeterminate'],['commitment','pending'],['native-evidence','unknown'],['agreement','unknown'],['future-step','verified'],['agreement-context','present'],['claim',null]]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    noted(h,p,step,outcome);
    assert.throws(()=>h.report(),/could not read valid state/,`${step} ${outcome}`);
    assert.equal(h.cli(['--json']).status,2,`${step} ${outcome}`);assert.equal(dbOnly(h).status,2,`${step} ${outcome}`);
  }
  // A stored attempt the event log lacks is still checked against the table.
  for(const attempts of ['xx',[null],[{}],[{step:'claim'}],[attempt('delivery','pending')]]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'identity',attempts}},event:'protocol_step',data:{stage:'identity'}});
    assert.throws(()=>h.report(),/could not read valid state/,JSON.stringify(attempts));
  }
});

test('the attempt table covers every note() call site in protocol-purchases.mjs',()=>{
  const source=readFileSync(resolve('src/dacs/protocol-purchases.mjs'),'utf8'),table=health.ATTEMPT_EFFECTS,seller=health.SELLER_STATUS;
  assert.ok(Array.isArray(table)&&typeof seller==='string','health.mjs exports its attempt table');
  // And every noteLost( call (an attempt only the event log can hold), apart from note() forwarding its own.
  // And every settle( call (note() for native evidence and delivery), apart from settle() forwarding its own.
  const calls=[...source.matchAll(/\bnote(?:Lost)?\(\s*\w+\s*,\s*'([a-z-]+)'\s*,\s*([^,]+?)\s*,/g),...source.matchAll(/\bsettle\(\s*'([a-z-]+)'\s*,\s*([^,]+?)\s*,/g)];
  assert.equal(source.match(/\bnoteLost\(operation, step, /g)?.length,1,'note() forwards to noteLost() once');
  assert.equal(source.match(/\bnote\(operation, step, /g)?.length,1,'settle() forwards to note() once');
  assert.equal(calls.length,source.match(/\bnote(?:Lost)?\(|\bsettle\(/g).length-2,'every other note(, noteLost( and settle( call names a literal step');
  // Outcome expressions that are not literals, and what their callee can return there.
  const DOMAINS={
    'resolved.disposition':['absent','rejected','indeterminate'],  // both Agreement-context consumers; present is planned
    'progress.disposition':['indeterminate','waiting'],             // SDK progress after anchored/rejected
    'readback.status':['absent','unavailable','indeterminate'],     // readCommitment/readDevnetNativeCommitment after verified/rejected; indeterminate: requireCommitmentFinality holds a native commitment
    "answer.status ?? 'indeterminate'":[seller],                    // the seller's own claim status
    'verified.status':['absent'],                                   // verifyPaymentEvidence after rejected/verified
    'delivery.status':['absent','unavailable'],                     // readDelivery after verified/rejected
    'check.status':['absent'],                                      // verifyAnchoredCopy after rejected/verified
    "confirmation.status ?? 'unknown'":[seller],                    // the seller's own confirmation status
  };
  const recorded=new Set();
  for(const [,step,expression] of calls){
    const literals=[...expression.matchAll(/'([^']*)'/g)].map(m=>m[1]);
    const dynamic=expression.replace(/^error instanceof SellerRefusedError \? '[^']*' : '[^']*'$|^'[^']*'$/,'');
    if(dynamic)assert.ok(Object.hasOwn(DOMAINS,expression),`note(…, '${step}', ${expression}): unknown outcome expression; add its domain`);
    for(const outcome of [...literals,...(dynamic?DOMAINS[expression]:[])])recorded.add(`${step} ${outcome}`);
  }
  const rows=new Set(table.map(([step,outcome])=>`${step} ${outcome}`));
  assert.equal(rows.size,table.length,'one row per pair');
  assert.deepEqual([...recorded].filter(pair=>!rows.has(pair)).sort(),[],'recorded pairs missing from the table');
  assert.deepEqual([...rows].filter(pair=>!recorded.has(pair)).sort(),[],'table rows no call site records');
  assert.deepEqual([...new Set(calls.map(m=>m[1]))].sort(),[...new Set(table.map(([step])=>step))].sort());
  // The independent pair lists above agree with the table, pair for pair.
  const pair=(step,outcome)=>rows.has(`${step} ${outcome}`)?`${step} ${outcome}`:`${step} ${seller}`;
  assert.deepEqual(new Set([...WRITE_PAIRS,...OTHER_PAIRS,...VET_PAIRS].map(([step,outcome])=>pair(step,outcome))),rows);
});

// Durable write intents, and the structured not-written mark.
// Saved exactly as protocol-purchases.mjs continueWalletAgreement saves them: the
// retained CREATE in state and a protocol_wallet_anchor_intent event, before the
// one-shot wallet anchor; protocol_wallet_anchor_not_issued withdraws a fresh intent.
const walletIntent=(h,p,type='protocol_wallet_anchor_intent')=>{
  const current=h.ops.get(p.accountId,p.id),protocol=current.state.protocol,logicalAddress=`TEST-${'1'.repeat(64)}`,agreementHash='2'.repeat(64);
  return h.ops.transition(p.id,current.status,current.status,{state:{protocol:{...protocol,walletAnchor:type==='protocol_wallet_anchor_intent'?{logicalAddress,writer:buyer,artifactKind:'Agreement'}:null}},
    event:type,data:{stage:protocol.stage,logicalAddress,agreementHash,...(type==='protocol_wallet_anchor_intent'?{}:{reason:'wallet-fenced'})}});
};

test('a wallet Agreement CREATE intent with no recorded attempt is not healthy until withdrawn or read back',t=>{
  const start=NOW-3600000-400000;
  const intended=(h,after=[])=>{
    const p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});
    h.clock.now=start+60000;walletIntent(h,p);
    for(const [step,outcome,stage] of after)step.startsWith('protocol_')?walletIntent(h,p,step):noted(h,p,step,outcome,{stage});
    h.clock.now=NOW;return p;
  };
  // The process stopped after the intent, before any attempt was noted; the purchase then expired.
  let h=fixture(t),p=intended(h);
  assert.deepEqual(h.ops.get(p.accountId,p.id).state.protocol.attempts,undefined,'no attempt was recorded');
  for(const r of [h.report(),h.report({operatorState:null})]){
    assert.equal(r.healthy,false);assert.deepEqual(stuckOf(r,p),[['expired',0,'unknown-readback-required',READBACK,['wallet-anchor']]]);
  }
  assert.equal(h.cli(['--json']).status,1);assert.equal(dbOnly(h).status,1);
  h.ops.transition(p.id,'agreement_pending','expired',{data:{reason:'approval window elapsed'}});
  assert.deepEqual(stuckOf(h.report(),p),[['expired',0,'unknown-readback-required',READBACK,['wallet-anchor']]],'persisted expiry keeps it');
  // Later attempts that do not read the CREATE back leave it open.
  for(const after of [[['agreement','waiting']],[['agreement','rejected','agreement-rejected']],[['commitment','verified']]]){
    h=fixture(t);p=intended(h,after);
    assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['wallet-anchor']],JSON.stringify(after));
  }
  // Withdrawn before issue, or read back anchored: nothing to read back.
  for(const after of [[['protocol_wallet_anchor_not_issued']],[['agreement','indeterminate'],['agreement','anchored','agreement-anchored']]]){
    h=fixture(t);p=intended(h,after);
    const r=h.report();assert.equal(r.healthy,true,JSON.stringify(after));assert.deepEqual(r.stuck,[]);assert.equal(dbOnly(h).status,0);
  }
  // A withdrawal resolves only the intent, not an earlier unknown Agreement write, even once
  // that write has left the stored ten attempts and only the event log holds it.
  h=fixture(t);p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:start});h.clock.now=start+60000;
  noted(h,p,'agreement','indeterminate');for(let i=0;i<10;i++)noted(h,p,'agreement','waiting');
  walletIntent(h,p);walletIntent(h,p,'protocol_wallet_anchor_not_issued');h.clock.now=NOW;
  assert.equal(h.ops.get(p.accountId,p.id).state.protocol.attempts.some(a=>a.outcome==='indeterminate'),false);
  assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['agreement']]);
});

test('an Agreement context counts as not written only by its recorded mark, never by its reason text',t=>{
  // A provider can choose its reason text, so text that claims no write is a possible write.
  for(const [reason,extra] of [[NO_PROVIDER,{}],['CONTEXT_NOT_WRITTEN: provider-controlled after-write claim',{}],['CONTEXT_PROVIDER_UNAVAILABLE: TEST',{}],
    ['CONTEXT_NOT_WRITTEN: TEST',{written:'false'}],['CONTEXT_NOT_WRITTEN: TEST',{written:0}],['CONTEXT_NOT_WRITTEN: TEST',{written:null}]]){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
    h.clock.now=NOW-30000;noted(h,p,'agreement-context','indeterminate',{reason,extra});h.clock.now=NOW;
    const r=h.report({operatorState:null}),label=JSON.stringify([reason,extra]);
    assert.equal(r.healthy,false,label);assert.deepEqual(r.stuck.map(s=>[s.purchaseId,s.outcome]),[[p.id,'seller-journal-not-read']],label);
    assert.equal(dbOnly(h).status,1,label);
  }
  // The mark is honoured only on the event log and stored attempt that note() writes together.
  for(const outcome of ['absent','rejected','indeterminate']){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW-60000});
    h.clock.now=NOW-30000;noted(h,p,'agreement-context',outcome,{reason:'TEST any text',extra:NOT_WRITTEN});h.clock.now=NOW;
    const r=h.report({operatorState:null});assert.equal(r.healthy,true,outcome);assert.deepEqual(r.stuck,[],outcome);
  }
  // The mark never downgrades any other step's write.
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-anchored',at:NOW-60000});
  h.clock.now=NOW-30000;noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE,extra:NOT_WRITTEN});h.clock.now=NOW;
  assert.deepEqual(stuckOf(h.report({operatorState:null}),p).map(s=>s.at(-1)),[['commit-request']]);
});

test('every protocol event saved outside note() is a replayed write intent or listed here as no write',()=>{
  const source=readFileSync(resolve('src/dacs/protocol-purchases.mjs'),'utf8');
  const events=new Set([...source.matchAll(/event: '(protocol_[a-z_]+)'/g)].map(m=>m[1]));
  // Not writes of their own: local state, a planned or signed message the buyer has not sent,
  // or a payment the purchase status already holds readback-only (payment_handoff onward).
  const NOT_WRITES=['protocol_identity_requested','protocol_seller_session_requested','protocol_seller_session_delegated','protocol_agreement_planned',
    'protocol_agreement_signed','protocol_agreement_public_projection_retained','protocol_transfer_observed','protocol_native_transfer_observed','protocol_native_wallet_guard_issued','protocol_step',
    // Signed CREATE bytes kept after they authenticated on chain, and the operator-action hold (local state only).
    'protocol_chain_pointer_kept','protocol_chain_readback_held',
    // The finality hold of a legacy native row: local state only, back to agreement_pending.
    'protocol_native_commitment_held'];
  assert.deepEqual([...events].filter(e=>!NOT_WRITES.includes(e)).sort(),Object.keys(health.INTENT_EFFECTS).sort());
  // Health holds the same list, to replay a not-saved check of any of these events.
  assert.deepEqual([...health.NO_WRITE_EVENTS].sort(),[...NOT_WRITES].sort());
});

// Protocol state is saved with a revision CAS: a check
// that read an older revision saves nothing and save() logs it as protocol_check_not_saved,
// with the event it would have saved under data.event beside that event's own data.
// The buyer copy is written once, after saving the counter-signature
// (protocol_buyer_copy_intent), and saves the copy reference only from an authenticated readback.
const notSaved=(h,p,event,data={})=>{
  const protocol=h.ops.get(p.accountId,p.id).state.protocol;
  h.ops.record(p.id,'protocol_check_not_saved',{...data,event,stage:data.stage??protocol.stage,revision:0,savedRevision:1,savedStage:protocol.stage});
};
const buyerCopyIntent=(h,p)=>{
  const current=h.ops.get(p.accountId,p.id),protocol=current.state.protocol;
  return h.ops.transition(p.id,current.status,current.status,{state:{protocol:{...protocol,bundle:{...protocol.bundle,buyerSignature:'TEST-countersignature'}}},
    event:'protocol_buyer_copy_intent',data:{stage:protocol.stage,logicalAddress:'TEST-buyer-copy-address'}});
};
const countersigning=(h,at=NOW-120000)=>{const p=h.create({status:'settled_verified',stage:'awaiting-countersignature',protocol:true,at});h.clock.now=at+30000;return p;};
const READ_BACK={bundle:{buyerSignature:'TEST-countersignature',buyerCopyReadBack:true}};

test('integration: every event protocol-purchases.mjs logs outside save() is replayed, and no other module records a protocol event health does not know',()=>{
  const source=readFileSync(resolve('src/dacs/protocol-purchases.mjs'),'utf8');
  const logged=[...source.matchAll(/\bops\.(?:record|appendEvent)\(\s*[\w.]+\s*,\s*(`[^`]*`|'[^']*')/g)].map(m=>m[1]);
  assert.equal(logged.length,source.match(/\bops\.(?:record|appendEvent)\(/g).length,'every logged event names its type');
  assert.deepEqual(logged.sort(),["'protocol_check_not_saved'",'`protocol_${step}`'],'only not-saved checks and lost attempts are logged outside save()');
  assert.equal(health.NOT_SAVED_EVENT,'protocol_check_not_saved');
  // The not-saved event carries the original event's data and its name under data.event.
  assert.match(source,/ops\.appendEvent\(operation\.id, 'protocol_check_not_saved', \{ \.\.\.data, event, stage: own\.stage, /);
  // Other modules: the delivery deadline watch's local observation carries no outcome or stage.
  const recorded=new Set();
  for(const file of readdirSync('src',{recursive:true}).filter(f=>f.endsWith('.mjs')).map(f=>join('src',f))){
    if(file===join('src','dacs','protocol-purchases.mjs')||file.startsWith(join('src','ops')))continue;
    const text=readFileSync(file,'utf8');
    for(const m of text.matchAll(/event:\s*'(protocol_[a-z_-]+)'|\b(?:record|appendEvent)\([^,()]+,\s*['`](protocol_[^'`]*)['`]/g))recorded.add(m[1]??m[2]);
  }
  assert.deepEqual([...recorded],['protocol_delivery_deadline_overdue']);
});

test('a commitment finality hold that was not saved, and a held commitment attempt, keep ops health readable',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-anchored'});
  notSaved(h,p,'protocol_native_commitment_held',{reason:'commitment finality is not established'});
  noted(h,p,'commitment','indeterminate',{reason:'independently authenticated commitment finality is not established'});
  const r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);assert.equal(dbOnly(h).status,0);
});

test('integration: a buyer copy written once stays unresolved until its authenticated readback',t=>{
  // The process stopped after the intent, or the write's answer was lost, or the readback is not there yet.
  for(const after of [[],[['buyer-copy','unavailable']],[['buyer-copy','absent']],[['buyer-copy','unavailable'],['buyer-copy','absent']],
    [['buyer-copy','rejected','bundle-rejected']],[['seller-copy','verified']]]){
    const h=fixture(t),p=countersigning(h);buyerCopyIntent(h,p);
    for(const [step,outcome,stage] of after)noted(h,p,step,outcome,{stage});
    h.clock.now=NOW;
    const r=h.report(),label=JSON.stringify(after);
    assert.equal(r.healthy,false,label);assert.deepEqual(stuckOf(r,p).map(s=>[s[1],s[2],s[3],s[4]]),[[0,'unknown-readback-required',READBACK,['buyer-copy']]],label);
    assert.equal(dbOnly(h).status,1,label);
  }
  // An authenticated readback resolves it.
  const h=fixture(t),p=countersigning(h);buyerCopyIntent(h,p);noted(h,p,'buyer-copy','absent');noted(h,p,'buyer-copy','anchored',{patch:READ_BACK});h.clock.now=NOW;
  let r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);assert.equal(dbOnly(h).status,0);
  // A later failed readback on another check does not reopen a read-back copy's write; a lost seller countersign answer is its own write.
  h.clock.now=NOW-1000;noted(h,p,'seller-copy','unavailable');h.clock.now=NOW;
  assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['seller-copy']]);
  // Older code saved the copy reference from the write acknowledgement; protocol-purchases still shows a completed
  // or counter-signing purchase resting on one as awaiting the readback, so it is unresolved too.
  for(const stage of ['completed','awaiting-countersignature']){
    const e=fixture(t),q=countersigning(e);
    noted(e,q,'buyer-copy','anchored',{stage,patch:{bundle:{buyerSignature:'TEST-countersignature',buyerCopyRef:{anchor:{kind:'storage-program',locator:'TEST'}}}}});e.clock.now=NOW;
    assert.deepEqual(stuckOf(e.report(),q).map(s=>[s[0],s.at(-1)]),[[stage,['buyer-copy']]],stage);
    e.clock.now=NOW-1000;noted(e,q,'buyer-copy','anchored',{patch:READ_BACK});e.clock.now=NOW;
    assert.equal(e.report().healthy,true,stage);
  }
  // A legacy bundle rejected after an acknowledged copy is never re-checked by protocol-purchases, and the
  // acknowledgement is not a readback, so its buyer copy write stays unresolved at bundle-rejected (it was reported healthy).
  const e=fixture(t),q=countersigning(e);
  noted(e,q,'buyer-copy','anchored',{patch:{bundle:{buyerSignature:'TEST-countersignature'}}});noted(e,q,'seller-copy','rejected',{stage:'bundle-rejected'});e.clock.now=NOW;
  assert.deepEqual(stuckOf(e.report(),q),[['bundle-rejected',0,'unknown-readback-required',READBACK,['buyer-copy']]]);assert.equal(dbOnly(e).status,1);
  // A copy read back before the seller copy was rejected raises nothing.
  const g=fixture(t),s=countersigning(g);
  buyerCopyIntent(g,s);noted(g,s,'buyer-copy','anchored',{patch:READ_BACK});noted(g,s,'seller-copy','rejected',{stage:'bundle-rejected'});g.clock.now=NOW;
  r=g.report();assert.equal(r.healthy,true);assert.deepEqual(r.stuck,[]);
});

test('integration: a check that lost to newer saved progress can add a write but never settles one, and never moves the timeline',t=>{
  const fresh=(h,stage='agreement-anchored')=>{const p=h.create({protocol:true,status:'agreement_pending',stage,at:NOW-60000});h.clock.now=NOW-30000;return p;};
  // A possibly-issued write in a not-saved check alerts, and the check's own stage never enters the timeline.
  let h=fixture(t),p=fresh(h);
  notSaved(h,p,'protocol_commit-request',{outcome:'unavailable',reason:UNAVAILABLE});h.clock.now=NOW;
  let r=h.report();
  assert.deepEqual(stuckOf(r,p),[['agreement-anchored',0,'unknown-readback-required',READBACK,['commit-request']]]);
  assert.equal(r.purchases[0].timeline.some(e=>e.stage==='committed'),false,'the not-saved stage is not in the timeline');
  assert.equal(dbOnly(h).status,1);
  // A saved verified readback resolves it; a not-saved one does not resolve a saved write.
  h.clock.now=NOW-1000;noted(h,p,'commitment','verified',{stage:'committed',toStatus:'awaiting_approval'});h.clock.now=NOW;
  assert.equal(h.report().healthy,true);
  // A check is not saved because another saved first, so its write is logged after that check's saved
  // readback, which is never recorded again. A saved resolving readback of the same step settles it in either order,
  // not-saved or lost (logged with no stage). Nothing else does: another step's readback, or none.
  for(const [readback,write,lost,writes] of [[['commitment','verified',{stage:'committed',toStatus:'awaiting_approval'}],'commit-request',false,[]],
    [['commitment','verified',{stage:'committed',toStatus:'awaiting_approval'}],'commit-request',true,[]],
    [['payment-evidence','verified',{stage:'payment-evidenced'}],'claim',false,[]],[['delivery','verified',{stage:'delivery-ready'}],'native-evidence',false,[]],
    [['payment-evidence','verified',{stage:'payment-evidenced'}],'commit-request',false,['commit-request']],[null,'claim',true,['claim']]]){
    h=fixture(t);p=fresh(h);
    if(readback)noted(h,p,readback[0],readback[1],readback[2]);
    const outcome=write==='native-evidence'?'held':'unavailable';
    if(lost)h.ops.record(p.id,`protocol_${write}`,{outcome,reason:UNAVAILABLE});else notSaved(h,p,`protocol_${write}`,{outcome,reason:UNAVAILABLE});
    h.clock.now=NOW;
    const label=JSON.stringify([readback?.slice(0,2),write,lost]);
    assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),writes.length?[writes]:[],label);
  }
  // A saved write after the readback is not settled by it.
  h=fixture(t);p=fresh(h);noted(h,p,'commitment','verified',{stage:'committed',toStatus:'awaiting_approval'});noted(h,p,'commit-request','unavailable',{reason:UNAVAILABLE});h.clock.now=NOW;
  assert.deepEqual(stuckOf(h.report(),p).map(s=>s.at(-1)),[['commit-request']]);
  // The write is held by the event log only (logged as note() does when the purchase changed mid-call),
  // so the stored attempts cannot keep it open in its place.
  h=fixture(t);p=fresh(h);h.ops.record(p.id,'protocol_commit-request',{outcome:'unavailable',reason:UNAVAILABLE});notSaved(h,p,'protocol_commitment',{outcome:'verified',stage:'committed'});h.clock.now=NOW;
  r=h.report();assert.deepEqual(stuckOf(r,p).map(s=>s.at(-1)),[['commit-request']]);
  assert.equal(r.purchases[0].stage,'agreement-anchored');assert.equal(r.purchases[0].timeline.some(e=>e.stage==='committed'),false);
  // A not-saved Agreement-context answer may follow a seller Vet write, unless no provider was invoked.
  h=fixture(t);p=fresh(h,'identity');notSaved(h,p,'protocol_agreement-context',{outcome:'indeterminate',reason:'TEST Vet publish answer lost'});h.clock.now=NOW;
  assert.deepEqual(h.report({operatorState:null}).stuck.map(s=>[s.purchaseId,s.outcome]),[[p.id,'seller-journal-not-read']]);
  h=fixture(t);p=fresh(h,'identity');notSaved(h,p,'protocol_agreement-context',{outcome:'indeterminate',reason:NO_PROVIDER,...NOT_WRITTEN});h.clock.now=NOW;
  assert.equal(h.report({operatorState:null}).healthy,true);
  // A not-saved intent or other event sent nothing: save() throws before the write that follows an intent.
  for(const event of [...Object.keys(health.INTENT_EFFECTS),...health.NO_WRITE_EVENTS]){
    h=fixture(t);p=fresh(h);notSaved(h,p,event);h.clock.now=NOW;
    r=h.report();assert.equal(r.healthy,true,event);assert.deepEqual(r.stuck,[],event);
  }
  // A not-saved check health cannot classify fails closed.
  for(const data of [{event:'protocol_future_event'},{event:'protocol_commit-request'},{event:'protocol_commit-request',outcome:'indeterminate'},{event:'protocol_future-step',outcome:'verified'},{outcome:'verified'},{event:7}]){
    h=fixture(t);p=fresh(h);h.ops.record(p.id,'protocol_check_not_saved',data);
    assert.throws(()=>h.report(),/could not read valid state/,JSON.stringify(data));assert.equal(dbOnly(h).status,2,JSON.stringify(data));
  }
});

for(const source of ['events','stored','both'])test(`later cause-free attempt clears health cause (${source})`,t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing'});
  const attempts=[{step:'agreement',outcome:'indeterminate',causeCode:'tls'},{step:'agreement',outcome:'waiting'}];
  if(source!=='stored')for(const attempt of attempts)h.ops.record(p.id,'protocol_agreement',{...attempt,stage:'agreement-signing'});
  if(source!=='events')h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing',attempts}},event:'protocol_step',data:{stage:'agreement-signing'}});
  const row=h.report().purchases[0];
  assert.equal(Object.hasOwn(row,'causeCode'),false);
  assert.deepEqual(row.unresolvedWrites,['agreement'],'clearing a cause does not resolve an unknown write');
});

for(const source of ['events','stored','both'])test(`not-sent attempt preserves earlier unknown writes (${source})`,t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing'});
  const attempts=[{step:'agreement',outcome:'indeterminate',causeCode:'network'},{step:'agreement',outcome:'indeterminate',causeCode:'tls',dispatched:false}];
  if(source!=='stored')for(const attempt of attempts)h.ops.record(p.id,'protocol_agreement',{...attempt,stage:'agreement-signing'});
  if(source!=='events')h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'agreement-signing',attempts}},event:'protocol_step',data:{stage:'agreement-signing'}});
  const row=h.report().purchases[0];
  assert.equal(row.outcome,'unknown-readback-required');assert.deepEqual(row.unresolvedWrites,['agreement']);assert.equal(row.causeCode,'tls');
});

// The cancel/send exclusion's per-payer records in the source transport
// journal, as devnet-native-transport.mjs writes them (cancelNativeTransfer,
// writeClaims, refuseCancelled), on the lane of a fixture wallet-Agreement
// purchase: its terms.domain network and chain identity and its buyer wallet.
// A cancellation names its purchase: PAYER_PURCHASE, which forPurchase()
// replaces with a purchase in the test's database.
const payerKey=(kind,lane=[WALLET_SCOPE.network,WALLET_SCOPE.chainIdentity,`0x${'b'.repeat(64)}`])=>`devnet/${kind}/${JSON.stringify(lane)}`;
const payerTerms={nonce:3,to:address,amountOs:'1000000000',payloadDigest:'f'.repeat(64)},payerAt=new Date(NOW).toISOString(),PAYER_PURCHASE=`pur_${'A'.repeat(16)}`;
const PAYER_RECORDS={
  'cancelled-payments':{cancelledPayments:'dacs-chatgpt-plugin/cancelled-native-payments/v2',transfers:[{...payerTerms,operationId:PAYER_PURCHASE,cancelledAt:payerAt}]},
  'transfer-claims':{transferClaims:'dacs-chatgpt-plugin/native-transfer-claims/v1',claims:[{leaseId:'1'.repeat(32),...payerTerms,expiresAt:payerAt,confirmTxAt:payerAt},{leaseId:'2'.repeat(32),...payerTerms,nonce:4,expiresAt:payerAt}]},
  // One refusal per payload (refuseCancelled keeps the first gate's): here four payloads, one at each gate.
  'refused-transfers':{refusedTransfers:'dacs-chatgpt-plugin/refused-native-transfers/v1',refusals:['signature','pre-broadcast','confirmTx','broadcast'].map((gate,i)=>({...payerTerms,nonce:payerTerms.nonce+i,gate,refusedAt:payerAt}))},
};
const withEntry=(kind,change)=>{const record=structuredClone(PAYER_RECORDS[kind]),list=Object.keys(record)[1];record[list][0]=change(record[list][0]);return record;};
const forPurchase=(value,operation)=>Array.isArray(value?.transfers)?{...value,transfers:value.transfers.map(e=>e?.operationId===PAYER_PURCHASE?{...e,operationId:operation.id}:e)}:value;

test('coverage: the source journal\'s cancelled-payment, transfer-claim and refused-transfer records on a buyer lane are not issued writes',async t=>{
  const h=fixture(t),operation=h.create({wallet:true}),j=h.durable('node2-transport.sqlite');
  for(const [kind,value] of Object.entries(PAYER_RECORDS))await j.put(payerKey(kind),forPurchase(value,operation));
  let r=h.report();
  assert.equal(r.healthy,true);assert.deepEqual(r.seller.journals,['node2-transport.sqlite']);assert.deepEqual(r.seller.unconfirmed,[]);assert.deepEqual(r.stuck,[]);
  const cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout).seller.unconfirmed,[]);
  // Released and expired claims leave an empty list; a later refusal list may hold up to 64.
  await j.put(payerKey('transfer-claims'),{...PAYER_RECORDS['transfer-claims'],claims:[]});
  await j.put(payerKey('refused-transfers'),{...PAYER_RECORDS['refused-transfers'],refusals:Array.from({length:64},(_,nonce)=>({...payerTerms,nonce,gate:'signature',refusedAt:payerAt}))});
  assert.equal(h.report().healthy,true);
  // The same terms signed from another payload are another payload; one transfer may be claimed by two leases.
  await j.put(payerKey('refused-transfers'),{...PAYER_RECORDS['refused-transfers'],refusals:[{...payerTerms,gate:'signature',refusedAt:payerAt},{...payerTerms,payloadDigest:'e'.repeat(64),gate:'confirmTx',refusedAt:payerAt}]});
  await j.put(payerKey('transfer-claims'),{...PAYER_RECORDS['transfer-claims'],claims:[{leaseId:'1'.repeat(32),...payerTerms,expiresAt:payerAt},{leaseId:'2'.repeat(32),...payerTerms,expiresAt:payerAt}]});
  assert.equal(h.report().healthy,true);
  // A cancellation keeps the lane's later cancellations, each its own purchase's.
  const later=h.create({wallet:true}),cancelled=PAYER_RECORDS['cancelled-payments'];
  await j.put(payerKey('cancelled-payments'),{...cancelled,transfers:[{...cancelled.transfers[0],operationId:operation.id},{...cancelled.transfers[0],nonce:4,operationId:later.id}]});
  assert.equal(h.report().healthy,true);
  // They hide nothing else in the journal: a pending seller write still alerts.
  await j.put('seller-transport',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  r=h.report();assert.equal(r.healthy,false);assert.deepEqual(r.seller.unconfirmed.map(row=>row.stage),['broadcast-started']);
});

const malformedPayerRecords=[
  ...['cancelled-payments','transfer-claims','refused-transfers'].flatMap(kind=>[
    [`${kind}: an extra field`,kind,withEntry(kind,e=>({...e,hash:'e'.repeat(64)}))],
    [`${kind}: a stage`,kind,{...PAYER_RECORDS[kind],stage:'observed'}],
    [`${kind}: no record`,kind,null],
    [`${kind}: another format`,kind,{...PAYER_RECORDS[kind],[Object.keys(PAYER_RECORDS[kind])[0]]:'dacs-chatgpt-plugin/other/v9'}],
    [`${kind}: no list`,kind,{[Object.keys(PAYER_RECORDS[kind])[0]]:Object.values(PAYER_RECORDS[kind])[0]}],
    [`${kind}: a list that is not an array`,kind,{...PAYER_RECORDS[kind],[Object.keys(PAYER_RECORDS[kind])[1]]:{}}],
    [`${kind}: a null entry`,kind,withEntry(kind,()=>null)],
    [`${kind}: a nonce that is not a safe integer`,kind,withEntry(kind,e=>({...e,nonce:'3'}))],
    [`${kind}: a payee that is not lowercase 0x hex`,kind,withEntry(kind,e=>({...e,to:address.toUpperCase().replace('0X','0x')}))],
    [`${kind}: a payee with a character before it`,kind,withEntry(kind,e=>({...e,to:`x${address}`}))],
    [`${kind}: a payee with a hex digit after it`,kind,withEntry(kind,e=>({...e,to:`${address}0`}))],
    [`${kind}: a payee one hex digit short`,kind,withEntry(kind,e=>({...e,to:address.slice(0,-1)}))],
    [`${kind}: a zero amount`,kind,withEntry(kind,e=>({...e,amountOs:'0'}))],
    [`${kind}: an amount with a leading zero`,kind,withEntry(kind,e=>({...e,amountOs:'01000000000'}))],
    [`${kind}: an amount with a character after it`,kind,withEntry(kind,e=>({...e,amountOs:'1000000000x'}))],
    [`${kind}: a numeric amount`,kind,withEntry(kind,e=>({...e,amountOs:1000000000}))],
    [`${kind}: a short payload digest`,kind,withEntry(kind,e=>({...e,payloadDigest:'f'.repeat(63)}))],
    [`${kind}: a missing payload digest`,kind,withEntry(kind,({payloadDigest,...e})=>e)],
  ]),
  ['cancelled-payments: no transfers','cancelled-payments',{...PAYER_RECORDS['cancelled-payments'],transfers:[]}],
  ['cancelled-payments: an operation that is not a purchase id','cancelled-payments',withEntry('cancelled-payments',e=>({...e,operationId:'op_1'}))],
  ['cancelled-payments: a purchase that is not in this database','cancelled-payments',withEntry('cancelled-payments',e=>({...e,operationId:`pur_${'Z'.repeat(16)}`}))],
  ['cancelled-payments: a cancellation time that is not ISO','cancelled-payments',withEntry('cancelled-payments',e=>({...e,cancelledAt:String(NOW)}))],
  // Times as the producer writes them (toISOString of a four-digit year), each caught by one check of at().
  ['cancelled-payments: a cancellation time with an extended year','cancelled-payments',withEntry('cancelled-payments',e=>({...e,cancelledAt:'+010000-01-01T00:00:00.000Z'}))],
  ['cancelled-payments: a cancellation time in no month','cancelled-payments',withEntry('cancelled-payments',e=>({...e,cancelledAt:'2026-13-01T00:00:00.000Z'}))],
  ['cancelled-payments: a cancellation time on no day of its month','cancelled-payments',withEntry('cancelled-payments',e=>({...e,cancelledAt:'2026-02-30T00:00:00.000Z'}))],
  ['transfer-claims: a lease id that is not 32 hex','transfer-claims',withEntry('transfer-claims',e=>({...e,leaseId:'1'.repeat(31)}))],
  ['transfer-claims: a lease id with a character before it','transfer-claims',withEntry('transfer-claims',e=>({...e,leaseId:`x${'1'.repeat(32)}`}))],
  ['transfer-claims: a lease id with a character after it','transfer-claims',withEntry('transfer-claims',e=>({...e,leaseId:`${'1'.repeat(32)}x`}))],
  ['transfer-claims: a lease id in upper case','transfer-claims',withEntry('transfer-claims',e=>({...e,leaseId:'A'.repeat(32)}))],
  ['transfer-claims: no expiry','transfer-claims',withEntry('transfer-claims',({expiresAt,...e})=>e)],
  ['transfer-claims: an expiry that is not ISO','transfer-claims',withEntry('transfer-claims',e=>({...e,expiresAt:'2026-10-13'}))],
  ['transfer-claims: a confirmTx time that is not ISO','transfer-claims',withEntry('transfer-claims',e=>({...e,confirmTxAt:null}))],
  ['refused-transfers: no refusals','refused-transfers',{...PAYER_RECORDS['refused-transfers'],refusals:[]}],
  ['refused-transfers: more than 64 refusals','refused-transfers',{...PAYER_RECORDS['refused-transfers'],refusals:Array.from({length:65},(_,nonce)=>({...payerTerms,nonce,gate:'signature',refusedAt:payerAt}))}],
  ['transfer-claims: two claims of one lease','transfer-claims',{...PAYER_RECORDS['transfer-claims'],claims:[...PAYER_RECORDS['transfer-claims'].claims,{...PAYER_RECORDS['transfer-claims'].claims[1],nonce:5}]}],
  ['refused-transfers: a payload refused again at another gate','refused-transfers',{...PAYER_RECORDS['refused-transfers'],refusals:[...PAYER_RECORDS['refused-transfers'].refusals,{...PAYER_RECORDS['refused-transfers'].refusals[0],gate:'broadcast'}]}],
  ['refused-transfers: a refusal kept twice','refused-transfers',{...PAYER_RECORDS['refused-transfers'],refusals:[...PAYER_RECORDS['refused-transfers'].refusals,PAYER_RECORDS['refused-transfers'].refusals[2]]}],
  ['refused-transfers: an unknown gate','refused-transfers',withEntry('refused-transfers',e=>({...e,gate:'release'}))],
  ['refused-transfers: a refusal time that is not ISO','refused-transfers',withEntry('refused-transfers',e=>({...e,refusedAt:'yesterday'}))],
];
test('coverage: a malformed cancelled-payment, transfer-claim or refused-transfer record still fails closed',async t=>{
  for(const [name,kind,value] of malformedPayerRecords){
    const h=fixture(t),operation=h.create({wallet:true});
    await h.durable('node2-transport.sqlite').put(payerKey(kind),forPurchase(value,operation));
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  const h=fixture(t);h.create({wallet:true});await h.durable('node2-transport.sqlite').put(payerKey('transfer-claims'),malformedPayerRecords[0][2]);
  assert.equal(h.cli(['--json']).status,2);
});

test('coverage: an unknown key under those prefixes, a lane that is not a purchase\'s own network, chain and buyer, a cancellation of a purchase on another lane, or such a record in a seller journal still fails closed',async t=>{
  const buyerWallet=`0x${'b'.repeat(64)}`,{network,chainIdentity}=WALLET_SCOPE,cases=[
    ['an unparsed suffix',kind=>`devnet/${kind}/TEST`],
    ['an empty suffix',kind=>`devnet/${kind}/`],
    ['a lane not as JSON.stringify writes it',kind=>`devnet/${kind}/${JSON.stringify([network,chainIdentity,buyerWallet],null,1)}`],
    ['a two-part lane',kind=>payerKey(kind,[network,buyerWallet])],
    ['a four-part lane',kind=>payerKey(kind,[network,chainIdentity,buyerWallet,buyerWallet])],
    ['a lane that is an object, not a list',kind=>`devnet/${kind}/${JSON.stringify({0:network,1:chainIdentity,2:buyerWallet,length:3})}`],
    ['a network that is not a pinned label',kind=>payerKey(kind,['Demos Devnet',chainIdentity,buyerWallet])],
    ['a numeric network',kind=>payerKey(kind,[7,chainIdentity,buyerWallet])],
    ['another network',kind=>payerKey(kind,['foreign-net',chainIdentity,buyerWallet])],
    ['a chain identity that is not 64 hex',kind=>payerKey(kind,[network,'d'.repeat(63),buyerWallet])],
    ['another chain identity',kind=>payerKey(kind,[network,'e'.repeat(64),buyerWallet])],
    ['the chain identity with 0x',kind=>payerKey(kind,[network,`0x${chainIdentity}`,buyerWallet])],
    ['another wallet',kind=>payerKey(kind,[network,chainIdentity,`0x${'c'.repeat(64)}`])],
    ['the seller\'s wallet',kind=>payerKey(kind,[network,chainIdentity,address])],
    ['the buyer in upper case',kind=>payerKey(kind,[network,chainIdentity,`0x${'B'.repeat(64)}`])],
  ];
  for(const kind of Object.keys(PAYER_RECORDS)){
    for(const [name,key] of cases){
      const h=fixture(t),operation=h.create({wallet:true});
      await h.durable('node2-transport.sqlite').put(key(kind),forPurchase(PAYER_RECORDS[kind],operation));
      assert.throws(()=>h.report(),/could not read valid state/,`${kind}: ${name}`);
    }
    for(const journal of ['seller-artifacts.sqlite','seller-wallet.sqlite']){
      const h=fixture(t),operation=h.create({wallet:true});
      await h.durable(journal).put(payerKey(kind),forPurchase(PAYER_RECORDS[kind],operation));
      assert.throws(()=>h.report(),/could not read valid state/,`${kind} in ${journal}`);
    }
    // The buyer's purchases here have no network or chain identity in their terms.
    const h=fixture(t),operation=h.create({protocol:true});h.create();
    await h.durable('node2-transport.sqlite').put(payerKey(kind),forPurchase(PAYER_RECORDS[kind],operation));
    assert.throws(()=>h.report(),/could not read valid state/,`${kind}: no purchase on the lane`);
  }
  // A cancellation of the same buyer's purchase that is not on this lane.
  const off=fixture(t);off.create({wallet:true});const other=off.create({protocol:true});
  await off.durable('node2-transport.sqlite').put(payerKey('cancelled-payments'),forPurchase(PAYER_RECORDS['cancelled-payments'],other));
  assert.throws(()=>off.report(),/could not read valid state/);
  // With no purchase, the buyer is not known in this database.
  const h=fixture(t);await h.durable('node2-transport.sqlite').put(payerKey('transfer-claims'),PAYER_RECORDS['transfer-claims']);
  assert.throws(()=>h.report(),/could not read valid state/);
  const cli=spawnSync(process.execPath,['scripts/ops-health.mjs','--database',h.path,'--operator-state',h.root,'--json'],{encoding:'utf8',timeout:10000});
  assert.equal(cli.status,2);
});

// The buyer's browser Agreement CREATE handoff in the source transport journal,
// as devnet-agreement-transport-broker.mjs writes it at each stage, for a
// fixture wallet-Agreement purchase (its scope(): account, buyer wallet, terms
// hash, job, planned Agreement hash and network), its request's CREATE the
// unsigned storage CREATE demos-sr2-adapter.mjs hands out for that Agreement:
// completed adds the CREATE's hash, uncertain the hash and the wallet's error
// code, denied the error code. scope replaces any part of the purchase's
// scope, giving a record that is consistent in itself for that scope.
function createHandoff(operation,stage='completed',scope={}){
  const {wallet=`0x${'b'.repeat(64)}`,account=operation.accountId,jobId:job,network,chainIdentity,agreement,transportBinding,termsHash='c'.repeat(64)}={...WALLET_SCOPE,...scope};
  const agreementHash=contentHash(agreement),envelopeHash=sha(canonicalize(agreement)),logicalAddress=fixedPriceAgreementLogicalAddress(job),programName=logicalToStorageProgramName(logicalAddress),nonce=1;
  const binding={account,operation:operation.id,wallet,'terms-hash':termsHash,job,'agreement-hash':agreementHash,network,authorization:'one immutable Agreement CREATE; no payment or completion'};
  const transaction=buildStorageProgramCreatePayload({from:wallet,storageAddress:deriveStorageAddress(wallet,programName,nonce,''),programName,logicalAddress,signedListing:agreement,nonce,timestamp:NOW});
  transaction.content.data[1].metadata={logicalAddress,contentHash:agreementHash,envelopeHash,artifactKind:'Agreement',networkBinding:transportBinding};
  Object.assign(transaction.content,{from_ed25519_address:wallet,network,chainIdentity});
  const request={method:'sendTransaction',params:[{kind:'devnet-agreement-storage-create',profile:'devnet-agreement',network,owner:`did:demos:agent:${wallet.slice(2)}`,artifactKind:'Agreement',jobId:job,
    logicalAddress,contentHash:agreementHash,envelopeHash,transaction}]};
  return{version:1,binding,correlation:'x'.repeat(32),request,requestHash:sha(canonicalize(request)),expiresAt:NOW+120000,stage,
    ...(['completed','uncertain'].includes(stage)?{transactionHash:'f'.repeat(64)}:{}),...(['uncertain','denied'].includes(stage)?{errorCode:'TEST_wallet_error'}:{})};
}
const handoffKey=(operation)=>`devnet-browser-agreement/create/${operation.id}`,handoffRehash=(r)=>{r.requestHash=sha(canonicalize(r.request));return r;};
const HANDOFF_STAGES=['queued','issued-to-browser','expired','completed','uncertain','denied'];
// A change to the request's CREATE (create: its content; op: its storage operation), rehashed.
const changeCreate=(change)=>r=>{const c=r.request.params[0].transaction.content;change(c,c.data[1]);return handoffRehash(r);};

test('coverage: the browser Agreement CREATE handoff, at each stage its producer leaves it, for a purchase in this database, is not an issued write',async t=>{
  const h=fixture(t),operation=h.create({wallet:true}),j=h.durable('node2-transport.sqlite');
  assert.deepEqual(Object.keys(health.BROWSER_HANDOFF_STAGES),HANDOFF_STAGES);
  for(const stage of HANDOFF_STAGES){
    await j.put(handoffKey(operation),createHandoff(operation,stage));
    const r=h.report();assert.equal(r.healthy,true,stage);assert.deepEqual(r.seller.unconfirmed,[],stage);
  }
  // The error code is the wallet's, when it gave one, cut to 80 characters.
  for(const stage of ['uncertain','denied']){
    const r=createHandoff(operation,stage);delete r.errorCode;await j.put(handoffKey(operation),r);assert.equal(h.report().healthy,true,stage);
    await j.put(handoffKey(operation),{...r,errorCode:'x'.repeat(80)});assert.equal(h.report().healthy,true,stage);
  }
  await j.put(handoffKey(operation),createHandoff(operation));
  const cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);
  // The producer's bounds: a CREATE at timestamp 0 (planWrite's nonnegative integer), a handoff expiring at 0.
  for(const record of [changeCreate(c=>{c.timestamp=0;})(createHandoff(operation)),{...createHandoff(operation),expiresAt:0}]){
    await j.put(handoffKey(operation),record);assert.equal(h.report().healthy,true,JSON.stringify([record.expiresAt]));
  }
  await j.put(handoffKey(operation),createHandoff(operation));
  // The CREATE carries the Agreement its purchase retained, signatures included.
  const signed={...WALLET_SCOPE.agreement,signatures:[{TEST:'retained signature'}]},signedPurchase=h.create({wallet:true,retained:signed});
  await j.put(handoffKey(signedPurchase),createHandoff(signedPurchase,'completed',{agreement:signed}));
  assert.equal(h.report().healthy,true);
  // Beside the payer records, and hiding nothing else in the journal.
  for(const [kind,value] of Object.entries(PAYER_RECORDS))await j.put(payerKey(kind),forPurchase(value,operation));
  assert.equal(h.report().healthy,true);
  await j.put('seller-transport',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  const r=h.report();assert.equal(r.healthy,false);assert.deepEqual(r.seller.unconfirmed.map(row=>row.stage),['broadcast-started']);
});

const malformedHandoffs=[
  ['no record','completed',()=>null],
  ['version 2','completed',r=>{r.version=2;}],
  ['no stage','completed',r=>{delete r.stage;}],
  ['a stage its producer never writes','completed',r=>{r.stage='broadcast-started';}],
  ['a journal stage its producer never writes','completed',r=>{r.stage='observed';}],
  // With no field a stage adds, so only the stage differs from a known one.
  ...['broadcast-started','observed','verified','prepared','Queued','denied ','toString','constructor','hasOwnProperty'].map(stage=>[`${stage}, a stage its producer never writes, with no stage fields`,'queued',r=>{r.stage=stage;}]),
  ['a signed transaction','completed',r=>{r.signedTransaction={content:{from:address}};}],
  ['no correlation','completed',r=>{delete r.correlation;}],
  ['a correlation that is not 32 base64url characters','completed',r=>{r.correlation='x'.repeat(31);}],
  ['a correlation with a character before it','completed',r=>{r.correlation=`!${'x'.repeat(32)}`;}],
  ['a correlation with a character after it','completed',r=>{r.correlation=`${'x'.repeat(32)}!`;}],
  ['a request that is not its hash','completed',r=>{r.requestHash='0'.repeat(64);}],
  ['an expiry that is not a safe integer','completed',r=>{r.expiresAt=new Date(NOW).toISOString();}],
  ['a negative expiry','completed',r=>{r.expiresAt=-1;}],
  ...['queued','issued-to-browser','expired','denied'].map(stage=>[`a transaction hash at ${stage}`,stage,r=>{r.transactionHash='f'.repeat(64);}]),
  ...['queued','issued-to-browser','expired','completed'].map(stage=>[`an error code at ${stage}`,stage,r=>{r.errorCode='TEST_wallet_error';}]),
  ...['completed','uncertain'].map(stage=>[`no transaction hash at ${stage}`,stage,r=>{delete r.transactionHash;}]),
  ['a transaction hash that is not lowercase 64 hex','completed',r=>{r.transactionHash='F'.repeat(64);}],
  ['an empty error code','denied',r=>{r.errorCode='';}],
  ['an error code over 80 characters','uncertain',r=>{r.errorCode='x'.repeat(81);}],
  ['an error code that is not text','denied',r=>{r.errorCode=7;}],
  ['no binding','completed',r=>{r.binding=null;}],
  ['no request','completed',r=>{r.request=null;}],
  ['a request with no CREATE in it','completed',r=>handoffRehash((r.request.params=[null],r))],
  ['a binding with an extra field','completed',r=>{r.binding.extra='x';}],
  ['a binding without its account','completed',r=>{delete r.binding.account;}],
  ['an empty account','completed',r=>{r.binding.account='';}],
  ['an account over 128 characters','completed',r=>{r.binding.account='x'.repeat(129);}],
  ['an account with a NUL','completed',r=>{r.binding.account=`${r.binding.account}\0`;}],
  ['another authorization','completed',r=>{r.binding.authorization='any CREATE';}],
  ['an Agreement hash that is not 64 hex','completed',r=>handoffRehash((r.binding['agreement-hash']=r.request.params[0].contentHash='e'.repeat(63),r))],
  ['a job that is not canonical','completed',r=>handoffRehash((r.binding.job=r.request.params[0].jobId='TEST-job',r))],
  ['a network that is not a pinned label','completed',r=>handoffRehash((r.binding.network=r.request.params[0].network='Demos Devnet',r))],
  ['a request with another method','completed',r=>handoffRehash((r.request.method='sign',r))],
  ['a request with two CREATEs','completed',r=>handoffRehash((r.request.params.push(r.request.params[0]),r))],
  ['a request whose params are not a list','completed',r=>handoffRehash((r.request.params={0:r.request.params[0],length:1},r))],
  ['a request with an extra field','completed',r=>handoffRehash((r.request.id=1,r))],
  ['a CREATE request with an extra field','completed',r=>handoffRehash((r.request.params[0].extra='not-written-by-producer',r))],
  ['a CREATE request without its envelope hash','completed',r=>handoffRehash((delete r.request.params[0].envelopeHash,r))],
  ['a request of another kind','completed',r=>handoffRehash((r.request.params[0].kind='devnet-native-transfer',r))],
  ['a request without its profile','queued',r=>handoffRehash((delete r.request.params[0].profile,r))],
  ['a request with another profile','queued',r=>handoffRehash((r.request.params[0].profile='devnet-other',r))],
  ['a request for another artifact','completed',r=>handoffRehash((r.request.params[0].artifactKind='Bundle',r))],
  ['a request owned by the seller','completed',r=>handoffRehash((r.request.params[0].owner=seller,r))],
  ['a request for another job','completed',r=>handoffRehash((r.request.params[0].jobId='01ARZ3NDEKTSV4RRFFQ69G5FAW',r))],
  ['a request without its logical address','completed',r=>handoffRehash((delete r.request.params[0].logicalAddress,r))],
  ['another job\'s logical address','completed',r=>handoffRehash((r.request.params[0].logicalAddress=fixedPriceAgreementLogicalAddress('01ARZ3NDEKTSV4RRFFQ69G5FAW'),r))],
  // The request, its CREATE's metadata, program name and storage address all at another job's Agreement address.
  ['a CREATE consistently at another job\'s logical address','completed',r=>{
    const create=r.request.params[0],c=create.transaction.content,op=c.data[1];
    create.logicalAddress=op.metadata.logicalAddress=fixedPriceAgreementLogicalAddress('01ARZ3NDEKTSV4RRFFQ69G5FAW');
    op.programName=logicalToStorageProgramName(create.logicalAddress);op.storageAddress=c.to=deriveStorageAddress(c.from,op.programName,c.nonce,'');
    return handoffRehash(r);
  }],
  ['a request for another content hash','completed',r=>handoffRehash((r.request.params[0].contentHash='d'.repeat(64),r))],
  ['a request sent from the seller','completed',r=>handoffRehash((r.request.params[0].transaction.content.from=address,r))],
  ['a request on another network','completed',r=>handoffRehash((r.request.params[0].network='demos-mainnet',r))],
  ['a binding and request on another network than the purchase and its CREATE','completed',r=>handoffRehash((r.binding.network=r.request.params[0].network='foreign-net',r))],
  // The CREATE itself: only the unsigned storage CREATE of this purchase's Agreement.
  ['a native send instead of the CREATE','completed',r=>handoffRehash((r.request.params[0].transaction={content:{from:r.binding.wallet,type:'native',to:address,amount:'1'}},r))],
  ['a signed CREATE','completed',r=>handoffRehash((Object.assign(r.request.params[0].transaction,{signature:{type:'ed25519',data:'f'.repeat(128)},hash:'f'.repeat(64)}),r))],
  // Unsigned is both: no signature, and no hash.
  ['a CREATE with a signature and no hash','completed',r=>handoffRehash((r.request.params[0].transaction.signature={type:'ed25519',data:'f'.repeat(128)},r))],
  ['a CREATE with a hash and no signature','completed',r=>handoffRehash((r.request.params[0].transaction.hash='f'.repeat(64),r))],
  // Each other part of the unsigned CREATE's shape, on its own.
  ['a CREATE with a status','completed',r=>handoffRehash((r.request.params[0].transaction.status='confirmed',r))],
  ['a CREATE in a block','completed',r=>handoffRehash((r.request.params[0].transaction.blockNumber=7,r))],
  ['a CREATE with a third data element','completed',changeCreate(c=>{c.data.push({});})],
  ['a CREATE tagged as a native send','completed',changeCreate(c=>{c.data[0]='native';})],
  ['a CREATE whose data is not a list','completed',changeCreate(c=>{c.data={0:c.data[0],1:c.data[1],length:2};})],
  ['a CREATE in binary encoding','completed',changeCreate((c,op)=>{op.encoding='binary';})],
  ['a CREATE with an ACL allow list','completed',changeCreate((c,op)=>{op.acl={mode:'public',allowed:[address]};})],
  ['a CREATE with its nonce as text','completed',changeCreate(c=>{c.nonce='1';})],
  ['a CREATE with a fractional timestamp','completed',changeCreate(c=>{c.timestamp=1.5;})],
  ['a CREATE with a negative timestamp','completed',changeCreate(c=>{c.timestamp=-1;})],
  ['a CREATE whose metadata envelope hash is not its request\'s','completed',changeCreate((c,op)=>{op.metadata.envelopeHash='e'.repeat(64);})],
  ['a CREATE with an extra transaction field','completed',r=>handoffRehash((r.request.params[0].transaction.extra=1,r))],
  ['a CREATE with an extra content field','completed',changeCreate(c=>{c.extra=1;})],
  ['a CREATE of another type','completed',changeCreate(c=>{c.type='native';})],
  ['a CREATE signed by another wallet','completed',changeCreate(c=>{c.from_ed25519_address=`0x${'d'.repeat(64)}`;})],
  ['a CREATE with an amount','completed',changeCreate(c=>{c.amount=1;})],
  ['a CREATE with a fee','completed',changeCreate(c=>{c.transaction_fee.network_fee=1;})],
  ['a CREATE at nonce 0','completed',changeCreate((c,op)=>{c.nonce=0;op.storageAddress=c.to=deriveStorageAddress(c.from,op.programName,0,'');})],
  ['a CREATE on another network','completed',changeCreate(c=>{c.network='foreign-net';})],
  ['a CREATE on another chain','completed',changeCreate(c=>{c.chainIdentity='e'.repeat(64);})],
  ['a CREATE with no chain identity','completed',changeCreate(c=>{delete c.chainIdentity;})],
  ['an update instead of a CREATE','completed',changeCreate((c,op)=>{op.operation='UPDATE_STORAGE_PROGRAM';})],
  ['a CREATE with an extra operation field','completed',changeCreate((c,op)=>{op.extra=1;})],
  ['a CREATE at a storage address that is not derived','completed',changeCreate((c,op)=>{op.storageAddress=c.to=`stor-${'0'.repeat(40)}`;})],
  ['a CREATE to another address','completed',changeCreate(c=>{c.to=`stor-${'0'.repeat(40)}`;})],
  ['a CREATE under another program name','completed',changeCreate((c,op)=>{op.programName='TEST-program';op.storageAddress=c.to=deriveStorageAddress(c.from,op.programName,c.nonce,'');})],
  ['a private CREATE','completed',changeCreate((c,op)=>{op.acl={mode:'private'};})],
  ['a CREATE with a salt','completed',changeCreate((c,op)=>{op.salt='x';})],
  ['a CREATE stored off chain','completed',changeCreate((c,op)=>{op.storageLocation='ipfs';})],
  ['a CREATE of another Agreement','completed',changeCreate((c,op)=>{op.data={...op.data,TEST:'another Agreement'};})],
  ['a CREATE of another Agreement with that Agreement\'s envelope hash','completed',r=>{const create=r.request.params[0],op=create.transaction.content.data[1];op.data={...op.data,TEST:'another Agreement'};create.envelopeHash=op.metadata.envelopeHash=sha(canonicalize(op.data));return handoffRehash(r);}],
  ['a CREATE whose envelope hash is not its Agreement\'s','completed',r=>{r.request.params[0].envelopeHash=r.request.params[0].transaction.content.data[1].metadata.envelopeHash='f'.repeat(64);return handoffRehash(r);}],
  ['a CREATE with extra metadata','completed',changeCreate((c,op)=>{op.metadata.extra=1;})],
  ['a CREATE for another logical address','completed',changeCreate((c,op)=>{op.metadata.logicalAddress='dacs3:agreement:TEST';})],
  ['a CREATE with another content hash','completed',changeCreate((c,op)=>{op.metadata.contentHash='d'.repeat(64);})],
  ['a CREATE of another artifact kind','completed',changeCreate((c,op)=>{op.metadata.artifactKind='Listing';})],
  ['a CREATE without its network binding','completed',changeCreate((c,op)=>{delete op.metadata.networkBinding;})],
];
test('coverage: a malformed browser Agreement CREATE handoff still fails closed',async t=>{
  for(const [name,stage,change] of malformedHandoffs){
    const h=fixture(t),operation=h.create({wallet:true}),r=createHandoff(operation,stage),changed=change(r);
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),changed===undefined?r:changed);
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  const h=fixture(t),operation=h.create({wallet:true});await h.durable('node2-transport.sqlite').put(handoffKey(operation),{...createHandoff(operation),stage:'broadcast-started'});
  assert.equal(h.cli(['--json']).status,2);
});

test('coverage: a browser Agreement CREATE handoff for a purchase that is not in this database, under another purchase\'s key, for any scope that is not its purchase\'s, or in a seller journal still fails closed',async t=>{
  const absent={id:`pur_${'Z'.repeat(16)}`,accountId:'acct_TEST_absent'};
  // Each consistent in itself, for a scope that differs from its purchase's in one place.
  const foreign=(scope)=>(operation)=>createHandoff(operation,'completed',scope);
  const cases=[
    ['an unparsed suffix',()=>'devnet-browser-agreement/create/TEST',createHandoff],
    ['an empty suffix',()=>'devnet-browser-agreement/create/',createHandoff],
    ['a purchase that is not in this database',()=>handoffKey(absent),(operation)=>createHandoff({...absent,accountId:operation.accountId})],
    ['another purchase\'s key',(operation,other)=>handoffKey(other),createHandoff],
    ['a binding to another purchase',handoffKey,(operation,other)=>createHandoff(other)],
    ['a consistent record for a wallet that is not this purchase\'s buyer',handoffKey,foreign({wallet:`0x${'d'.repeat(64)}`})],
    ['a consistent record for the seller\'s wallet',handoffKey,foreign({wallet:address})],
    ['a consistent record for another account',handoffKey,foreign({account:'acct_TEST_foreign'})],
    ['a consistent record for another job',handoffKey,foreign({jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAW'})],
    ['a consistent record on another network',handoffKey,foreign({network:'foreign-net'})],
    ['a consistent record on another chain',handoffKey,foreign({chainIdentity:'e'.repeat(64)})],
    ['a consistent record for another Agreement',handoffKey,foreign({agreement:{...WALLET_SCOPE.agreement,TEST:'another Agreement'}})],
    ['a consistent CREATE of another Agreement under the purchase\'s planned Agreement hash',handoffKey,(operation)=>{const r=createHandoff(operation,'completed',{agreement:{...WALLET_SCOPE.agreement,TEST:'another Agreement'}});r.binding['agreement-hash']=WALLET_SCOPE.agreementHash;return r;}],
    // The planned Agreement's content hash leaves its signatures out; the purchase retained it with none.
    ['a consistent record for the planned Agreement with a signature the purchase never retained',handoffKey,foreign({agreement:{...WALLET_SCOPE.agreement,signature:{TEST:'not retained'}}})],
    ['a consistent record for the planned Agreement with signatures the purchase never retained',handoffKey,foreign({agreement:{...WALLET_SCOPE.agreement,signatures:[{TEST:'not retained'}]}})],
    ['a consistent record bound to another transport',handoffKey,foreign({transportBinding:{...WALLET_SCOPE.transportBinding,pinVersion:'TEST-other-pin'}})],
    ['another terms hash',handoffKey,(operation)=>{const r=createHandoff(operation);r.binding['terms-hash']='d'.repeat(64);return r;}],
  ];
  for(const [name,key,value] of cases){
    const h=fixture(t),operation=h.create({wallet:true}),other=h.create({wallet:true});
    await h.durable('node2-transport.sqlite').put(key(operation,other),value(operation,other));
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  // The CREATE carries exactly the Agreement the purchase retained for its
  // wallet CREATE, and that is its planned Agreement.
  const signed={...WALLET_SCOPE.agreement,signatures:[{TEST:'retained signature'}]},another={...WALLET_SCOPE.agreement,TEST:'another Agreement'};
  for(const [name,retained,agreement] of [
    ['a purchase that retained no Agreement',null,WALLET_SCOPE.agreement],
    ['the planned Agreement without the signatures its purchase retained',signed,WALLET_SCOPE.agreement],
    ['the planned Agreement for a purchase that retained another',another,WALLET_SCOPE.agreement],
    ['the retained Agreement of a purchase that planned another',another,another],
  ]){
    const h=fixture(t),operation=h.create({wallet:true,retained}),r=createHandoff(operation,'completed',{agreement});
    r.binding['agreement-hash']=WALLET_SCOPE.agreementHash;
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),r);
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  // Consistent with the Agreement a purchase retained instead of the one it planned: under its own hashes, or its CREATE under the planned content hash.
  for(const [name,change] of [
    ['the retained Agreement of a purchase that planned another, under its own hashes',r=>r],
    ['the retained Agreement of a purchase that planned another, under the planned content hash',r=>{const create=r.request.params[0];r.binding['agreement-hash']=create.contentHash=create.transaction.content.data[1].metadata.contentHash=WALLET_SCOPE.agreementHash;return handoffRehash(r);}],
  ]){
    const h=fixture(t),operation=h.create({wallet:true,retained:another});
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),change(createHandoff(operation,'completed',{agreement:another})));
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  // A purchase whose transport binding is not JSON object text binds no CREATE, even one that names the same value.
  for(const transportBinding of ['TEST-not-json',7]){
    const h=fixture(t),operation=h.create({wallet:true,scope:{transportBinding}});
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),createHandoff(operation,'completed',{transportBinding}));
    assert.throws(()=>h.report(),/could not read valid state/,String(transportBinding));
  }
  // A purchase with no planned Agreement, network or transport binding binds none.
  for(const create of [{protocol:true},{}]){
    const h=fixture(t),operation=h.create(create);
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),createHandoff(operation));
    assert.throws(()=>h.report(),/could not read valid state/,JSON.stringify(create));
  }
  // Recognized in the source transport journal only.
  for(const journal of ['seller-artifacts.sqlite','seller-wallet.sqlite'])for(const stage of ['queued','completed','uncertain']){
    const h=fixture(t),operation=h.create({wallet:true});
    await h.durable(journal).put(handoffKey(operation),createHandoff(operation,stage));
    assert.throws(()=>h.report(),/could not read valid state/,`${stage} in ${journal}`);
  }
  // With no purchase, nothing binds it.
  const h=fixture(t);await h.durable('node2-transport.sqlite').put(handoffKey(absent),createHandoff(absent));
  assert.throws(()=>h.report(),/could not read valid state/);assert.equal(h.cli(['--json']).status,2);
});

// The buyer's records the source transport journal keeps at rest at a stage no
// journal table holds, for the fixture wallet-Agreement purchase. failed:
// devnet-native-transport.mjs readback keeps the buyer's native transfer read
// back as failed (at its nonce fence, or its nonce consumed by another
// transfer) under its intent key and on its wallet lane. denied-unsigned:
// demos-sr2-adapter.mjs retireDeniedHandoff retires the purchase's Agreement
// CREATE plan after the wallet's denial, as the broker's resume runs it.
const BUYER_WALLET=`0x${'b'.repeat(64)}`;
function failedTransfer(failure={blockNumber:9,nonceFence:2},{wallet=PAYER,network=WALLET_SCOPE.network,chainIdentity=WALLET_SCOPE.chainIdentity,nonce=3}={}){
  const content={type:'native',from:wallet,to:address,amount:'1000000000',data:['native',{nativeOperation:'send',args:[address,'1000000000']}],nonce,timestamp:NOW};
  const signedTransaction=signTransaction(content),hash=signedTransaction.hash;
  return {stage:'failed',hash,nonce,signedTransaction,networkBinding:{network,chainIdentity,TEST:'fixture observed binding'},failure};
}
const failedKeys=(r)=>[`devnet/native-transfer/${r.hash}`,`devnet/native-wallet/${JSON.stringify([r.networkBinding?.network??WALLET_SCOPE.network,r.networkBinding?.chainIdentity??WALLET_SCOPE.chainIdentity,r.signedTransaction?.content?.from??BUYER_WALLET])}`];
function deniedPlan({agreement=WALLET_SCOPE.agreement,wallet=BUYER_WALLET,jobId=WALLET_SCOPE.jobId,network=WALLET_SCOPE.network,chainIdentity=WALLET_SCOPE.chainIdentity}={}){
  const logicalAddress=fixedPriceAgreementLogicalAddress(jobId),programName=logicalToStorageProgramName(logicalAddress),nonce=1,hash=contentHash(agreement),envelopeHash=sha(canonicalize(agreement));
  const metadata={logicalAddress,contentHash:hash,envelopeHash,artifactKind:'Agreement',networkBinding:WALLET_SCOPE.transportBinding},nativeAddress=deriveStorageAddress(wallet,programName,nonce,'');
  const payload=buildStorageProgramCreatePayload({from:wallet,storageAddress:nativeAddress,programName,logicalAddress,signedListing:agreement,nonce,timestamp:NOW});
  payload.content.data[1].metadata=metadata;payload.content.from_ed25519_address=wallet;
  const authorizationMessage=sha(JSON.stringify(payload.content)),scope=canonicalize([new URL(WALLET_SCOPE.transportBinding.endpoint).origin,chainIdentity,WALLET_SCOPE.transportBinding.bindingId]),writer=`did:demos:agent:${wallet.slice(2)}`;
  Object.assign(payload.content,{network,chainIdentity});
  return {logicalAddress,artifact:agreement,writer:`did:demos:agent:${wallet.slice(2)}`,owner:wallet,programName,hash,envelopeHash,artifactKind:'Agreement',metadata,
    scope,planId:sha(canonicalize([scope,writer,logicalAddress])),nativeAddress,nonce,stage:DENIED_UNSIGNED,payload,authorizationMessage,
    evidenceMode:'explicit-pinned-transport-single-node',authorizationProfile:'embedded-storage-anchor-create',retirement:{reason:'explicit-wallet-denial-without-signed-record',observedAccountNonce:0}};
}
const deniedKey=(r)=>`sr2/adapter/${r.planId}`;

// Independent regressions. Each starts with a producer-shaped
// record; the journal still has a valid digest after each single-field edit.
for(const [name,change] of [
  ['missing signature',r=>{delete r.signedTransaction.signature;}],
  ['null signature',r=>{r.signedTransaction.signature=null;}],
  ['wrong signature type',r=>{r.signedTransaction.signature.type='TEST';}],
  ['invalid signature',r=>{r.signedTransaction.signature.data='f'.repeat(128);}],
  ['destination changed under retained hash',r=>{r.signedTransaction.content.to=BUYER_WALLET;}],
  ['amount changed under retained hash',r=>{r.signedTransaction.content.amount='2';}],
  ['rehashing changed content without its signature',r=>{r.signedTransaction.content.timestamp++;r.hash=r.signedTransaction.hash=sha(JSON.stringify(r.signedTransaction.content));}],
  ['missing native body',r=>{delete r.signedTransaction.content.data;}],
  ['wrong native tag',r=>{r.signedTransaction.content.data[0]='TEST';r.signedTransaction=signTransaction(r.signedTransaction.content);r.hash=r.signedTransaction.hash;}],
  ['wrong native operation',r=>{r.signedTransaction.content.data[1].nativeOperation='TEST';r.signedTransaction=signTransaction(r.signedTransaction.content);r.hash=r.signedTransaction.hash;}],
  ['wrong send argument',r=>{r.signedTransaction.content.data[1].args[0]=BUYER_WALLET;r.signedTransaction=signTransaction(r.signedTransaction.content);r.hash=r.signedTransaction.hash;}],
])test(`failed transfer rejects ${name}`,async t=>{
  const h=fixture(t);h.create({wallet:true,scope:{buyer:PAYER}});
  const j=h.durable('node2-transport.sqlite'),r=failedTransfer(),key=failedKeys(r)[0];
  await j.put(key,r);assert.equal(h.report().healthy,true);
  change(r);await j.put(failedKeys(r)[0],r);
  assert.throws(()=>h.report(),/could not read valid state/);
});

for(const [name,change] of [
  ['native payload substituted for CREATE',r=>{const {network,chainIdentity}=r.payload.content;r.payload=failedTransfer().signedTransaction;Object.assign(r.payload.content,{network,chainIdentity});}],
  ['signature only',r=>{r.payload.signature={type:'ed25519',data:'f'.repeat(128)};}],
  ['hash only',r=>{r.payload.hash='e'.repeat(64);} ],
  ['different embedded Agreement signatures',r=>{r.payload.content.data[1].data={...r.artifact,signatures:[{TEST:'not retained'}]};}],
  ['wrong native address',r=>{r.nativeAddress=`stor-${'e'.repeat(40)}`;}],
  ['wrong program name',r=>{r.programName='TEST';}],
  ['wrong envelope hash',r=>{r.envelopeHash='e'.repeat(64);} ],
  ['wrong descriptor metadata',r=>{r.metadata={...r.metadata,logicalAddress:'TEST'};}],
  ['wrong payload metadata',r=>{r.payload.content.data[1].metadata={...r.metadata,envelopeHash:'e'.repeat(64)};}],
  ['wrong transport metadata',r=>{r.payload.content.data[1].metadata={...r.metadata,networkBinding:{TEST:'foreign'}};}],
  ['wrong payload address',r=>{r.payload.content.to=`stor-${'e'.repeat(40)}`;}],
  ['wrong payload nonce',r=>{r.payload.content.nonce++;}],
  ['wrong descriptor nonce',r=>{r.nonce++;r.retirement.observedAccountNonce++;}],
  ['unsafe next nonce',r=>{r.nonce=r.payload.content.nonce=Number.MAX_SAFE_INTEGER+1;r.retirement.observedAccountNonce=Number.MAX_SAFE_INTEGER;}],
  ['wrong scope',r=>{r.scope=canonicalize(['https://foreign.invalid',WALLET_SCOPE.chainIdentity,WALLET_SCOPE.transportBinding.bindingId]);}],
  ['wrong scope with recomputed plan ID',r=>{r.scope=canonicalize(['https://foreign.invalid',WALLET_SCOPE.chainIdentity,WALLET_SCOPE.transportBinding.bindingId]);r.planId=sha(canonicalize([r.scope,r.writer,r.logicalAddress]));}],
  ['wrong plan ID',r=>{r.planId='e'.repeat(64);} ],
  ['wrong authorization message',r=>{r.authorizationMessage='e'.repeat(64);} ],
  ['hashing the final handoff instead of the original plan',r=>{r.authorizationMessage=sha(JSON.stringify(r.payload.content));}],
  ['wrong evidence mode',r=>{r.evidenceMode='simulated-fixture';}],
])test(`denied plan rejects ${name}`,async t=>{
  const h=fixture(t);h.create({wallet:true});
  const j=h.durable('node2-transport.sqlite'),r=deniedPlan();
  await j.put(deniedKey(r),r);assert.equal(h.report().healthy,true);
  change(r);await j.put(deniedKey(r),r);
  assert.throws(()=>h.report(),/could not read valid state/);
});

test('health accepts a real adapter-produced denied plan',async t=>{
  const {admittedTransport,layoutAdmission,layoutChain,WALLET}=await import('./helpers/claude-node2-current-coverage-fixture.mjs');
  const {createDemosSr2Adapter,createInMemoryDemosSr2Journal}=await import('../src/dacs/demos-sr2-adapter.mjs');
  const run=admittedTransport(await layoutAdmission(),{...layoutChain(),getAddressNonce:{result:200,response:0},searchStoragePrograms:{result:200,response:[]}});
  t.after(()=>run.capability.close());
  const source=run.capability,journal=createInMemoryDemosSr2Journal(),writer=`did:demos:agent:${WALLET.slice(2)}`;
  const adapter=createDemosSr2Adapter({rpcUrl:source.pins.endpoint,journal,sourceCapability:source,now:()=>NOW});
  const plan=await adapter.planWrite({logicalAddress:fixedPriceAgreementLogicalAddress(WALLET_SCOPE.jobId),artifact:WALLET_SCOPE.agreement,writer,artifactKind:'Agreement'});
  await adapter.takeStorageAnchorHandoff({planId:plan.planId,walletAddress:WALLET,network:source.pins.network});
  await adapter.retireDeniedHandoff({logicalAddress:plan.logicalAddress,writer,walletAddress:WALLET,provesUnsigned:async()=>true});
  const record=journal.get(plan.planId);
  assert.equal(record.stage,'denied-unsigned');
  const h=fixture(t);h.create({wallet:true,scope:{buyer:WALLET,network:source.pins.network,chainIdentity:source.pins.chainIdentity,transportBinding:source.transportBinding}});
  const durable=h.durable('node2-transport.sqlite');
  await durable.put(deniedKey(record),record);
  assert.equal(h.report().healthy,true);assert.deepEqual(h.report().seller.unconfirmed,[]);
  for(const change of [r=>{r.authorizationMessage='e'.repeat(64);},r=>{r.nativeAddress=`stor-${'e'.repeat(40)}`;},r=>{r.payload.content.data[1].data={...r.artifact,signatures:[{TEST:'not retained'}]};}]){
    const altered=structuredClone(record);change(altered);await durable.put(deniedKey(altered),altered);
    assert.throws(()=>h.report(),/could not read valid state/);
  }
});

test('the source journal\'s failed native transfer and denied unsigned Agreement CREATE plan for a buyer here are not issued writes',async t=>{
  const h=fixture(t),operation=h.create({wallet:true}),j=h.durable('node2-transport.sqlite');
  h.create({wallet:true,scope:{buyer:PAYER}});
  for(const failure of [{blockNumber:9,nonceFence:2},{blockNumber:0,supersededByHash:'e'.repeat(64)}])for(const key of failedKeys(failedTransfer(failure)))await j.put(key,failedTransfer(failure));
  // A transfer at nonce 1 failed at nonce fence 0.
  const fenced=failedTransfer({blockNumber:2,nonceFence:0},{nonce:1});await j.put(failedKeys(fenced)[0],fenced);
  // A transfer at nonce 0 superseded by another.
  const first=failedTransfer({blockNumber:1,supersededByHash:'d'.repeat(64)},{nonce:0});await j.put(failedKeys(first)[0],first);
  const plan=deniedPlan();await j.put(deniedKey(plan),plan);
  // Read beside the buyer's later purchases with no source lane or no retained Agreement.
  h.create({at:NOW+1});h.create({wallet:true,retained:null,at:NOW+2});
  await j.put(handoffKey(operation),{...createHandoff(operation,'denied'),errorCode:'TEST_wallet_denied'});
  let r=h.report();assert.equal(r.healthy,true);assert.deepEqual(r.seller.unconfirmed,[]);
  const cli=h.cli(['--json']);assert.equal(cli.status,0,cli.stderr);
  // They hide nothing else in the journal: a pending seller write still alerts.
  await j.put('seller-transport',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:address}}});
  r=h.report();assert.equal(r.healthy,false);assert.deepEqual(r.seller.unconfirmed.map(row=>row.stage),['broadcast-started']);
});

const malformedAtRest=[
  ...[['failed',failedTransfer,(r)=>failedKeys(r)[0]],['failed, on its lane',failedTransfer,(r)=>failedKeys(r)[1]]].flatMap(([kind,make,key])=>[
    [`${kind}: an extra field`,key,()=>({...make(),receipt:{}})],
    [`${kind}: no failure`,key,()=>{const{failure,...r}=make();return r;}],
    [`${kind}: a failure with an extra field`,key,()=>make({blockNumber:9,nonceFence:2,TEST:1})],
    [`${kind}: a failure with both proofs`,key,()=>make({blockNumber:9,nonceFence:2,supersededByHash:'e'.repeat(64)})],
    [`${kind}: a failure with no block`,key,()=>make({nonceFence:2})],
    [`${kind}: a negative block`,key,()=>make({blockNumber:-1,nonceFence:2})],
    [`${kind}: a block that is not an integer`,key,()=>make({blockNumber:'9',nonceFence:2})],
    [`${kind}: a nonce fence that is not the nonce below`,key,()=>make({blockNumber:9,nonceFence:3})],
    [`${kind}: a nonce fence that is not an integer`,key,()=>make({blockNumber:9,nonceFence:'2'})],
    [`${kind}: superseded by itself`,key,(r)=>({...make(),failure:{blockNumber:9,supersededByHash:make().hash}})],
    [`${kind}: superseded by a hash that is not 64 hex`,key,()=>make({blockNumber:9,supersededByHash:'E'.repeat(64)})],
    [`${kind}: a hash that is not its signed transaction's`,key,()=>({...make(),signedTransaction:{...make().signedTransaction,hash:'e'.repeat(64)}})],
    [`${kind}: a hash that is not 64 hex`,key,()=>({...make(),hash:'E'.repeat(64)})],
    [`${kind}: a nonce that is not its transaction's`,key,()=>({...make(),nonce:4,failure:{blockNumber:9,nonceFence:3}})],
    [`${kind}: a negative nonce`,key,()=>{const r=make({blockNumber:9,supersededByHash:'e'.repeat(64)});r.nonce=r.signedTransaction.content.nonce=-1;return r;}],
    [`${kind}: a storage CREATE`,key,()=>{const r=make();r.signedTransaction.content.type='storageProgram';return r;}],
    [`${kind}: no signed transaction`,key,()=>{const{signedTransaction,...r}=make();return {...r,signedTransaction:null};}],
    [`${kind}: no network binding`,key,()=>({...make(),networkBinding:null})],
    [`${kind}: on another network`,key,()=>make(undefined,{network:'foreign-net'})],
    [`${kind}: on another chain`,key,()=>make(undefined,{chainIdentity:'e'.repeat(64)})],
    [`${kind}: of a wallet that is not a buyer here`,key,()=>make(undefined,{wallet:`0x${'c'.repeat(64)}`})],
    [`${kind}: of the seller`,key,()=>make(undefined,{wallet:address})],
    [`${kind}: of the buyer in upper case`,key,()=>make(undefined,{wallet:`0x${'B'.repeat(64)}`})],
  ]),
  ['failed: under another transfer\'s intent key',()=>`devnet/native-transfer/${'e'.repeat(64)}`,()=>failedTransfer()],
  ['failed: on another wallet\'s lane',()=>`devnet/native-wallet/${JSON.stringify([WALLET_SCOPE.network,WALLET_SCOPE.chainIdentity,`0x${'c'.repeat(64)}`])}`,()=>failedTransfer()],
  ['failed: on the lane of another network',()=>`devnet/native-wallet/${JSON.stringify(['foreign-net',WALLET_SCOPE.chainIdentity,BUYER_WALLET])}`,()=>failedTransfer()],
  ['failed: under a key of no transfer',()=>'devnet/native-transfer/TEST',()=>failedTransfer()],
  ['failed: a consistent hash that is not lowercase hex',(r)=>`devnet/native-transfer/${r.hash}`,()=>{const r=failedTransfer();r.hash=r.signedTransaction.hash='E'.repeat(64);return r;}],
  ['failed: a nonce as text',(r)=>failedKeys(r)[0],()=>{const r=failedTransfer({blockNumber:9,supersededByHash:'e'.repeat(64)});r.nonce=r.signedTransaction.content.nonce='3';return r;}],
  ['failed: no failure proof',(r)=>failedKeys(r)[0],()=>({...failedTransfer(),failure:null})],
  // readback refuses a negative nonce fence: nonce 0 can only fail by supersession.
  ['failed: a nonce fence below zero',(r)=>failedKeys(r)[0],()=>{const r=failedTransfer({blockNumber:9,nonceFence:-1});r.nonce=r.signedTransaction.content.nonce=0;return r;}],
  ['denied-unsigned: under another plan\'s key',()=>`sr2/adapter/${'e'.repeat(64)}`,()=>deniedPlan()],
  ...[
    ['an extra field',r=>{r.TEST=1;}],
    ['an adopted wallet authorization',r=>{r.authorizedTransaction={hash:'e'.repeat(64)};}],
    ['a transaction hash',r=>{r.transactionHash='e'.repeat(64);}],
    ['no retirement',r=>{delete r.retirement;}],
    ['another retirement reason',r=>{r.retirement.reason='TEST';}],
    ['a retirement with an extra field',r=>{r.retirement.TEST=1;}],
    ['a nonce that is not the one after the account\'s',r=>{r.retirement.observedAccountNonce=1;}],
    ['an account nonce that is not an integer',r=>{r.retirement.observedAccountNonce='0';}],
    ['an account nonce that is not a whole number',r=>{r.retirement.observedAccountNonce=0.5;r.nonce=1.5;}],
    ['a negative account nonce',r=>{r.retirement.observedAccountNonce=-1;r.nonce=0;}],
    ['another authorization profile',r=>{r.authorizationProfile='TEST';}],
    ['another artifact kind',r=>{r.artifactKind='Deliverable';}],
    ['a writer that is not its owner',r=>{r.writer=`did:demos:agent:${'c'.repeat(64)}`;}],
    ['a plan id that is not 64 hex',r=>{r.planId='TEST';}],
    ['no CREATE payload',r=>{r.payload=null;}],
    ['another Agreement hash',r=>{r.hash='e'.repeat(64);}],
    ['the Agreement address of another job',r=>{r.logicalAddress=fixedPriceAgreementLogicalAddress('01ARZ3NDEKTSV4RRFFQ69G5FAW');}],
  ].map(([name,change])=>[`denied-unsigned: ${name}`,deniedKey,()=>{const r=deniedPlan();change(r);return r;}]),
  ...[
    ['of a wallet that is not a buyer here',{wallet:`0x${'c'.repeat(64)}`}],
    ['of the seller',{wallet:address}],
    ['for another job',{jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAW'}],
    ['on another network',{network:'foreign-net'}],
    ['on another chain',{chainIdentity:'e'.repeat(64)}],
    ['for an Agreement the purchase did not retain',{agreement:{...WALLET_SCOPE.agreement,TEST:'another Agreement'}}],
    ['for the planned Agreement with signatures the purchase did not retain',{agreement:{...WALLET_SCOPE.agreement,signatures:[{TEST:'not retained'}]}}],
  ].map(([name,scope])=>[`denied-unsigned: a consistent plan ${name}`,(r)=>deniedKey(r),()=>deniedPlan(scope)]),
];
test('a malformed failed native transfer or denied unsigned Agreement CREATE plan, one for anything that is not a buyer\'s purchase here, or either in a seller journal still fails closed',async t=>{
  for(const [name,key,make] of malformedAtRest){
    const h=fixture(t);h.create({wallet:true});h.create({wallet:true,scope:{buyer:PAYER}});const value=make();
    await h.durable('node2-transport.sqlite').put(key(value),value);
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  // A purchase that retained no Agreement, or none on the source transport, binds no denied plan; nothing binds a failed transfer without a purchase there.
  for(const [name,create,key,value] of [['no retained Agreement',{wallet:true,retained:null},deniedKey,deniedPlan()],['no source transport',{protocol:true},deniedKey,deniedPlan()],
    ['a failed transfer with no source transport purchase',{protocol:true},(r)=>failedKeys(r)[0],failedTransfer()]]){
    const h=fixture(t);h.create(create);
    await h.durable('node2-transport.sqlite').put(key(value),value);
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  for(const journal of ['seller-artifacts.sqlite','seller-wallet.sqlite'])for(const [key,value] of [[failedKeys(failedTransfer())[0],failedTransfer()],[deniedKey(deniedPlan()),deniedPlan()]]){
    const h=fixture(t);h.create({wallet:true});
    await h.durable(journal).put(key,value);
    assert.throws(()=>h.report(),/could not read valid state/,`${value.stage} in ${journal}`);
  }
  const h=fixture(t);h.create({wallet:true});await h.durable('node2-transport.sqlite').put(failedKeys(failedTransfer())[0],{...failedTransfer(),receipt:{}});
  assert.equal(h.cli(['--json']).status,2);
});

test('coverage: health\'s handoff request kind and profile are the producer\'s',async()=>{
  const {DEVNET_AGREEMENT_KIND,DEVNET_AGREEMENT_PROFILE}=await import('../src/wallet/devnet-native-transport.mjs');
  assert.deepEqual(health.BROWSER_HANDOFF_REQUEST,{kind:DEVNET_AGREEMENT_KIND,profile:DEVNET_AGREEMENT_PROFILE});
});

// DACS_BUYER_CHAIN_READBACK=on: a final purchase held for the operator
// (chainReadbackHeld) stays operator-action-required, as its stuck entry says,
// when its last attempt was refused locally before dispatch; JSON and text
// still show that attempt as not sent. Without the hold it is not-sent.
for(const held of [true,false])test(`not-sent last attempt on a final purchase (${held?'held for the operator':'not held'})`,t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'settled_verified',stage:'delivered'});
  const attempts=[{step:'bundle-request',outcome:'unavailable',causeCode:'tls',dispatched:false}];
  const hold=held?{chainReadbackHeld:{action:'chain-readback-pointers-missing',since:new Date(NOW).toISOString(),missing:['payment-evidence'],reason:'the seller session key is retired'}}:{};
  for(const attempt of attempts)h.ops.record(p.id,'protocol_bundle-request',{...attempt,stage:'delivered'});
  h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'delivered',attempts,...hold}},event:'protocol_step',data:{stage:'delivered'}});
  const report=h.report(),row=report.purchases[0],outcome=held?'operator-action-required':'not-sent';
  assert.equal(row.outcome,outcome);assert.equal(row.lastAttemptDispatched,false);assert.equal(row.causeCode,'tls');assert.deepEqual(row.unresolvedWrites,[]);
  assert.match(formatOpsHealth(report),new RegExp(`outcome=${outcome} cause=tls last-attempt=not-sent`));
  assert.deepEqual(report.stuck.map(({outcome,thresholdMs,nextExpected})=>({outcome,thresholdMs,nextExpected})),
    held?[{outcome:'operator-action-required',thresholdMs:0,nextExpected:'chain readback pointers missing: the seller can no longer be asked for its signed CREATEs; operator action required; never resend'}]:[]);
});

// Sweep fixes. Each durable journal's meta and accounting, as
// openDurableWalletJournal writes and checks them, is checked on its own: a
// journal of another format, version or identity, or whose record count, byte
// total, next sequence or row byte count disagrees with its rows, exits 2.
// Every damage keeps the other checks consistent (row digests are recomputed
// where they cover the changed field).
test('sweep: a durable journal of another format, version or identity, or whose counts, sequence or row bytes disagree, fails closed, each on its own',async t=>{
  const meta=(db)=>Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map(row=>[row.key,row.value]));
  const redigest=(db)=>{const m=meta(db);for(const row of db.prepare('SELECT key,value FROM records').all())db.prepare('UPDATE records SET digest=? WHERE key=?').run(sha(`${m.format}\n${m.journal_id}\n${row.key}\n${row.value}`),row.key);};
  const set=(key,value)=>(db)=>{if(value===undefined)db.prepare('DELETE FROM meta WHERE key=?').run(key);else db.prepare('UPDATE meta SET value=? WHERE key=?').run(typeof value==='function'?value(meta(db)[key]):value,key);};
  const identity=(change)=>(db)=>{set('journal_id',change)(db);redigest(db);};
  const cases=[
    ['another format',(db)=>{set('format','TEST-other-journal')(db);redigest(db);}],
    ['another version',set('version',String(DURABLE_WALLET_JOURNAL_VERSION+1))],
    ['no version',set('version',undefined)],
    ['no journal id',identity(undefined)],
    ['a journal id in upper case',identity((id)=>`A${id.slice(1).toUpperCase()}`)],
    ['a journal id one hex short',identity((id)=>id.slice(1))],
    ['a journal id one hex long',identity((id)=>`${id}a`)],
    ['a journal id with a prefix',identity((id)=>`x${id}`)],
    ['a journal id with a suffix',identity((id)=>`${id}x`)],
    ['a record count one short',set('records',(n)=>String(Number(n)-1))],
    ['a record count one over',set('records',(n)=>String(Number(n)+1))],
    ['a byte total one over',set('total_bytes',(n)=>String(Number(n)+1))],
    ['a next sequence at the last row',set('next_seq',(n)=>String(Number(n)-1))],
    ['a row whose byte count is not its value\'s',(db)=>{db.prepare("UPDATE records SET bytes=bytes+1 WHERE key='TEST-b'").run();set('total_bytes',(n)=>String(Number(n)+1))(db);}],
  ];
  const journal=async(h)=>{const j=h.durable('seller-wallet.sqlite');await j.put('TEST-a',{stage:'verified'});await j.put('TEST-b',{stage:'denied'});return new DatabaseSync(join(h.root,'seller-wallet.sqlite'));};
  const control=fixture(t),db=await journal(control);
  try{assert.equal(control.report().healthy,true);assert.equal(meta(db).next_seq,'3');}finally{db.close();}
  for(const [name,damage] of cases){
    const h=fixture(t),db=await journal(h);
    try{damage(db);}finally{db.close();}
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
  // An empty journal's next sequence is at least 1.
  const empty=fixture(t);empty.durable('seller-wallet.sqlite');const edb=new DatabaseSync(join(empty.root,'seller-wallet.sqlite'));
  try{assert.equal(empty.report().healthy,true);set('next_seq','0')(edb);}finally{edb.close();}
  assert.throws(()=>empty.report(),/could not read valid state/,'an empty journal whose next sequence is 0');
});

// Health's copies of its producers' constants: the per-payer record formats,
// the refusals kept per lane and every gate refuseCancelled is called with
// (devnet-native-transport.mjs), and every stage the broker writes to a
// handoff record (devnet-agreement-transport-broker.mjs exactPut(recordKey…)
// and its completion).
test('sweep: health\'s payer record formats, refusal cap and gates, and handoff stages are its producers\'',async()=>{
  const transport=await import('../src/wallet/devnet-native-transport.mjs');
  assert.deepEqual(health.PAYER_RECORD_FORMATS,transport.NATIVE_PAYER_RECORD_FORMATS);
  assert.equal(health.REFUSALS_KEPT,transport.REFUSALS_KEPT);
  assert.deepEqual(Object.fromEntries(Object.values(PAYER_RECORDS).map(record=>Object.entries(record)[0])),health.PAYER_RECORD_FORMATS,'the fixture records carry them');
  const source=readFileSync(resolve('src/wallet/devnet-native-transport.mjs'),'utf8');
  const gates=[...source.matchAll(/\brefuseCancelled\([^()]*?,\s*'([A-Za-z-]+)'\s*\)/g)].map(m=>m[1]);
  assert.equal(gates.length,source.match(/\brefuseCancelled\(/g).length,'every refuseCancelled call names a literal gate');
  assert.deepEqual([...new Set(gates)].sort(),[...health.REFUSAL_GATES].sort());
  const broker=readFileSync(resolve('src/portal/devnet-agreement-transport-broker.mjs'),'utf8');
  const stages=[...broker.matchAll(/\bexactPut\(recordKey\([^)]*\),\s*\{[^}]*?\bstage: '([a-z-]+)'/g),...broker.matchAll(/\bstage = (?:matching \? )?'([a-z-]+)'(?: : '([a-z-]+)')?;/g)].flatMap(m=>m.slice(1).filter(Boolean));
  assert.equal(broker.match(/\bexactPut\(recordKey\(/g).length,4,'the request, its claim (expired or issued) and its completion');
  assert.deepEqual([...new Set(stages)].sort(),Object.keys(health.BROWSER_HANDOFF_STAGES).sort());
});

// The lane and binding parts a buyer record names must equal its purchase's,
// and must also be in their producer's formats: a record consistent with a
// purchase whose database holds a malformed network, chain identity, wallet,
// job, terms hash or account still exits 2. A binding's account is non-empty
// and at most 128 characters. (Its NUL check cannot decide: SQLite text read
// back stops at a NUL, so no purchase's account holds one.)
test('sweep: a buyer record consistent with a purchase holding a malformed network, chain identity, wallet, job, terms hash or account still fails closed',async t=>{
  const networks=['Demos Devnet','-demos-devnet','demos devnet'],wallets=[`0x${'B'.repeat(64)}`,`0x${'b'.repeat(63)}`,`x0x${'b'.repeat(64)}`,`0x${'b'.repeat(65)}`];
  const lanes=[...networks.map(network=>({network})),...[`${'D'.repeat(64)}`,'d'.repeat(63),`x${'d'.repeat(64)}`,`${'d'.repeat(64)}x`].map(chainIdentity=>({chainIdentity})),...wallets.map(buyer=>({buyer}))];
  for(const scope of lanes)for(const kind of Object.keys(PAYER_RECORDS)){
    const h=fixture(t),operation=h.create({wallet:true,scope});
    await h.durable('node2-transport.sqlite').put(payerKey(kind,[scope.network??WALLET_SCOPE.network,scope.chainIdentity??WALLET_SCOPE.chainIdentity,scope.buyer??BUYER_WALLET]),forPurchase(PAYER_RECORDS[kind],operation));
    assert.throws(()=>h.report(),/could not read valid state/,`${kind}: ${JSON.stringify(scope)}`);
  }
  const bindings=[...networks.map(network=>[{network},{network}]),...wallets.slice(0,1).map(buyer=>[{buyer},{wallet:buyer}]),[{jobId:'TEST-job'},{jobId:'TEST-job'}],[{termsHash:'C'.repeat(64)},{termsHash:'C'.repeat(64)}],
    ...['','x'.repeat(129)].map(account=>[{account},{}])];
  for(const [scope,record] of bindings){
    const h=fixture(t),operation=h.create({wallet:true,scope});
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),createHandoff(operation,'completed',record));
    assert.throws(()=>h.report(),/could not read valid state/,JSON.stringify(scope));
  }
  // The buyer's at-rest records name the purchase's wallet in its producer's format too.
  for(const [name,record] of [['a failed transfer',()=>failedTransfer(undefined,{wallet:wallets[0]})],['a denied plan',()=>deniedPlan({wallet:wallets[0]})]]){
    const h=fixture(t);h.create({wallet:true,scope:{buyer:wallets[0]}});const value=record();
    await h.durable('node2-transport.sqlite').put(value.stage==='failed'?failedKeys(value)[0]:deniedKey(value),value);
    assert.throws(()=>h.report(),/could not read valid state/,`${name} of a wallet in upper case`);
  }
  // The account bounds themselves.
  for(const account of ['x','x'.repeat(128)]){
    const h=fixture(t),operation=h.create({wallet:true,scope:{account}});
    await h.durable('node2-transport.sqlite').put(handoffKey(operation),createHandoff(operation));
    assert.equal(h.report().healthy,true,`an account of ${account.length}`);
  }
});

// A protocol purchase in an unknown or handed-off payment status takes that
// status as its stage, whatever its protocol stage, with that status's
// threshold and advice: an uncertain payment (and the unknown stage) always
// needs the original write's readback.
test('sweep: a payment status or the unknown stage is the stage, and an uncertain payment or unknown stage needs readback',t=>{
  const advice={approved:'one-time wallet handoff',payment_handoff:'original payment readback; never resend',broadcast_reported:'original payment readback; never resend'};
  for(const status of ['approved','payment_handoff','broadcast_reported','payment_uncertain']){
    const h=fixture(t);h.create({protocol:true,status,stage:'seller-committed',at:NOW-STAGE_THRESHOLDS[status]-1000});
    const r=h.report(),unknown=status==='payment_uncertain';
    assert.deepEqual([r.purchases[0].stage,r.purchases[0].outcome],[status,unknown?'unknown-readback-required':'recorded'],status);
    assert.deepEqual(r.stuck.map(s=>[s.stage,s.thresholdMs,s.outcome,s.nextExpected]),[[status,STAGE_THRESHOLDS[status],unknown?'unknown-readback-required':'waiting',unknown?READBACK:advice[status]]],status);
  }
  for(const create of [{status:'unknown'},{protocol:true,status:'agreement_pending',stage:'unknown'}]){
    const h=fixture(t);h.create({...create,at:NOW-STAGE_THRESHOLDS.unknown-1000});
    const r=h.report();
    assert.deepEqual([r.purchases[0].stage,r.purchases[0].outcome],['unknown','unknown-readback-required'],JSON.stringify(create));
    assert.deepEqual(r.stuck.map(s=>[s.stage,s.thresholdMs,s.outcome,s.nextExpected]),[['unknown',STAGE_THRESHOLDS.unknown,'unknown-readback-required',READBACK]]);
  }
});

// A readback that lost to newer progress (logged with no stage) is not saved
// progress: it settles no write of its step, not even one lost after it.
test('sweep: a lost readback settles no lost write of its step logged after it',t=>{
  const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'agreement-signing',at:NOW-60000});
  h.ops.record(p.id,'protocol_commitment',{outcome:'verified'});
  h.ops.record(p.id,'protocol_commit-request',{outcome:'unavailable',reason:UNAVAILABLE});
  const r=h.report();
  assert.deepEqual(r.purchases[0].unresolvedWrites,['commit-request']);assert.deepEqual(stuckOf(r,p),[['agreement-signing',0,'unknown-readback-required',READBACK,['commit-request']]]);
});

// The stored last-ten attempts can only add to the event log: a possible Vet
// write or an unresolved read that only they hold still shows. The last
// attempt (outcome, dispatch and cause) is the log's when the log has one,
// else the stored tail's.
test('sweep: the stored attempts add a possible Vet write or an unresolved read; the last attempt is the log\'s, else the stored one',t=>{
  const stored=(h,attempts,events=[])=>{
    const p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    for(const [step,data] of events)h.ops.record(p.id,`protocol_${step}`,{stage:'identity',...data});
    h.ops.transition(p.id,p.status,p.status,{state:{protocol:{stage:'identity',attempts}},event:'protocol_step',data:{stage:'identity'}});
    return h.report({operatorState:null}).purchases[0];
  };
  let h=fixture(t);
  assert.equal(stored(h,[attempt('agreement-context','absent')]).outcome,'seller-journal-not-read','a provider call only the stored attempts hold');
  h=fixture(t);
  assert.equal(stored(h,[attempt('seller-confirmation','unknown')]).outcome,'unresolved-read','an unknown read only the stored attempts hold');
  h=fixture(t);
  let row=stored(h,[attempt('bundle-request','unavailable',null,{dispatched:false,causeCode:'tls'})]);
  assert.deepEqual([row.outcome,row.lastAttemptDispatched,row.causeCode],['not-sent',false,'tls'],'a refusal before dispatch only the stored attempts hold');
  // The log's last attempt was sent (or says nothing), the stored one was not: the log decides.
  for(const dispatched of [undefined,true]){
    h=fixture(t);
    row=stored(h,[attempt('seller-confirmation','unknown',null,{dispatched:false,causeCode:'tls'})],[['seller-confirmation',{outcome:'unknown',...(dispatched===undefined?{}:{dispatched})}]]);
    assert.deepEqual([row.outcome,Object.hasOwn(row,'lastAttemptDispatched'),Object.hasOwn(row,'causeCode')],['unresolved-read',false,false],String(dispatched));
  }
  h=fixture(t);
  row=stored(h,[attempt('seller-confirmation','unknown')],[['bundle-request',{outcome:'unavailable',dispatched:false,causeCode:'tls'}]]);
  assert.deepEqual([row.outcome,row.lastAttemptDispatched,row.causeCode],['not-sent',false,'tls'],'the log\'s refusal');
});

// Each pending stage of a seller write is listed, with its hash or
// transactionHash (null when it has neither), until its own readback; only a
// wallet lane clears at broadcast-accepted (sr2/wallet/ in the wallet journal,
// demo/wallet/ in the artifact journal). Recognized settled stages are not
// listed. A seller is known from purchase terms or by any owner field its own
// journals carry. An unknown stage, or a malformed hash, exits 2.
test('sweep: every pending seller write is listed until its readback, a lane clears at broadcast-accepted only in its own journal, and an unknown stage fails closed',async t=>{
  const PENDING_STAGES=['intent','issued','unknown','broadcast-started','broadcast-accepted','broadcast-answered','sr2-readback-pending','handoff-issued','authorization-issued'];
  const h=fixture(t),artifacts=h.durable('seller-artifacts.sqlite'),wallet=h.durable('seller-wallet.sqlite'),transport=h.durable('node2-transport.sqlite');
  h.create();
  const hash='e'.repeat(64),content={from:address};
  for(const stage of PENDING_STAGES)await artifacts.put(`demo/artifact/${stage}`,{stage,hash,transaction:{content}});
  for(const stage of ['prepared','verified','denied','observed'])await artifacts.put(`demo/artifact/${stage}`,{stage,transaction:{content}});
  // broadcast-accepted after readback clears only a wallet lane, in its own journal.
  await wallet.put('sr2/wallet/lane',{stage:'broadcast-accepted',hash,signedTransaction:{content}});
  await artifacts.put('demo/wallet/lane',{stage:'broadcast-accepted',hash,signedTransaction:{content}});
  for(const [journal,key] of [[wallet,'demo/wallet/lane'],[wallet,'sr2/other/lane'],[artifacts,'sr2/wallet/lane'],[artifacts,'demo/other/lane'],[transport,'sr2/wallet/lane']])await journal.put(key,{stage:'broadcast-accepted',hash,signedTransaction:{content}});
  // The transaction's hash only, or none.
  await transport.put('TEST-transaction-hash',{stage:'issued',transactionHash:'d'.repeat(64),signedTransaction:{content}});
  await transport.put('TEST-no-hash',{stage:'intent',signedTransaction:{content}});
  // A seller known by the owner field each journal shape carries.
  await transport.put('TEST-transaction',{stage:'issued',hash,transaction:{content}});
  await transport.put('TEST-owner',{stage:'issued',hash,owner:address});
  await transport.put('TEST-payload',{stage:'issued',hash,payload:{content}});
  const r=h.report(),listed=(source)=>r.seller.unconfirmed.filter(row=>row.source===source);
  assert.equal(r.healthy,false);
  assert.deepEqual(listed('seller-artifacts.sqlite').map(row=>row.stage),[...PENDING_STAGES,'broadcast-accepted','broadcast-accepted']);
  assert.deepEqual(listed('seller-artifacts.sqlite').map(row=>row.recordId).slice(-2),['sr2/wallet/lane','demo/other/lane'].map(sha));
  assert.deepEqual(listed('seller-wallet.sqlite').map(row=>[row.recordId,row.stage]),[[sha('demo/wallet/lane'),'broadcast-accepted'],[sha('sr2/other/lane'),'broadcast-accepted']]);
  assert.deepEqual(listed('node2-transport.sqlite').map(row=>[row.recordId,row.hash,row.stage]),[
    [sha('sr2/wallet/lane'),hash,'broadcast-accepted'],[sha('TEST-transaction-hash'),'d'.repeat(64),'issued'],[sha('TEST-no-hash'),null,'intent'],
    [sha('TEST-transaction'),hash,'issued'],[sha('TEST-owner'),hash,'issued'],[sha('TEST-payload'),hash,'issued']]);
  assert.ok(r.seller.unconfirmed.every(row=>row.nextExpected===READBACK));
  assert.equal(JSON.parse(h.cli(['--json']).stdout).seller.unconfirmed.find(row=>row.recordId===sha('TEST-no-hash')).hash,null);
  // A seller known only by its own journal's owner field.
  const other=`0x${'9'.repeat(64)}`;
  await wallet.put('TEST-other-seller',{stage:'verified',owner:other});
  await transport.put('TEST-other-seller',{stage:'issued',hash,owner:other});
  assert.ok(h.report().seller.unconfirmed.some(row=>row.recordId===sha('TEST-other-seller')&&row.source==='node2-transport.sqlite'));
  // An unknown stage, by a buyer or by nobody, and a malformed hash fail closed.
  for(const [name,value] of [['a buyer\'s record at an unknown stage',{stage:'TEST-stage',signedTransaction:{content:{from:`0x${'b'.repeat(64)}`}}}],['a record with no owner at an unknown stage',{stage:'TEST-stage'}],
    ['a record with no stage',{hash}],['a seller write with a hash that is not 64 hex',{stage:'issued',hash:'E'.repeat(64),signedTransaction:{content}}],
    ['a seller write with a character before its hash',{stage:'issued',hash:`x${hash}`,signedTransaction:{content}}],['a seller write with a character after its hash',{stage:'issued',hash:`${hash}x`,signedTransaction:{content}}],['a seller write with a transaction hash that is not 64 hex',{stage:'issued',transactionHash:'e'.repeat(63),signedTransaction:{content}}]]){
    const f=fixture(t);f.create();await f.durable('node2-transport.sqlite').put('TEST',value);
    assert.throws(()=>f.report(),/could not read valid state/,name);
  }
});

// Every terminal purchase status and protocol stage is terminal: an old
// purchase in one is listed at that stage and never stuck.
test('sweep: every terminal status or stage is terminal, so an old purchase in it is never stuck',t=>{
  for(const status of ['payment_failed','payment_mismatch','expired','terms_changed','cancelled','superseded','agreement_rejected','listing_withdrawn']){
    const h=fixture(t);h.create({status,at:NOW-90000000});
    const r=h.report({recentHours:48});assert.deepEqual([r.purchases[0].stage,r.stuck],[status,[]],status);
  }
  for(const stage of ['completed','agreement-rejected','claim-rejected','evidence-rejected','delivery-rejected','bundle-rejected']){
    const h=fixture(t);h.create({protocol:true,status:'settled_verified',stage,at:NOW-90000000});
    const r=h.report({recentHours:48});assert.deepEqual([r.purchases[0].stage,r.stuck],[stage,[]],stage);
  }
});

// A purchase database health cannot read as protocol-purchases.mjs and the
// operation store write it fails closed: a malformed purchase id, protocol
// terms with no protocol stage or an unknown one, no events, a malformed
// operator hold, a not-saved check of an event that is not a protocol event,
// or a stored attempt whose step or outcome is not text.
test('sweep: a purchase database health cannot read as its producers write it fails closed',t=>{
  const state=(h,p,value)=>h.db.prepare('UPDATE operations SET state=? WHERE id=?').run(JSON.stringify(value),p.id);
  const rename=(h,p,id)=>{h.db.exec('PRAGMA foreign_keys=OFF');h.db.prepare('UPDATE operations SET id=? WHERE id=?').run(id,p.id);h.db.prepare('UPDATE operation_events SET operation_id=? WHERE operation_id=?').run(id,p.id);h.db.exec('PRAGMA foreign_keys=ON');};
  const cases=[
    ['a purchase id with a character before it',(h,p)=>rename(h,p,`x${p.id}`)],
    ['a purchase id with a character after it',(h,p)=>rename(h,p,`${p.id}x`)],
    ['a purchase id one character short',(h,p)=>rename(h,p,p.id.slice(0,-1))],
    ['protocol terms with no protocol stage',(h,p)=>state(h,p,{})],
    ['an unknown protocol stage',(h,p)=>state(h,p,{protocol:{stage:'TEST-stage'}})],
    ['no events',(h,p)=>h.db.prepare('DELETE FROM operation_events WHERE operation_id=?').run(p.id)],
    ...[null,'TEST',{action:'TEST'},[]].map(held=>[`an operator hold ${JSON.stringify(held)}`,(h,p)=>state(h,p,{protocol:{stage:'identity',chainReadbackHeld:held}})]),
    ['a not-saved check of an event that is not a protocol event',(h,p)=>h.ops.record(p.id,'protocol_check_not_saved',{event:'protocolXcommit-request',outcome:'unavailable',stage:'identity'})],
    ['a stored attempt whose step is a list',(h,p)=>state(h,p,{protocol:{stage:'identity',attempts:[{step:['claim'],outcome:'unavailable'}]}})],
    ['a stored attempt whose outcome is a list',(h,p)=>state(h,p,{protocol:{stage:'identity',attempts:[{step:'commitment',outcome:['verified']}]}})],
  ];
  for(const [name,damage] of cases){
    const h=fixture(t),p=h.create({protocol:true,status:'agreement_pending',stage:'identity'});
    assert.equal(h.report().healthy,true,`control for ${name}`);damage(h,p);
    assert.throws(()=>h.report(),/could not read valid state/,name);
  }
});

// The timeline holds each lane's own stage entries (a repeated status is one
// entry; a plain purchase has no protocol lane; only stage-change log steps
// join it); a stage's age is from its own lane's last entry, or updated_at
// when it has none; an event that is not a protocol attempt is no attempt.
test('sweep: the timeline holds each lane\'s own entries, and a stage\'s age is from its own entry',t=>{
  let h=fixture(t);const p=h.create({at:NOW-900000});
  h.clock.now=NOW-600000;h.ops.transition(p.id,'awaiting_approval','approved');
  h.clock.now=NOW-300000;h.ops.transition(p.id,'approved','approved',{event:'payment_readback_pending',data:{}});
  h.clock.now=NOW-200000;h.ops.record(p.id,'approved',{});h.ops.record(p.id,'payment_note',{outcome:'TEST-not-an-attempt'});
  const log=join(h.root,'server.log');
  writeFileSync(log,JSON.stringify({event:'purchase_timeline',purchaseId:p.id,steps:[{step:'stage-change',timestampMs:NOW-600000,stage:'approved'},{step:'wallet-handoff',timestampMs:NOW-100000}]}));
  let r=h.report({logPath:log});
  assert.deepEqual(r.purchases[0].timeline.map(e=>[e.lane,e.stage,e.gapMs]),[['purchase','awaiting_approval',0],['purchase','approved',300000],['log','approved',0]]);
  assert.deepEqual(r.stuck.map(s=>[s.stage,s.ageMs]),[['approved',600000]]);
  // A payment status's age is from its purchase-lane entry, not a protocol entry of the same name.
  h=fixture(t);const q=h.create({protocol:true,status:'payment_uncertain',stage:'seller-committed',at:NOW-600000});
  h.clock.now=NOW-60000;h.ops.transition(q.id,q.status,q.status,{event:'protocol_step',data:{stage:'payment_uncertain'}});
  assert.deepEqual(h.report().stuck.map(s=>[s.stage,s.ageMs]),[['payment_uncertain',600000]]);
  // A logically expired purchase has no expiry entry: its age is from updated_at.
  h=fixture(t);const e=h.create({at:NOW-7200000});
  h.clock.now=NOW-5000000;h.ops.transition(e.id,'awaiting_approval','awaiting_approval',{event:'payment_readback_pending',data:{}});
  r=h.report({recentHours:48});assert.deepEqual([r.purchases[0].stage,r.purchases[0].ageMs],['expired',5000000]);
  // A settled purchase at another protocol stage than committed: its age is from that stage's entry, not a later poll.
  h=fixture(t);const c=h.create({protocol:true,status:'settled_verified',stage:'identity',at:NOW-900000});
  h.clock.now=NOW-600000;h.ops.transition(c.id,c.status,c.status,{state:{protocol:{stage:'completed'}},event:'protocol_step',data:{stage:'completed'}});
  h.clock.now=NOW-300000;h.ops.transition(c.id,c.status,c.status,{event:'payment_readback_pending',data:{}});
  r=h.report();assert.deepEqual([r.purchases[0].stage,r.purchases[0].ageMs],['completed',600000]);
  // A fresh purchase with an unresolved write is stuck at once, at age 0.
  h=fixture(t);const w=h.create({protocol:true,status:'agreement_pending',stage:'identity',at:NOW});noted(h,w,'claim','unavailable');
  assert.deepEqual(h.report().stuck.map(s=>[s.ageMs,s.thresholdMs,s.outcome]),[[0,0,'unknown-readback-required']]);
});

test('sweep: the recent window includes a purchase updated exactly at its edge',t=>{
  const h=fixture(t),p=h.create({at:NOW-3600000});
  assert.deepEqual(h.report({recentHours:1}).purchases.map(r=>r.purchaseId),[p.id]);
  assert.deepEqual(h.report({recentHours:1,now:NOW+1}).purchases,[]);
});

test('sweep: health\'s own options are checked, and the report says where its limits came from',t=>{
  const h=fixture(t);h.create();
  for(const options of [{now:-1},{now:1.5},{now:Number.MAX_SAFE_INTEGER+2},{limit:0},{limit:10001},{limit:1.5},{recentHours:0},{recentHours:-1},{recentHours:Infinity},{recentHours:NaN},
    {thresholds:{TEST:60000}},{thresholds:{completed:60000}},{thresholds:{identity:0}},{thresholds:{identity:1.5}},{thresholds:{identity:'60000'}}])
    assert.throws(()=>h.report(options),/could not read valid state/,JSON.stringify(options));
  for(const options of [{now:0},{limit:1},{limit:10000},{recentHours:0.5},{thresholds:{identity:1}}])assert.doesNotThrow(()=>h.report(options),JSON.stringify(options));
  const r=h.report({operatorState:null});assert.deepEqual(Object.keys(r.seller).sort(),['journals','unconfirmed']);
});

test('sweep: the text report says healthy or stuck, and shows only the purchase, journal and readback facts there are',async t=>{
  const h=fixture(t);
  let text=formatOpsHealth(h.report({operatorState:null}));
  assert.match(text,/^HEALTHY /);assert.match(text,/^recent purchases: none$/m);assert.match(text,/^seller journals: not selected$/m);assert.doesNotMatch(text,/seller unconfirmed writes/);
  text=formatOpsHealth(h.report());assert.match(text,/^seller journals: absent$/m);assert.doesNotMatch(text,/seller unconfirmed writes/);
  const p=h.create(),j=h.durable('seller-wallet.sqlite');await j.put('TEST',{stage:'verified'});
  text=formatOpsHealth(h.report());
  assert.match(text,/^HEALTHY /);assert.doesNotMatch(text,/recent purchases: none/);
  assert.match(text,new RegExp(`^purchase ${p.id} stage=awaiting_approval ageMs=0 outcome=recorded$`,'m'));
  assert.match(text,/^seller journals: seller-wallet\.sqlite$/m);assert.match(text,/^seller unconfirmed writes: none$/m);
  await j.put('TEST-pending',{stage:'issued',signedTransaction:{content:{from:address}}});
  text=formatOpsHealth(h.report());
  assert.match(text,/^STUCK /);assert.match(text,/^seller readback source=seller-wallet\.sqlite record=[0-9a-f]{64} hash=unknown stage=issued next=original write readback; never resend$/m);
  assert.doesNotMatch(text,/seller unconfirmed writes: none/);
});

// Owners and buyers are known only in the 0x lowercase 64-hex form: a seller
// journal's malformed owner field, or a purchase's malformed buyer wallet,
// makes no pending transport write attributable.
test('sweep: only owners and buyers in the 0x lowercase 64-hex form are known',async t=>{
  for(const wallet of [`0x${'A'.repeat(64)}`,`x0x${'a'.repeat(64)}`,`0x${'a'.repeat(64)}0`,`0x${'a'.repeat(63)}`]){
    let h=fixture(t);h.create();await h.durable('seller-wallet.sqlite').put('TEST',{stage:'verified',owner:wallet});
    await h.durable('node2-transport.sqlite').put('TEST',{stage:'issued',hash:'e'.repeat(64),owner:wallet});
    assert.throws(()=>h.report(),/could not read valid state/,`seller ${wallet}`);
    h=fixture(t);h.create({scope:{buyer:wallet}});
    await h.durable('node2-transport.sqlite').put('TEST',{stage:'broadcast-started',hash:'e'.repeat(64),signedTransaction:{content:{from:wallet}}});
    assert.throws(()=>h.report(),/could not read valid state/,`buyer ${wallet}`);
  }
});

// The stale scratch sweep removes only a directory with this CLI's exact name
// and owner marker, private (0700, files 0600, owner.json a file), whose
// process is gone; anything else is kept and nothing fails.
test('sweep: the stale scratch sweep removes only an exactly named, private, owned and dead CLI scratch',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL');
  const stale=readdirSync(root)[0],owner=JSON.parse(readFileSync(join(root,stale,'owner.json'),'utf8')),prefix=`dacs-ops-health-${owner.pid}-`,keep=[];
  const decoy=(name,{marker={},markerMode=0o600,dirMode=0o700,markerDir=false}={})=>{
    const directory=join(root,name);mkdirSync(directory,{mode:0o700});
    if(markerDir)mkdirSync(join(directory,'owner.json'));else writeFileSync(join(directory,'owner.json'),JSON.stringify({...owner,directory:name,...marker}),{mode:0o600});
    fs.chmodSync(join(directory,'owner.json'),markerMode);fs.chmodSync(directory,dirMode);keep.push(name);
  };
  decoy(`x${stale}`);decoy(`${stale}x`);decoy(`${prefix}ABCDE`);decoy('TEST-not-scratch');
  decoy(`${prefix}OTHER1`,{marker:{directory:`${prefix}OTHER2`}});
  decoy(`${prefix}MODE01`,{markerMode:0o601});decoy(`${prefix}MODE02`,{dirMode:0o701});decoy(`${prefix}MARKDR`,{markerDir:true});
  writeFileSync(join(root,`${prefix}AFILE1`),'');fs.chmodSync(join(root,`${prefix}AFILE1`),0o700);keep.push(`${prefix}AFILE1`);
  try{
    const cli=cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:root});
    assert.equal(cli.status,0,cli.stderr);assert.deepEqual(readdirSync(root).sort(),keep.sort());
  }finally{fs.chmodSync(join(root,`${prefix}MARKDR`,'owner.json'),0o700);}
});

test('sweep: a stale scratch whose process cannot be signalled is kept, and a sweep error other than a vanished entry fails',async t=>{
  const h=fixture(t);h.create();const root=await interruptedSnapshot(t,h,'SIGKILL'),stale=join(root,readdirSync(root)[0]),pid=JSON.parse(readFileSync(join(stale,'owner.json'),'utf8')).pid;
  const previous=process.env.TMPDIR,kill=process.kill,lstat=fs.lstatSync;process.env.TMPDIR=root;
  try{
    // Another user's live process answers EPERM, not ESRCH.
    process.kill=(target,signal)=>{if(target===pid&&signal===0)throw Object.assign(new Error('TEST'),{code:'EPERM'});return kill.call(process,target,signal);};
    h.report();assert.ok(fs.existsSync(stale),'kept while its process may live');process.kill=kill;
    for(const code of ['ENOENT','EACCES']){
      fs.lstatSync=(path,...args)=>{if(path===stale)throw Object.assign(new Error('TEST'),{code});return lstat(path,...args);};syncBuiltinESMExports();
      if(code==='ENOENT')h.report();else assert.throws(()=>h.report(),{code});
      fs.lstatSync=lstat;syncBuiltinESMExports();
    }
    assert.ok(fs.existsSync(stale));h.report();assert.ok(!fs.existsSync(stale),'swept once nothing stands in the way');
  }finally{process.kill=kill;fs.lstatSync=lstat;syncBuiltinESMExports();process.env.TMPDIR=previous;}
});

test('sweep: scratch is private under any umask: a 0700 directory with 0600 marker, copy, WAL and SHM',t=>{
  const h=fixture(t);h.create();
  const root=mkdtempSync(join(tmpdir(),'umask-health-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const previous=process.env.TMPDIR,mask=process.umask(0);process.env.TMPDIR=root;
  try{
    const modes=readOnlySnapshot(h.path,()=>{const [directory]=readdirSync(root);return [fs.statSync(join(root,directory)).mode&0o7777,Object.fromEntries(readdirSync(join(root,directory)).sort().map(file=>[file,fs.statSync(join(root,directory,file)).mode&0o7777]))];});
    assert.deepEqual(modes,[0o700,{'owner.json':0o600,'state.sqlite':0o600,'state.sqlite-shm':0o600,'state.sqlite-wal':0o600}]);
    // The private copy is closed when its read returns, and removed.
    let kept;readOnlySnapshot(h.path,(db)=>{kept=db;});
    assert.throws(()=>kept.prepare('SELECT 1'),/not open/);assert.deepEqual(readdirSync(root),[]);
  }finally{process.umask(mask);process.env.TMPDIR=previous;}
});

test('sweep: a database path that is not a file, a link chain over 32 links, or a WAL beside an intermediate alias fails closed',t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const links=mkdtempSync(join(tmpdir(),'chain-health-'));t.after(()=>rmSync(links,{recursive:true,force:true}));
  assert.throws(()=>opsHealth({databasePath:links,now:NOW}),/could not read valid state/,'a directory');
  const chain=(n)=>{let target=h.path;for(let i=n;i>=1;i--){const link=join(links,`chain-${n}-${i}`);fs.symlinkSync(target,link);target=link;}return target;};
  assert.equal(opsHealth({databasePath:chain(32),now:NOW}).healthy,false,'32 links reach the database');
  assert.throws(()=>opsHealth({databasePath:chain(33),now:NOW}),/could not read valid state/,'33 links');
  const two=chain(2);assert.equal(opsHealth({databasePath:two,now:NOW}).healthy,false);
  writeFileSync(`${join(links,'chain-2-2')}-wal`,'');
  assert.throws(()=>opsHealth({databasePath:two,now:NOW}),/could not read valid state/,'a WAL beside an intermediate alias');
});

test('sweep: a filesystem error other than absence is never read as absence, and a copy that changed is never opened',async t=>{
  const h=fixture(t);unresolvedPurchase(h);
  const error=(code)=>Object.assign(new Error('TEST'),{code});
  const mock=(name,replace)=>{const original=fs[name];fs[name]=replace(original);syncBuiltinESMExports();return ()=>{fs[name]=original;syncBuiltinESMExports();};};
  const check=(restore,body)=>{try{body();}finally{restore();}};
  check(mock('lstatSync',original=>(path,...args)=>{if(path===`${h.path}-journal`)throw error('EACCES');return original(path,...args);}),()=>assert.throws(()=>h.report(),{code:'EACCES'},'a sidecar that cannot be checked'));
  check(mock('readFileSync',original=>(path,...args)=>{if(path===`${h.path}-wal`)throw error('EACCES');return original(path,...args);}),()=>assert.throws(()=>h.report(),{code:'EACCES'},'a WAL that cannot be read'));
  let reads=0,opened=false;
  check(mock('readFileSync',original=>(path,...args)=>{const bytes=original(path,...args);return path===h.path&&++reads===2?Buffer.concat([bytes,Buffer.from([0])]):bytes;}),
    ()=>assert.throws(()=>readOnlySnapshot(h.path,()=>{opened=true;}),/could not read valid state/,'a database that changed between its reads'));
  reads=0;
  check(mock('readFileSync',original=>(path,...args)=>{if(path===`${h.path}-wal`&&++reads===2)throw error('ENOENT');return original(path,...args);}),
    ()=>assert.throws(()=>readOnlySnapshot(h.path,()=>{opened=true;}),/could not read valid state/,'a WAL gone at its second read'));
  assert.equal(opened,false);
  // The ledger's directory is a file.
  const e=fixture(t);e.create();writeFileSync(join(e.root,'evidence'),'');assert.equal(e.report().healthy,true,'retired ledger directory is not selected');
  // Sidecars beside a database that is not in WAL mode, or of an absent journal.
  const legacy=join(h.root,'legacy-shm.sqlite'),db=new DatabaseSync(legacy);db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t(x)');db.close();
  writeFileSync(`${legacy}-shm`,'');assert.throws(()=>readOnlySnapshot(legacy,()=>{}),/could not read valid state/,'SHM beside a database not in WAL mode');
  const s=fixture(t);s.create();writeFileSync(join(s.root,'seller-wallet.sqlite-shm'),'');assert.throws(()=>s.report(),/could not read valid state/,'the SHM of an absent journal');
  // A database replaced by another file of the same bytes while it was copied.
  const r=fixture(t);unresolvedPurchase(r);reads=0;
  check(mock('readFileSync',original=>(path,...args)=>{const bytes=original(path,...args);if(path===r.path&&++reads===2){fs.copyFileSync(r.path,`${r.path}.copy`);fs.renameSync(`${r.path}.copy`,r.path);}return bytes;}),
    ()=>{assert.throws(()=>readOnlySnapshot(r.path,()=>{opened=true;}),/could not read valid state/,'a database replaced during the copy');assert.equal(opened,false);});
});

test('sweep: scratch avoids operator state and ignores retired linked ledgers',t=>{
  const h=fixture(t);h.create();mkdirSync(join(h.root,'nested'));
  assert.equal(cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:join(h.root,'nested')}).status,2,'inside the operator state');
  const outside=mkdtempSync(join(tmpdir(),'ledger-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  writeFileSync(join(outside,'seller-approvals.jsonl'),'');mkdirSync(join(h.root,'evidence'));fs.symlinkSync(join(outside,'seller-approvals.jsonl'),join(h.root,'evidence','seller-approvals.jsonl'));
  assert.equal(h.report().healthy,true,'a retired linked ledger is ignored');
  assert.equal(cliWith(['--database',h.path,'--operator-state',h.root,'--json'],{TMPDIR:outside}).status,0,'retired ledger is not live state');
  assert.deepEqual(readdirSync(outside),['seller-approvals.jsonl']);
});
