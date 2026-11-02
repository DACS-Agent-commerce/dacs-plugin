import { types } from 'node:util';
import { OperationError } from '../operations.mjs';
import { networkIdentityLabel, PURCHASE_STATUS_HELP } from '../purchases.mjs';
import { protocolView, usesAgreementContext, usesNativeDemDelivery } from '../dacs/protocol-purchases.mjs';
import { usesNativePaymentEvidence } from '../dacs/native-payment-evidence-consumer.mjs';
import { DEVNET_NATIVE_COMMITMENT_MARKER } from '../devnet-demo/commitment-consumer.mjs';
import { FIXTURE_FINALITY, FIXTURE_SUBSTRATE } from '../dacs/fixture-anchors.mjs';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';
import { vetNotPerformedRef } from '../dacs/purchase-protocol.mjs';
import { normalizeDemAmount } from '../dacs/listing.mjs';
import { AGREEMENT_CONTEXT_SOURCE, isOperatorContextAuthority } from '../dacs/agreement-context-consumer.mjs';
import { DEM_DELIVERY_CONTEXT_SOURCE, isDemDeliveryContextAuthority } from '../dacs/dem-delivery-context-consumer.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Single-line text: no Unicode control (Cc), format (Cf: every zero-width and bidi
// control), line separator (Zl) or paragraph separator (Zp) characters.
const text = (v, max = 240) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v) ? v : null;
const hash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
const address = (v) => typeof v === 'string' && /^(?:0x)?[0-9a-f]{64}$/.test(v) ? v : null;
const claim = (v) => typeof v === 'string' && /^did:demos:agent:[0-9a-f]{64}$/.test(v) ? v : null;
const integer = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const time = (v) => integer(v) !== null && v <= 8640000000000000 ? v : null;
const iso = (v) => text(v, 30) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v ? v : null;
const signature = (v) => typeof v === 'string' && /^(?:(?:0x)?[0-9a-f]{128}|[A-Za-z0-9_-]{86})$/.test(v) ? v : null;
// A native storage address or a DACS locator `dacsN:<kind>:<id>`; never a URL.
const locator = (v) => text(v, 256) && /^(?:stor-(?:[0-9a-f]{40}|[0-9a-f]{64})|dacs[1-5]:[a-z][a-z-]{0,31}:[A-Za-z0-9:._%-]+)$/.test(v) ? v : null;
const origin = (v) => {
  if (!text(v, 256)) return null;
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && u.origin === v ? v : null; } catch { return null; }
};
// The origin of a transport endpoint stored as the binding writes it: an http(s)
// root URL `<origin>/`, so without credentials, another path, a query or a fragment.
const endpointOrigin = (v) => {
  if (!text(v, 256)) return null;
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && `${u.origin}/` === v ? u.origin : null; } catch { return null; }
};
// The stored price exactly as the purchase path writes it (purchaseSupport in
// listing.mjs): a canonical positive DEM amount and its base units. It comes from a
// signed Listing, which the SDK caps at 16,384 bytes, so a longer amount was never stored.
// It is now also at most 78 OS digits; one stored before that bound fails this check.
const price = (v) => {
  if (!object(v) || typeof v.amount !== 'string' || v.amount.length > 16384 || v.currency !== 'DEM') return false;
  try { const { amount, amountOs } = normalizeDemAmount(v.amount); return amount === v.amount && amountOs === v.amountOs; } catch { return false; }
};
const refValid = (v) => object(v) && v.anchor?.kind === 'storage-program' && locator(v.anchor.locator) && hash(v.contentHash);
const statuses = new Set(Object.keys(PURCHASE_STATUS_HELP));
const stages = new Set(['identity','agreement-signing','agreement-anchored','seller-committed','committed','payment-observed','awaiting-claim','payment-evidenced','native-payment-evidence-held','delivery-ready','delivered','awaiting-countersignature','completed','agreement-rejected','claim-rejected','evidence-rejected','delivery-rejected','bundle-rejected']);
// The protocol enters these stages only after the payment verified (protocol-purchases.mjs advance and recheck).
const PAID_STAGES = new Set(['payment-observed','awaiting-claim','payment-evidenced','native-payment-evidence-held','delivery-ready','delivered','awaiting-countersignature','completed','claim-rejected','evidence-rejected','delivery-rejected','bundle-rejected']);
// Not completed and not progressing. Some of these can still change (a late payment
// hash revives a cancelled purchase), so the wording never says they are final.
const STOPPED = new Set(['agreement_rejected','terms_changed','expired','cancelled','payment_failed','payment_mismatch','superseded']);
const profiles = new Set(['dacs-chatgpt-plugin/fixed-price-pay-dem/v1','dacs-chatgpt-plugin/sr2-wallet-agreement/v1','dacs-chatgpt-plugin/devnet-pay-dem-purchase/v1']);
const PUBLICATIONS = new Set(['native-read-back','pending-readback','held-evidence-rejected','held-readback-only','deferred-to-explicit-sdk-finaliser']);
// Stored hold reasons can hold raw errors or seller text, so only the stored status is mapped to fixed wording.
const HOLD = new Map([['pending', 'Delivery evidence has not been read back yet.'], ['rejected', 'Delivery evidence was rejected or did not match the verified Deliverable.']]);
const NATIVE_EVIDENCE_HELD = 'Payment evidence is held: it has not been read back and verified.';
// Anchor receipt metadata is exported only from these fixed vocabularies: the SDK's
// native Demos receipt, the plugin's loopback fixture receipt, and the SDK lifecycle
// and disposition enums. Anything else is exported as null.
const SUBSTRATES = new Set(['demos', FIXTURE_SUBSTRATE]);
const FINALITY_PROFILES = new Set(['demos-bft-confirmed-native-read', FIXTURE_FINALITY]);
const TRANSACTION_KINDS = new Set(['demos-storage-program', 'fixture-sr2-write']);
const ANCHOR_STATES = new Set(['submitted','accepted','included','finalized','rejected','dropped','replaced','expired','reorged']);
const DISPOSITIONS = new Set(['established', 'indeterminate']);
const known = (set, v) => typeof v === 'string' && set.has(v) ? v : null;
const currentDelivery = (p) => ['delivery-ready','delivered','awaiting-countersignature','completed','bundle-rejected'].includes(p.stage) && ['verified','delivery-ready','delivered'].includes(p.delivery?.status) && refValid(p.delivery.deliverableRef) && hash(p.delivery.payloadHash) === p.delivery.deliverableRef.contentHash;
const copiesVerified = (p) => p.stage === 'completed' && hash(p.bundle?.bundleHash) && iso(p.bundle?.verifiedAt) && refValid(p.bundle?.buyerCopyRef) && refValid(p.bundle?.sellerCopyRef) && signature(p.bundle?.buyerSignature) && signature(p.bundle?.sellerSignature);
const stopped = (c) => STOPPED.has(c.operation.status) || ['agreement-rejected','claim-rejected','evidence-rejected','delivery-rejected'].includes(c.p.stage);
const LISTING_CHECKS = ['directory-detail-hash-matches-summary','directory-coordinates-match','chain-anchor-present','chain-readback-equals-directory-detail','chain-anchor-owner-is-seller','catalog-observation-fresh','standard-reader-verified','v0.1-purchase-support'];
const HISTORY = 'Recorded observations made by this server at the listed times; this document performs no fresh verification.';
// Only refusals made by this module during the current projection leave as they are.
// Each projection marks its own refusals in a fresh set, so anything else thrown while
// projecting becomes a content-free refusal: an OperationError from a caller's callback,
// a refusal kept from an earlier call and thrown again, or one from a nested call.
let marks = null;
const refuse = (code, message) => { const error = new OperationError(code, message); marks?.add(error); return error; };
const invalid = (message = 'the stored purchase shape or profile is unsupported') => refuse('receipt_invalid_operation', message);
const notOwner = () => refuse('receipt_not_owner', 'only the owning account may export this purchase');

