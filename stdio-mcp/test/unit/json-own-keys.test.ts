import assert from 'node:assert/strict';
import test from 'node:test';
import { toJsonSafe, stringify } from '../../src/json.js';
for(const payload of ['{"__proto__":{"label":"signed metadata"},"hash":"retained"}', '{"nested":{"__proto__":"ordinary value"}}','{"__proto__":null,"constructor":"field"}']) {
 test(`JSON-safe output preserves own data keys: ${payload}`,()=>{
  const input=JSON.parse(payload);
  assert.equal(JSON.stringify(toJsonSafe(input)),JSON.stringify(input));
  assert.deepEqual(JSON.parse(stringify(input)),input);
 });
}
test('ordinary nested data still round-trips',()=>{
 const input={child:{text:'value'},array:[1,true,null]};
 assert.deepEqual(toJsonSafe(input),input);
});
