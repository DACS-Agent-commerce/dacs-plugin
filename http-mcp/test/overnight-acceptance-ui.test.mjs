// Overnight ORDINARY functional acceptance of the guided dashboard's seller
// wizard and buyer flow through its PUBLIC HTTP interface, the portal API and
// the fixture chain's public RPC, on the offline launcher (the installed user
// path). SIMULATED fixtures only. Source-aware; NOT a security review, NOT live
// Demos testnet, NOT ChatGPT, NOT v0.1 acceptance.
//
// Expected texts and stages come from the public tester guide
// (docs/OVERNIGHT-UI.md, docs/TESTER-DASHBOARD.md) and the behaviour contract,
// not from the dashboard's own tests. Seller and buyer "wallets" are synthetic
// extension-wallet stand-ins (labelled); the built-in wallet's publication is
// covered (and currently failing) in the browser file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startOfflineTester } from '../bin/offline-fixtures/operator.mjs';
import { startFixtureChain, deriveStorageAddress } from '../bin/offline-fixtures/chain.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { demToOs, unique } from './helpers/overnight-acceptance-flows.mjs';
import {
  act, dashState, evidence, signIn, signTx, submitTx, rpc, txByHash, readStoragePublic, publishFromPortal, payFromPortal, stageStates,
} from './helpers/overnight-acceptance-dashboard.mjs';

const launchers = [];
async function launcher() {
  const h = await startOfflineTester({ dashboard: true, logLevel: 'silent' });
  launchers.push(h);
  return h;
}
after(async () => {
  for (const h of launchers) await h.stop();
});

const SELLER_STAGES = ['prepared', 'signed', 'submitted', 'chain', 'directory', 'discoverable'];

// Fixture chain storage-program CREATE: ordinary accepting and refusing
// controls (fixture behaviour, not protocol probing).
test('OA-U4 fixture chain: a correct storage-program CREATE is accepted and readable; a CREATE at an already-used address is refused and changes nothing', { timeout: 30_000 }, async () => {
  const chain = await startFixtureChain();
  try {
    const w = createEphemeralWallet();
    const make = (nonce, programName, data) => {
      const storageAddress = deriveStorageAddress(w.address, programName, nonce);
      return { content: { type: 'storageProgram', from: w.address, to: storageAddress, amount: 0, data: ['storageProgram', { operation: 'CREATE_STORAGE_PROGRAM', storageAddress, programName, encoding: 'json', data }], nonce, timestamp: Date.now(), transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null } } };
    };
    // Accepting control.
    const good = make(1, 'overnight-a', { hello: 'world', n: 1 });
    const ok1 = await submitTx(chain.url, signTx(w, good));
    assert.equal(ok1.broadcast, true, ok1.reason);
    const stored = await readStoragePublic(chain.url, good.content.to);
    assert.deepEqual([stored.http, stored.body.owner, stored.body.data], [200, w.address, { hello: 'world', n: 1 }]);
    assert.equal(chain.nonceOf(w.address), 1);
    assert.equal(chain.stats().storagePrograms, 1);
    // Already-used address: the next nonce's derived address pre-occupied.
    const next = make(2, 'overnight-b', { second: true });
    chain.seedStorage(next.content.to, { data: { occupied: true }, owner: `0x${'1'.repeat(64)}` });
    const refused = await submitTx(chain.url, signTx(w, next));
    assert.equal(refused.confirmed, false);
    assert.match(refused.reason, /already exists/);
    assert.deepEqual((await readStoragePublic(chain.url, next.content.to)).body.data, { occupied: true }, 'existing program unchanged');
    assert.equal(chain.nonceOf(w.address), 1, 'nonce unchanged by a refused write');
    // A correct write at a fresh address still works afterwards.
    const later = make(2, 'overnight-c', { third: true });
    assert.equal((await submitTx(chain.url, signTx(w, later))).broadcast, true);
    assert.equal(chain.stats().storagePrograms, 3);
    // Unknown address read is a plain 404.
    assert.equal((await readStoragePublic(chain.url, `stor-${'0'.repeat(40)}`)).http, 404);
    const status = await rpc(chain.url, { method: 'nodeCall', params: [{ message: 'getTransactionStatus', data: { hash: ok1.txHash } }] });
    assert.equal(status.response.state, 'included');
  } finally {
    await chain.close();
  }
});