// A copy of only the parts of a stored purchase that this module reads, made without
// calling anything on the input. Nothing outside those parts is listed or read: not the
// delivered report, the rest of the signed Listing, the seller's payment-evidence
// answer, claims, attempts, or anything stored there later, so none of it can change or
// block an export.
// - `terms` is built by the plugin when the purchase is prepared, and is copied whole:
//   own, enumerable data properties of plain objects (prototype Object.prototype or
//   null) and dense arrays, within fixed budgets. An accessor, toJSON function, proxy,
//   class instance, symbol key, `__proto__` key or non-finite number refuses the
//   purchase, and undefined is treated as JSON treats it.
// - Everything else is read by name along the fixed paths in READ, by property
//   descriptor. An object on a path must be a plain object, and a list an array with
//   the ordinary prototype, read by index. On a path, an accessor, a non-enumerable
//   property, a proxy, an array hole, or a function, symbol, bigint or non-finite
//   value refuses the purchase, and so does a class instance (including `Date`, or an
//   `Array` subclass) in place of an expected object or list. A list longer than the
//   module accepts is read as empty. Any other object or array, class instance or
//   not, where a value or the other kind of container is expected is kept only as an
//   empty one of its kind and never read; no check accepts it.
const SNAPSHOT_LIMITS = Object.freeze({ depth: 48, nodes: 100_000, chars: 8_000_000 });
const WHOLE = Symbol('copied whole'), VALUE = Symbol('value');
class List { constructor(items, max) { this.items = items; this.max = max; Object.freeze(this); } }
const path = (entries) => Object.freeze(Object.assign(Object.create(null), entries));
const fields = (...names) => Object.fromEntries(names.map(name => [name, VALUE]));
const REF = path({ anchor: path(fields('kind', 'locator')), contentHash: VALUE });
const RECEIPT = path({ ...fields('logicalAddress', 'nativeAddress', 'contentHash', 'observedAt', 'substrate', 'finalityProfile', 'observationDisposition', 'state'),
  transactionRef: path(fields('kind', 'value')), blockRef: path(fields('id', 'height', 'timestamp')) });
