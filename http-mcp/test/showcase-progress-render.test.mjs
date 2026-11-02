import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { renderShowcaseProgress, showcaseProgressHtml } from '../public/portal/showcase-progress.mjs';
import { showcaseProgress } from '../src/mcp/showcase-progress.mjs';
import { showcaseProgressForModel } from '../src/mcp/showcase-model.mjs';
import { sellerData, decodeSellerDataEnvelope, SELLER_DATA_MAX } from '../src/mcp/seller-content.mjs';
import { ESC_HELPER, STATUS_RENDER, SHOWCASE_STATUS_RENDER, SHOWCASE_STATUS_RESOURCE_URI, SHOWCASE_UI_RESOURCES, STATUS_RESOURCE_URI, UI_RESOURCES, uiHtml } from '../src/mcp/ui.mjs';
import { publicationBaseSurface } from './helpers/publication-base-surface.mjs';

const hostile = '<img src=x onerror="send()">&\'"</script>';
const ledger = () => showcaseProgress({ operation: { status: hostile, terms: { profile: hostile, listing: { anchor: { locator: hostile }, contentHash: hostile } }, state: { preparedVerification: { checks: [{ name: hostile, ok: false, detail: hostile }], evidence: { chainMode: hostile } } } } });
class Node {
  constructor(tag, text = '') { this.tag = tag; this.textContent = text; this.children = []; this.props = {}; }
  get text() { return this.textContent + this.children.map((child) => child.text).join(''); }
}
const el = (tag, props, ...children) => Object.assign(new Node(tag), { props, children: children.map((child) => child instanceof Node ? child : new Node('#text', String(child ?? ''))) });
const render = (source, data) => {
  // The status view's purchase card writes its amount into the [data-amount] span as text.
  const amount = { textContent: '' };
  const node = { innerHTML: '', textContent: '', querySelector: (selector) => (selector === '[data-amount]' ? amount : null) };
  vm.runInNewContext(`${ESC_HELPER}${source};render(data)`, { data, document: { getElementById: () => node } });
  return node.innerHTML || node.textContent;
};
test('portal renderer keeps every hostile field in text nodes and starts no workflow', () => {
  const root = renderShowcaseProgress(ledger(), el);
  assert.ok(root.text.includes(hostile)); assert.ok(root.text.includes('Missing proof'));
  const walk = (node) => { assert.ok(!['img', 'script', 'button', 'a'].includes(node.tag)); assert.ok(Object.keys(node.props).every((k) => !k.startsWith('on'))); node.children.forEach(walk); };
  walk(root); assert.equal(renderShowcaseProgress(null, el), null);
});
test('MCP markup escapes all evidence and reason fields and makes no network or wallet call', () => {
  const html = showcaseProgressHtml(ledger());
  assert.ok(!html.includes(hostile)); assert.ok(html.includes('&lt;img src=x onerror=&quot;send()&quot;&gt;&amp;&#39;&quot;&lt;/script&gt;'));
  assert.match(html, /Missing proof/); assert.doesNotMatch(html, /<(img|script|button|a)[ >]/);
  const data = { operationId: 'test-purchase', terms: {}, status: 'payment_uncertain', showcaseProgress: ledger() };
  const mcp = render(SHOWCASE_STATUS_RENDER, data); assert.ok(mcp.includes(html)); assert.ok(mcp.includes('DACS purchase ledger'));
  assert.equal(render(SHOWCASE_STATUS_RENDER, { ...data, showcaseProgress: undefined }), render(STATUS_RENDER, { ...data, showcaseProgress: undefined }));
});
// "Unchanged from main" is checked against the PR's merge base by
// scripts/check-off-unchanged.mjs (docs/SWITCHES.md), never by a pinned hash.
test('off-by-default MCP resources are the plain views; the ledger changes only the status view', async () => {
  const plain = UI_RESOURCES.map((resource) => ({ uri: resource.uri, html: uiHtml(resource) }));
  for (const { html } of plain) assert.doesNotMatch(html, /showcaseProgress|DACS purchase ledger/);
  for (const config of [{}, { showcaseLedger: false }]) assert.deepEqual((await publicationBaseSurface(config)).html, plain);
  const on = SHOWCASE_UI_RESOURCES.map((resource) => ({ uri: resource.uri, html: uiHtml(resource) }));
  assert.deepEqual((await publicationBaseSurface({ showcaseLedger: true })).html, on);
  assert.deepEqual(on.filter(({ uri }) => uri !== SHOWCASE_STATUS_RESOURCE_URI), plain.filter(({ uri }) => uri !== STATUS_RESOURCE_URI));
});
test('portal purchase branches mount the ledger without adding workflow actions', () => {
  const source = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
  assert.equal(source.split('renderShowcaseProgress(view.showcaseProgress, el)').length - 1, 2);
  assert.doesNotMatch(renderShowcaseProgress.toString(), /fetch\(|api\(|request\(|sendTransaction|recheck/);
});

test('model ledger fails closed for new fields, familiar prose, and invalid formatted values', () => {
  const plain = ledger();
  plain.substrate = hostile;
  plain.extra = { nested: { instructions: hostile }, state: 'verified' };
  plain['stages.0.name'] = 'Identify';
  const stage = plain.stages[0], row = stage.evidence[0];
  stage.extra = { reason: hostile }; row.extra = [hostile];
  row.block = hostile; row.txHash = hostile; row.artifactHash = hostile;
  row.reason = 'Required proof is missing.'; // Familiar fixed prose is still copied text here.
  const model = showcaseProgressForModel(plain);
  assert.deepEqual(decodeSellerDataEnvelope(model.extra), plain.extra);
  assert.equal(decodeSellerDataEnvelope(model['stages.0.name']), 'Identify');
  assert.deepEqual(decodeSellerDataEnvelope(model.stages[0].extra), stage.extra);
  const output = model.stages[0].evidence[0];
  for (const key of ['label', 'check', 'reason', 'txHash', 'block', 'artifactKey', 'artifactHash', 'scope', 'extra']) {
    assert.deepEqual(decodeSellerDataEnvelope(output[key]), row[key]);
  }
  for (const key of ['status', 'profile', 'substrate']) assert.deepEqual(decodeSellerDataEnvelope(model[key]), plain[key]);
  assert.equal(model.stages[0].name, 'Identify'); assert.equal(model.stages[0].state, 'rejected');
  const valid = { ...row, block: 123, txHash: `0x${'A'.repeat(64)}`, artifactHash: 'a'.repeat(64) };
  const safe = showcaseProgressForModel({ version: 1, stages: [{ name: 'Identify', state: 'verified', evidence: [valid] }] });
  assert.equal(safe.version, 1);
  for (const key of ['block', 'txHash', 'artifactHash']) assert.equal(safe.stages[0].evidence[0][key], valid[key]);
  assert.equal(row.block, hostile, 'input is not mutated');
  for (const [key, value] of [['name', hostile], ['state', hostile]]) {
    assert.equal(decodeSellerDataEnvelope(showcaseProgressForModel({ stages: [{ [key]: value }] }).stages[0][key]), value);
  }
});

test('App ledger renders labelled hostile text visibly untrusted and escaped through the real status hook', () => {
  const model = showcaseProgressForModel(ledger());
  const html = render(SHOWCASE_STATUS_RENDER, { operationId: 'model-ledger', terms: {}, showcaseProgress: model });
  assert.match(html, /DACS purchase ledger/); assert.match(html, /Untrusted seller text:/);
  assert.ok(!html.includes(hostile)); assert.match(html, /&lt;img src=x onerror=&quot;send\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /\[object Object\]/); assert.doesNotMatch(html, /<(img|script)[ >]/);
  assert.ok(!showcaseProgressHtml(ledger()).includes('Untrusted seller text:'), 'plain portal display stays unchanged');
  model.stages[0].reason = sellerData('x'.repeat(SELLER_DATA_MAX + 1));
  assert.match(render(SHOWCASE_STATUS_RENDER, { operationId: 'model-ledger', terms: {}, showcaseProgress: model }), /\(truncated\)/);
  model.stages[0].reason = { label: 'seller data', text: hostile, truncated: false };
  const malformed = render(SHOWCASE_STATUS_RENDER, { operationId: 'model-ledger', terms: {}, showcaseProgress: model });
  assert.match(malformed, /Untrusted seller text:/); assert.ok(!malformed.includes(hostile));
});
