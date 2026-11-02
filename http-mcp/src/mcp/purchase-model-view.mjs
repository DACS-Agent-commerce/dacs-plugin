// Model-visible purchase result while the report view is on: main's
// purchase-tool copy (seller-content.mjs with `purchase: true`, the result
// the switch-off path returns), unchanged in every field but one. Every field
// main's result carries (the settlement and recovery fields included) reaches
// the model and the App as main shows it: the plugin's own verdicts and
// recovery sentences raw, seller-supplied text in main's labelled seller-data
// envelope. The one field the view changes is the verified report wrapper,
// protocol.delivery.report: it is kept only when the purchase view would show
// the same report (purchased-report.mjs: stage, service layer, report shape,
// locator, payload hash and recomputed SHA-256), and its coordinates keep only
// a validated block reference and canonical address. Otherwise it is null.
import { sellerContentForModel } from './seller-content.mjs';
import { purchasedReportView } from '../../public/portal/purchased-report.mjs';

const matching = (pattern) => (v) => (typeof v === 'string' && pattern.test(v) ? v : undefined);
const TX = matching(/^(?:0x)?[0-9a-fA-F]{64}$/);
const STOR = matching(/^stor-(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const INT = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : matching(/^[0-9]{1,20}$/)(v));
const TIME = (v) => (Number.isSafeInteger(v) && v >= 0 ? v
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
// A logical address must be one of this purchase's own canonical addresses.
const LOCATOR = (v, job) => (typeof v === 'string' && typeof job === 'string'
  && ['dacs3:agreement:', 'dacs4:deliverable:', 'dacs4:evidence:', 'dacs4:payment:'].some((prefix) => v === `${prefix}${job}`) ? v : STOR(v));
// The block reference keeps only its validated fields; none left is null.
function block(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const kept = Object.entries({ id: TX, height: INT, timestamp: TIME }).filter(([key]) => Object.hasOwn(v, key))
    .map(([key, check]) => [key, check(v[key])]).filter(([, value]) => value !== undefined);
  return kept.length ? Object.fromEntries(kept) : null;
}

// `shown` is purchasedReportView(out.protocol), which the caller also narrates,
// so the report's SHA-256 is recomputed once per result.
export function modelPurchaseView(out, shown = out.protocol ? purchasedReportView(out.protocol) : null) {
  const copy = sellerContentForModel(out, { purchase: true });
  const delivery = copy.protocol?.delivery, wrapper = delivery?.report;
  if (!wrapper) return copy;
  const job = out.protocol.jobId;
  const report = shown?.available ? { ...wrapper, coordinates: { block: block(wrapper.coordinates.block), address: LOCATOR(wrapper.coordinates.address, job) ?? null } } : null;
  return { ...copy, protocol: { ...copy.protocol, delivery: { ...delivery, report } } };
}
