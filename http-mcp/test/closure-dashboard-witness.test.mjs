// Closure (dashboard D1/F1): wrong-implementation witnesses for the
// dashboard's pure public rules. One contract check (dashboardViolations)
// runs against the shipped bin/offline-fixtures/tester-dashboard.mjs, where
// it must find nothing, and against disposable mutated copies written to a
// temporary directory, where it must name the broken rule. The candidate is
// never modified. The stateful rules (one Add press gives a new action after
// a closed one; a settled receipt is read before it is kept) are witnessed
// by closure-dashboard-recovery.test.mjs, whose regression cases fail on the
// pre-repair dashboard (see the core evidence). Not a security review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as shipped from '../bin/offline-fixtures/tester-dashboard.mjs';

const SOURCE = new URL('../bin/offline-fixtures/tester-dashboard.mjs', import.meta.url);
const ORIGINAL = readFileSync(SOURCE, 'utf8');
const BARE = ['@modelcontextprotocol/client', '@kynesyslabs/dacs'];

const MUTANTS = [
  {
    name: 'pre-repair identity set: failed_before_send and cancelled not finished',
    find: "'rejected_before_send', 'failed_before_send', 'cancelled', 'expired']);",
    replace: "'rejected_before_send', 'expired']);",
    expect: ['closed identity actions are not unfinished'],
  },
  {
    name: 'evidence drops the kept purchases',
    find: 'completedPurchases: (state.completedPurchases ?? []).map(purchaseEvidence),',
    replace: 'completedPurchases: [],',
    expect: ['evidence keeps the settled purchase and receipt'],
  },
  {
    name: 'evidence copies kept purchases verbatim (key and portal link leak)',
    find: 'completedPurchases: (state.completedPurchases ?? []).map(purchaseEvidence),',
    replace: 'completedPurchases: (state.completedPurchases ?? []).map((p) => ({ ...purchaseEvidence(p), ...p })),',
    expect: ['evidence carries no key or portal link'],
  },
  {
    name: 'any finished purchase reported with an observed receipt in evidence',
    find: ': { observed: false },',
    replace: ": { observed: p.status !== 'awaiting_approval' },",
    expect: ['cancelled purchase has no receipt'],
  },
];

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dacs-closure-dashboard-witness-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function loadCopy(label, mutant) {
  let text = ORIGINAL;
  if (mutant) {
    assert.equal(text.split(mutant.find).length, 2, `mutation anchor appears exactly once: ${mutant.name}`);
    text = text.replace(mutant.find, () => mutant.replace);
  }
  for (const spec of BARE) text = text.replace(`from '${spec}'`, () => `from '${import.meta.resolve(spec)}'`);
  const file = join(dir, `tester-dashboard-${label}.mjs`);
  writeFileSync(file, text);
  return import(pathToFileURL(file).href);
}

const terms = { network: 'offline-fixture', amount: '1.5', amountOs: '1500000000', payee: `0x${'b'.repeat(64)}`, buyerWallet: `0x${'a'.repeat(64)}`, seller: 'did:demos:agent:bb', listingId: 'fixture', version: 1 };
const receipt = { chainMode: 'simulated-fixture', txHash: 'c'.repeat(64), txNonce: 1, payer: `0x${'a'.repeat(64)}`, payee: `0x${'b'.repeat(64)}`, amountOs: '1500000000', observation: 'included' };

// A dashboard state after: a settled purchase (kept), a cancelled one (kept),
// a new pending purchase, and closed identity actions in every slot.
function stateFixture() {
  const op = (status) => ({ idempotencyKey: 'tester-add-KEY', operationId: `idn_${status}`, action: 'add', username: 'h', status, statusHelp: null, portalUrl: 'http://127.0.0.1:1/portal/identity/x#t=CAP' });
  return {
    signIn: { status: 'signed_in', wallets: [terms.buyerWallet], authorizationUrl: null, error: null },
    listing: { discovery: null, verification: null, search: null, error: null },
    purchase: { idempotencyKey: 'tester-buy-NEW', operationId: 'pur_new', status: 'awaiting_approval', approvalUrl: 'http://127.0.0.1:1/portal/purchase/p#t=CAP', terms, receipt: null, replayed: false, error: null },
    completedPurchases: [
      { operationId: 'pur_settled', status: 'settled_verified', terms, receipt, keptAt: '2026-10-04T00:00:00Z', idempotencyKey: 'tester-buy-OLD', approvalUrl: 'http://127.0.0.1:1/portal/purchase/q#t=CAP' },
      { operationId: 'pur_cancelled', status: 'cancelled', terms, receipt: null, keptAt: '2026-10-04T00:00:01Z' },
    ],
    identity: { add: op('failed_before_send'), remove: op('cancelled'), twitter: { add: op('failed_before_send'), remove: op('cancelled') }, observed: null, error: null },
    checklist: {},
    seller: { signIn: { status: 'signed_out', wallets: [] }, listing: null, fieldErrors: {}, error: null },
    earlier: { buyer: [], seller: [] },
    activity: [],
  };
}

// The D1/F1 public rules, from the tester guide, not from
// the module's own output.
async function dashboardViolations(mod) {
  const broken = [];
  const rule = (name, ok) => {
    if (!ok) broken.push(name);
  };
  const s = stateFixture();
  const unfinished = mod.unfinishedSteps(s).map((u) => u.step);
  rule('closed identity actions are not unfinished', !unfinished.some((step) => step.startsWith('identity')));
  rule('a pending purchase is unfinished', unfinished.includes('purchase'));
  const e = mod.buildEvidenceExport(s, {});
  const kept = e.buyer.completedPurchases ?? [];
  rule('evidence keeps the settled purchase and receipt', kept[0]?.operationId === 'pur_settled' && kept[0]?.status === 'settled_verified' && kept[0]?.receipt?.observed === true && kept[0]?.receipt?.txHash === receipt.txHash);
  rule('cancelled purchase has no receipt', kept[1]?.status === 'cancelled' && kept[1]?.receipt?.observed === false);
  rule('current purchase unchanged', e.buyer.purchase?.operationId === 'pur_new' && e.buyer.purchase?.receipt?.observed === false);
  rule('evidence carries no key or portal link', !/#t=|tester-(buy|add)-|idempotency|approvalUrl|portalUrl/i.test(JSON.stringify(e)));
  return broken;
}

test('accepting control: the shipped dashboard and its unmutated copy satisfy every rule', async () => {
  assert.deepEqual(await dashboardViolations(shipped), []);
  assert.deepEqual(await dashboardViolations(await loadCopy('unmutated')), [], 'the copy loader itself changes nothing');
});

for (const [i, mutant] of MUTANTS.entries()) {
  test(`witness: "${mutant.name}" is caught`, async () => {
    const broken = await dashboardViolations(await loadCopy(`m${i}`, mutant));
    for (const name of mutant.expect) assert.ok(broken.includes(name), `expected "${name}" in ${JSON.stringify(broken)}`);
  });
}
