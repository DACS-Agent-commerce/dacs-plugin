// Ops health checks a retained failed native transfer's signature in the form the
// configured node uses (its getNetworkInfo answer): the bare hash while the
// signatureDomain fork is inactive, "demos-tx:v1:<chainId>:<hash>" once active.
// With no usable answer it reports "signature authority unavailable", apart from
// a malformed record, with its own exit code (3, where unreadable state is 2).
// It changes no transfer status and authorises no retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { formatOpsHealth } from '../src/ops/health.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { ACTIVE, INACTIVE, cli, exitWith, failedRecord, health, node, preimage, sha, stateWith, withTransfer } from './helpers/health-signature-world.mjs';

// ---- failure cases first ----------------------------------------------------
test('a bare-hash record on an active-fork chain is a signature form mismatch: listed, not accepted, not corrupt', (t) => {
  const s = withTransfer(t, INACTIVE, undefined, { stuck: true });
  const report = health(s, ACTIVE);
  assert.deepEqual(report.signatureFormMismatch, [{ hash: s.record.hash, purchaseIds: ['pur_AAAAAAAAAAAAAAAA', 'pur_BBBBBBBBBBBBBBBB'] }], 'one entry per transfer, hash and purchase IDs only');
  assert.equal(report.healthy, false);
  assert.deepEqual(report.signatureAuthorityUnavailable, []);
  assert.equal(report.stuck.length, 1, 'the other stuck purchase is still reported');
  const text = formatOpsHealth(report);
  assert.match(text, new RegExp(`signature form mismatch hash=${s.record.hash} purchases=pur_AAAAAAAAAAAAAAAA,pur_BBBBBBBBBBBBBBBB next=nothing is resent`));
  assert.match(text, /stuck pur_BBBBBBBBBBBBBBBB/);
  assert.doesNotMatch(JSON.stringify(report) + text, /signedTransaction|"retry|"resend|re-?send now/i);
});

test('the reverse is a mismatch too: a domain-form record on an inactive-fork chain', (t) => {
  const report = health(withTransfer(t, ACTIVE), INACTIVE);
  assert.equal(report.signatureFormMismatch.length, 1);
  assert.equal(report.healthy, false);
});

test('a record valid under neither form is still corrupt, whichever form the node selects', (t) => {
  const other = createEphemeralWallet();
  for (const answer of [ACTIVE, INACTIVE]) {
    for (const edit of [(r) => { r.signedTransaction.signature.data = other.signHex(r.hash); return r; }, (r) => { r.signedTransaction.signature.data = other.signHex(preimage(ACTIVE, r.hash)); return r; }]) {
      assert.throws(() => health(withTransfer(t, INACTIVE, edit), answer), /could not read valid state/);
    }
  }
  assert.throws(() => health(withTransfer(t, { ...ACTIVE, chainId: 8 }), ACTIVE), /could not read valid state/);
});

test('a mismatch record does not change how the next record is judged (the other form is probed in a fresh run record)', (t) => {
  const wallet = createEphemeralWallet(), bare = failedRecord(wallet, INACTIVE, { nonce: 4 }), domain = failedRecord(wallet, ACTIVE, { nonce: 3 });
  for (const records of [[domain, bare], [bare, domain]]) {
    const s = stateWith(t, wallet, records.map((r) => [`devnet/native-transfer/${r.hash}`, r]));
    const report = health(s, INACTIVE);
    assert.deepEqual(report.signatureFormMismatch.map((r) => r.hash), [domain.hash]);
    assert.deepEqual(report.signatureAuthorityUnavailable, []);
  }
});

test('a malformed record is still corrupt even when its signature is in the other form', (t) => {
  assert.throws(() => health(withTransfer(t, INACTIVE, (r) => { r.failure.nonceFence += 1; return r; }), ACTIVE), /could not read valid state/);
});

test('a record signed for another chain id is invalid on an active-fork chain', (t) => {
  const s = withTransfer(t, { ...ACTIVE, chainId: 8 });
  assert.throws(() => health(s, ACTIVE), /could not read valid state/);
});

