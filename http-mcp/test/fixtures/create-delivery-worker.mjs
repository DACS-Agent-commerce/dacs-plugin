import { deliveryWorld } from '../helpers/create-delivery-world.mjs';
import { openDurableWalletJournal } from '@kynesyslabs/dacs-client/wallet/durable-journal';
import { PURPOSES } from '../../src/wallet/challenges.mjs';

const input = JSON.parse(process.argv[2]);
const world = deliveryWorld({ path: input.path, seed: false, wallet: { address: input.wallet } });
const journal = openDurableWalletJournal({ path: input.journalPath, mode: 'create' });
let journalCalls = 0;
for (const method of ['get', 'put', 'entries', 'withWalletLock']) {
  const original = journal[method].bind(journal);
  journal[method] = (...args) => { journalCalls++; return original(...args); };
}
world.delivery.walletFactoryFor('purchase')({ anchorJournal: journal });
// Blocks at once, inside any open transaction: a send callback would only run after the synchronous claim had committed.
const pause = (point) => {
  if (input.point !== point) return;
  process.send({ point, journalCalls });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
if (input.point === 'delivery') {
  await world.send();
  pause('delivery');
} else {
  const start = world.start();
  world.delivery.bindStart({ operationId: 'purchase', start });
  const answer = world.delivery.claim({ operationId: 'purchase', start,
    consume: () => {
      world.challenges.verifyAndConsume({ challengeId: input.challengeId, purpose: PURPOSES.AGREEMENT_CREATE_CLAIM,
        expectedBinding: {}, signature: input.signature, consumedBy: 'purchase' });
      pause('consumed');
    },
    mintRelay: () => {
      pause('claimed');
      const relay = world.relayAccess.mint({ operationId: 'purchase', phases: ['rpc'] });
      pause('capabilities');
      return relay;
    },
  });
  if (!answer.request) throw new Error('claim did not commit');
  pause('committed');
}
throw new Error('the requested crash point was not reached');
