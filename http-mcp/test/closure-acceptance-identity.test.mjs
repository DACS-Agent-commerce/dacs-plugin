// Closure acceptance: identity-action recovery through the public portal API
// and MCP tools (SIMULATED fixture chain; the test "wallet" is a stand-in that
// reports what a wallet answered). Source-aware ordinary functional testing:
// NOT a security review, NOT live Demos testnet, NOT ChatGPT, NOT full v0.1
// acceptance. Only ordinary state and user-input cases; valid link tokens are
// always used.
//
// Expected results come from the closure identity interface (the embedded
// wallet's published interface), not from the classifier:
// - report from wallet_requested with success !== true, wallet === 'embedded'
//   and a documented stopped-before-broadcast code -> failed_before_send:
//   terminal, not in flight, readback not needed, no second wallet request
//   (409 invalid_state); the same wallet can start a new identity action.
// - without wallet:'embedded' (absent, 'extension', unrecognised) the old
//   rule holds: USER_REJECTED/user_rejected -> rejected_before_send, else
//   unknown -> readback_pending, which stays in flight and blocks.
// - ambiguous embedded answers (outcome_unknown, broadcast_rejected,
//   internal_error, wallet_error, sdk_error, wrong_wallet, other or absent
//   code) stay unknown and block.
// - POST /portal/api/identity/:id/cancel: 200 cancelled from prepared,
//   awaiting_wallet, awaiting_public_proof, review; idempotent on cancelled;
//   any status after the wallet was asked -> 409 invalid_state with
//   details.status.
// - identity_operation_in_progress details: operationId, status, expiresAt,
//   cancellable (additive).
// - a GitHub proof URL whose handle has characters outside [A-Za-z0-9-] ->
//   409 invalid_proof_url; the action stays awaiting_public_proof and a
//   corrected URL proceeds. Twitter is unchanged.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startHarness } from './helpers/harness.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';

const WRITE = 'dacs.account.read dacs.identities.write';
const PRE_SEND = ['locked', 'busy', 'invalid_params', 'invalid_request', 'not_configured', 'unsupported', 'held_for_review', 'upstream_unavailable', 'identity_mismatch', 'confirm_rejected', 'payload_mismatch'];
const AMBIGUOUS_EMBEDDED = ['outcome_unknown', 'broadcast_rejected', 'internal_error', 'wallet_error', 'sdk_error', 'wrong_wallet', 'some_new_code', null];
const PRE_WALLET = ['prepared', 'awaiting_wallet', 'awaiting_public_proof', 'review'];

// One fresh harness per test: each test links up to 12 accounts, and one
// harness's ordinary per-client rate limit (429 rate_limited on dynamic client
// registration) is reached after about 20. Nothing about the limit is tested.
let h;
beforeEach(async () => {
  h = await startHarness({ env: { DACS_IDENTITY_WRITES: 'simulated-fixture-only' } });
});
afterEach(async () => h.close());

const key = (label) => `${label}-${randomBytes(5).toString('hex')}`;
const handleOf = (label) => `${label}-${randomBytes(3).toString('hex')}`;

