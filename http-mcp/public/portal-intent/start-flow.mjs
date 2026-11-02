// The Start sequence for one DACS purchase with the embedded wallet
// (DACS_INTENT_APPROVAL=on). DOM-free: the portal (start.mjs) and Node tests
// drive the same function.
//
// Order and server checks are main's: identity, plan, Agreement signature,
// the browser Agreement session (devnet profile), submit, then the one
// Agreement CREATE. The difference is who approves: one intent dialog, then
// the wallet gate (gate.mjs) checks each structured draft and derives the
// bytes itself. A mismatch throws before that step is signed.
import { buildIntent } from './intent.mjs';

// api(path, body) -> parsed JSON or throws; broker: the existing browser
// Agreement broker client (devnet profile only); provider: the wallet's
// request() target for the broker's one CREATE delivery; recheck(): the
// portal's settled re-check after that write.
export async function runStart({ id, token, address, gate, api, origin, broker = null, provider = null, recheck = null, log = () => {}, now = () => Date.now() }) {
  const base = `/portal/api/purchase/${encodeURIComponent(id)}/intent`;
  const started = await api(`${base}/start`, { token, address });
  const intent = await buildIntent({ view: started, start: started.start, wallet: address, now: now() });
  if (intent.profile === 'devnet' && (!broker || !provider)) throw new Error('This purchase needs the browser Agreement session; nothing was signed.');
  // The CREATE's operator RPC auth signatures are fenced by the SDK class the gate gave this session.
  if (intent.profile === 'devnet' && !gate.fencesSdk) throw new Error('This wallet session cannot hold its operator RPC auth signatures to the Start; nothing was signed.');
  log('Review the purchase start in your wallet. It is the only approval before payment.');
  await gate.open(intent);
  try {
    const s = started.start;
    let signature;
    let delegationSignature;
    if (s.needs?.identitySignature) {
      log('Signing your identity presentation (checked against the approved start).');
      signature = await gate.signIdentity(s.identity?.bundle);
    } else await gate.noteIdentity(s.identity?.bundle);
    if (intent.steps.includes('delegation')) {
      if (s.needs?.delegationSignature) delegationSignature = await gate.signDelegation(s.delegation?.payload);
      else gate.noteDelegation();
    }
    const planned = await api(`${base}/plan`, { token, intent: intent.record, ...(signature ? { signature } : {}), ...(delegationSignature ? { delegationSignature } : {}) });
    let agreementSignature;
    let anchorSignature;
    if (planned.plan?.needs?.agreementSignature) {
      log('Signing the Agreement (job, Listing, price, payee, parties and vet records checked).');
      agreementSignature = await gate.signAgreement(planned.plan.draft);
      if (intent.profile === 'fixture') anchorSignature = await gate.signAnchorAuthorization();
    } else await gate.noteAgreement(planned.plan?.draft);
    // Checked by now: the deadline is the Listing's term after generation.
    log(`Agreement checked: deliverable ${intent.agreement.deliverable.hash}, delivery deadline ${new Date(planned.plan.draft.terms.deadline).toISOString()}.`);
    if (intent.profile === 'devnet') await broker.authenticate({ address, sign: (message) => gate.signBrokerChallenge(message, { origin }) });
    let next = await api(`${base}/sign`, { token, intent: intent.record, ...(agreementSignature ? { agreementSignature } : {}), ...(anchorSignature ? { anchorSignature } : {}) });
    // This check lost to newer saved progress: read the saved state back and
    // write nothing from this view (main's countersign handling).
    if (next.evidence?.protocol?.notSaved) return recheck ? await recheck() : next;
    if (intent.profile === 'devnet' && next.evidence?.protocol?.stage === 'agreement-signing') {
      gate.expectAgreementCreate();
      const covered = gate.coverCreate(provider);
      log('Writing the Agreement record from your wallet (checked against the approved start; sent once).');
      let delivered;
      try {
        delivered = await broker.approveOne(covered);
      } catch (error) {
        throw gate.lastRefusal ?? error;
      }
      if (gate.lastRefusal) throw gate.lastRefusal;
      if (delivered?.state && delivered.state !== 'completed') log(`Agreement record: ${delivered.state}. Nothing is resent; the server reads it back.`);
      if (recheck) next = await recheck();
    }
    return next;
  } finally {
    gate.finish();
  }
}
