// In-memory mutations only. Production files and git metadata stay untouched.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const guard="if (previous && previous.stage !== 'observed') fail('outcome_unknown','the retained native transfer must be read back; it is never resent');";
const mutants={
  recipient:['src/devnet-demo/operator-buyer-approval.mjs','&& content.to===expectation.payee',''],
  unknown:['test/helpers/showcase-safety-status.mjs',"observation.status==='unavailable'?'unknown':observation.status",'observation.status'],
  'no-resend':['src/wallet/devnet-native-transport.mjs',guard,'',"if(retained && retained.stage !== 'observed') fail('outcome_unknown','an issued native transfer appeared while acquiring the connection fence');"],
  'retain-intent':['src/wallet/devnet-native-transport.mjs','await retain(intent(tx.hash),issued);',''],
  'delivery-absent':['src/dacs/dem-delivery-consumer.mjs',"if (record.status !== 'present') return { disposition: record.status==='rejected'?'rejected':'indeterminate', reason: record.reason ?? 'canonical deliverable is not present' };",''],
  'delivery-unavailable':['src/dacs/dem-delivery-consumer.mjs','return { disposition: \'indeterminate\', reason: `deliverable read failed: ${error?.message ?? error}` };','throw error;'],
  'delivery-projection':['src/dacs/protocol-purchases.mjs',"reached('delivery-ready', 'delivered', 'awaiting-countersignature', 'completed', 'bundle-rejected') ? p.delivery : null",'p.delivery'],
  selector:['scripts/showcase-safety.mjs','if(names.some(key=>!Object.hasOwn(scenarios,key)))throw new Error(`choose all or ${Object.keys(scenarios).join(\', \')}`);',''],
  transcript:['scripts/showcase-safety.mjs',"print('OFFLINE SAFETY SHOWCASE — fake chain/transport callbacks, no network sockets or external requests; no live effects.');",''],
};
const mutation=mutants[process.env.DACS_SHOWCASE_MUTANT];
assert.ok(mutation,'choose an explicit showcase mutant');
registerHooks({load(url,context,nextLoad){
  const result=nextLoad(url,context);
  if(url.endsWith('/'+mutation[0])){
    const source=String(result.source);
    assert.equal(source.split(mutation[1]).length,2,'mutation must remove exactly one guard');
    let changed=source.replace(mutation[1],mutation[2]);
    if(mutation[3]){assert.equal(changed.split(mutation[3]).length,2);changed=changed.replace(mutation[3],'');}
    return {...result,source:changed};
  }
  return result;
}});
