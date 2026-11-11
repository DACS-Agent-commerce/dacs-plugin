// Ops health checks a retained failed native transfer's signature in the form the
// configured node uses (its getNetworkInfo answer): the bare hash while the
// signatureDomain fork is inactive, "demos-tx:v1:<chainId>:<hash>" once active.
// With no usable answer it reports "signature authority unavailable", apart from
// a malformed record, with its own exit code (3, where unreadable state is 2).
// It changes no transfer status and authorises no retry.
import './helpers/health-missing-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/database.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

const { opsHealth, formatOpsHealth } = await import('../src/ops/health.mjs');
const { DURABLE_WALLET_JOURNAL_FORMAT, DURABLE_WALLET_JOURNAL_VERSION } = await import('../src/wallet/durable-journal.mjs');

const sha = (value) => createHash('sha256').update(value).digest('hex');
const NETWORK = 'demos-devnet', CHAIN = 'd'.repeat(64), PAYEE = `0x${'a'.repeat(64)}`;
const INACTIVE = { chainId: 7, forks: { osDenomination: { activated: true }, signatureDomain: { activated: false } } };
const ACTIVE = { chainId: 7, forks: { osDenomination: { activated: true }, signatureDomain: { activated: true } } };
const preimage = (info, hash) => (info.forks.signatureDomain.activated ? `demos-tx:v1:${info.chainId}:${hash}` : hash);
const loader = new URL('./helpers/health-missing-modules.mjs', import.meta.url).href;

// A failed native transfer as the source transport keeps it, signed over the
// preimage `signedFor` calls for (the wallet signs what its node's answer says).
function failedRecord(wallet, signedFor, { nonce = 3, to = PAYEE } = {}) {
  const content = { type: 'native', from: wallet.address, to, amount: '1000000000', data: ['native', { nativeOperation: 'send', args: [to, '1000000000'] }], nonce, timestamp: 1_900_000_000_000 };
  const hash = sha(JSON.stringify(content));
  const signedTransaction = { content, hash, signature: { type: 'ed25519', data: wallet.signHex(preimage(signedFor, hash)) } };
  return { stage: 'failed', hash, nonce, signedTransaction, networkBinding: { network: NETWORK, chainIdentity: CHAIN }, failure: { blockNumber: 9, nonceFence: nonce - 1 } };
}
const keysOf = (r, wallet) => [`devnet/native-transfer/${r.hash}`, `devnet/native-wallet/${JSON.stringify([NETWORK, CHAIN, wallet.address])}`];

// The app database (one cancelled purchase by the transfer's buyer) and the source
// journal, laid out as the operator keeps them.
function stateWith(t, wallet, records) {
  const root = mkdtempSync(join(tmpdir(), 'ops-health-authority-')), state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(state, 'app'), { recursive: true });
  const databasePath = join(state, 'app', 'dacs-chatgpt.sqlite'), db = openDatabase(databasePath);
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  // One cancelled purchase by the transfer's buyer, written as the operation store
  // keeps it (this checkout cannot load that store).
  const at = new Date().toISOString(), id = 'pur_AAAAAAAAAAAAAAAA';
  const terms = { buyer: { wallet: wallet.address }, seller: { payee: PAYEE }, network: NETWORK, rail: 'demos-native:DEM', domain: { network: NETWORK, rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN } };
  db.prepare('INSERT INTO operations (id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,state,handoff_token_hash,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'TEST-buyer', 'purchase', 'TEST-A', sha('A'), 'cancelled', JSON.stringify(terms), sha('TEST-A'), '{}', sha('handoff'), new Date(Date.now() + 60000).toISOString(), at, at);
  db.prepare('INSERT INTO operation_events (operation_id,seq,at,type,data) VALUES (?,?,?,?,?)').run(id, 1, at, 'created', JSON.stringify({ status: 'cancelled' }));
  db.close();
  const journal = new DatabaseSync(join(state, 'node2-transport.sqlite'));
  const journalId = 'e'.repeat(32), rows = records.map(([key, value], i) => ({ key, seq: i + 1, value: JSON.stringify(value) }));
  journal.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE records (key TEXT PRIMARY KEY, seq INTEGER, value TEXT, digest TEXT, bytes INTEGER)');
  const meta = { format: DURABLE_WALLET_JOURNAL_FORMAT, version: String(DURABLE_WALLET_JOURNAL_VERSION), journal_id: journalId, records: String(rows.length), total_bytes: String(rows.reduce((n, r) => n + Buffer.byteLength(r.value), 0)), next_seq: String(rows.length + 1) };
  for (const [k, v] of Object.entries(meta)) journal.prepare('INSERT INTO meta VALUES (?,?)').run(k, v);
  for (const r of rows) journal.prepare('INSERT INTO records VALUES (?,?,?,?,?)').run(r.key, r.seq, r.value, sha(`${meta.format}\n${journalId}\n${r.key}\n${r.value}`), Buffer.byteLength(r.value));
  journal.close();
  return { state, databasePath, journalPath: join(state, 'node2-transport.sqlite') };
}
const withTransfer = (t, signedFor, edit = (r) => r) => {
  const wallet = createEphemeralWallet(), record = edit(failedRecord(wallet, signedFor));
  return { wallet, record, ...stateWith(t, wallet, keysOf(record, wallet).map((k) => [k, record])) };
};
const health = (s, networkInfo) => opsHealth({ databasePath: s.databasePath, operatorState: s.state, ...(networkInfo === undefined ? {} : { networkInfo }) });