const PARTIES = new List(path({ role: VALUE, vetRecordRef: path({ ...REF, signer: VALUE }) }), 4);
const READ = path({
  ...fields('accountId', 'kind', 'id', 'status'), terms: WHOLE,
  state: path({
    preparedVerification: path({ checks: new List(path(fields('name', 'ok')), LISTING_CHECKS.length), evidence: path(fields('checkedAt', 'chainRpcOrigin', 'chainMode')) }),
    protocol: path({
      stage: VALUE, listing: path({ offering: path(fields('title')) }),
      agreement: path({ ref: REF, hash: VALUE, artifact: path({ terms: path(fields('deadline')), parties: PARTIES }), anchorReceipt: RECEIPT }),
      planned: path({ draft: path({ parties: PARTIES }) }),
      commitment: path({ ref: REF, ...fields('contentHash', 'verifiedAt'), anchorReceipt: RECEIPT }),
      transfer: path(fields('txHash', 'blockNumber')),
      paymentEvidence: path({ ref: REF, anchorReceipt: RECEIPT, ...fields('evidenceHash', 'verifiedAt') }),
      delivery: path({ ...fields('status', 'payloadHash', 'evidenceHash', 'evidencePublication'), deliverableRef: REF, anchorReceipt: RECEIPT, evidenceRef: REF, evidenceReceipt: RECEIPT, evidenceHold: path(fields('status')) }),
      bundle: path({ ...fields('bundleHash', 'finalisedAt', 'verifiedAt', 'buyerSignature', 'sellerSignature'), buyerCopyRef: REF, sellerCopyRef: REF }),
      deliveryDeadline: path({ overdue: path(fields('deadline', 'checkedAt', 'read', 'disposition', 'obligatedParty', 'seller', 'authority')),
        laterDelivery: path({ ...fields('verifiedAt', 'deliveredAt', 'deliveredAtSource', 'payloadHash'), deliverableRef: REF }) }),
      agreementContext: path(fields('source', 'authority', 'scopeHash', 'resolvedAt')),
    }),
  }),
});
function snapshot(input) {
  const budget = { nodes: SNAPSHOT_LIMITS.nodes, chars: SNAPSHOT_LIMITS.chars };
  const spend = (field, n) => { if ((budget[field] -= n) < 0) throw invalid('the stored purchase exceeds the receipt size limits'); };
  const field = (v, key) => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !('value' in d) || !d.enumerable) throw invalid();
    return d.value;
  };
  // A plain object (prototype Object.prototype or null), or with `array` an array with
  // the ordinary prototype; never a proxy.
  const container = (v, array) => {
    if (types.isProxy(v)) throw invalid();
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw invalid();
  };
  // A JSON value; anything else that is not an object (a function, symbol, bigint or
  // non-finite number) could only come from code, and refuses.
  const scalar = (v) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v;
    throw invalid();
  };
  // The whole-copy used for `terms`, within the depth and size budgets.
  const copy = (v, depth) => {
    if (v === null || typeof v !== 'object') { scalar(v); if (typeof v === 'string') spend('chars', v.length); return v; }
    if (depth > SNAPSHOT_LIMITS.depth) throw invalid();
    const array = Array.isArray(v);
    container(v, array);
    spend('nodes', 1);
    if (array) {
      // The length is charged before the keys are listed, so an oversized array is
      // refused without enumerating it.
      spend('nodes', v.length);
      if (Reflect.ownKeys(v).length !== v.length + 1) throw invalid();
      const out = [];
      for (let i = 0; i < v.length; i++) { const item = field(v, String(i)); out.push(item === undefined ? null : copy(item, depth + 1)); }
      return out;
    }
    const out = {}, keys = Reflect.ownKeys(v);
    spend('nodes', keys.length);
    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') throw invalid();
      spend('chars', key.length);
      const value = field(v, key);
      if (value !== undefined) out[key] = copy(value, depth + 1);
    }
    return out;
  };
  // Reads `v` by `rule`: WHOLE, VALUE, a List, or a path of names.
  const read = (v, rule) => {
    if (rule === WHOLE) return copy(v, 1);
    if (v === null || typeof v !== 'object') return scalar(v);
    if (types.isProxy(v)) throw invalid();
    const array = Array.isArray(v);
    if (rule === VALUE || array !== rule instanceof List) return array ? [] : {};
    container(v, array);
    if (array) {
      if (v.length > rule.max) return [];
      return Array.from({ length: v.length }, (_, i) => { const item = field(v, String(i)); return item === undefined ? null : read(item, rule.items); });
    }
    const out = {};
    for (const name of Object.keys(rule)) {
      const d = Object.getOwnPropertyDescriptor(v, name);
      if (d === undefined) continue;
      if (!('value' in d) || !d.enumerable) throw invalid();
      if (d.value !== undefined) out[name] = read(d.value, rule[name]);
    }
    return out;
  };
  return read(input, READ);
}

