import { sanitizeSellerName } from '../../public/portal/seller-name.mjs';
import { renderShowcaseProgress, showcaseProgressHtml } from '../../public/portal/showcase-progress.mjs';

// Small MCP Apps views. Self-contained HTML with no network access (empty
// connect/resource domain allowlists); they only render the tool result the
// host delivers over the open MCP Apps bridge (ui/initialize,
// ui/notifications/tool-result) and ask the host to open portal links
// (ui/open-link). Tools remain fully usable without them. URIs are versioned:
// a changed template gets a new URI (hosts cache by URI), and every referring
// tool imports the constant below so all consumers stay consistent.
import { PURCHASED_REPORT_SCRIPT, PURCHASED_REPORT_STYLE } from '../../public/portal/purchased-report.mjs';
import { ACCOUNT_PRICE_PROSE } from './seller-content.mjs';

const PROTOCOL_VERSION = '2026-01-26';
// v2: listing text fields arrive as seller-data envelopes ({label, text}); the
// view renders their decoded value exactly as v1 rendered the raw string.
// v3: adds the optional seller identity observation (the identity branch had
// used v2 for that before merging main, so it takes the next number).
// v4: v3 plus GitHub signals, served instead of v3 when DACS_IDENTITY_GITHUB_SIGNALS=on.
export const LISTINGS_RESOURCE_URI = 'ui://dacs/listings-v3.html';
// v5: GitHub repository names and URLs are decoded from their seller-data envelopes.
export const SIGNALS_LISTINGS_RESOURCE_URI = 'ui://dacs/listings-v5.html';
// v2: agent/publication results (including register_agent) render as an
// onboarding card instead of falling into the purchase branch.
// v5: an over-long price renders as plain prose on the purchase and account
// cards, and the purchase amount is written as text (v3 and v4 were the
// showcase status view's).
export const STATUS_RESOURCE_URI = 'ui://dacs/status-v5.html';
// v2: the purchase and account cards it composes from the status view changed as status-v5.
export const REPORT_STATUS_RESOURCE_URI = 'ui://dacs/status-report-v2.html';

const STYLE = `
:root{color-scheme:light dark;font:14px/1.4 system-ui,sans-serif}
body{margin:0;padding:12px}
.card{border:1px solid #8884;border-radius:10px;padding:10px 12px;margin:0 0 8px}
.row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.muted{opacity:.7;font-size:12px}
.ok{color:#1a7f37}.bad{color:#cf222e}
code{font-size:12px;word-break:break-all}
button{font:inherit;padding:4px 10px;border-radius:8px;border:1px solid #8886;background:transparent;cursor:pointer}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:4px;border-bottom:1px solid #8883;vertical-align:top}
`;

// HTML escaping shared by the views (exported so tests evaluate the real code).
export const ESC_HELPER = `
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
`;

const BRIDGE = `
let nextId=1;const pending=new Map();
function rpc(method,params){const id=nextId++;window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise(r=>pending.set(id,r));}
function note(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*');}
function openLink(url){if(/^https:\\/\\//.test(url)||/^http:\\/\\/(127\\.0\\.0\\.1|localhost)[:/]/.test(url))rpc('ui/open-link',{url});}
window.addEventListener('message',e=>{if(e.source!==window.parent)return;const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
 if(m.id!==undefined&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return;}
 if(m.method==='ui/notifications/tool-result'){render(m.params?.structuredContent??null);}});
document.addEventListener('click',e=>{const a=e.target.closest('[data-link]');if(a){e.preventDefault();openLink(a.dataset.link);}});
rpc('ui/initialize',{appInfo:{name:'dacs-view',version:'1'},appCapabilities:{},protocolVersion:'${PROTOCOL_VERSION}'}).then(()=>note('ui/notifications/initialized',{}));
if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);
`;

