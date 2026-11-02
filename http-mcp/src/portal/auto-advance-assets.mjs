// The default entry stays byte-for-byte unchanged. Enabled purchase pages use
// an entry with narrowly checked hooks into that same renderer and wallet.
export function autoAdvancePortalPage(page){
  const entry='/portal/assets/portal.js',script=`<script type="module" src="${entry}"></script>`;
  if(page.split(entry).length!==2||page.split(script).length!==2)throw new Error('portal auto-advance entry drift');
  return page.replace(entry,'/portal/assets/auto-portal.js');
}
export function autoAdvancePortalSource(source){
  const replace=(old,next)=>{
    if(source.split(old).length!==2)throw new Error('portal auto-advance hook drift');
    source=source.replace(old,next);
  };
  replace("const $ = (id)","import { createPurchaseAutoAdvance, createPurchaseWalletIdle } from './purchase-auto-advance.mjs';\nlet purchaseAuto=null,purchaseIdle=null;\nconst $ = (id)");
  replace("const data = await response.json().catch(() => ({}));", "let data;try{data=await response.json();}catch(error){throw Object.assign(error,{indeterminate:true});}");
  replace("{ code: data.error }","{ code: data.error, status: response.status }");
  replace("const response = await fetch(path,", "let response;\n  try { response = await fetch(path,");
  replace("credentials: 'same-origin' });", "credentials: 'same-origin', signal: AbortSignal.timeout(10000) }); } catch(error) { throw Object.assign(error,{indeterminate:true}); }");
  replace("{ txHash: hash === 'unknown' ? null : hash }", "{ txHash: hash === 'unknown' ? null : hash, code:'outcome_unknown' }");
  replace("if (busy) return;", "if (busy||purchaseAuto?.recovering||purchaseAuto?.disposed) return;");
  // After pagehide no wallet call is made. Each step's first request is
  // claimed right before the call, and a claim refuses after teardown; every
  // signature, including the later ones of a step, also checks here. A
  // signature that returns after teardown is dropped: nothing is submitted.
  replace("  const res = await provider.request({ method: 'sign', params: [message] });", "  purchaseAuto?.live();\n  const res = await provider.request({ method: 'sign', params: [message] });\n  purchaseAuto?.live();");
  replace("for (const b of document.querySelectorAll(LOCKABLE)) b.disabled = false;", "for (const b of document.querySelectorAll(LOCKABLE)) b.disabled = purchaseAuto?.recovering===true;");
  // An action that waited for a read during teardown does not start.
  replace("    const all = [...document.querySelectorAll(LOCKABLE)];", "    await purchaseAuto?.pause();\n    if(purchaseAuto?.disposed)return;\n    const all = [...document.querySelectorAll(LOCKABLE)];");
  replace("      await fn();\n    } catch (error) {\n      log(error.message, 'bad');", "      await fn();\n    } catch (error) {\n      if(!purchaseAuto?.recover(error))log(error.message, 'bad');");
  replace("      busy = false;\n      // Re-enable", "      busy = false;\n      purchaseAuto?.resume();\n      // Re-enable");
  replace("    await embedded.ready;", "    await embedded.ready;\n    if(!embedded.getPublicState().locked)purchaseIdle?.unlocked();");
  replace("  provider = embeddedProvider;", "  if(purchaseIdle?.unlocked()===false)return;\n  provider = embeddedProvider;");
  const start=source.indexOf('async function purchaseFlow(id)'),end=source.indexOf('// ---------------- identity add/remove');
  if(start<0||end<start)throw new Error('portal purchase flow drift');
  let purchase=source.slice(start,end);
  source=source.slice(0,start)+'AUTO_PURCHASE_FLOW'+source.slice(end);
  const edit=(old,next)=>{
    if(purchase.split(old).length!==2)throw new Error('portal purchase auto-advance hook drift');
    purchase=purchase.replace(old,next);
  };
  // Each signature step is journaled in this tab before the wallet is asked;
  // a journaled step stays readback-only (purchaseAuto.readbackOnly).
  const once=kind=>`if(!purchaseAuto.claim('${kind}'))throw Object.assign(new Error('This wallet request was already made in this tab. It stays readback-only.'),{code:'outcome_unknown'});\n`;
  // The plan presentation (with its app-session authorization) and the
  // Agreement signature are separate steps with their own claims: a plan
  // saved after a 202 still lets this tab ask for the Agreement signature.
  edit("    const presentation = await walletSign(", `    ${once('agreement-plan-presentation')}    const presentation = await walletSign(`);
  edit("    const agreementSignature = await walletSign(", `    ${once('agreement-signature')}    const agreementSignature = await walletSign(`);
  edit("        const signature = await walletSign(challenge.message);", `        ${once('approval')}        const signature = await walletSign(challenge.message);`);
  edit("    const bundleSignature = await walletSign(", `    ${once('bundle')}    const bundleSignature = await walletSign(`);
  // The broker session lives only in this page's memory. After a reload the
  // standalone CREATE authenticates through the broker's own flow first. The
  // CREATE is claimed in this tab only when the broker hands it to the wallet:
  // a failure before that (no session, a refused or lost claim) asks nothing
  // and claims nothing, and a refused claim needs a new session. Like every
  // signing action it is not offered on a notSaved view.
  edit("  const token = fragment.get('t')", "  let agreementBrokerSession=false;\n  async function approveCreate(){\n    if(purchaseAuto.asked('create'))throw Object.assign(new Error('This CREATE remains readback-only.'),{code:'outcome_unknown'});\n    let handed=false;\n    const wallet={request:request=>{handed=true;"+once('create')+"return provider.request(request);}};\n    try{await offlineAgreementBroker.approveOne(wallet);}\n    catch(error){if(!handed){if(error.code)agreementBrokerSession=false;throw error;}if(!error.code&&!error.status)error.indeterminate=true;throw error;}\n  }\n  const token = fragment.get('t')");
  edit("      await offlineAgreementBroker.approveOne(provider);", "      await approveCreate();");
  edit("        await offlineAgreementBroker.authenticate({ address, sign: walletSign });", "        await offlineAgreementBroker.authenticate({ address, sign: walletSign });\n        agreementBrokerSession=true;");
  // A broker session that completes after teardown submits no Agreement.
  edit("    let next = await api(`/portal/api/purchase/${id}/agreement/sign`,", "    purchaseAuto.live();\n    let next = await api(`/portal/api/purchase/${id}/agreement/sign`,");
  edit("      nodes.push(recheckAction());", "      if(offlineAgreementBroker&&!ev.protocol?.notSaved&&!purchaseAuto.asked('create')&&view.autoAdvance?.requiresSignature===false&&ev.protocol.stage==='agreement-signing')nodes.push(action('Approve Agreement CREATE',async()=>{needWallet({writes:'payment'});needPaymentNetwork(t);needBoundWallet(t);if(!agreementBrokerSession){log('Authenticate this exact Agreement browser session with your linked wallet. Payment remains held.');await offlineAgreementBroker.authenticate({address,sign:walletSign});agreementBrokerSession=true;}await approveCreate();render(await recheckUntilSettled());}));\n      nodes.push(recheckAction());");
  edit("  const render = (view) => {", "  const render = (view) => {\n    if(purchaseAuto.disposed)return;\n    purchaseAuto.observe(view);");
  edit("    if (view.status === 'agreement_pending') {", "    if(purchaseAuto.readbackOnly(view)){\n      nodes.push(el('p',{},purchaseAuto.signatureAsked(view)?'This tab already asked your wallet for this signature. It will not be requested again; checking whether it was recorded.':'Checking payment readback. No approval or transfer will be repeated.'),view.verification?.outcome==='hash_required'?el('p',{},'Use your wallet history and verify_deal to supply the transaction hash. Recovery remains readback-only.'):null,recheckAction());\n    } else if (view.status === 'agreement_pending') {");
  edit("if (!ev.protocol?.notSaved && (!agreementOnly || ['identity', 'agreement-signing'].includes(ev.protocol.stage)))", "if (!ev.protocol?.notSaved && view.autoAdvance?.requiresSignature===true)");
  edit("ev.protocol?.stage === 'awaiting-countersignature' && !ev.protocol.notSaved && !ev.protocol.bundle?.counterSigned ? action", "purchaseAuto.signatureAsked(view) ? el('p',{},'This tab already asked your wallet to counter-sign. It will not be requested again; checking whether it was recorded.') : ev.protocol?.stage === 'awaiting-countersignature' && !ev.protocol.notSaved && !ev.protocol.bundle?.counterSigned && view.autoAdvance?.requiresSignature!==false ? action");
  const pollStart=purchase.indexOf('  async function recheckUntilSettled() {'),pollEnd=purchase.indexOf('  const recheckAction =',pollStart);
  if(pollStart<0||pollEnd<pollStart)throw new Error('portal recheck helper drift');
  // A check that ends after teardown, or finds the page closed, renders
  // nothing and makes no fallback /view read.
  purchase=purchase.slice(0,pollStart)+'  async function recheckUntilSettled(){const next=await purchaseAuto.check();purchaseAuto.live();return next ?? await api(`/portal/api/purchase/${id}/view`,{token});}\n'+purchase.slice(pollEnd);
  edit("    let txHash = null;", "    let txHash = null,walletAsked=false;");
  edit("      txHash = await walletSend(view.payload);", "      if(!purchaseAuto.markWrite())throw Object.assign(new Error('This payment remains readback-only.'),{code:'outcome_unknown'});\n      walletAsked=true;\n      txHash = await walletSend(view.payload);\n      purchaseAuto.rememberHash(txHash);");
  // A page closed before the payment request asked the wallet nothing, so it
  // reports nothing. A result from a wallet already asked is still reported,
  // whatever its error code: the page tracks the call itself.
  edit("    } catch (error) {\n      const reported =", "    } catch (error) {\n      if(!walletAsked&&error.code==='page_closed')throw error;\n      purchaseAuto.rememberHash(error.txHash);\n      if(!error.code)error.indeterminate=true;\n      const reported =");
  // Closed buyer access shows main's refusal text with only a manual Re-check.
  edit("\n  render(await api(`/portal/api/purchase/${id}/view`, { token }));\n}", "\n  purchaseIdle=createPurchaseWalletIdle({wallet:()=>embedded});\n  if(embedded?.getPublicState().locked===false)purchaseIdle.unlocked();\n  purchaseAuto=createPurchaseAutoAdvance({read:(txHash)=>api(`/portal/api/purchase/${id}/auto/recheck`,{token,...(txHash?{txHash}:{})}),render,notice:log,end:()=>purchaseIdle.end(),refusal:error=>flow(el('p',{class:'bad'},error.message),recheckAction()),storage:sessionStorage,key:`dacs:auto:${id}`});\n  window.addEventListener('pagehide',()=>{purchaseAuto.destroy();purchaseIdle.destroy();},{once:true});\n  try { render(await api(`/portal/api/purchase/${id}/view`,{token})); }\n  catch(error){if(!purchaseAuto.recover(error))throw error;}\n}");
  return source.replace('AUTO_PURCHASE_FLOW',purchase);
}
