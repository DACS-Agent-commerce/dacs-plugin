const FAILED=['payment_failed','payment_mismatch','expired','terms_changed','cancelled','superseded','agreement_rejected'];
const WAITING=['agreement-signing','agreement-anchored','committed','seller-committed','awaiting-claim','native-payment-evidence-held','payment-evidenced','delivery-ready','delivered'];
// A notSaved view is one check's own unsaved copy: it offers nothing to sign,
// so the page reads again instead of waiting for the buyer.
export function purchasePhase(view){
  const p=view.evidence?.protocol;
  if(FAILED.includes(view.status)||p?.stage?.endsWith('-rejected')||p?.stage==='completed')return 'ended';
  if(['awaiting_approval','approved'].includes(view.status))return 'approval';
  if(['payment_handoff','broadcast_reported','payment_uncertain'].includes(view.status))return 'readback';
  if(view.status==='agreement_pending')return !p?.notSaved&&(p?.stage==='identity'||view.autoAdvance?.requiresSignature!==false)?'approval':'readback';
  if(view.status==='settled_verified'){
    if(!p)return 'ended';
    if(p.stage==='payment-observed')return p.nativePayment?.subsequentProtocol?.includes('native-evidence-readback-required')?'readback':'ended';
    if(p.stage==='awaiting-countersignature')return p.notSaved||view.autoAdvance?.requiresSignature===false?'readback':'approval';
    if(p.stage==='delivery-ready'&&p.delivery?.evidencePublication==='deferred-to-explicit-sdk-finaliser')return 'ended';
    if(p.stage==='delivered'&&/deferred|held/.test(p.limits?.bundleFinalization??''))return 'ended';
    return WAITING.includes(p.stage)?'readback':'ended';
  }
  return 'ended';
}
// Closed buyer access is final for this page: it is shown, automatic polling
// stops, and only a manual re-check reads again.
export const refused=(error)=>error?.code==='buyer_access_closed';
// The portal answers almost every refusal with 409, so a 409 alone says
// nothing. Only these conflicts have their answer in the saved purchase state
// (another tab or check moved it, or the server already holds this result),
// so the page reads that state back. Every other refusal (balance, limits,
// wallet, signature, seller delegation, Agreement context or terms, network)
// is the buyer's to act on and is shown as the server's text.
export const AMBIGUOUS_CONFLICTS=Object.freeze(['invalid_state','protocol_check_stale','hash_conflict','already_countersigned','native_payment_already_issued']);
// A chain read that failed (the buyer balance could not be read exactly) is
// not the buyer's to act on: the page shows the server's text and keeps
// reading, as for an unavailable upstream.
export const TRANSIENT=Object.freeze(['buyer_balance_unavailable']);
export const recoverable=(error)=>!refused(error)&&(error?.indeterminate===true||['outcome_unknown','upstream_unavailable',...TRANSIENT].includes(error?.code)||error?.status===409&&AMBIGUOUS_CONFLICTS.includes(error?.code));
// Progress only: observation times, deadline projections, poll metadata and
// attempt notes change on every read without the purchase moving.
export function purchaseProgress(view){
  const p=view?.evidence?.protocol,d=p?.delivery,b=p?.bundle,w=p?.deliveryDeadline;
  return JSON.stringify([view?.status,p?.stage,view?.autoAdvance?.requiresSignature,view?.verification?.outcome,view?.evidence?.receipt?.txHash,view?.evidence?.reportedTxHash,
    p?.agreement?.hash,p?.commitment?.contentHash,p?.claim?.settlementId,p?.paymentEvidence?.ref,Boolean(p?.nativeEvidence),w?.deliveryVerified,Boolean(w?.overdue),Boolean(w?.laterDelivery),w?.pastDueMs>0,
    d?.status,d?.fulfilmentId,d?.deliverableRef,d?.evidenceRef,d?.evidenceHash,d?.evidencePublication,d?.evidenceHold?.reason,Boolean(d?.evidenceReceipt),b?.bundleHash,b?.buyerCopy,b?.sellerCopy]);
}
// The wallet request a purchase screen would make: the Agreement plan's
// presentation, the Agreement, purchase approval or bundle signatures. Payment
// and CREATE are marked at their wallet calls.
export function signatureKind(view){
  if(purchasePhase(view)!=='approval')return null;
  if(view.status==='agreement_pending')return view.evidence?.protocol?.stage==='agreement-signing'?'agreement-signature':'agreement-plan-presentation';
  if(view.status==='awaiting_approval')return 'approval';
  return view.evidence?.protocol?.stage==='awaiting-countersignature'?'bundle':null;
}

