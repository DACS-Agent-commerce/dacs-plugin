import { sellerFailureCause } from '../dacs/seller-http.mjs';
import { canonicalize, contentHash, fixedPriceAgreementLogicalAddress, isCanonicalJobId, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { deriveStorageAddress } from '../dacs/wallet-transactions.mjs';
import { verifyDemosTransactionSignature } from '../wallet/demos-transaction-signature.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, readlinkSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { purchaseTimeline } from './purchase-timeline.mjs';
import { DURABLE_WALLET_JOURNAL_FORMAT, DURABLE_WALLET_JOURNAL_VERSION } from '../wallet/durable-journal.mjs';

const minute=60_000,sha=(value)=>createHash('sha256').update(value).digest('hex');
const HASH=/^[0-9a-f]{64}$/,ID=/^pur_[A-Za-z0-9_-]{16}$/;
const TERMINAL=new Set(['settled_verified','payment_failed','payment_mismatch','expired','terms_changed','cancelled','superseded','agreement_rejected','listing_withdrawn','completed','agreement-rejected','claim-rejected','evidence-rejected','delivery-rejected','bundle-rejected']);
export const STAGE_THRESHOLDS=Object.freeze({
  identity:30*minute,'agreement-signing':10*minute,'agreement-anchored':5*minute,
  committed:30*minute,'seller-committed':30*minute,agreement_pending:10*minute,
  awaiting_approval:30*minute,approved:5*minute,payment_handoff:5*minute,broadcast_reported:5*minute,
  payment_uncertain:5*minute,unknown:5*minute,'payment-observed':5*minute,'awaiting-claim':5*minute,
  'native-payment-evidence-held':5*minute,'payment-evidenced':5*minute,'delivery-ready':10*minute,
  delivered:10*minute,'awaiting-countersignature':30*minute,
});
const STAGES=new Set([...Object.keys(STAGE_THRESHOLDS),...TERMINAL]);
// Every (step, outcome) pair protocol-purchases.mjs records with note() (line
// numbers below are in that file). WRITE: the call may have issued a write, or
// asked the seller to make one, and its outcome is unknown; it stays unresolved
// through later attempts until a resolving attempt comes after it. resolves():
// a verified readback (or anchor receipt) that settles earlier unresolved
// writes of the named steps, and only those. NEITHER: a refusal, a read, a
// local check or a not-yet answer; it resolves nothing. SELLER_STATUS rows take
// whatever status the seller's own answer carried. A pair not in the table
// cannot be classified and fails closed.
const WRITE='write',NEITHER='neither',VET='seller-vet',WALLET_CREATE='wallet-anchor',resolves=(...steps)=>Object.freeze({resolves:steps});
export const SELLER_STATUS='(any other seller-reported status)';
export const ATTEMPT_EFFECTS=Object.freeze([
  // :665 (:658 if the purchase changed meanwhile) the Agreement-context provider
  // ran. It may publish seller Vet records (devnet-demo/agreement-context.mjs),
  // which only seller readback shows: the seller journal decides. Only the
  // attempt's structured `written: false` mark (:473; set by the consumer only
  // when it invoked no provider) says nothing can have been written.
  ['agreement-context','absent',VET],['agreement-context','rejected',VET],['agreement-context','indeterminate',VET],
  ['agreement','anchored',resolves('agreement',WALLET_CREATE)], // :776,867 SDK-verified anchor receipt; :867 verifies the retained wallet CREATE
  ['agreement','rejected',NEITHER],                   // :770,775,863,866 refused, or anchored with other terms
  ['agreement','indeterminate',WRITE],                // :772,864 proposal/anchor/binding submission outcome unknown
  ['agreement','waiting',NEITHER],                    // :772,864 SDK lease held elsewhere, or seller contribution not yet available
  ['commit-request','unavailable',WRITE],             // :785,904 seller.commit() may have written; the answer was lost
  ['commit-request','refused',NEITHER],               // :785,904 SellerRefusedError: the seller declined
  ['commitment','verified',resolves('commit-request')], // :789,908 canonical commitment read back and verified
  ['commitment','rejected',NEITHER],                  // :794,914
  ['commitment','absent',NEITHER],['commitment','unavailable',NEITHER], // :795,915 readback not there yet / failed
  ['commitment','indeterminate',NEITHER],            // :804,924 a native commitment read back but finality is not established: held, nothing sent
  ['claim','accepted',WRITE],                         // :993 the seller says it wrote payment evidence; not yet read back
  ['claim','rejected',NEITHER],                       // :988,991
  ['claim','unavailable',WRITE],                      // :989 submitPayment answer lost
  ['claim','indeterminate',WRITE],['claim',SELLER_STATUS,WRITE], // :992 the seller answered without delivering
  ['payment-evidence','verified',resolves('claim')],  // :1004 verified payment evidence at the canonical address
  ['payment-evidence','rejected',NEITHER],['payment-evidence','absent',NEITHER],['payment-evidence','unavailable',NEITHER], // :999,1002,1003
  ['delivery','verified',resolves('native-evidence')], // :1046,1380; :1380 only after the native evidence read back present (:1352)
  ['delivery','rejected',resolves('native-evidence')], // :1047,1368; :1368 likewise after :1352
  ['delivery','absent',NEITHER],['delivery','unavailable',NEITHER], // :1052
  ['bundle-request','ready',NEITHER],['bundle-request','rejected',NEITHER], // :1024,1026 seller-signed request checked locally
  ['bundle-request','refused',NEITHER],['bundle-request','unavailable',NEITHER], // :1017 the request anchors nothing
  ['countersign','rejected',NEITHER],                 // :1108,1109 local copy check, before the counter-signature is saved
  // The one buyer copy write (:1116) follows its saved intent (:1114) and is
  // never sent again; only an authenticated readback resolves it (:1174).
  ['buyer-copy','anchored',resolves('buyer-copy')],   // :1174 buyer copy read back and authenticated
  ['buyer-copy','unavailable',WRITE],                 // :1118 the write's answer was lost; :1169 its readback failed
  ['buyer-copy','absent',WRITE],                      // :1173 the write sent once is not read back yet
  ['buyer-copy','rejected',WRITE],                    // :1172 the copy read back does not verify; the write sent once is not read back
  ['seller-copy','verified',resolves('seller-copy')], // :1138 seller copy read back and verified
  ['seller-copy','rejected',NEITHER],['seller-copy','absent',NEITHER], // :1136,1137
  ['seller-copy','refused',NEITHER],                  // :1180
  ['seller-copy','unavailable',WRITE],                // :1180 countersign answer lost; :1133 its readback failed
  ['seller-confirmation','unavailable',NEITHER],      // :1144 read-only confirmBuyerCopy, after :1138 verified the copy
  ['seller-confirmation','unknown',NEITHER],['seller-confirmation',SELLER_STATUS,NEITHER], // :1141
  ['native-evidence','held',WRITE],                   // :1322,1339,1386 submission or its readback ambiguous (:1303 submits nothing, same pair)
  ['native-evidence','verified-fixture-native-read',resolves('native-evidence')], // :1383
  // DACS_BUYER_CHAIN_READBACK=on (keepVerified): a fresh read that kept an
  // already verified delivery. Any seller ask before it replays a completed
  // claim from the seller's effect cache, so nothing new can be written.
  ['chain-readback','indeterminate',NEITHER],
].map(Object.freeze));
const EFFECTS=new Map(ATTEMPT_EFFECTS.map(([step,outcome,effect])=>[`${step}\n${outcome}`,effect]));
// Durable write intents protocol-purchases.mjs saves before a write, with no
// attempt until the write answers: :831 retains the wallet Agreement CREATE
// before the one-shot wallet anchor; :840 withdraws only that fresh intent,
// before anything was issued; :1114 saves the buyer's counter-signature before
// the one buyer copy write. Replayed from the event log with the attempts.
const opens=(step)=>Object.freeze({opens:step});
export const INTENT_EFFECTS=Object.freeze({protocol_wallet_anchor_intent:opens(WALLET_CREATE),protocol_wallet_anchor_not_issued:resolves(WALLET_CREATE),protocol_buyer_copy_intent:opens('buyer-copy')});
// Every other event save() records: local state, a planned or signed message
// the buyer has not sent, or a payment the purchase status already holds
// readback-only (payment_handoff onward). None is a write of its own. The
// chain readback events keep authenticated signed CREATE bytes or hold the
// purchase for the operator (DACS_BUYER_CHAIN_READBACK=on). The native
// commitment hold returns a legacy approvable row to agreement_pending.
export const NO_WRITE_EVENTS=Object.freeze(['protocol_identity_requested','protocol_seller_session_requested','protocol_seller_session_delegated','protocol_agreement_planned',
  'protocol_agreement_signed','protocol_agreement_public_projection_retained','protocol_transfer_observed','protocol_native_transfer_observed','protocol_native_wallet_guard_issued','protocol_step',
  'protocol_chain_pointer_kept','protocol_chain_readback_held','protocol_native_commitment_held']);
// DACS_BUYER_CHAIN_READBACK=on: a final purchase that can no longer obtain a
// chain pointer it lacks (state.protocol.chainReadbackHeld) keeps its verified
// result but needs the operator; it alerts until a readback keeps every pointer.
const CHAIN_READBACK_HELD='chain-readback-pointers-missing';
const CHAIN_READBACK_NEXT='chain readback pointers missing: the seller can no longer be asked for its signed CREATEs; operator action required; never resend';
// A check that read an older protocol revision saves nothing (:411): its
// event goes to the log as protocol_check_not_saved, with the event it would
// have saved under data.event and that event's own data (an attempt's outcome
// and mark) beside it. Its stage was never saved.
export const NOT_SAVED_EVENT='protocol_check_not_saved';
function notSavedCheck(data){
  const type=data?.event;
  if(typeof type!=='string'||!type.startsWith('protocol_'))fail();
  if(Object.hasOwn(INTENT_EFFECTS,type)||NO_WRITE_EVENTS.includes(type))return {notSaved:type};
  if(!Object.hasOwn(data,'outcome'))fail();
  return {notSaved:type,step:type.slice('protocol_'.length),outcome:data.outcome,written:data.written,dispatched:data.dispatched};
}
function attemptEffect(step,outcome,written,dispatched){
  if(typeof step!=='string'||outcome===undefined||outcome===null)fail();
  const effect=EFFECTS.get(`${step}\n${typeof outcome==='string'?outcome:''}`)??EFFECTS.get(`${step}\n${SELLER_STATUS}`)??fail();
  // This attempt sent nothing; it neither opens nor resolves earlier writes.
  return dispatched===false || effect===VET&&written===false?NEITHER:effect;
}
// One history in order: the writes it leaves unresolved, whether the
// Agreement-context provider may have written, and the last outcome.
// A not-saved check can only add: a write or provider call it made may have
// been issued, but its readbacks settle nothing. Its intent was not saved,
// and save() throws before the write that follows an intent, so nothing was
// sent for it.
// A check that is not saved, or lost (logged with no stage, :486), lost to
// another change. When that change was another check's saved readback, the
// lost check's write is logged after it, and that readback is never recorded
// again. Each such write targets the one canonical address of its step for
// this job, so a saved resolving readback of that step settles it wherever it
// sits in the log. A saved write still needs a resolving readback after it.
function classifyAttempts(attempts){
  const open=new Set(),verified=new Set();
  let vet=false,last,causeCode,lastAttemptDispatched;
  for(const {intent,notSaved,lost,step,outcome,written,dispatched} of attempts){
    if(intent||notSaved||lost)continue;
    const effect=attemptEffect(step,outcome,written,dispatched);
    if(effect.resolves)for(const resolved of effect.resolves)verified.add(resolved);
  }
  for(const {intent,notSaved,lost,step,outcome,written,dispatched,causeCode:attemptCause} of attempts){
    if(intent){const effect=INTENT_EFFECTS[intent];if(effect.opens)open.add(effect.opens);else for(const resolved of effect.resolves)open.delete(resolved);continue;}
    if(notSaved&&step===undefined)continue;
    const effect=attemptEffect(step,outcome,written,dispatched);
    if(effect===WRITE&&!((notSaved||lost)&&verified.has(step)))open.add(step);
    else if(effect===VET)vet=true;
    if(notSaved)continue;
    last=outcome;causeCode=sellerFailureCause(attemptCause);lastAttemptDispatched=dispatched;
    if(effect!==WRITE&&effect!==VET&&effect!==NEITHER)for(const resolved of effect.resolves)open.delete(resolved);
  }
  return {open,vet,last,causeCode,lastAttemptDispatched};
}
const NEXT={
  identity:'buyer identity presentation','agreement-signing':'Agreement signature and anchor readback',
  'agreement-anchored':'seller commitment readback',committed:'buyer payment approval','seller-committed':'buyer payment approval (profile may hold payment)',
  agreement_pending:'Agreement progress',awaiting_approval:'buyer payment approval',approved:'one-time wallet handoff',
  payment_handoff:'original payment readback; never resend',broadcast_reported:'original payment readback; never resend',
  payment_uncertain:'original payment readback; never resend',unknown:'original write readback; never resend',
  'payment-observed':'payment evidence readback (profile may hold claims)','awaiting-claim':'seller claim acceptance and payment evidence readback',
  'native-payment-evidence-held':'original evidence write readback; never resend','payment-evidenced':'delivery readback',
  'delivery-ready':'delivery evidence readback (profile may defer completion)',delivered:'completed bundle (profile may defer completion)',
  'awaiting-countersignature':'buyer bundle countersignature and copy readback',
};
const SELLER_VET_NEXT='seller Vet write readback: rerun with --operator-state (seller-artifacts.sqlite journal); never resend';
const fail=()=>{throw new Error('ops health could not read valid state');};
const stage=(value)=>{if(!STAGES.has(value))fail();return value;};
const at=(value)=>{if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isSafeInteger(Date.parse(value))||new Date(value).toISOString()!==value)fail();return Date.parse(value);};