function context(operation, { accountId, enabled, now = () => Date.now() } = {}) {
  if (enabled !== true) throw refuse('showcase_receipt_disabled', 'showcase receipts are disabled');
  if (!object(operation) || types.isProxy(operation)) throw invalid('a stored purchase operation is required');
  // The owner is read from its property descriptor, so no getter runs before the gate.
  const owner = Object.getOwnPropertyDescriptor(operation, 'accountId');
  if (!text(accountId, 128) || !owner || !('value' in owner) || owner.value !== accountId) throw notOwner();
  // Every later read uses the snapshot, and ownership is checked again on it.
  const op = snapshot(operation);
  const t = op.terms, p = op.state?.protocol;
  if (op.accountId !== accountId || !object(t) || !object(t.buyer) || t.buyer.accountId !== accountId) throw notOwner();
  if (op.kind !== 'purchase' || !text(op.id, 128) || !statuses.has(op.status) || !object(t) || !object(op.state)
    || !address(t.buyer.wallet) || !claim(t.seller?.claim) || !address(t.seller?.payee)
    || !text(t.listing?.listingId, 128) || !Number.isSafeInteger(t.listing.version) || t.listing.version < 1 || !refValid({ anchor: t.listing.anchor, contentHash: t.listing.contentHash })
    || !price(t.price) || !text(t.network, 80)
    || !object(t.domain) || !['simulated-fixture','public-chain-read'].includes(t.domain.mode) || (t.domain.mode === 'public-chain-read' && !hash(t.domain.chainIdentity))
    || (t.protocol && (!object(p) || !profiles.has(t.protocol.profile) || !text(t.protocol.jobId, 128) || !stages.has(p.stage) || (PAID_STAGES.has(p.stage) && op.status !== 'settled_verified'))) || (!t.protocol && p)) {
    throw invalid();
  }
  const at = typeof now === 'function' ? now() : now;
  if (time(at) === null) throw refuse('receipt_invalid_time', 'now must be an epoch millisecond timestamp');
  // The finality and Vet limits depend only on the terms (profile, Agreement-context
  // source and transport binding), so they are taken from a view of the terms and stage
  // alone, never from stored records.
  const limits = (t.protocol ? protocolView({ status: op.status, terms: t, state: { protocol: { stage: p.stage } } })?.limits : null) ?? {};
  const c = { operation: op, t, p: p ?? {}, limits, generatedAt: new Date(at).toISOString() };
  c.resolved = usesAgreementContext(op) && contextResolved(c, at);
  return { ...c, vet: vetStatement(c) };
}

