import test from 'node:test';
import assert from 'node:assert/strict';
import {mountEmbeddedWallet} from '../public/portal/embedded-wallet/ui.mjs';
import {Node,fakeDocument,flush} from './helpers/portal-auto-dom.mjs';

async function lockedWallet(){
  const document=fakeDocument();globalThis.document=document;globalThis.Node=Node;
  const reported=[];
  Node.prototype.reportValidity=function(){reported.push(this);return false;};
  let reads=0;
  const vaultStore={get:async()=>{reads++;return{address:'0x'+'1'.repeat(64)};},put:async()=>{},clear:async()=>{}};
  const root=document.getElementById('wallet');
  const handle=mountEmbeddedWallet(root,{vaultStore,sessionFactory:async()=>{throw new Error('no session is opened by an empty unlock');}});
  await handle.ready;
  const form=root.querySelectorAll('form').find(f=>f.querySelectorAll('button').some(b=>b.text==='Unlock'));
  return{handle,root,form,reported,reads:()=>reads};
}

test('an empty unlock password is refused with the required-field state: no key derivation, no vault read, the field stays enabled',async()=>{
  const w=await lockedWallet();
  try{
    assert.ok(w.form,'the locked view has an unlock form');
    const input=w.form.querySelector('input');
    assert.equal(input.value,'');
    const before=w.reads();
    await w.form.fire('submit');await flush();
    assert.equal(w.reads(),before,'an empty submit never reaches the vault');
    assert.deepEqual(w.reported,[input],'the browser required-field message is requested on the password field');
    assert.notEqual(input.disabled,true,'the field is not disabled, so it keeps reporting valueMissing');
    assert.notEqual(w.root.attributes['aria-busy'],'true','the busy state was never entered');
    assert.equal(w.handle.getPublicState().locked,true);
  }finally{w.handle.destroy();delete Node.prototype.reportValidity;}
});

test('a non-empty unlock password still goes through the unlock path',async()=>{
  const w=await lockedWallet();
  try{
    w.form.querySelector('input').value='not-the-password';
    const before=w.reads();
    await w.form.fire('submit');await flush();
    assert.equal(w.reads(),before+1);
    assert.deepEqual(w.reported,[]);
    assert.equal(w.handle.getPublicState().locked,true);
  }finally{w.handle.destroy();delete Node.prototype.reportValidity;}
});