test('an unreadable node answer reports signature authority unavailable, not corruption', (t) => {
  const s = withTransfer(t, ACTIVE);
  for (const answer of [undefined, null, 'down', [], { forks: true }, { chainId: 7, forks: { signatureDomain: { activated: 'true' } } },
    { forks: { signatureDomain: { activated: true } } }, { chainId: -1, forks: { signatureDomain: { activated: true } } }, { chainId: 1.5, forks: { signatureDomain: { activated: true } } }]) {
    const report = health(s, answer);
    assert.equal(report.signatureAuthorityUnavailable.length, 2, JSON.stringify(answer));
    assert.deepEqual(report.signatureAuthorityUnavailable.map((r) => r.source), ['node2-transport.sqlite', 'node2-transport.sqlite']);
    assert.equal(report.healthy, false, 'it does not claim health it could not check');
    assert.deepEqual(report.stuck, []);
    assert.match(formatOpsHealth(report), /signature authority unavailable/);
  }
});

test('a malformed record is still corrupt when the authority is unavailable (only its signature waits for the node)', (t) => {
  const other = `0x${'c'.repeat(64)}`;
  for (const edit of [(r) => { r.signedTransaction.content.to = other; }, (r) => { delete r.signedTransaction.content.data; }, (r) => { r.failure.nonceFence += 1; }, (r) => { r.receipt = {}; }]) {
    const s = withTransfer(t, ACTIVE, (r) => { edit(r); return r; });
    assert.throws(() => health(s), /could not read valid state/);
  }
});

test('a valid domain-form record on an active-fork chain is valid, never called corrupt', (t) => {
  const s = withTransfer(t, ACTIVE);
  const report = health(s, ACTIVE);
  assert.equal(report.healthy, true, JSON.stringify(report));
  assert.deepEqual(report.signatureAuthorityUnavailable, []);
  assert.deepEqual(report.seller, { journals: ['node2-transport.sqlite'], unconfirmed: [] });
  assert.doesNotMatch(formatOpsHealth(report), /signature authority/);
});

test('inactive fork: the bare-hash record is valid and the domain-form record is only a mismatch (never accepted)', (t) => {
  assert.equal(health(withTransfer(t, INACTIVE), INACTIVE).healthy, true);
  assert.equal(health(withTransfer(t, ACTIVE), INACTIVE).healthy, false);
});

test('health reads and reports only: the journal is byte-for-byte unchanged and nothing authorises a retry', (t) => {
  const s = withTransfer(t, ACTIVE), before = readFileSync(s.journalPath);
  const report = health(s, ACTIVE), unavailable = health(s);
  assert.deepEqual(readFileSync(s.journalPath), before);
  // Neither report carries the retained transaction or any instruction to send again.
  for (const r of [report, unavailable]) assert.doesNotMatch(JSON.stringify(r), /signedTransaction|"retry|"resend|re-?send now/i);
  assert.deepEqual(report.seller.unconfirmed, [], 'a failed transfer is resolved: it is not listed as a write to read back');
  assert.deepEqual(unavailable.seller.unconfirmed, [], 'an unavailable authority does not turn it into one either');
});

// ---- the transaction verifier on its own -------------------------------------
test('verifyDemosTransactionSignature: the form follows the answer, and an answer that does not say verifies nothing', async () => {
  const { verifyDemosTransactionSignature } = await import('../src/wallet/demos-transaction-signature.mjs');
  const wallet = createEphemeralWallet(), hash = sha('a transaction');
  const sign = (info) => wallet.signHex(preimage(info, hash));
  const check = (info, signature) => verifyDemosTransactionSignature({ networkInfo: info, hash, signature, publicKey: wallet.address });
  assert.equal(check(INACTIVE, sign(INACTIVE)), 'valid');
  assert.equal(check(ACTIVE, sign(ACTIVE)), 'valid');
  assert.equal(check({ ...ACTIVE, chainId: 0 }, sign({ ...ACTIVE, chainId: 0 })), 'valid');
  assert.equal(check(ACTIVE, sign(INACTIVE)), 'invalid', 'bare hash on an active-fork chain');
  assert.equal(check(INACTIVE, sign(ACTIVE)), 'invalid', 'domain form on an inactive-fork chain');
  assert.equal(check(ACTIVE, sign({ ...ACTIVE, chainId: 8 })), 'invalid', 'another chain id');
  assert.equal(check(ACTIVE, wallet.signHex('x')), 'invalid');
  assert.equal(check(ACTIVE, 'not a signature'), 'invalid');
  assert.equal(verifyDemosTransactionSignature({ networkInfo: ACTIVE, hash: 'ABC', signature: sign(ACTIVE), publicKey: wallet.address }), 'invalid');
  for (const answer of [undefined, null, { forks: [] }, 'x', { forks: { signatureDomain: { activated: 'false' } } }, { chainId: 7, forks: { signatureDomain: {} } }, { forks: { signatureDomain: { activated: true } } },
    { chainId: '7', forks: { signatureDomain: { activated: true } } }, { chainId: -1, forks: { signatureDomain: { activated: true } } }, { chainId: 2 ** 53, forks: { signatureDomain: { activated: true } } }]) {
    assert.equal(check(answer, sign(INACTIVE)), 'unavailable', JSON.stringify(answer));
    assert.equal(check(answer, sign(ACTIVE)), 'unavailable', JSON.stringify(answer));
  }
});