export const SELLER_IDENTITY_RENDER = `
function decodedRepositoryText(v){if(typeof v==='string')return v;if(!v||v.truncated)return '(repository text unavailable)';try{return JSON.parse(String(v.text).split('\\n')[1]);}catch{return '(repository text unavailable)';}}
${sanitizeSellerName.toString()}
function sellerIdentityHtml(i){if(!i)return '';return '<div class="muted"><b>Identities of the directory-asserted seller claim</b><div>'+esc(i.label)+'</div>'+
 (i.identities?Object.entries(i.identities).map(([kind,entries])=>'<div>'+esc(kind)+': '+(entries.map(e=>esc(e.value)+' · '+esc(e.url)+(e.punycode?' (punycode / IDNA A-label)':'')+(e.signals?' <span>'+esc(e.signals.label)+'</span> '+(e.signals.stars?.top||[]).map(r=>'<a href="'+esc(decodedRepositoryText(r.url))+'">'+esc(decodedRepositoryText(r.name))+'</a>: '+esc(r.stars)+' stars'+(r.archived?' (archived)':'')).join('; '):'')).join('; ')||'None observed')+'</div>').join('')+'<div>'+esc(i.otherAssociations)+' other associations not displayed; '+esc(i.unrecognizedEntries)+' unrecognized entries omitted.</div>':'')+
 '<div>'+esc(i.evidence.mode)+'; configured network '+esc(i.evidence.network)+'; RPC '+esc(i.evidence.rpcOrigin)+'; server-local observation '+esc(i.evidence.observedAt)+'</div><div>'+esc(i.evidence.note)+'</div><div>'+esc(i.evidence.readLimits.authority)+'</div></div>';}
`;

const LEGACY_SELLER_IDENTITY_RENDER = `
${sanitizeSellerName.toString()}
function sellerIdentityHtml(i){if(!i)return '';return '<div class="muted"><b>Identities of the directory-asserted seller claim</b><div>'+esc(i.label)+'</div>'+
 (i.identities?Object.entries(i.identities).map(([kind,entries])=>'<div>'+esc(kind)+': '+(entries.map(e=>esc(e.value)+' · '+esc(e.url)+(e.punycode?' (punycode / IDNA A-label)':'')).join('; ')||'None observed')+'</div>').join('')+'<div>'+esc(i.otherAssociations)+' other associations not displayed; '+esc(i.unrecognizedEntries)+' unrecognized entries omitted.</div>':'')+
 '<div>'+esc(i.evidence.mode)+'; configured network '+esc(i.evidence.network)+'; RPC '+esc(i.evidence.rpcOrigin)+'; server-local observation '+esc(i.evidence.observedAt)+'</div><div>'+esc(i.evidence.note)+'</div><div>'+esc(i.evidence.readLimits.authority)+'</div></div>';}
`;

export const LISTINGS_RENDER = SELLER_IDENTITY_RENDER + `
function sd(v){if(!v||typeof v!=='object')return v;try{return JSON.parse(String(v.text).split('\\n')[1]);}catch{return undefined;}}
function render(d){const el=document.getElementById('app');if(!d){el.textContent='No data.';return;}
 if(Array.isArray(d.results)){el.innerHTML='<p class="muted">Directory hints from '+esc(d.directoryOrigin)+' ('+esc(d.evidenceMode)+'). Not yet verified.</p>'+
  '<table><tr><th>Service</th><th>Seller</th><th>Price hint</th></tr>'+d.results.map(r=>'<tr><td><b>'+esc(sd(r.title))+'</b><div class="muted">'+esc(r.listingId)+' v'+esc(r.version)+' · '+esc(sd(r.category))+'</div></td><td>'+(r.sellerIdentity?'<p>Seller-provided name (not verified): <bdi>'+esc(sanitizeSellerName(sd(r.sellerName)))+'</bdi></p>':esc(sd(r.sellerName)||''))+'<div class="muted"><code>'+esc(r.sellerIdentity?r.seller:r.seller.slice(0,28))+(r.sellerIdentity?'':'…')+'</code></div>'+sellerIdentityHtml(r.sellerIdentity)+'</td><td>'+esc(sd(r.priceHint)||'?')+' '+esc(sd(r.currency)||'')+'</td></tr>').join('')+'</table>';return;}
 el.innerHTML='<div class="card"><div class="row"><b>'+esc(sd(d.title)||d.listingId)+'</b><span class="'+(d.transactable?'ok':'bad')+'">'+(d.transactable?'Verified':'Not transactable')+'</span></div>'+
  (d.price?'<div>'+esc(d.price.amount)+' DEM</div>':'')+'<div class="muted">'+esc(sd(d.description)||'')+'</div></div>'+
  '<div class="card">'+(d.checks||[]).map(c=>'<div class="'+(c.ok?'ok':'bad')+'">'+(c.ok?'✓':'✗')+' '+esc(c.name)+(c.detail?' <span class="muted">'+esc(c.detail)+'</span>':'')+'</div>').join('')+
  '<div class="muted">Evidence mode: '+esc(d.evidence?.chainMode)+'</div></div>';}
`;