// The stored marker the plugin writes when it resolves the configured Agreement context
// (protocol-purchases.mjs savePlan): its source matches the terms, with the authority
// label that source's writer accepts, the scope hash and an ISO resolution time no
// later than this projection.
const CONTEXT_AUTHORITY = new Map([[AGREEMENT_CONTEXT_SOURCE, isOperatorContextAuthority], [DEM_DELIVERY_CONTEXT_SOURCE, isDemDeliveryContextAuthority]]);
const contextResolved = ({ t, p }, at) => object(p.agreementContext) && p.agreementContext.source === t.protocol.agreementContext
  && CONTEXT_AUTHORITY.get(p.agreementContext.source)?.(p.agreementContext.authority) === true && hash(p.agreementContext.scopeHash) !== null
  && iso(p.agreementContext.resolvedAt) !== null && Date.parse(p.agreementContext.resolvedAt) <= at;

// A party's Vet record reference, when it is well formed: at the canonical address for
// this job and party, carrying a signer identifier, and not the not-performed
// placeholder. When the references come from an Agreement context, only once a valid
// resolution marker is stored.
function vetRef(c, role) {
  const { operation, t, p } = c;
  if (usesAgreementContext(operation) && !c.resolved) return null;
  const parties = p.agreement?.artifact?.parties ?? p.planned?.draft?.parties;
  const ref = Array.isArray(parties) && parties.length <= 4 ? parties.find(x => x?.role === role)?.vetRecordRef : null;
  const party = role === 'buyer' ? `did:demos:agent:${t.buyer.wallet.replace(/^0x/, '')}` : t.seller.claim;
  return refValid(ref) && ref.anchor.locator === compositeVerificationAddress(t.protocol?.jobId, party) && claim(ref.signer)
    && ref.contentHash !== vetNotPerformedRef(t.protocol?.jobId, party).contentHash ? ref : null;
}

// What this purchase stores about Vet. A profile whose Vet references come from an
// Agreement context describes the whole profile in its limit, which can claim more
// than a given purchase holds, so its wording here follows what is stored. None of it
// says the referenced records or their signatures were checked: this module checks
// neither.
const VET_UNRESOLVED = 'No validated Agreement-context resolution marker is stored; Vet references are not exported.';
const VET_REFERENCES = 'After the stored Agreement context resolved, this operation retained canonical Vet record references for both parties, each carrying a signer identifier; this receipt does not verify the referenced records or their signatures, and does not retain independently verified per-party Vet results.';
const VET_INCOMPLETE = 'After the stored Agreement context resolved, this operation did not retain canonical Vet record references for both parties; this receipt does not verify any referenced record.';
function vetStatement(c) {
  if (!usesAgreementContext(c.operation)) return text(c.limits.vet);
  if (!c.resolved) return VET_UNRESOLVED;
  return vetRef(c, 'buyer') && vetRef(c, 'seller') ? VET_REFERENCES : VET_INCOMPLETE;
}

// Any failure other than a refusal made by this projection leaves as a content-free
// refusal, never another error's code or text.
function project(build, operation, options) {
  const outer = marks, mine = new WeakSet();
  marks = mine;
  try { return build(context(operation, options)); }
  catch (error) { throw mine.has(error) ? error : invalid('the stored purchase could not be projected'); }
  finally { marks = outer; }
}

