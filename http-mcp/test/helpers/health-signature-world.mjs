// An operator state for ops health: the app database, created through the store,
// and the source transport journal holding retained failed native transfers, plus
// a stand-in node that answers getNetworkInfo and a runner for the health command.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DURABLE_WALLET_JOURNAL_FORMAT, DURABLE_WALLET_JOURNAL_VERSION } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { openDatabase } from '../../src/store/database.mjs';
import { opsHealth } from '../../src/ops/health.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';

export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const NETWORK = 'demos-devnet', CHAIN = 'd'.repeat(64), PAYEE = `0x${'a'.repeat(64)}`;
export const INACTIVE = { chainId: 7, forks: { osDenomination: { activated: true }, signatureDomain: { activated: false } } };
export const ACTIVE = { chainId: 7, forks: { osDenomination: { activated: true }, signatureDomain: { activated: true } } };
export const preimage = (info, hash) => (info.forks.signatureDomain.activated ? `demos-tx:v1:${info.chainId}:${hash}` : hash);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

// A failed native transfer as the source transport keeps it, signed over the
// preimage `signedFor` calls for (the wallet signs what its node's answer says).
export function failedRecord(wallet, signedFor, { nonce = 3, to = PAYEE } = {}) {
  const content = { type: 'native', from: wallet.address, to, amount: '1000000000', data: ['native', { nativeOperation: 'send', args: [to, '1000000000'] }], nonce, timestamp: 1_900_000_000_000 };
  const hash = sha(JSON.stringify(content));
  const signedTransaction = { content, hash, signature: { type: 'ed25519', data: wallet.signHex(preimage(signedFor, hash)) } };
  return { stage: 'failed', hash, nonce, signedTransaction, networkBinding: { network: NETWORK, chainIdentity: CHAIN }, failure: { blockNumber: 9, nonceFence: nonce - 1 } };
}
export const keysOf = (r, wallet) => [`devnet/native-transfer/${r.hash}`, `devnet/native-wallet/${JSON.stringify([NETWORK, CHAIN, wallet.address])}`];

const insertPurchase = (db, id, status, terms, at) => {
  db.prepare('INSERT INTO operations (id,account_id,kind,idempotency_key,request_hash,status,terms,terms_hash,state,handoff_token_hash,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'TEST-buyer', 'purchase', `TEST-${id}`, sha(id), status, JSON.stringify(terms), sha(`TEST-${id}`), '{}', sha(`handoff-${id}`), new Date(Date.now() + 60000).toISOString(), at, at);
  db.prepare('INSERT INTO operation_events (operation_id,seq,at,type,data) VALUES (?,?,?,?,?)').run(id, 1, at, 'created', JSON.stringify({ status }));
};

// The app database (one cancelled purchase by the transfer's buyer, and with
// `stuck` a second one an hour into an uncertain payment) and the source
// journal, laid out as the operator keeps them.
export function stateWith(t, wallet, records, { stuck = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ops-health-authority-')), state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(state, 'app'), { recursive: true });
  const databasePath = join(state, 'app', 'dacs-chatgpt.sqlite'), db = openDatabase(databasePath);
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const terms = { buyer: { wallet: wallet.address }, seller: { payee: PAYEE }, network: NETWORK, rail: 'demos-native:DEM', domain: { network: NETWORK, rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN } };
  insertPurchase(db, 'pur_AAAAAAAAAAAAAAAA', 'cancelled', terms, new Date().toISOString());
  if (stuck) insertPurchase(db, 'pur_BBBBBBBBBBBBBBBB', 'payment_uncertain', terms, new Date(Date.now() - 3_600_000).toISOString());
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
export const withTransfer = (t, signedFor, edit = (r) => r, options) => {
  const wallet = createEphemeralWallet(), record = edit(failedRecord(wallet, signedFor));
  return { wallet, record, ...stateWith(t, wallet, keysOf(record, wallet).map((k) => [k, record]), options) };
};
export const health = (s, networkInfo) => opsHealth({ databasePath: s.databasePath, operatorState: s.state, ...(networkInfo === undefined ? {} : { networkInfo }) });

// A node whose getNetworkInfo answer is `answer` ('down' answers with a body that is not JSON).
export async function node(answer) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests += 1;
    await new Promise((drained) => { req.on('end', drained); req.resume(); });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(answer === 'down' ? 'not json' : JSON.stringify({ result: 200, response: answer }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests: () => requests, close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }) };
}
// Runs the health command (`script`, from the package root) over the state, with no loader of any kind.
export const cli = (s, env = {}, script = 'scripts/ops-health.mjs') => new Promise((done) => {
  const child = spawn(process.execPath, [script, '--database', s.databasePath, '--operator-state', s.state, '--json'],
    { cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: '', DACS_CHAIN_RPC_URL: '', ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (status) => done({ status, stdout, stderr }));
});
// The command's result against a node answering `answer`, or with no node configured ('none').
export const exitWith = async (s, answer, script) => {
  if (answer === 'none') return cli(s, {}, script);
  const server = await node(answer);
  try { return await cli(s, { DACS_CHAIN_RPC_URL: server.url }, script); } finally { await server.close(); }
};