// ---- failure cases first ----------------------------------------------------
test('a bare-hash record on an active-fork chain is invalid (corrupt), not accepted', (t) => {
  const s = withTransfer(t, INACTIVE);
  assert.throws(() => health(s, ACTIVE), /could not read valid state/);
});

test('a record signed for another chain id is invalid on an active-fork chain', (t) => {
  const s = withTransfer(t, { ...ACTIVE, chainId: 8 });
  assert.throws(() => health(s, ACTIVE), /could not read valid state/);
});

test('an unreadable node answer reports signature authority unavailable, not corruption', (t) => {
  const s = withTransfer(t, ACTIVE);
  for (const answer of [undefined, null, 'down', [], {}, { chainId: 7, forks: { signatureDomain: { activated: 'true' } } },
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

test('inactive fork: the bare-hash record is valid and the domain-form record is not (no second form)', (t) => {
  assert.equal(health(withTransfer(t, INACTIVE), INACTIVE).healthy, true);
  assert.throws(() => health(withTransfer(t, ACTIVE), INACTIVE), /could not read valid state/);
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
  for (const answer of [undefined, null, {}, 'x', { forks: { signatureDomain: { activated: 'false' } } }, { chainId: 7, forks: { signatureDomain: {} } }, { forks: { signatureDomain: { activated: true } } },
    { chainId: '7', forks: { signatureDomain: { activated: true } } }, { chainId: -1, forks: { signatureDomain: { activated: true } } }, { chainId: 2 ** 53, forks: { signatureDomain: { activated: true } } }]) {
    assert.equal(check(answer, sign(INACTIVE)), 'unavailable', JSON.stringify(answer));
    assert.equal(check(answer, sign(ACTIVE)), 'unavailable', JSON.stringify(answer));
  }
});

// ---- the command line ------------------------------------------------------
async function node(answer) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(answer === 'down' ? 'not json' : JSON.stringify({ result: 200, response: answer }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }) };
}
const cli = (s, env = {}) => new Promise((done) => {
  const child = spawn(process.execPath, ['--import', loader, 'scripts/ops-health.mjs', '--database', s.databasePath, '--operator-state', s.state, '--json'],
    { cwd: resolve('.'), env: { ...process.env, DACS_CHAIN_RPC_URL: '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (status) => done({ status, stdout, stderr }));
});
const exitWith = async (s, answer) => {
  if (answer === 'none') return cli(s);
  const server = await node(answer);
  try { return await cli(s, { DACS_CHAIN_RPC_URL: server.url }); } finally { await server.close(); }
};

test('command line: the configured node\'s answer decides; unavailable authority exits 3, corruption 2', async (t) => {
  const domain = withTransfer(t, ACTIVE), bare = withTransfer(t, INACTIVE);
  const ok = await exitWith(domain, ACTIVE);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(JSON.parse(ok.stdout).healthy, true);
  assert.equal((await exitWith(bare, ACTIVE)).status, 2, 'a bare-hash record on an active-fork chain is corrupt');
  assert.equal((await exitWith(bare, INACTIVE)).status, 0);
  for (const answer of ['none', 'down', {}, { forks: { signatureDomain: { activated: 'yes' } } }, { forks: { signatureDomain: { activated: true } } }]) {
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

test('command line: the node is not needed when no retained failed transfer needs it', async (t) => {
  const wallet = createEphemeralWallet(), s = stateWith(t, wallet, []);
  const out = await cli(s);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).signatureAuthorityUnavailable, []);
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
  assert.throws(() => health(withTransfer(t, ACTIVE), missing), /could not read valid state/);
});