function deadline(p) {
  const o = p.deliveryDeadline?.overdue, l = p.deliveryDeadline?.laterDelivery;
  const overdue = object(o) && time(o.deadline) !== null && time(o.checkedAt) !== null && o.read === 'not-present' && o.disposition === 'indeterminate'
    && o.obligatedParty === 'seller' && claim(o.seller) && o.authority === 'local-observation'
    ? { deadline: o.deadline, checkedAt: o.checkedAt, read: o.read, disposition: o.disposition, obligatedParty: o.obligatedParty, seller: o.seller, authority: o.authority } : null;
  const laterDelivery = object(l) && time(l.verifiedAt) !== null && time(l.deliveredAt) !== null && l.deliveredAtSource === 'seller-recorded delivery SettlementEvidence.observedAt' && refValid(l.deliverableRef) && hash(l.payloadHash)
    ? { verifiedAt: l.verifiedAt, deliveredAt: l.deliveredAt, deliveredAtSource: l.deliveredAtSource,
      deliverableRef: { anchor: { kind: l.deliverableRef.anchor.kind, locator: l.deliverableRef.anchor.locator }, contentHash: l.deliverableRef.contentHash }, payloadHash: l.payloadHash } : null;
  return { deadline: overdue?.deadline ?? time(p.agreement?.artifact?.terms?.deadline), overdue, laterDelivery };
}

function stageRows(c) {
  const { operation, t, p } = c;
  const checks = operation.state.preparedVerification?.checks;
  const identified = Array.isArray(checks) && checks.length === LISTING_CHECKS.length && LISTING_CHECKS.every(name => checks.filter(x => object(x) && x.name === name && x.ok === true).length === 1);
  const negotiated = refValid(p.agreement?.ref) && hash(p.agreement.hash) === p.agreement.ref.contentHash && refValid(p.commitment?.ref) && iso(p.commitment.verifiedAt)
    && ['seller-committed','committed','payment-observed','awaiting-claim','payment-evidenced','native-payment-evidence-held','delivery-ready','delivered','awaiting-countersignature','completed','claim-rejected','evidence-rejected','delivery-rejected','bundle-rejected'].includes(p.stage);
  const evidence = refValid(p.paymentEvidence?.ref) && ['payment-evidenced','delivery-ready','delivered','awaiting-countersignature','completed','delivery-rejected','bundle-rejected'].includes(p.stage);
  const delivered = currentDelivery(p), settled = evidence && delivered && refValid(p.delivery.evidenceRef) && p.delivery.status !== 'delivery-ready';
  const plainSettled = !t.protocol && operation.status === 'settled_verified';
  const row = (name, status, reason) => ({ name, status, reason });
  return [
    row('Identify', operation.status === 'terms_changed' ? 'rejected' : identified ? 'done' : 'pending', operation.status === 'terms_changed' ? 'Stored terms no longer match the selected Listing.' : identified ? 'The prepare-time Listing checks passed; identity and service quality have narrower scope.' : 'No passing prepare-time Listing check set is stored.'),
    row('Vet', 'pending', c.vet ?? 'No per-party Vet verification results are stored in this operation.'),
    row('Negotiate', p.stage === 'agreement-rejected' ? 'rejected' : negotiated ? 'done' : 'pending', p.stage === 'agreement-rejected' ? 'The stored Agreement stage was rejected.' : negotiated ? 'The bound Agreement and independently read commitment are retained; inclusion is not BFT finality.' : 'A bound Agreement and verified commitment readback are not both stored.'),
    row('Settle', ['claim-rejected','evidence-rejected','delivery-rejected'].includes(p.stage) ? 'rejected' : settled ? 'done' : delivered || evidence || hash(p.transfer?.txHash) || plainSettled ? 'observed' : 'pending',
      p.stage === 'delivery-rejected' ? 'The current delivery was rejected; retained references are historical only.' : ['claim-rejected','evidence-rejected'].includes(p.stage) ? 'The stored payment claim or evidence stage was rejected.' : settled ? 'Payment evidence, Deliverable and delivery evidence passed stored readback checks.' : delivered ? 'Report available; delivery evidence is pending or held.' : evidence ? 'Payment evidence retained; current delivery is not verified.' : hash(p.transfer?.txHash) ? 'Transfer observed by one RPC tuple only; delivery is pending.' : plainSettled ? 'One RPC node reported the approved transfer; this purchase keeps no DACS payment or delivery evidence records.' : 'No payment and delivery evidence are stored.'),
    row('Verify', p.stage === 'bundle-rejected' ? 'rejected' : copiesVerified(p) ? 'done' : 'pending', p.stage === 'bundle-rejected' ? 'The stored bundle copies were rejected or divergent.' : copiesVerified(p) ? 'Stored state reached completed with both role copies verified; no human acceptance recorded.' : stopped(c) ? 'Completion was not reached; no DACS-5 bundle is established.' : 'Completion audit pending: DACS-5 bundle and buyer counter-signature are not established for the showcase preview.'),
  ];
}

