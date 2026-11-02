import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';

test('durable final time survives unchanged observations and reconstruction, resets only when unresolved',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());let time=Date.now();
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('a','TEST','a',new Date(time).toISOString());
  const make=()=>createOperationStore({db,handoffSecret:'k'.repeat(32),now:()=>time});let ops=make();
  let operation=ops.createIdempotent({accountId:'a',kind:'purchase',idempotencyKey:'a',request:{},status:'settled_verified',terms:{},termsHash:'a'.repeat(64),expiresAt:new Date(time+3600000).toISOString(),state:{protocol:{stage:'payment-observed',sessionDelegation:{payload:{expiresAt:time+3600000}}}}}).operation;
  const move=(stage)=>{operation=ops.transition(operation.id,operation.status,'settled_verified',{state:{protocol:{...operation.state.protocol,stage}},event:'TEST_observed'});};
  move('delivery-ready');const first=time;
  assert.equal(operation.state.protocol.sellerSessionFinalAt,first);
  for(let n=0;n<8;n++){time+=10*60000;move('delivery-ready');ops=make();assert.equal(ops.get('a',operation.id).state.protocol.sellerSessionFinalAt,first);}
  move('delivered');assert.equal(operation.state.protocol.sellerSessionFinalAt,first);
  move('payment-evidenced');assert.equal(Object.hasOwn(operation.state.protocol,'sellerSessionFinalAt'),false);
  time+=1000;move('delivery-ready');assert.equal(operation.state.protocol.sellerSessionFinalAt,time);
  const final=operation.state.protocol.sellerSessionFinalAt;time+=1000;
  operation=ops.transition(operation.id,'settled_verified','settled_verified',{state:{protocol:{...operation.state.protocol,sellerSessionFinalAt:time}},event:'TEST_attempt_reset'});
  assert.equal(operation.state.protocol.sellerSessionFinalAt,final,'callers cannot reset the final clock');
});