// ---- the command line ------------------------------------------------------
test('command line: the configured node\'s answer decides; unavailable authority exits 3, corruption 2', async (t) => {
  const domain = withTransfer(t, ACTIVE), bare = withTransfer(t, INACTIVE);
  const ok = await exitWith(domain, ACTIVE);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(JSON.parse(ok.stdout).healthy, true);
  assert.equal((await exitWith(bare, ACTIVE)).status, 3, 'a bare-hash record on an active-fork chain is a form mismatch, not corrupt');
  assert.equal((await exitWith(bare, INACTIVE)).status, 0);
  for (const answer of ['none', 'down', { forks: true }, { forks: { signatureDomain: { activated: 'yes' } } }, { forks: { signatureDomain: { activated: true } } }]) {
    const out = await exitWith(domain, answer);
    assert.equal(out.status, 3, `${JSON.stringify(answer)}: ${out.stderr}`);
    const report = JSON.parse(out.stdout);
    assert.equal(report.signatureAuthorityUnavailable.length, 2);
    assert.equal(report.healthy, false);
  }
  // A node that cannot be reached at all.
  const dead = await node(INACTIVE); const url = dead.url; await dead.close();
  assert.equal((await cli(domain, { DACS_CHAIN_RPC_URL: url })).status, 3);
});

test('command line: the purchase database must be at the store\'s schema version (3, as src/store/database.mjs writes it); 2 exits 2', async (t) => {
  const s = withTransfer(t, ACTIVE), setVersion = (value) => {
    const db = new DatabaseSync(s.databasePath);
    try { db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(value); } finally { db.close(); }
  };
  const current = await exitWith(s, ACTIVE);
  assert.equal(current.status, 0, current.stderr + current.stdout);
  setVersion('2');
  assert.equal((await exitWith(s, ACTIVE)).status, 2);
  setVersion('3');
  assert.equal((await exitWith(s, ACTIVE)).status, 0);
});

test('command line: a form mismatch exits 3 with the whole report printed; a signature valid under neither form exits 2', async (t) => {
  const bare = withTransfer(t, INACTIVE), domain = withTransfer(t, ACTIVE), other = createEphemeralWallet();
  for (const [s, answer] of [[bare, ACTIVE], [domain, INACTIVE]]) {
    const out = await exitWith(s, answer);
    assert.equal(out.status, 3, out.stderr + out.stdout);
    const report = JSON.parse(out.stdout);
    assert.equal(report.format, 'dacs-ops-health/v2');
    assert.equal(report.error, undefined);
    assert.deepEqual(report.signatureFormMismatch, [{ hash: s.record.hash, purchaseIds: ['pur_AAAAAAAAAAAAAAAA'] }]);
    assert.equal(report.purchases.length, 1, 'the full report, not only an error');
    assert.equal(report.healthy, false);
  }
  const neither = withTransfer(t, INACTIVE, (r) => { r.signedTransaction.signature.data = other.signHex(r.hash); return r; });
  for (const answer of [ACTIVE, INACTIVE]) {
    const out = await exitWith(neither, answer);
    assert.equal(out.status, 2, out.stderr + out.stdout);
    assert.deepEqual(JSON.parse(out.stdout), { format: 'dacs-ops-health/v2', error: 'ops health could not read valid state or options' });
  }
});

test('command line: a stuck purchase wins over a form mismatch (exit 1), and both are listed', async (t) => {
  const s = withTransfer(t, INACTIVE, undefined, { stuck: true });
  const out = await exitWith(s, ACTIVE);
  assert.equal(out.status, 1, out.stderr + out.stdout);
  const report = JSON.parse(out.stdout);
  assert.equal(report.stuck.length, 1);
  assert.equal(report.stuck[0].purchaseId, 'pur_BBBBBBBBBBBBBBBB');
  assert.equal(report.signatureFormMismatch.length, 1);
});