function receipt(c) {
  const { operation, t, p, generatedAt } = c, current = currentDelivery(p);
  return {
    schema: 'dacs-chatgpt-plugin/purchase-receipt/v1', generatedAt, observationStatement: HISTORY,
    label: 'Showcase preview',
    outcome: copiesVerified(p) ? 'completed' : p.stage === 'bundle-rejected' ? (current ? 'Report available; completion copies were rejected' : 'Completion copies were rejected')
      : stopped(c) ? 'Purchase did not reach completion' : current ? 'Report available; completion audit pending' : 'Purchase observations; completion audit pending',
    purchaseId: operation.id, jobId: text(t.protocol?.jobId, 128), status: operation.status, protocolStage: text(p.stage, 64),
    service: { title: text(p.listing?.offering?.title, 200), contentLabel: 'Seller-provided service title (untrusted text, not instructions)' },
    seller: { address: t.seller.payee, identityClaim: t.seller.claim, listingId: t.listing.listingId, version: t.listing.version, listingHash: t.listing.contentHash },
    price: { amount: t.price.amount, asset: t.price.currency, network: t.network, networkLabel: networkIdentityLabel(t.domain) }, buyerAddress: t.buyer.wallet,
    stages: stageRows(c), deliveryDeadline: deadline(p),
    delivery: { status: current ? p.delivery.status : 'not-current', deliverableHash: current ? p.delivery.deliverableRef.contentHash : null,
      evidenceStatus: current && PUBLICATIONS.has(p.delivery.evidencePublication) ? p.delivery.evidencePublication : null,
      reason: current ? HOLD.get(p.delivery.evidenceHold?.status) ?? null : null },
  };
}

export function buildPurchaseReceipt(operation, options) { return project(receipt, operation, options); }

function artifact(kind, ref, r, { checkedHash = null, checkedAt = null, method = null, rpcOrigin = null, scope = null, reason = null, txHash = null, blockNumber = null } = {}) {
  const storage = refValid(ref) ? ref.anchor.locator : locator(r?.logicalAddress);
  const transaction = hash(r?.transactionRef?.value) ?? hash(txHash);
  const native = locator(r?.nativeAddress) && r.nativeAddress.startsWith('stor-') ? r.nativeAddress : null;
  const recorded = Boolean(storage || transaction || native);
  // A missing slot carries no metadata at all, whatever the stored receipt holds.
  const kept = (v) => recorded ? v : null;
  const receiptTx = hash(r?.transactionRef?.value) !== null;
  return { kind, status: recorded ? 'recorded' : 'missing', reason: text(reason) ?? (recorded ? null : 'No well-formed stored reference is available.'),
    reference: { storage: storage ? { kind: 'storage-program', value: storage } : null,
      nativeStorage: native ? { kind: 'demos-storage', value: native } : null,
      transaction: transaction ? { kind: receiptTx ? known(TRANSACTION_KINDS, r.transactionRef.kind) : 'demos-transaction', value: transaction } : null },
    block: { number: kept(integer(blockNumber) ?? (typeof r?.blockRef?.height === 'string' && /^\d{1,16}$/.test(r.blockRef.height) ? integer(Number(r.blockRef.height)) : null)), id: kept(text(r?.blockRef?.id, 128)), timestamp: kept(time(r?.blockRef?.timestamp)) },
    checkedHash: kept(hash(checkedHash) ?? (refValid(ref) ? ref.contentHash : hash(r?.contentHash))),
    observation: { checkedAt: kept(iso(checkedAt)), recordedAt: kept(time(r?.observedAt)), method: kept(text(method)), rpcOrigin: kept(origin(rpcOrigin)), scope: kept(text(scope, 400)),
      substrate: kept(known(SUBSTRATES, r?.substrate)), finalityProfile: kept(known(FINALITY_PROFILES, r?.finalityProfile)), disposition: kept(known(DISPOSITIONS, r?.observationDisposition)), state: kept(known(ANCHOR_STATES, r?.state)) } };
}