function portal(start) {
  const url = new URL(start.portalUrl);
  const id = url.pathname.split('/').pop();
  const token = new URLSearchParams(url.hash.slice(1)).get('t');
  return {
    id,
    async call(step, body = {}) {
      const res = await fetch(`${h.origin}/portal/api/identity/${id}/${step}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
      return { http: res.status, body: await res.json() };
    },
  };
}

const proofUrlFor = (kind, handle) => (kind === 'github' ? `https://gist.github.com/${handle}/${randomBytes(6).toString('hex')}` : `https://x.com/${handle}/status/${BigInt(`0x${randomBytes(6).toString('hex')}`)}`);

async function startAdd(user, kind = 'twitter') {
  const start = await tool(h, user, 'start_identity_action', { idempotencyKey: key('ca-id'), action: 'add', kind });
  assert.equal(start.error, undefined, `start_identity_action succeeded (${start.error ?? ''} ${start.message ?? ''})`);
  assert.equal(start.status, 'prepared');
  return { start, p: portal(start) };
}

// Drives an add through the documented portal steps up to `until`.
async function addTo(user, until, { kind = 'twitter', handle = handleOf(kind === 'github' ? 'gh' : 'tw') } = {}) {
  const { start, p } = await startAdd(user, kind);
  const proofUrl = proofUrlFor(kind, handle);
  const steps = [
    ['awaiting_wallet', () => p.call('view')],
    ['awaiting_public_proof', () => p.call('connected', { address: user.wallet.address })],
    ['review', () => p.call('proof', { proofUrl })],
    ['wallet_requested', () => p.call('request')],
  ];
  let status = 'prepared';
  for (const [next, run] of steps) {
    if (status === until) break;
    const r = await run();
    assert.equal(r.http, 200, `${next}: HTTP ${r.http} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.status, next);
    status = next;
  }
  assert.equal(status, until);
  return { start, p, handle, proofUrl };
}

async function opStatus(user, operationId) {
  const ids = await tool(h, user, 'get_identities');
  return ids.operations.find((o) => o.operationId === operationId);
}

const linkedHandles = async (user) => {
  const ids = await tool(h, user, 'get_identities');
  const w = ids.wallets.find((x) => x.address === user.wallet.address);
  return (w?.claims ?? []).filter((c) => c.kind === 'web2').map((c) => `${c.platform}:${c.handle}`).sort();
};

async function expectNextStarts(user, label) {
  const next = await tool(h, user, 'start_identity_action', { idempotencyKey: key('ca-next'), action: 'add', kind: 'github' });
  assert.equal(next.error, undefined, `${label}: the same wallet starts a new identity action (got ${next.error}: ${next.message})`);
  assert.equal(next.status, 'prepared', label);
  return next;
}

async function expectBlocked(user, blocker, status, label) {
  const next = await tool(h, user, 'start_identity_action', { idempotencyKey: key('ca-blocked'), action: 'add', kind: 'github' });
  assert.equal(next.error, 'identity_operation_in_progress', `${label}: a new identity action is refused`);
  assert.equal(next.details?.operationId, blocker, label);
  assert.equal(next.details?.status, status, label);
  assert.equal(typeof next.details?.expiresAt, 'string', `${label}: details.expiresAt`);
  assert.equal(typeof next.details?.cancellable, 'boolean', `${label}: details.cancellable`);
  return next;
}

test('CA-N0 accepting control: a valid add the wallet sent is observed by readback; the next action then starts', async () => {
  const user = await linkedUser(h, WRITE);
  const { start, p, handle } = await addTo(user, 'wallet_requested');
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: handle }); // SIMULATED wallet broadcast
  const reported = await p.call('report', { outcome: { success: true, wallet: 'embedded' } });
  assert.equal(reported.http, 200);
  assert.equal(reported.body.status, 'association_observed');
  assert.equal((await opStatus(user, start.operationId)).status, 'association_observed');
  assert.deepEqual(await linkedHandles(user), [`twitter:${handle}`]);
  await expectNextStarts(user, 'after an observed add');
});

test('CA-N1 every documented embedded pre-send code closes the action as failed_before_send; no second wallet request; the same wallet starts a new action', async () => {
  for (const code of PRE_SEND) {
    const user = await linkedUser(h, WRITE);
    const { start, p } = await addTo(user, 'wallet_requested');
    const reported = await p.call('report', { outcome: { success: false, code, message: `${code}: nothing was signed`, wallet: 'embedded' } });
    assert.equal(reported.http, 200, code);
    assert.equal(reported.body.status, 'failed_before_send', `${code} from the embedded wallet`);
    assert.equal((await opStatus(user, start.operationId)).status, 'failed_before_send', `${code}: get_identities agrees`);
    const again = await p.call('request');
    assert.equal(again.http, 409, `${code}: the wallet is not asked a second time`);
    assert.equal(again.body.error, 'invalid_state', code);
    assert.equal((await p.call('view')).body.status, 'failed_before_send', `${code}: re-viewing does not reopen it`);
    assert.deepEqual(await linkedHandles(user), [], `${code}: nothing linked`);
    await expectNextStarts(user, code);
  }
});

test('CA-N2 the same pre-send code without wallet:"embedded" keeps the old rule: unknown, readback_pending, blocking', async () => {
  for (const wallet of [undefined, 'extension', 'unrecognised-wallet']) {
    const user = await linkedUser(h, WRITE);
    const { start, p } = await addTo(user, 'wallet_requested');
    const outcome = { success: false, code: 'upstream_unavailable', message: 'the GitHub user could not be read; nothing was signed', ...(wallet ? { wallet } : {}) };
    const reported = await p.call('report', { outcome });
    assert.equal(reported.http, 200);
    assert.equal(reported.body.status, 'readback_pending', `wallet=${wallet}`);
    assert.equal(reported.body.walletOutcome?.classification, 'unknown', `wallet=${wallet}`);
    const blocked = await expectBlocked(user, start.operationId, 'readback_pending', `wallet=${wallet}`);
    assert.equal(blocked.details.cancellable, false, 'an action the wallet was asked for cannot be cancelled');
  }
  // Retained: a user rejection is rejected_before_send from either wallet.
  for (const [wallet, code] of [['extension', 'USER_REJECTED'], ['embedded', 'user_rejected'], [undefined, 'USER_REJECTED']]) {
    const user = await linkedUser(h, WRITE);
    const { p } = await addTo(user, 'wallet_requested');
    const reported = await p.call('report', { outcome: { success: false, code, message: 'rejected', ...(wallet ? { wallet } : {}) } });
    assert.equal(reported.body.status, 'rejected_before_send', `${wallet}/${code}`);
    await expectNextStarts(user, `${wallet}/${code}`);
  }
});

test('CA-N3 ambiguous embedded answers stay in flight and block; a later readback still resolves them without a retry', async () => {
  for (const code of AMBIGUOUS_EMBEDDED) {
    const user = await linkedUser(h, WRITE);
    const { start, p } = await addTo(user, 'wallet_requested');
    const reported = await p.call('report', { outcome: { success: false, ...(code ? { code } : {}), message: 'ambiguous', wallet: 'embedded' } });
    assert.equal(reported.http, 200, String(code));
    assert.equal(reported.body.status, 'readback_pending', `embedded ${code}: not closed`);
    await expectBlocked(user, start.operationId, 'readback_pending', `embedded ${code}`);
    assert.equal((await p.call('request')).http, 409, `embedded ${code}: no second wallet request`);
  }
  // Boundary: success:true is never turned into failed_before_send by a code.
  const user = await linkedUser(h, WRITE);
  const { start, p, handle } = await addTo(user, 'wallet_requested');
  const reported = await p.call('report', { outcome: { success: true, code: 'locked', wallet: 'embedded' } });
  assert.equal(reported.body.status, 'readback_pending', 'a reported success waits for readback');
  await expectBlocked(user, start.operationId, 'readback_pending', 'success with a code');
  h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: handle });
  assert.equal((await p.call('view')).body.status, 'association_observed', 'readback resolves it later, with no retry');
});

test('CA-N4 cancel from each pre-wallet state ends the action as cancelled (idempotent) and frees the wallet', async () => {
  for (const state of PRE_WALLET) {
    const user = await linkedUser(h, WRITE);
    const { start, p } = await addTo(user, state);
    const cancelled = await p.call('cancel');
    assert.equal(cancelled.http, 200, `${state}: ${JSON.stringify(cancelled.body).slice(0, 200)}`);
    assert.equal(cancelled.body.status, 'cancelled', state);
    const twice = await p.call('cancel');
    assert.equal(twice.http, 200, `${state}: cancel again is idempotent`);
    assert.equal(twice.body.status, 'cancelled');
    assert.equal((await opStatus(user, start.operationId)).status, 'cancelled', `${state}: get_identities agrees`);
    if (state === 'review') assert.equal((await p.call('request')).http, 409, 'a cancelled action never asks the wallet');
    await expectNextStarts(user, `cancelled from ${state}`);
  }
  // The user-visible recovery for an abandoned open action: blocked, cancel, start.
  const user = await linkedUser(h, WRITE);
  const { start, p } = await addTo(user, 'awaiting_public_proof');
  const blocked = await expectBlocked(user, start.operationId, 'awaiting_public_proof', 'abandoned open action');
  assert.equal(blocked.details.cancellable, true, 'an action not yet sent to the wallet is cancellable');
  assert.equal((await p.call('cancel')).body.status, 'cancelled');
  await expectNextStarts(user, 'after cancelling the abandoned action');
});

test('CA-N5 cancel after the wallet was asked is refused with invalid_state and changes nothing', async () => {
  const cases = [
    ['wallet_requested', async () => {}],
    ['readback_pending', async (p) => p.call('report', { outcome: { success: false, code: 'TIMEOUT', message: 'timed out' } })],
    ['failed_before_send', async (p) => p.call('report', { outcome: { success: false, code: 'locked', message: 'locked', wallet: 'embedded' } })],
    ['association_observed', async (p, user, handle) => {
      h.chain.seedWeb2Identity(user.wallet.address, 'twitter', { username: handle });
      return p.call('report', { outcome: { success: true, wallet: 'embedded' } });
    }],
  ];
  for (const [status, reach] of cases) {
    const user = await linkedUser(h, WRITE);
    const { start, p, handle } = await addTo(user, 'wallet_requested');
    await reach(p, user, handle);
    assert.equal((await p.call('view')).body.status, status, `precondition ${status}`);
    const refused = await p.call('cancel');
    assert.equal(refused.http, 409, status);
    assert.equal(refused.body.error, 'invalid_state', status);
    assert.equal(refused.body.details?.status, status, `${status}: details.status`);
    assert.equal((await opStatus(user, start.operationId)).status, status, `${status}: unchanged`);
  }
});

test('CA-N6 a GitHub proof URL with an underscore handle is refused at the proof step; the same action accepts the corrected URL and completes; Twitter is unchanged', async () => {
  const user = await linkedUser(h, WRITE);
  const { start, p } = await addTo(user, 'awaiting_public_proof', { kind: 'github' });
  const bad = await p.call('proof', { proofUrl: proofUrlFor('github', `ca_bad_${randomBytes(2).toString('hex')}`) });
  assert.equal(bad.http, 409);
  assert.equal(bad.body.error, 'invalid_proof_url');
  assert.ok(typeof bad.body.message === 'string' && bad.body.message.length > 0, 'the refusal is explained');
  assert.equal((await p.call('view')).body.status, 'awaiting_public_proof', 'the action stays at the proof step');
  const good = handleOf('ca-ok');
  const fixed = await p.call('proof', { proofUrl: proofUrlFor('github', good) });
  assert.equal(fixed.http, 200);
  assert.equal(fixed.body.status, 'review');
  assert.equal(fixed.body.username, good);
  assert.equal((await p.call('request')).body.status, 'wallet_requested');
  h.chain.seedWeb2Identity(user.wallet.address, 'github', { username: good });
  assert.equal((await p.call('report', { outcome: { success: true, wallet: 'embedded' } })).body.status, 'association_observed');
  assert.equal((await opStatus(user, start.operationId)).status, 'association_observed');
  assert.deepEqual(await linkedHandles(user), [`github:${good}`]);

  // Twitter handles may contain underscores: unchanged.
  const tw = await linkedUser(h, WRITE);
  const { p: tp } = await addTo(tw, 'awaiting_public_proof');
  const ok = await tp.call('proof', { proofUrl: proofUrlFor('twitter', `ca_tw_${randomBytes(2).toString('hex')}`) });
  assert.equal(ok.http, 200);
  assert.equal(ok.body.status, 'review');
});