export function createPurchaseAutoAdvance({read,render,notice=()=>{},end=()=>{},refusal=error=>notice(error.message,'bad'),setTimer=setTimeout,clearTimer=clearTimeout,storage=null,key='dacs:auto'}){
  let timer=null,inflight=null,paused=false,stopped=false,view=null,delay=500,recovering=false,txHash=null,disposed=false;
  // Tab-scoped journal (sessionStorage on the page): one entry per wallet
  // request kind, written before the wallet is asked and never cleared.
  const memory=new Map(),journal=storage??{getItem:k=>memory.get(k)??null,setItem:(k,v)=>{memory.set(k,v);}};
  // An earlier page claimed both Agreement steps as one 'agreement' entry; a
  // tab holding it stays readback-only for both, and it is never written now.
  const LEGACY={'agreement-plan-presentation':'agreement','agreement-signature':'agreement'};
  const asked=kind=>journal.getItem(`${key}:${kind}`)!==null||(Object.hasOwn(LEGACY,kind)&&journal.getItem(`${key}:${LEGACY[kind]}`)!==null);
  // After teardown nothing more is claimed, asked of the wallet, read or
  // rendered from this page.
  function live(){if(disposed)throw Object.assign(new Error('This page was closed. Nothing more is signed, sent or checked from it.'),{code:'page_closed'});}
  function claim(kind){
    live();
    if(asked(kind))return false;
    journal.setItem(`${key}:${kind}`,'asked');
    if(!asked(kind))throw new Error('This tab could not record the wallet request. Nothing was requested.');
    return true;
  }
  // The page's hash only stands in for a lost report. Once the server holds a
  // pointer (the page's, or one corrected through verify_deal), or refuses the
  // page's as a conflict, reads stop supplying it.
  function retire(next){if(next?.evidence?.reportedTxHash)txHash=null;}
  const conflict=error=>{if(error?.code==='hash_conflict')txHash=null;};
  function clear(){if(timer!==null)clearTimer(timer);timer=null;}
  // A transient refusal's own text says what the page waits for; then it reads the state.
  function checking(error){if(TRANSIENT.includes(error?.code))notice(error.message,'warn');notice('Checking purchase state. Nothing is signed or resent.','warn');}
  function refuse(error){stopped=true;recovering=false;clear();end();refusal(error);}
  function schedule(){
    clear();
    if(paused||stopped||inflight||(!recovering&&(!view||purchasePhase(view)!=='readback'&&!readbackOnly(view))))return;
    timer=setTimer(()=>{timer=null;void check();},delay);
  }
  function observe(next){
    if(disposed)return;
    view=next;recovering=false;retire(next);
    if(purchasePhase(next)==='ended'){stopped=true;clear();end();return;}
    schedule();
  }
  async function check(){
    if(disposed)return null;
    if(inflight)return inflight;
    clear();
    inflight=Promise.resolve().then(()=>read(txHash)).then(next=>{
      const changed=purchaseProgress(view)!==purchaseProgress(next);
      delay=changed?500:Math.min(delay*2,8000);
      recovering=paused;retire(next);
      if(!paused&&!stopped){observe(next);render(next);}
      return next;
    }).catch(error=>{
      conflict(error);
      if(disposed)return null;
      if(refused(error))refuse(error);
      else if(!recoverable(error)){stopped=true;clear();end();notice(error.message,'bad');}
      else{recovering=true;delay=Math.min(delay*2,8000);checking(error);}
      return null;
    }).finally(()=>{inflight=null;schedule();});
    return inflight;
  }
  const signatureAsked=next=>{const kind=signatureKind(next);return kind!==null&&asked(kind);};
  function readbackOnly(next){return ['payment_handoff','broadcast_reported','payment_uncertain'].includes(next.status)||asked('payment')&&['awaiting_approval','approved'].includes(next.status)||signatureAsked(next);}
  return{
    observe,check,
    async pause(){paused=true;clear();await inflight;},
    resume(){paused=false;schedule();},
    // After teardown every late action error is absorbed without a notice.
    recover(error){
      if(disposed)return true;
      if(refused(error)){refuse(error);return true;}
      if(!recoverable(error))return false;
      conflict(error);recovering=true;delay=500;
      checking(error);schedule();return true;
    },
    get recovering(){return recovering;},
    markWrite(){return claim('payment');},
    claim,asked,signatureAsked,live,
    get disposed(){return disposed;},
    rememberHash(hash){if(typeof hash==='string'&&/^(0x)?[0-9a-fA-F]{64}$/.test(hash))txHash=hash;},
    readbackOnly,
    // Teardown is final: no late action, read or failure restarts polling.
    destroy(){disposed=stopped=true;clear();},
  };
}

export function createPurchaseWalletIdle({wallet=()=>null,document=globalThis.document,now=()=>Date.now(),idleMs=300000,setTimer=setTimeout,clearTimer=clearTimeout}){
  let timer=null,last=now(),hiddenAt=document.hidden?now():null,active=true;
  function clear(){if(timer!==null)clearTimer(timer);timer=null;}
  function lock(){clear();wallet()?.lock();}
  function schedule(){
    clear();if(!active||!wallet()||wallet().getPublicState().locked)return;
    const remaining=Math.min(last+idleMs,hiddenAt===null?Infinity:hiddenAt+idleMs)-now();
    if(remaining<=0){lock();return;}
    timer=setTimer(schedule,remaining);
  }
  const activity=event=>{if(event.isTrusted&&!document.hidden){last=now();schedule();}};
  const visibility=()=>{
    if(document.hidden){hiddenAt=now();schedule();return;}
    if(hiddenAt!==null&&now()-hiddenAt>=idleMs){hiddenAt=null;lock();return;}
    hiddenAt=null;schedule();
  };
  document.addEventListener('pointerdown',activity);
  document.addEventListener('keydown',activity);
  document.addEventListener('visibilitychange',visibility);
  return{
    unlocked(){if(!active){lock();return false;}last=now();schedule();return !wallet()?.getPublicState().locked;},
    end(){active=false;lock();},
    destroy(){active=false;lock();document.removeEventListener('pointerdown',activity);document.removeEventListener('keydown',activity);document.removeEventListener('visibilitychange',visibility);},
  };
}