// Scratch names and private ownership metadata identify only this CLI's copies.
// A live (or reused) PID is never swept. Unexpected files, links or modes are
// left alone; no recursive removal of an unrecognized directory is permitted.
const activeScratch=new Set();
const inside=(path,root)=>path===root||path.startsWith(root+sep);
const privateEntry=(path,directory,mode)=>{
  const st=lstatSync(path);
  return st.uid===process.getuid()&&(st.mode&0o7777)===mode&&(directory?st.isDirectory():st.isFile());
};
function cleanScratch(){for(const directory of activeScratch){rmSync(directory,{recursive:true,force:true});activeScratch.delete(directory);}}
process.once('exit',cleanScratch);
for(const [signal,code] of [['SIGINT',130],['SIGTERM',143]])process.once(signal,()=>{try{cleanScratch();}finally{process.exit(code);}});
function scratchDirectory(stateRoots){
  const root=realpathSync(tmpdir());
  if(stateRoots.some(state=>inside(root,state)))fail();
  for(const name of readdirSync(root)){
    const match=/^dacs-ops-health-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(name);
    if(!match)continue;
    const directory=join(root,name),marker=join(directory,'owner.json');
    if(stateRoots.some(state=>inside(state,directory)))continue;
    try{
      if(!privateEntry(directory,true,0o700)||!privateEntry(marker,false,0o600))continue;
      const owner=JSON.parse(readFileSync(marker,'utf8'));
      if(owner.format!=='dacs-ops-health-scratch/v1'||owner.pid!==Number(match[1])||owner.directory!==name)continue;
      try{process.kill(owner.pid,0);continue;}catch(error){if(error.code!=='ESRCH')continue;}
      const files=readdirSync(directory);
      if(files.some(file=>!['owner.json','state.sqlite','state.sqlite-wal','state.sqlite-shm','state.sqlite-journal'].includes(file)||!privateEntry(join(directory,file),false,0o600)))continue;
      rmSync(directory,{recursive:true});
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const directory=mkdtempSync(join(root,`dacs-ops-health-${process.pid}-`));
  activeScratch.add(directory);
  writeFileSync(join(directory,'owner.json'),JSON.stringify({format:'dacs-ops-health-scratch/v1',pid:process.pid,directory:directory.slice(root.length+1)}),{mode:0o600,flag:'wx'});
  return directory;
}
const SIDECARS=['-wal','-shm','-journal'];
const identity=(path)=>{
  try{const st=lstatSync(path);return `${st.isSymbolicLink()?'link':st.isFile()?'file':'other'}:${st.dev}:${st.ino}`;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
};
// A selected SQLite database is one file set: every name it is reached
// through, its canonical file, and the WAL/SHM/rollback sidecars SQLite uses
// beside that canonical file. Sidecar links are refused outright, so every
// live file lives in an excluded directory. A sidecar under any other name in
// the chain (a renamed database's WAL left at its old name) is ambiguous.
function fileSet(path){
  const names=[];
  for(let name=resolve(path);;name=resolve(dirname(name),readlinkSync(name))){
    if(names.length>32)fail();
    names.push(name);
    if(!lstatSync(name).isSymbolicLink())break;
  }
  const real=realpathSync(path),sidecars={};
  if(!identity(real)?.startsWith('file:'))fail();
  for(const suffix of SIDECARS){
    const canonical=identity(`${real}${suffix}`);
    if(canonical!==null&&!canonical.startsWith('file:'))fail();
    for(const name of names){const alias=identity(`${name}${suffix}`);if(alias!==null&&alias!==canonical)fail();}
    sidecars[suffix]=canonical;
  }
  return {real,sidecars,roots:[...new Set([...names.map(name=>realpathSync(dirname(name))),dirname(real)])],key:JSON.stringify([names,real,identity(real),sidecars])};
}
// Real absence of an optional file is reported as absent. An existing name,
// including a dangling link, is selected state and must resolve.
function selectedPath(path){
  try{lstatSync(path);}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    if(identity(dirname(path))!==null){try{realpathSync(dirname(path));}catch{fail();}}
    return null;
  }
  try{return realpathSync(path);}catch{fail();}
}
// SQLite's readOnly flag still writes live SHM reader marks. Read a stable
// DB/WAL copy using filesystem reads only, then let SQLite index its private
// copy. A changing source fails closed; no live locks or sidecars are touched.
// Names, inodes and sidecar existence are checked before reading and again
// after the copy is written.
export function readOnlySnapshot(path,read,stateRoots=[]) {
  const set=fileSet(path),real=set.real;
  const optional=(file)=>{try{return readFileSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const database=readFileSync(real),log=optional(`${real}-wal`),shm=optional(`${real}-shm`),again=readFileSync(real),logAgain=optional(`${real}-wal`);
  if(!database.equals(again)||(log===null?logAgain!==null:logAgain===null||!log.equals(logAgain)))fail();
  // A WAL-mode header (file format versions 2) with SHM but no WAL means the
  // WAL was moved or is being removed. A rollback journal, or WAL state beside
  // a database that is not in WAL mode, cannot be copied consistently.
  const walMode=database.length>=100&&database[18]===2&&database[19]===2;
  if(set.sidecars['-journal']!==null||(walMode?log===null&&shm!==null:log!==null||shm!==null))fail();
  const directory=scratchDirectory([...stateRoots,...set.roots]),copy=join(directory,'state.sqlite');
  let db;
  try {
    writeFileSync(copy,database,{mode:0o600,flag:'wx'});
    if(log!==null)writeFileSync(`${copy}-wal`,log,{mode:0o600,flag:'wx'});
    if(shm!==null)writeFileSync(`${copy}-shm`,shm,{mode:0o600,flag:'wx'});
    if(fileSet(path).key!==set.key)fail();
    db=new DatabaseSync(copy,{readOnly:true});
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN');return read(db);
  } finally {
    try { if(db){try{db.exec('ROLLBACK');}finally{db.close();}} }
    finally { rmSync(directory,{recursive:true,force:true});activeScratch.delete(directory); }
  }
}
function journal(path,stateRoots) {
  return readOnlySnapshot(path,(db)=>{
    const meta=Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map(row=>[row.key,row.value]));
    if(meta.format!==DURABLE_WALLET_JOURNAL_FORMAT||meta.version!==String(DURABLE_WALLET_JOURNAL_VERSION)||!/^[0-9a-f]{32}$/.test(meta.journal_id??''))fail();
    const rows=db.prepare('SELECT key,seq,value,digest,bytes FROM records ORDER BY seq').all();
    if(String(rows.length)!==meta.records||String(rows.reduce((sum,row)=>sum+row.bytes,0))!==meta.total_bytes||(rows.at(-1)?.seq??0)>=Number(meta.next_seq))fail();
    return rows.map(row=>{
      if(row.bytes!==Buffer.byteLength(row.value)||row.digest!==sha(`${meta.format}\n${meta.journal_id}\n${row.key}\n${row.value}`))fail();
      return {key:row.key,value:JSON.parse(row.value)};
    });
  },stateRoots);
}
// Open publications use the same five-minute readback window as payments.
const PUBLICATION_WAIT_MS=300_000;
const PUBLICATION_STATUSES=new Set(['awaiting_identity_signature','awaiting_listing_signature','listing_signed','publication_handoff','broadcast_reported','chain_verified','directory_submitted','directory_visible','publication_uncertain','publication_mismatch','cancelled']);
export const OPEN_PUBLICATIONS=new Set(['publication_handoff','broadcast_reported','publication_uncertain']);
// A cancelled publication whose handed-off write was never read back can still
// land later (cancelling only checks the wallet nonce at that moment), so it
// stays listed until a readback verifies it. Cancelled rows are informational:
// their writes may never land, so they cannot permanently fail health.
// Every row with a saved handoff is aged from that handoff, so a later status
// change cannot restart the alert clock.
function readLegacyPublications(db,now) {
  return db.prepare("SELECT o.id,o.status,o.updated_at,c.operation_id IS NOT NULL AND c.verified_at IS NULL AS unread_handoff,c.saved_at AS handoff_at FROM operations o LEFT JOIN write_coordinates c ON c.operation_id=o.id WHERE o.kind='listing_publication' ORDER BY o.created_at,o.id").all().flatMap(row=>{
    if(!/^pub_[A-Za-z0-9_-]{16}$/.test(row.id)||!PUBLICATION_STATUSES.has(row.status))fail();
    const cancelledUnread=row.status==='cancelled'&&row.unread_handoff===1;
    const openedAt=at(row.handoff_at??row.updated_at);
    const open=OPEN_PUBLICATIONS.has(row.status)||cancelledUnread;
    if(!open||now-openedAt<=PUBLICATION_WAIT_MS)return [];
    return [{operationId:row.id,status:row.status,nextExpected:'operator-led original readback of the v1 publication; never resend or re-publish'}];
  });
}
function readPurchases(databasePath,now,stateRoots) {
  return readOnlySnapshot(databasePath,(db)=>{
    if(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value!=='2')fail();
    const events=db.prepare('SELECT at,type,data FROM operation_events WHERE operation_id=? ORDER BY seq');
    const rows=db.prepare("SELECT id,account_id,status,state,created_at,updated_at,expires_at,terms_hash,json_extract(terms,'$.domain.network') AS network,json_extract(terms,'$.domain.chainIdentity') AS chain_identity,json_extract(terms,'$.protocol.jobId') AS job,json_extract(terms,'$.protocol.transportBinding') AS transport_binding,json_extract(terms,'$.buyer.wallet') AS buyer,json_extract(terms,'$.seller.payee') AS seller,json_extract(terms,'$.protocol') IS NOT NULL AS protocol FROM operations WHERE kind='purchase' ORDER BY created_at DESC,id").all().map(row=>{
      if(!ID.test(row.id))fail();
      const status=stage(row.status),state=JSON.parse(row.state),protocol=state?.protocol?.stage;
      if(row.protocol&&protocol===undefined)fail();
      if(protocol!==undefined)stage(protocol);
      const history=[];
      let lastStatus=null,lastProtocol=null;
      const add=(lane,value,timestampMs)=>{
        const previous=lane==='purchase'?lastStatus:lastProtocol;
        if(value===previous)return;
        history.push({lane,stage:value,timestampMs});
        if(lane==='purchase')lastStatus=value;else lastProtocol=value;
      };
      // note() appends a protocol_<step> event carrying the outcome in the same
      // transaction as the stored attempt; no other saved event has an
      // outcome. If the purchase was cancelled or expired during the step's
      // call, only the event is written (protocol-purchases.mjs :486). A check
      // that lost to newer saved progress is logged as not saved. The event log
      // is the whole history, with the write intents in order; the stored
      // attempts are the last ten. Both are classified: a write either leaves
      // unresolved alerts, so the stored tail can only add an alert, never hide
      // one.
      const noted=[];
      for(const event of events.all(row.id)){
        const data=JSON.parse(event.data),timestampMs=at(event.at);
        if(event.type===NOT_SAVED_EVENT){noted.push(notSavedCheck(data));continue;}
        if(event.type==='created'){
          add('purchase',stage(data.status),timestampMs);
          if(row.protocol)add('protocol','identity',timestampMs);
        } else if(STAGES.has(event.type))add('purchase',event.type,timestampMs);
        if(event.type.startsWith('protocol_')&&Object.hasOwn(data,'stage'))add('protocol',stage(data.stage),timestampMs);
        if(event.type.startsWith('protocol_')&&Object.hasOwn(data,'outcome'))noted.push({step:event.type.slice('protocol_'.length),outcome:data.outcome,written:data.written,dispatched:data.dispatched,causeCode:data.causeCode,lost:!Object.hasOwn(data,'stage')});
        else if(Object.hasOwn(INTENT_EFFECTS,event.type))noted.push({intent:event.type});
      }
      const stored=state?.protocol?.attempts??[];
      if(!Array.isArray(stored)||stored.some(entry=>entry===null||typeof entry!=='object'))fail();
      const log=classifyAttempts(noted),tail=classifyAttempts(stored.map(({step,outcome,written,dispatched,causeCode})=>({step,outcome,written,dispatched,causeCode}))),open=new Set([...log.open,...tail.open]),vet=log.vet||tail.vet,last=log.last??tail.last;
      // The saved counter-signature is the buyer copy write's intent; the copy
      // counts as read back only once buyerCopyReadBack is saved, at any stage.
      // Older code saved it from the write acknowledgement alone, and
      // protocol-purchases shows such a purchase as awaiting the readback
      // (shownStage); one that then reached bundle-rejected is never re-checked.
      const bundle=state?.protocol?.bundle;
      if(bundle?.buyerSignature&&bundle.buyerCopyReadBack!==true)open.add('buyer-copy');
      const expiresAt=at(row.expires_at),expired=['awaiting_approval','agreement_pending'].includes(status)&&expiresAt<=now;
      const effective=expired?'expired':status==='settled_verified'&&protocol==='committed'?'awaiting-claim':TERMINAL.has(status)&&status!=='settled_verified'?status
        :['approved','payment_handoff','broadcast_reported','payment_uncertain'].includes(status)?status:protocol??status;
      const lane=effective===protocol?'protocol':'purchase';
      const entered=history.filter(event=>event.lane===lane&&event.stage===(status==='settled_verified'&&protocol==='committed'?'settled_verified':effective)).at(-1)?.timestampMs??at(row.updated_at);
      if(!history.length)fail();
      const writes=[...open].sort(),unknown=effective==='payment_uncertain'||effective==='unknown'||writes.length>0;
      const held=state?.protocol?.chainReadbackHeld;
      if(held!==undefined&&(held===null||typeof held!=='object'||held.action!==CHAIN_READBACK_HELD))fail();
      return {purchaseId:row.id,stage:effective,enteredAt:entered,updatedAt:at(row.updated_at),createdAt:at(row.created_at),unknown,writes,vet,operatorAction:held!==undefined,lastAttemptDispatched:log.last!==undefined?log.lastAttemptDispatched:tail.lastAttemptDispatched,
        ...(sellerFailureCause(log.last!==undefined?log.causeCode:tail.causeCode)?{causeCode:log.last!==undefined?log.causeCode:tail.causeCode}:{}),unresolvedRead:!unknown&&!vet&&(log.last!==undefined?log.lastAttemptDispatched:tail.lastAttemptDispatched)!==false&&(last==='indeterminate'||last==='unknown'),history,seller:row.seller,buyer:row.buyer,termsHash:row.terms_hash,
        // What the source transport journal's buyer records bind to (payerRecord, buyerCreateHandoff):
        // agreement is the exact Agreement retained for the wallet CREATE (protocol-purchases.mjs :831).
        scope:{account:row.account_id,network:row.network,chainIdentity:row.chain_identity,job:row.job,transportBinding:row.transport_binding,agreementHash:state?.protocol?.planned?.plan?.agreementHash,
          agreement:state?.protocol?.walletAnchor?.artifact}};
    });
    return {rows,legacyPublications:readLegacyPublications(db,now)};
  },stateRoots);
}
const PENDING=new Set(['intent','issued','unknown','broadcast-started','broadcast-accepted','broadcast-answered','sr2-readback-pending','handoff-issued','authorization-issued']);
// 'closing': an unsigned artifact intent a shutdown left askable; nothing to read back.
const JOURNAL_STAGES=new Set([...PENDING,'prepared','verified','denied','observed','closing']);
// Historical local journals remain read-only recovery evidence for v1 writes.
// They say nothing about the health or budget of a remote seller.
const JOURNALS=['seller-artifacts.sqlite','seller-wallet.sqlite','node2-transport.sqlite'];
// The cancel/send exclusion's per-payer records in the source transport
// journal (devnet-native-transport.mjs cancelledKey, claimsKey and refusedKey,
// written by cancelNativeTransfer, writeClaims and refuseCancelled): a
// cancelled payment's settlement terms, the transfers signature leases have
// claimed, and the transfers refused for a cancelled payment's terms. None
// holds a hash or a signed transaction, so none is an issued write. Each is
// recognized only in the exact shape its producer writes, on the lane
// [network, chainIdentity, wallet] of a purchase in this database (its
// terms.domain network and chain identity and its buyer wallet; the producer
// keys the lane by its pinned network and chain identity, which a purchase
// it serves carries), and a cancellation only for a purchase on that lane
// (protocol-purchases.mjs passes the purchase's id and buyer wallet);
// anything else under these prefixes fails closed.
const text=(value,pattern)=>typeof value==='string'&&pattern.test(value),iso=(value)=>(at(value),true);
const plain=(value)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameKeys=(value,keys)=>JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
const TERMS=['nonce','to','amountOs','payloadDigest'];
const terms=(entry)=>Number.isSafeInteger(entry.nonce)&&text(entry.to,/^0x[0-9a-f]{64}$/)&&text(entry.amountOs,/^[1-9][0-9]*$/)&&text(entry.payloadDigest,HASH);
// The producer's format markers (NATIVE_PAYER_RECORD_FORMATS), refusals kept
// per lane (REFUSALS_KEPT) and refusing gates (its refuseCancelled calls); a
// test keeps them equal.
export const PAYER_RECORD_FORMATS=Object.freeze({cancelledPayments:'dacs-chatgpt-plugin/cancelled-native-payments/v2',transferClaims:'dacs-chatgpt-plugin/native-transfer-claims/v1',refusedTransfers:'dacs-chatgpt-plugin/refused-native-transfers/v1'});
export const REFUSALS_KEPT=64,REFUSAL_GATES=Object.freeze(['signature','pre-broadcast','confirmTx','broadcast']);
const PAYER_RECORDS=Object.freeze([
  {prefix:'devnet/cancelled-payments/',marker:'cancelledPayments',list:'transfers',min:1,max:Infinity,
    entry:(e,onLane)=>sameKeys(e,[...TERMS,'operationId','cancelledAt'])&&text(e.operationId,ID)&&onLane(e.operationId)&&iso(e.cancelledAt)},
  // A lease's claim replaces its earlier one (claimTransfer): one per lease.
  {prefix:'devnet/transfer-claims/',marker:'transferClaims',list:'claims',min:0,max:Infinity,distinct:(e)=>e.leaseId,
    entry:(e)=>sameKeys(e,[...TERMS,'leaseId','expiresAt',...(Object.hasOwn(e,'confirmTxAt')?['confirmTxAt']:[])])&&text(e.leaseId,/^[0-9a-f]{32}$/)&&iso(e.expiresAt)&&(!Object.hasOwn(e,'confirmTxAt')||iso(e.confirmTxAt))},
  // At most REFUSALS_KEPT refusals are kept per payer lane, one per payload
  // (refuseCancelled's samePayload: the terms and payload digest).
  {prefix:'devnet/refused-transfers/',marker:'refusedTransfers',list:'refusals',min:1,max:REFUSALS_KEPT,distinct:(e)=>JSON.stringify(TERMS.map(k=>e[k])),
    entry:(e)=>sameKeys(e,[...TERMS,'gate','refusedAt'])&&REFUSAL_GATES.includes(e.gate)&&iso(e.refusedAt)},
].map(Object.freeze));
const LABEL=/^[a-z0-9][a-z0-9._-]{0,63}$/,WALLET=/^0x[0-9a-f]{64}$/;
function payerRecord(key,value,purchases){
  const kind=PAYER_RECORDS.find(({prefix})=>key.startsWith(prefix));
  if(!kind)return false;
  let lane;
  try{lane=JSON.parse(key.slice(kind.prefix.length));}catch{fail();}
  if(!Array.isArray(lane)||lane.length!==3||key!==kind.prefix+JSON.stringify(lane)||!text(lane[0],LABEL)||!text(lane[1],/^(?:0x)?[0-9a-f]{64}$/)||!text(lane[2],WALLET))fail();
  const onLane=(purchase)=>purchase!==undefined&&purchase.buyer===lane[2]&&purchase.scope.network===lane[0]&&purchase.scope.chainIdentity===lane[1];
  if(![...purchases.values()].some(onLane))fail();
  const marker=kind.marker,entries=value?.[kind.list];
  if(!plain(value)||!sameKeys(value,[marker,kind.list])||value[marker]!==PAYER_RECORD_FORMATS[marker]||!Array.isArray(entries)||entries.length<kind.min||entries.length>kind.max
    ||!entries.every(entry=>plain(entry)&&terms(entry)&&kind.entry(entry,(id)=>onLane(purchases.get(id))))||(kind.distinct&&new Set(entries.map(kind.distinct)).size!==entries.length))fail();
  return true;
}
// The buyer's browser Agreement CREATE handoff in the source transport journal
// (src/portal/devnet-agreement-transport-broker.mjs recordKey, written by its
// wallet request, claim and complete): a wallet-Agreement purchase on the
// source broker leaves one once its CREATE is requested, at completed once
// that CREATE was accepted. It holds the unsigned CREATE
// request only. The signed CREATE is the buyer's own sr2/wallet/ lane record
// and the purchase's Agreement attempts keep its outcome, so it is not an
// issued write. It is recognized only as that producer writes it: keyed to a
// purchase in this database whose scope its binding is (scope(): the account,
// buyer wallet, terms hash, job, planned Agreement hash and network); the
// exact envelope, binding and request, whose one CREATE is the unsigned
// storage CREATE of that purchase's Agreement (agreementCreate); one of the producer's six
// stages, each of which it can leave at rest (nothing advances or removes a
// queued or issued handoff the browser never returns to); transactionHash
// only, and always, at completed and uncertain; errorCode (the wallet's, cut
// to 80 characters, left out when empty) only at uncertain and denied.
// Anything else under the prefix fails closed.
// The producer's request kind and profile (DEVNET_AGREEMENT_KIND and
// DEVNET_AGREEMENT_PROFILE, src/wallet/devnet-native-transport.mjs; a test
// keeps them equal).
export const BROWSER_HANDOFF_REQUEST=Object.freeze({kind:'devnet-agreement-storage-create',profile:'devnet-agreement'});
// The fields each stage adds: true where required, false where optional.
export const BROWSER_HANDOFF_STAGES=Object.freeze({queued:{},'issued-to-browser':{},expired:{},completed:{transactionHash:true},uncertain:{transactionHash:true,errorCode:false},denied:{errorCode:false}});
const HANDOFF_PREFIX='devnet-browser-agreement/create/';
const requestDigest=(request)=>{try{return sha(canonicalize(request));}catch{fail();}};
const CREATE_REQUEST=['kind','profile','network','owner','artifactKind','jobId','logicalAddress','contentHash','envelopeHash','transaction'];
const ZERO_FEE=Object.freeze({network_fee:0,rpc_fee:0,additional_fee:0,rpc_address:null});
// The unsigned storage CREATE the request carries, as takeStorageAnchorHandoff
// (src/dacs/demos-sr2-adapter.mjs) hands it out from planWrite's
// buildStorageProgramCreatePayload (src/dacs/wallet-transactions.mjs): the
// purchase's Agreement (its contentHash the planned Agreement hash, its
// envelopeHash the request's), byte for byte the one the purchase retained
// for its wallet CREATE, signatures included (the broker compares the two;
// contentHash leaves signatures out), at the request's logical address and its
// derived storage address, from the buyer wallet, on the purchase's network
// and chain identity, bound to its transport (metadata.networkBinding is
// terms.protocol.transportBinding), with no signature or hash.
function agreementCreate(tx,r,wallet,scope){
  const c=tx?.content,op=c?.data?.[1],m=op?.metadata;
  try{
    return plain(tx)&&sameKeys(tx,['content','signature','hash','status','blockNumber'])&&tx.signature===null&&tx.hash===''&&tx.status===''&&tx.blockNumber===null
      &&plain(c)&&sameKeys(c,['type','from','to','amount','data','nonce','timestamp','transaction_fee','from_ed25519_address','network','chainIdentity'])
      &&c.type==='storageProgram'&&c.from===wallet&&c.from_ed25519_address===wallet&&c.amount===0&&Number.isSafeInteger(c.nonce)&&c.nonce>=1&&Number.isSafeInteger(c.timestamp)&&c.timestamp>=0
      &&plain(c.transaction_fee)&&canonicalize(c.transaction_fee)===canonicalize(ZERO_FEE)&&c.network===scope.network&&c.chainIdentity===scope.chainIdentity
      &&Array.isArray(c.data)&&c.data.length===2&&c.data[0]==='storageProgram'
      &&plain(op)&&sameKeys(op,['operation','storageAddress','programName','encoding','data','metadata','acl','salt','storageLocation'])&&op.operation==='CREATE_STORAGE_PROGRAM'
      &&op.programName===logicalToStorageProgramName(r.logicalAddress)&&op.storageAddress===deriveStorageAddress(wallet,op.programName,c.nonce,'')&&c.to===op.storageAddress
      &&op.encoding==='json'&&op.salt===''&&op.storageLocation==='onchain'&&plain(op.acl)&&sameKeys(op.acl,['mode'])&&op.acl.mode==='public'
      &&plain(op.data)&&contentHash(op.data)===r.contentHash&&sha(canonicalize(op.data))===r.envelopeHash&&plain(scope.agreement)&&canonicalize(op.data)===canonicalize(scope.agreement)
      &&plain(m)&&sameKeys(m,['logicalAddress','contentHash','envelopeHash','artifactKind','networkBinding'])&&m.logicalAddress===r.logicalAddress&&m.contentHash===r.contentHash
      &&m.envelopeHash===r.envelopeHash&&m.artifactKind==='Agreement'&&typeof scope.transportBinding==='string'&&canonicalize(m.networkBinding)===canonicalize(JSON.parse(scope.transportBinding));
  }catch{return false;}
}
function buyerCreateHandoff(key,value,purchases){
  if(!key.startsWith(HANDOFF_PREFIX))return false;
  const id=key.slice(HANDOFF_PREFIX.length),purchase=ID.test(id)?purchases.get(id):undefined,s=purchase?.scope,b=value?.binding,r=value?.request?.params?.[0];
  const fields=plain(value)&&Object.hasOwn(BROWSER_HANDOFF_STAGES,value.stage)?BROWSER_HANDOFF_STAGES[value.stage]:null;
  if(!purchase||!fields||!sameKeys(value,['version','binding','correlation','request','requestHash','expiresAt','stage',...Object.keys(fields).filter(k=>fields[k]||Object.hasOwn(value,k))])
    ||value.version!==1||(Object.hasOwn(value,'transactionHash')&&!text(value.transactionHash,HASH))
    ||(Object.hasOwn(value,'errorCode')&&(typeof value.errorCode!=='string'||!value.errorCode||value.errorCode.length>80))
    ||!plain(b)||!sameKeys(b,['account','operation','wallet','terms-hash','job','agreement-hash','network','authorization'])||!Object.values(b).every(v=>typeof v==='string'&&v.length>0&&v.length<=128&&!v.includes('\0'))
    ||b.operation!==id||b.account!==s.account||b.wallet!==purchase.buyer||b['terms-hash']!==purchase.termsHash||b.job!==s.job||b['agreement-hash']!==s.agreementHash||b.network!==s.network
    ||!text(b.wallet,WALLET)||!text(b['terms-hash'],HASH)||!text(b['agreement-hash'],HASH)
    ||!isCanonicalJobId(b.job)||!text(b.network,LABEL)||b.authorization!=='one immutable Agreement CREATE; no payment or completion'
    ||!plain(value.request)||!sameKeys(value.request,['method','params'])||value.request.method!=='sendTransaction'||!Array.isArray(value.request.params)||value.request.params.length!==1
    ||!plain(r)||!sameKeys(r,CREATE_REQUEST)||r.kind!==BROWSER_HANDOFF_REQUEST.kind||r.profile!==BROWSER_HANDOFF_REQUEST.profile||r.artifactKind!=='Agreement'||r.owner!==`did:demos:agent:${b.wallet.slice(2)}`
    ||r.jobId!==b.job||r.network!==b.network||r.logicalAddress!==fixedPriceAgreementLogicalAddress(b.job)||r.contentHash!==b['agreement-hash']||!text(r.envelopeHash,HASH)
    ||!agreementCreate(r.transaction,r,b.wallet,s)
    ||!text(value.requestHash,HASH)||requestDigest(value.request)!==value.requestHash||!text(value.correlation,/^[A-Za-z0-9_-]{32}$/)
    ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0)fail();
  return true;
}
// Two more buyer records the source transport journal keeps at rest, at a
// stage no journal table here holds. Each is recognized only in its
// producer's shape, for the buyer of a purchase in this database on that
// purchase's network and chain identity; anything else at either stage fails
// closed, and neither is recognized in a seller journal.
// failed (src/wallet/devnet-native-transport.mjs readback): the buyer's native
// transfer read back as failed at its saved nonce fence, or its nonce consumed
// by another transfer, kept under its intent key and on its wallet lane. It
// is resolved and never resent, as an observed transfer is.
const FAILURES=[['blockNumber','nonceFence'],['blockNumber','supersededByHash']];
// The signature is checked in the form the configured node uses (its
// getNetworkInfo answer, passed in as authority.networkInfo). Without a usable
// answer the record is not called corrupt: it is listed in authority.unavailable,
// and its other fields are still checked.
function failedTransfer(key,value,purchases,authority){
  if(value?.stage!=='failed')return false;
  const tx=value.signedTransaction,c=tx?.content,n=value.networkBinding,f=value.failure;
  const badSignature=()=>{
    const verdict=verifyDemosTransactionSignature({networkInfo:authority.networkInfo,activatedChains:authority.activatedChains,hash:tx.hash,signature:tx.signature.data,publicKey:c.from});
    if(verdict==='unavailable')authority.unavailable.push({source:'node2-transport.sqlite',recordId:sha(key)});
    return verdict==='invalid';
  };
  if(!plain(value)||!sameKeys(value,['stage','hash','nonce','signedTransaction','networkBinding','failure'])||!text(value.hash,HASH)||!Number.isSafeInteger(value.nonce)||value.nonce<0
    ||!plain(tx)||tx.hash!==value.hash||!plain(c)||c.type!=='native'||!text(c.from,WALLET)||c.nonce!==value.nonce||!plain(n)
    ||!Array.isArray(c.data)||c.data[0]!=='native'||c.data[1]?.nativeOperation!=='send'||!Array.isArray(c.data[1].args)||c.data[1].args.length!==2||c.data[1].args[0]!==c.to
    ||sha(JSON.stringify(c))!==tx.hash||tx.signature?.type!=='ed25519'||badSignature()
    ||![...purchases.values()].some(p=>p.buyer===c.from&&p.scope.network===n.network&&p.scope.chainIdentity===n.chainIdentity)
    ||(key!==`devnet/native-transfer/${value.hash}`&&key!==`devnet/native-wallet/${JSON.stringify([n.network,n.chainIdentity,c.from])}`)
    ||!plain(f)||!FAILURES.some(keys=>sameKeys(f,keys))||!Number.isSafeInteger(f.blockNumber)||f.blockNumber<0
    ||(Object.hasOwn(f,'nonceFence')?!Number.isSafeInteger(f.nonceFence)||f.nonceFence<0||f.nonceFence+1!==value.nonce:!text(f.supersededByHash,HASH)||f.supersededByHash===value.hash))fail();
  return true;
}
// denied-unsigned (src/dacs/demos-sr2-adapter.mjs retireDeniedHandoff, which
// the broker's resume runs for a denied handoff): the adapter plan of the
// purchase's Agreement CREATE (sr2/adapter/<plan>), for the Agreement the
// purchase retained, retired once no signed record, no program of its name
// and the account's nonce just below the plan's proved it unsent. It never
// issues again.
const DENIED_PLAN=['logicalAddress','artifact','writer','owner','programName','hash','envelopeHash','artifactKind','metadata','scope','planId','nativeAddress','nonce','stage','payload','authorizationMessage','evidenceMode','authorizationProfile','retirement'];
function deniedCreatePlan(key,value,purchases){
  if(value?.stage!=='denied-unsigned')return false;
  const c=value.payload?.content,t=value.retirement;
  const own=(p)=>{
    const s=p.scope;
    if(p.buyer!==value.owner||!isCanonicalJobId(s.job)||value.logicalAddress!==fixedPriceAgreementLogicalAddress(s.job)||value.hash!==s.agreementHash
      ||!plain(s.agreement)||canonicalize(value.artifact)!==canonicalize(s.agreement)||typeof s.transportBinding!=='string')return false;
    const binding=JSON.parse(s.transportBinding),r={logicalAddress:value.logicalAddress,contentHash:value.hash,envelopeHash:value.envelopeHash};
    if(!plain(binding)||!text(binding.bindingId,HASH)||binding.network!==s.network||binding.chainIdentity!==s.chainIdentity
      ||typeof binding.endpoint!=='string'||value.scope!==canonicalize([new URL(binding.endpoint).origin,s.chainIdentity,binding.bindingId]))return false;
    const metadata={logicalAddress:r.logicalAddress,contentHash:r.contentHash,envelopeHash:r.envelopeHash,artifactKind:'Agreement',networkBinding:binding};
    // planWrite hashes the content before takeStorageAnchorHandoff appends
    // network and chainIdentity. Retirement changes only stage and proof.
    const initial={...c};delete initial.network;delete initial.chainIdentity;
    return agreementCreate(value.payload,r,p.buyer,s)&&value.nonce===c.nonce
      &&value.programName===c.data[1].programName&&value.nativeAddress===c.to
      &&value.envelopeHash===sha(canonicalize(value.artifact))&&canonicalize(value.metadata)===canonicalize(metadata)
      &&value.planId===sha(canonicalize([value.scope,value.writer,value.logicalAddress]))
      &&value.authorizationMessage===sha(JSON.stringify(initial));
  };
  try{
    if(plain(value)&&sameKeys(value,DENIED_PLAN)&&text(value.planId,HASH)&&key===`sr2/adapter/${value.planId}`&&text(value.owner,WALLET)&&value.writer===`did:demos:agent:${value.owner.slice(2)}`
      &&value.artifactKind==='Agreement'&&value.evidenceMode==='explicit-pinned-transport-single-node'&&value.authorizationProfile==='embedded-storage-anchor-create'
      &&plain(c)&&plain(value.artifact)&&Number.isSafeInteger(value.nonce)&&value.nonce>=1&&[...purchases.values()].some(own)
      &&plain(t)&&sameKeys(t,['reason','observedAccountNonce'])&&t.reason==='explicit-wallet-denial-without-signed-record'&&Number.isSafeInteger(t.observedAccountNonce)&&t.observedAccountNonce>=0
      &&value.nonce===t.observedAccountNonce+1)return true;
  }catch{}
  fail();
}
function sellerWrites(operatorState,present,sellers,buyers,stateRoots,purchases,authority) {
  if(!operatorState)return {journals:null,unconfirmed:[]};
  const rows=[];
  for(const source of present)for(const row of journal(join(operatorState,source),stateRoots))rows.push({...row,source});
  const owner=(r)=>r.signedTransaction?.content?.from??r.transaction?.content?.from??r.owner??r.payload?.content?.from;
  const owners=new Set([...sellers,...rows.filter(row=>row.source!=='node2-transport.sqlite').map(row=>owner(row.value))].filter(value=>/^0x[0-9a-f]{64}$/.test(value??'')));
  const unconfirmed=[];
  for(const {source,key,value} of rows){
    if(source==='node2-transport.sqlite'){
      if(payerRecord(key,value,purchases)||buyerCreateHandoff(key,value,purchases)||failedTransfer(key,value,purchases,authority)||deniedCreatePlan(key,value,purchases))continue;
      if(!JOURNAL_STAGES.has(value?.stage))fail();
      if(!owners.has(owner(value))){
        if(PENDING.has(value.stage)&&!buyers.has(owner(value)))fail();
        continue;
      }
    }
    if(!JOURNAL_STAGES.has(value?.stage))fail();
    if(!PENDING.has(value.stage)||(value.stage==='broadcast-accepted'&&((source==='seller-wallet.sqlite'&&key.startsWith('sr2/wallet/'))||(source==='seller-artifacts.sqlite'&&key.startsWith('demo/wallet/')))))continue;
    const candidate=value.hash??value.transactionHash;
    if(candidate!==undefined&&!HASH.test(candidate))fail();
    unconfirmed.push({source,recordId:sha(key),hash:candidate??null,stage:value.stage,nextExpected:'original write readback; never resend'});
  }
  return {journals:present,unconfirmed};
}
// networkInfo is the configured node's getNetworkInfo answer, when the caller
// has one; it only decides how a retained failed transfer's signature is checked.
export function opsHealth({databasePath,operatorState=null,logPath=null,now=Date.now(),recentHours=24,limit=100,thresholds={},networkInfo=null}={}) {
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(limit)||limit<1||limit>10000||!Number.isFinite(recentHours)||recentHours<=0)fail();
  for(const [key,value] of Object.entries(thresholds))if(!Object.hasOwn(STAGE_THRESHOLDS,key)||!Number.isSafeInteger(value)||value<1)fail();
  const configured={...STAGE_THRESHOLDS,...thresholds};
  // Every selected file set is validated, and every directory holding live
  // state is known, before any scratch is created or stale scratch is swept.
  const database=fileSet(databasePath),stateRoots=[...database.roots],present=[];
  if(operatorState){
    operatorState=realpathSync(operatorState);stateRoots.push(operatorState);
    // The operator's app opens exactly <state>/app/dacs-chatgpt.sqlite. The
    // database's real path must be that unresolved name, so app/ must be a
    // real directory: an app/ link to another service or a renamed database
    // (whose WAL stays at the old name) cannot bind.
    if(database.real!==join(operatorState,'app','dacs-chatgpt.sqlite'))fail();
    for(const source of JOURNALS){
      const path=join(operatorState,source);
      if(selectedPath(path)===null){if(SIDECARS.some(suffix=>identity(`${path}${suffix}`)!==null))fail();continue;}
      stateRoots.push(...fileSet(path).roots);present.push(source);
    }
  }
  const {rows,legacyPublications}=readPurchases(databasePath,now,stateRoots),logged=logPath?purchaseTimeline(readFileSync(logPath,'utf8')):new Map();
  // An unresolved write attempt alerts at once, on any stage (expired,
  // cancelled and completed included), until a resolving attempt. The unknown
  // payment stages are never terminal and keep their thresholds. Possible
  // seller Vet writes show only in the seller artifact journal: without it the
  // purchase alerts; with it, its pending rows below decide. An unresolved
  // read is only a notice.
  const sellerJournal=present.includes('seller-artifacts.sqlite'),vetUnread=(row)=>row.vet&&!sellerJournal;
  const immediate=(row)=>row.writes.length>0||vetUnread(row)||row.operatorAction;
  // A held purchase stays operator-action-required, as in its stuck entry,
  // when its last attempt was not sent; lastAttemptDispatched still shows it.
  const outcome=(row)=>row.unknown?'unknown-readback-required':row.vet?(sellerJournal?'seller-journal-checked':'seller-journal-not-read'):row.operatorAction?'operator-action-required':row.lastAttemptDispatched===false?'not-sent':row.unresolvedRead?'unresolved-read':'recorded';
  const stuck=rows.filter(row=>immediate(row)||!TERMINAL.has(row.stage)&&now-row.enteredAt>configured[row.stage]).map(row=>({purchaseId:row.purchaseId,stage:row.stage,ageMs:Math.max(0,now-row.enteredAt),thresholdMs:immediate(row)?0:configured[row.stage],
    outcome:row.unknown?'unknown-readback-required':vetUnread(row)?'seller-journal-not-read':row.operatorAction?'operator-action-required':'waiting',nextExpected:row.unknown?NEXT.unknown:vetUnread(row)?SELLER_VET_NEXT:row.operatorAction?CHAIN_READBACK_NEXT:NEXT[row.stage],unresolvedWrites:row.writes}));
  const purchases=rows.filter(row=>row.updatedAt>=now-recentHours*3_600_000).slice(0,limit).map(row=>{
    const timeline=row.history.map(event=>({...event,source:'database'}));
    for(const event of logged.get(row.purchaseId)??[]){
      if(event.step!=='stage-change')continue;
      timeline.push({lane:'log',stage:stage(event.stage),timestampMs:event.timestampMs,source:'server-log'});
    }
    timeline.sort((a,b)=>a.timestampMs-b.timestampMs);
    return {purchaseId:row.purchaseId,stage:row.stage,ageMs:Math.max(0,now-row.enteredAt),outcome:outcome(row),...(row.lastAttemptDispatched===false?{lastAttemptDispatched:false}:{}),...(sellerFailureCause(row.causeCode)?{causeCode:row.causeCode}:{}),unresolvedWrites:row.writes,timeline:timeline.map((event,i)=>({stage:event.stage,lane:event.lane,source:event.source,at:new Date(event.timestampMs).toISOString(),gapMs:i?Math.max(0,event.timestampMs-timeline[i-1].timestampMs):0}))};
  });
  const authority={networkInfo,activatedChains:new Set(),unavailable:[]};
  const {journals,unconfirmed}=sellerWrites(operatorState,present,rows.map(row=>row.seller),new Set(rows.map(row=>row.buyer).filter(value=>/^0x[0-9a-f]{64}$/.test(value??''))),stateRoots,new Map(rows.map(row=>[row.purchaseId,row])),authority);
  return {format:'dacs-ops-health/v2',legacyPublications,at:new Date(now).toISOString(),healthy:stuck.length===0&&unconfirmed.length===0&&authority.unavailable.length===0&&!legacyPublications.some(row=>OPEN_PUBLICATIONS.has(row.status)),purchases,stuck,seller:{journals,unconfirmed},signatureAuthorityUnavailable:authority.unavailable,thresholdsMs:configured};
}
export function formatOpsHealth(report) {
  const lines=[`${report.healthy?'HEALTHY':'STUCK'} ${report.at}`];
  for(const purchase of report.purchases){
    lines.push(`purchase ${purchase.purchaseId} stage=${purchase.stage} ageMs=${purchase.ageMs} outcome=${purchase.outcome}${purchase.causeCode?` cause=${purchase.causeCode}`:''}${purchase.lastAttemptDispatched===false?' last-attempt=not-sent':''}`);
    for(const event of purchase.timeline)lines.push(`  ${event.at} gapMs=${event.gapMs} ${event.lane}:${event.stage} source=${event.source}`);
  }
  if(!report.purchases.length)lines.push('recent purchases: none');
  for(const row of report.stuck)lines.push(`stuck ${row.purchaseId} stage=${row.stage} ageMs=${row.ageMs} thresholdMs=${row.thresholdMs} outcome=${row.outcome}${row.unresolvedWrites.length?` writes=${row.unresolvedWrites.join(',')}`:''} next=${row.nextExpected}`);
  for(const row of report.legacyPublications)lines.push(`legacy publication ${row.operationId} status=${row.status} next=${row.nextExpected}`);
  const {unconfirmed,journals}=report.seller;
  lines.push(journals===null?'seller journals: not selected':`seller journals: ${journals.join(', ')||'absent'}`);
  for(const row of unconfirmed)lines.push(`seller readback source=${row.source} record=${row.recordId} hash=${row.hash??'unknown'} stage=${row.stage} next=${row.nextExpected}`);
  if(journals?.length&&!unconfirmed.length)lines.push('seller unconfirmed writes: none');
  for(const row of report.signatureAuthorityUnavailable)lines.push(`signature authority unavailable source=${row.source} record=${row.recordId} next=read the configured node's network information; the record is neither accepted nor called corrupt`);
  return `${lines.join('\n')}\n`;
}
