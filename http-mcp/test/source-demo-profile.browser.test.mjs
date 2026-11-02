// Named Chrome consumer for the source-demo capability descriptor. The full
// effectful TEST purchase is exercised in source-demo-e2e.test.mjs; this check
// proves the actual packaged browser provider accepts the same separately
// declared SettlementEvidence policy without making a wallet or chain write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetAgreementTransportHarness } from './helpers/devnet-agreement-transport-harness.mjs';
import { launchTestChrome, openRecordedPage, createCleanupStack } from './helpers/embedded-wallet-fixtures.mjs';

test('Chrome packaged provider consumes the exact source-demo settlement capability without a write', { timeout: 120000 }, async (t) => {
  const cleanup=createCleanupStack();t.after(()=>cleanup.run());
  const h=await startDevnetAgreementTransportHarness({settlementEnabled:true});cleanup.add('source-demo harness',10000,()=>h.close());
  const launched=await launchTestChrome(cleanup);t.diagnostic(`browser-real Chrome ${launched.version}; ${launched.executablePath}`);
  const {page,requests,consoleErrors}=await openRecordedPage(launched.browser,cleanup);
  await page.route('**/*',(route)=>new URL(route.request().url()).origin===h.origin?route.continue():route.abort());
  await page.goto(`${h.origin}/portal/assets/embedded-wallet/index.html`);
  const receipt=await page.evaluate(async()=>{
    const profile=await fetch('/portal/api/devnet-native-wallet-profile',{method:'POST'}).then((r)=>r.json());
    const provider=await import('/portal/assets/embedded-wallet/sdk-provider.mjs');
    const capability=provider.createDevnetAgreementWalletTransport(profile);
    return {profile:capability.profile,network:capability.network,kinds:[provider.DEVNET_AGREEMENT_STORAGE_KIND,provider.DEVNET_SETTLEMENT_STORAGE_KIND],binding:capability.transportBinding,publication:capability.settlementPublication};
  });
  assert.equal(receipt.profile,'devnet-agreement');
  assert.deepEqual(receipt.kinds,['devnet-agreement-storage-create','devnet-settlement-evidence-storage-create']);
  assert.deepEqual(receipt.publication,h.capability.settlementPublication);
  assert.deepEqual(receipt.binding,h.capability.transportBinding);
  assert.equal(h.chain.wire.record.broadcastAttempts.length,0);assert.equal(h.chain.record.broadcasts.length,0);
  assert.deepEqual(consoleErrors,[]);assert.ok(requests.every((r)=>new URL(r.url).origin===h.origin));
  t.diagnostic(JSON.stringify({browser:launched.version,profile:receipt.profile,network:receipt.network,bindingId:receipt.binding.bindingId,settlementPolicy:receipt.publication.policy,writes:0}));
});
