import test from 'node:test';
import assert from 'node:assert/strict';

const active = (chainId) => ({ chainId, forks: { signatureDomain: { activated: true } } });
const missing = (chainId) => ({ chainId, forks: {} });
export function transactionDomainCases(label, makeCheck) {
  // The provider returns one refusal code; the two verifier APIs expose availability.
  const unavailable = label === 'browser provider' ? 'invalid' : 'unavailable';
  test(`${label}: unseen chain with missing member verifies only the bare hash`, async (t) => {
    const check = await makeCheck(t);
    assert.equal(await check(missing(1), 'bare'), 'valid');
    assert.equal(await check(missing(1), 'domain'), 'invalid');
  });
  for (const [name, answer] of [['missing', missing(1)], ['false', { chainId: 1, forks: { signatureDomain: { activated: false } } }]]) {
    test(`${label}: active chain 1 then ${name} refuses`, async (t) => {
      const check = await makeCheck(t);
      assert.equal(await check(missing(1), 'bare'), 'valid');
      assert.equal(await check(active(1), 'domain'), 'valid');
      assert.equal(await check(answer, 'bare'), unavailable);
      assert.equal(await check(answer, 'domain'), unavailable);
    });
  }
  test(`${label}: active chain 1 does not restrict missing member on chain 2`, async (t) => {
    const check = await makeCheck(t);
    assert.equal(await check(active(1), 'domain'), 'valid');
    assert.equal(await check(missing(2), 'bare'), 'valid');
  });
  for (const [name, signatureDomain] of [['string activated', { activated: 'true' }], ['boolean member', true]]) {
    test(`${label}: ${name} refuses both forms`, async (t) => {
      const check = await makeCheck(t);
      for (const form of ['bare', 'domain']) assert.equal(await check({ chainId: 1, forks: { signatureDomain } }, form), unavailable);
    });
  }
  test(`${label}: guard retains 16 chain ids and drops the oldest first`, async (t) => {
    const check = await makeCheck(t);
    for (let id = 1; id <= 16; id++) assert.equal(await check(active(id), 'domain'), 'valid');
    assert.equal(await check(active(1), 'domain'), 'valid', 'seeing an id again does not change its age');
    assert.equal(await check(active(17), 'domain'), 'valid');
    assert.equal(await check(missing(1), 'bare'), 'valid', 'oldest id was dropped');
    for (let id = 2; id <= 17; id++) assert.equal(await check(missing(id), 'bare'), unavailable);
  });
  test(`${label}: public testnet answer selects the bare hash`, async (t) => {
    // Mirrors the public testnet node's answer on 2026-11-11.
    const answer = { chainId: 1, forks: { signatureDomain: { activationHeight: null, activated: false, currentHeight: 76177 } } };
    const check = await makeCheck(t);
    assert.equal(await check(answer, 'bare'), 'valid');
    assert.equal(await check(answer, 'domain'), 'invalid');
  });
  test(`${label}: a separate instance starts with an empty guard`, async (t) => {
    assert.equal(await (await makeCheck(t))(active(1), 'domain'), 'valid');
    assert.equal(await (await makeCheck(t))(missing(1), 'bare'), 'valid');
  });
}