function evidence(c) {
  const { operation, t, p, limits: v } = c, prepared = operation.state.preparedVerification?.evidence;
  // The transport endpoint is named only for records this profile reads through it:
  // the Agreement always, the rest only when that record is native rather than a fixture.
  const endpoint = t.protocol?.transportBinding?.source === 'devnet-agreement-transport/v1' ? endpointOrigin(t.protocol.transportBinding.endpoint) : null;
  const via = (native) => native ? endpoint : null, scope = text(v.finality);
  const nativeDelivery = via(usesNativeDemDelivery(operation));
  const vet = (role) => {
    const ref = vetRef(c, role);
    return artifact(`${role}-vet`, ref, null, { checkedAt: p.agreementContext?.resolvedAt, method: ref ? 'provider-context-reference' : null, scope: c.vet });
  };
  const b = p.bundle;
  return { schema: 'dacs-chatgpt-plugin/purchase-evidence/v1', generatedAt: c.generatedAt, observationStatement: HISTORY, receipt: receipt(c),
    artifacts: [
      artifact('Listing', { anchor: t.listing.anchor, contentHash: t.listing.contentHash }, null, { checkedHash: t.listing.contentHash, checkedAt: prepared?.checkedAt, method: 'prepare-time-readback', rpcOrigin: prepared?.chainRpcOrigin, scope: prepared?.chainMode }),
      vet('buyer'), vet('seller'),
      artifact('Agreement', p.agreement?.ref, p.agreement?.anchorReceipt, { checkedHash: p.agreement?.hash, method: 'readback', rpcOrigin: via(true), scope }),
      artifact('commitment', p.commitment?.ref, p.commitment?.anchorReceipt, { checkedHash: p.commitment?.contentHash, checkedAt: p.commitment?.verifiedAt, method: 'readback', rpcOrigin: via(t.protocol?.sellerCommitment === DEVNET_NATIVE_COMMITMENT_MARKER), scope }),
      artifact('payment', null, null, { txHash: p.transfer?.txHash, blockNumber: p.transfer?.blockNumber, scope: 'observed-by-one-rpc-tuple-only; inclusion is not BFT finality', method: 'readback' }),
      artifact('payment-evidence', p.paymentEvidence?.ref, p.paymentEvidence?.anchorReceipt, { checkedHash: p.paymentEvidence?.evidenceHash, checkedAt: p.paymentEvidence?.verifiedAt, method: 'readback', rpcOrigin: via(usesNativePaymentEvidence(operation)), scope,
        reason: p.stage === 'native-payment-evidence-held' ? NATIVE_EVIDENCE_HELD : null }),
      artifact('Deliverable', p.delivery?.deliverableRef, p.delivery?.anchorReceipt, { checkedHash: p.delivery?.payloadHash, method: 'readback', rpcOrigin: nativeDelivery, scope: currentDelivery(p) ? scope : 'historical reference; delivery is not current' }),
      artifact('delivery-evidence', p.delivery?.evidenceRef, p.delivery?.evidenceReceipt, { checkedHash: refValid(p.delivery?.evidenceRef) ? p.delivery.evidenceHash : null, method: refValid(p.delivery?.evidenceRef) ? 'readback' : null, rpcOrigin: nativeDelivery, scope,
        reason: HOLD.get(p.delivery?.evidenceHold?.status) ?? null }),
      artifact('buyer-completion-copy', b?.buyerCopyRef, null, { checkedAt: copiesVerified(p) ? b.verifiedAt : null, method: copiesVerified(p) ? 'readback' : null, scope }),
      artifact('seller-completion-copy', b?.sellerCopyRef, null, { checkedAt: copiesVerified(p) ? b.verifiedAt : null, method: copiesVerified(p) ? 'readback' : null, scope }),
    ],
    bundle: object(b) && hash(b.bundleHash) ? { bundleHash: b.bundleHash, finalisedAt: time(b.finalisedAt), verifiedAt: iso(b.verifiedAt),
      buyerCounterSignature: signature(b.buyerSignature), sellerSignature: signature(b.sellerSignature) } : null,
    limits: { finality: scope ?? 'not-established', vet: c.vet ?? 'not-recorded', humanAcceptance: 'not-recorded', links: 'No fixed network explorer base is configured; references have no links.',
      missingObservation: 'Null observation fields were not retained in the purchase operation; no new verification or acknowledgement is inferred.' },
  };
}

export function exportPurchaseEvidence(operation, options) { return project(evidence, operation, options); }