test('command line: the node is not needed when no retained failed transfer needs it', async (t) => {
  const wallet = createEphemeralWallet(), s = stateWith(t, wallet, []);
  const out = await cli(s);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).signatureAuthorityUnavailable, []);
});

// The node's whole reply body is exactly `size` bytes.
const sized = (size) => ({ ...ACTIVE, pad: 'x'.repeat(size - JSON.stringify({ result: 200, response: { ...ACTIVE, pad: '' } }).length) });

test('command line: a node reply over 64 KiB is authority unavailable; one of exactly 64 KiB is read', async (t) => {
  const domain = withTransfer(t, ACTIVE);
  assert.equal(JSON.stringify({ result: 200, response: sized(65536) }).length, 65536);
  const big = await exitWith(domain, sized(65537));
  assert.equal(big.status, 3, big.stderr + big.stdout);
  assert.equal(JSON.parse(big.stdout).signatureAuthorityUnavailable.length, 2);
  assert.equal((await exitWith(domain, sized(2_000_000))).status, 3);
  const edge = await exitWith(domain, sized(65536));
  assert.equal(edge.status, 0, edge.stderr + edge.stdout);
});

test('command line: DACS_CHAIN_TIMEOUT_MS outside the configuration\'s range, or not an integer, refuses before any request', async (t) => {
  const domain = withTransfer(t, ACTIVE);
  for (const value of ['-1', '0', '499', '60001', '99999999999', '1.5', 'abc', 'NaN', 'Infinity']) {
    const server = await node(ACTIVE);
    try {
      const out = await cli(domain, { DACS_CHAIN_RPC_URL: server.url, DACS_CHAIN_TIMEOUT_MS: value });
      assert.equal(out.status, 2, `${value}: ${out.stdout}`);
      assert.deepEqual(JSON.parse(out.stdout), { format: 'dacs-ops-health/v2', error: 'DACS_CHAIN_TIMEOUT_MS must be an integer in [500, 60000]' }, value);
      assert.equal(server.requests(), 0, `${value}: no request was made`);
    } finally { await server.close(); }
  }
  for (const value of ['500', '60000']) {
    const server = await node(ACTIVE);
    try {
      const out = await cli(domain, { DACS_CHAIN_RPC_URL: server.url, DACS_CHAIN_TIMEOUT_MS: value });
      assert.equal(out.status, 0, `${value}: ${out.stdout}${out.stderr}`);
      assert.equal(server.requests(), 1);
    } finally { await server.close(); }
  }
});

test('command line: a stuck purchase wins over an unavailable authority (exit 1), and the unavailable records are still listed', async (t) => {
  const s = withTransfer(t, ACTIVE, undefined, { stuck: true });
  for (const answer of ['none', 'down']) {
    const out = await exitWith(s, answer);
    assert.equal(out.status, 1, `${answer}: ${out.stderr}${out.stdout}`);
    const report = JSON.parse(out.stdout);
    assert.equal(report.stuck.length, 1);
    assert.equal(report.signatureAuthorityUnavailable.length, 2);
  }
  const answered = await exitWith(s, ACTIVE);
  assert.equal(answered.status, 1);
  assert.deepEqual(JSON.parse(answered.stdout).signatureAuthorityUnavailable, []);
});

import { transactionDomainCases } from './helpers/transaction-domain-cases.mjs';
transactionDomainCases('transaction verifier', async () => {
  const { verifyDemosTransactionSignature } = await import('../src/wallet/demos-transaction-signature.mjs');
  const activatedChains = new Set(), wallet = createEphemeralWallet(), hash = sha('guard transaction');
  return async (networkInfo, form) => {
    const verdict = verifyDemosTransactionSignature({ networkInfo, hash, publicKey: wallet.address, activatedChains,
      signature: wallet.signHex(form === 'domain' ? `demos-tx:v1:${networkInfo.chainId}:${hash}` : hash) });
    assert.ok(activatedChains.size <= 16, 'bounded run record');
    return verdict;
  };
});

test('health: a missing member selects only the bare hash in a fresh run', (t) => {
  const missing = { chainId: 7, forks: {} };
  assert.equal(health(withTransfer(t, ACTIVE), ACTIVE).healthy, true);
  assert.equal(health(withTransfer(t, INACTIVE), missing).healthy, true);
  assert.equal(health(withTransfer(t, ACTIVE), missing).signatureFormMismatch.length, 1, 'the domain form is only a mismatch, never accepted');
});
