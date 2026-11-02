// A seller session key record that no longer parses is kept and reported, but
// the parser's message quotes the text it failed on, which can be inside the
// private key. Only fixed text may leave the store: in kept reasons, in
// errors from signing, and on the operator's stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { createOperatorSellerSessions } from '../src/devnet-demo/operator-sessions.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

const UNREADABLE = 'seller session key record is unreadable';
// The PKCS#8 ed25519 prefix is public; any 8 characters after it are secret.
const fragments = (privateKey) => Array.from({ length: privateKey.length - 29 }, (_, index) => privateKey.slice(22 + index, 30 + index));
const leaks = (text, privateKey) => fragments(privateKey).some((fragment) => text.includes(fragment));
// Damaged records whose surviving text starts inside, or breaks off inside, the key.
const damage = {
  'starts inside the key': (raw, privateKey) => raw.slice(raw.indexOf(privateKey) + Math.floor(privateKey.length * 0.65)),
  'unquoted key': (raw, privateKey) => raw.replace(`"${privateKey}"`, privateKey),
  'stray quote inside the key': (raw, privateKey) => { const at = raw.indexOf(privateKey) + Math.floor(privateKey.length * 0.65); return `${raw.slice(0, at)}"${raw.slice(at)}`; },
};

test('an unreadable key record is reported with fixed text only, by the sweep and by signing', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-session-secrecy-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessions = createOperatorSellerSessions({ directory }), seller = createEphemeralWallet();
  for (const [name, edit] of Object.entries(damage)) {
    const operation = { id: `TEST-${name}`, accountId: 'TEST', terms: { buyer: { wallet: createEphemeralWallet().address }, seller: { claim: seller.claim }, listing: { listingId: 'TEST', version: 1, contentHash: 'a'.repeat(64) }, protocol: { jobId: generateCanonicalJobId() } },
      state: { protocol: { listing: { terms: { deadlineSecAfterCommit: 3600 } }, agreement: { artifact: { terms: { deadline: Date.now() + 3600000 } } } } } };
    sessions.request(operation);
    const path = join(directory, `${sha256Hex(operation.id)}.json`), raw = readFileSync(path, 'utf8'), { privateKey } = JSON.parse(raw);
    writeFileSync(path, edit(raw, privateKey), { mode: 0o600 });
    const kept = sessions.sweep(() => operation).kept.find((item) => item.key === sha256Hex(operation.id));
    assert.equal(kept?.reason, `unreadable record: ${UNREADABLE}`, name);
    assert.equal(leaks(JSON.stringify(kept), privateKey), false, name);
    operation.state.protocol.sessionDelegation = { payload: {} };
    assert.throws(() => sessions.signerFor(operation), (error) => error.message === UNREADABLE && !leaks(String(error.stack), privateKey), name);
    rmSync(path);
  }
});

test('the operator sweep never copies key bytes from an unreadable record to stderr', { timeout: 300000 }, async (t) => {
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true }); t.after(() => h.close());
  const time = Date.now(), id = 'TEST-secret-record', ops = h.application.services.ops;
  h.application.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(id, 'TEST', id, new Date(time).toISOString());
  const operation = ops.createIdempotent({ accountId: id, kind: 'purchase', idempotencyKey: id, request: { id }, status: 'agreement_pending', terms: { buyer: { wallet: createEphemeralWallet().address }, seller: { claim: h.prepared.operatorEvidence.seller },
    listing: h.composition.published.listingPin, protocol: { jobId: generateCanonicalJobId() } }, termsHash: 'a'.repeat(64), expiresAt: new Date(time + 3600000).toISOString(), state: { protocol: { stage: 'identity', listing: h.composition.listing } } }).operation;
  const directory = join(h.config.stateDirectory, 'seller-sessions');
  createOperatorSellerSessions({ directory }).request(operation);
  const path = join(directory, `${sha256Hex(operation.id)}.json`), raw = readFileSync(path, 'utf8'), { privateKey } = JSON.parse(raw);
  writeFileSync(path, damage['starts inside the key'](raw, privateKey), { mode: 0o600 });
  const errors = [], write = process.stderr.write;
  let result;
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  try { result = h.operator.sweepSellerSessions(); } finally { process.stderr.write = write; }
  assert.deepEqual(result.kept.map((item) => item.reason), [`unreadable record: ${UNREADABLE}`]);
  assert.deepEqual(errors, [`seller-session-sweep: ${sha256Hex(operation.id)}: unreadable record: ${UNREADABLE}\n`]);
  assert.equal(leaks(errors.join('') + JSON.stringify(result), privateKey), false);
});