// Classification order: agent/publication (register_agent, get_agent_status,
// verify_agent_publication all carry agentId) before purchase operations
// (operationId) before account. Chain verification is shown only when the
// result explicitly says onChainVerified: true; absence means not verified.
// A purchase's terms.amount is a seller-data envelope when the stored price is
// longer than any Demos amount (seller-content.mjs); the card shows fixed
// prose for it, not the envelope's model-facing label. The amount is written
// as text (textContent), never as markup. An account purchase's amount is then
// the model's prose that points to get_purchase_status (priceForAccount); the
// account card shows people plain prose for it too.
export const STATUS_RENDER = `
function purchaseAmount(el,amount){el.querySelector('[data-amount]').textContent=amount&&typeof amount==='object'?'Price too long to show here':String(amount??'');}
function accountAmount(amount){return amount===${JSON.stringify(ACCOUNT_PRICE_PROSE)}?'price too long to show here':amount;}
function render(d){const el=document.getElementById('app');if(!d){el.textContent='No data.';return;}
 if(d.agentId){const state=d.publicationStatus??d.status;el.innerHTML='<div class="card"><div class="row"><b>Agent '+esc(d.listingId||d.agentId)+'</b><span>'+esc(state)+'</span></div>'+
  '<div class="'+(d.onChainVerified===true?'ok':'muted')+'">'+(d.onChainVerified===true?'Chain readback verified ('+esc(d.evidence?.chainMode)+')':'Not verified on chain')+'</div>'+
  '<p>'+esc(d.next||'')+'</p>'+(d.portalUrl?'<button data-link="'+esc(d.portalUrl)+'">Open onboarding portal</button>':'')+'</div>';return;}
 if(d.operationId){el.innerHTML='<div class="card"><div class="row"><b>Purchase '+esc(d.operationId)+'</b><span>'+esc(d.status)+'</span></div>'+
  '<div><span data-amount></span> → <code>'+esc(d.terms?.payee)+'</code></div><div class="muted">'+esc(d.terms?.listingId)+' v'+esc(d.terms?.version)+' · '+esc(d.terms?.network)+'</div>'+
  '<p>'+esc(d.next)+'</p>'+(d.approvalUrl?'<button data-link="'+esc(d.approvalUrl)+'">Open wallet approval</button>':'')+'</div>';purchaseAmount(el,d.terms?.amount);return;}
 if(d.accountId){el.innerHTML='<div class="card"><b>Account</b><div class="muted">'+esc(d.accountId)+'</div>'+(d.wallets||[]).map(w=>'<div><code>'+esc(w.address)+'</code></div>').join('')+'</div>'+
  '<div class="card"><b>Agents</b>'+((d.agents||[]).map(a=>'<div>'+esc(a.listingId)+': '+esc(a.publicationStatus)+'</div>').join('')||'<div class="muted">none</div>')+'</div>'+
  '<div class="card"><b>Purchases</b>'+((d.purchases||[]).map(p=>'<div>'+esc(p.listingId)+' '+esc(accountAmount(p.amount))+': '+esc(p.status)+'</div>').join('')||'<div class="muted">none</div>')+'</div>';return;}
 el.textContent=JSON.stringify(d);}
`;

export const UI_RESOURCES = [
  {
    uri: LISTINGS_RESOURCE_URI,
    title: 'DACS listing comparison',
    description: 'Compares discovered listings and shows independent verification checks.',
    render: LEGACY_SELLER_IDENTITY_RENDER + LISTINGS_RENDER.slice(SELLER_IDENTITY_RENDER.length),
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
  },
  {
    uri: STATUS_RESOURCE_URI,
    title: 'DACS account and operation status',
    description: 'Shows account, agent onboarding and purchase status with portal links.',
    render: STATUS_RENDER,
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
  },
];

// The App renders the report from structuredContent alone, the same labelled
// copy the model gets (purchased-report.mjs reportFromResult); no tool result
// carries it in _meta. The status App also renders account, agent and refused
// tool results, so a failed call is named by its own error code, never as a
// failed purchase status read.
const REPORT_STATUS_RENDER = PURCHASED_REPORT_SCRIPT + STATUS_RENDER.replace('function render(d)', 'function renderStatus(d)') + `
function toolErrorCode(r){try{const code=JSON.parse(r?.content?.[0]?.text).error;return typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code)?code:null;}catch{return null;}}
function render(d){const el=document.getElementById('app');
 if(d?.toolFailed){el.textContent='The latest tool call failed'+(d.code?' with error '+d.code:'')+'. It returned no purchase status, so no report is shown.';return;}
 renderStatus(d);
 if(d?.operationId&&!d.agentId){const report=document.createElement('section');report.className='purchased-report';renderPurchasedReport(report,...reportFromResult(d));el.append(report);}
 else if(!d)el.textContent='Report unavailable: The latest tool result has no verified purchase status.';}
`;
const REPORT_UI_RESOURCES = [UI_RESOURCES[0], { ...UI_RESOURCES[1], uri: REPORT_STATUS_RESOURCE_URI, render: REPORT_STATUS_RENDER, reportView: true }];

const REPORT_BRIDGE = BRIDGE
  .replace('render(m.params?.structuredContent??null)', 'render(m.params?.isError?{toolFailed:true,code:toolErrorCode(m.params)}:m.params?.structuredContent??null)');

export function uiHtml(resource) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${resource.title}</title><style>${STYLE}${resource.reportView ? PURCHASED_REPORT_STYLE : ''}</style></head>` +
    `<body><div id="app" class="muted">Waiting for tool result…</div><script>${ESC_HELPER}${resource.render}${resource.reportView ? REPORT_BRIDGE : BRIDGE}</script></body></html>`;
}

// Decode only for display, retaining a visible trust label and escaping through
// the shared markup builder. Plain portal ledgers never go through this adapter.
export function showcaseProgressHtmlForModel(ledger) {
  function display(value) {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'label') && Object.hasOwn(value, 'text') && Object.hasOwn(value, 'truncated')) {
      let text = value.text;
      try { text = JSON.parse(String(value.text).split('\n')[1]); } catch {}
      return `Untrusted seller text: ${typeof text === 'string' ? text : JSON.stringify(text)}${value.truncated ? ' (truncated)' : ''}`;
    }
    if (Array.isArray(value)) return value.map(display);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, display(child)]));
  }
  return showcaseProgressHtml(display(ledger));
}

// v6: the purchase and account cards changed as status-v5.
export const SHOWCASE_STATUS_RESOURCE_URI = 'ui://dacs/status-v6.html';
export const SHOWCASE_STATUS_RENDER = `${renderShowcaseProgress.toString()}
${showcaseProgressHtml.toString()}
${showcaseProgressHtmlForModel.toString()}
${STATUS_RENDER.replace("+'</div>';purchaseAmount(el,d.terms?.amount);return;}\n if(d.accountId)", "+'</div>'+showcaseProgressHtmlForModel(d.showcaseProgress);purchaseAmount(el,d.terms?.amount);return;}\n if(d.accountId)")}`;
export const SHOWCASE_UI_RESOURCES = UI_RESOURCES.map((resource) => resource.uri === STATUS_RESOURCE_URI ? { ...resource, uri: SHOWCASE_STATUS_RESOURCE_URI, render: SHOWCASE_STATUS_RENDER } : resource);

// The views the three view switches select. The ledger and the report view each
// replace the status view, so the pair is refused here as by loadConfig and
// createApp; the signals listings view composes over either. All off: UI_RESOURCES.
export function uiResources({ ledger = false, reportView = false, signalsOn = false } = {}) {
  if (ledger && reportView) throw new TypeError('the showcase report view and the showcase ledger cannot be enabled together');
  const base = ledger ? SHOWCASE_UI_RESOURCES : reportView ? REPORT_UI_RESOURCES : UI_RESOURCES;
  if (!signalsOn) return base;
  return base.map((resource) => resource.uri === LISTINGS_RESOURCE_URI
    ? { ...resource, uri: SIGNALS_LISTINGS_RESOURCE_URI, render: LISTINGS_RENDER } : resource);
}
