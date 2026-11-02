import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const moduleUrl=process.env.PUBLIC_TEXT_REPORT_TEST_MODULE ?? new URL('../src/devnet-demo/services/public-text-report.mjs',import.meta.url);
const {producePublicTextReport:produce,PUBLIC_TEXT_REPORT_SERVICE_ID:serviceId,PUBLIC_TEXT_REPORT_SERVICE_VERSION:serviceVersion,
  PUBLIC_TEXT_REPORT_MAX_INPUT_BYTES:maxInput,PUBLIC_TEXT_REPORT_MAX_CONTENT_BYTES:maxContent}=await import(moduleUrl);
const digest=(text)=>createHash('sha256').update(text,'utf8').digest('hex');
const cats='Cats chase mice. Cats nap.';
const solar='Solar panels make power. Power helps homes! Clean power matters.';
const goldens=[
  {input:cats,inputHash:'6eef6f78d44c339c554c4bc9c03dfb89ea09cb176a39e4290959b5e5fea3d325',outputHash:'3746a036f52c146c6146730fb6fc4a71cac6e995d1624655a644a80577738bb9',text:`Public text report: dacs-public-text-report v1
Input SHA-256: 6eef6f78d44c339c554c4bc9c03dfb89ea09cb176a39e4290959b5e5fea3d325
Characters (including whitespace): 26
Words: 5
Sentences: 2
Reading grade (rough ARI, 1-18): 1
Frequent terms: cats (2), chase (1), mice (1), nap (1)
Longest sentence (16 characters): Cats chase mice.
Extractive summary:
1. Cats chase mice.
2. Cats nap.
`},
  {input:solar,inputHash:'701f8bd168d8171b42de1f98144c4a8fd195bf161315b4ca8424297c34d5d6ae',outputHash:'d7912aff2f038d657e8c595a75ab550c82b4b6dc15caa46cbc6d1c0081d7bfc4',text:`Public text report: dacs-public-text-report v1
Input SHA-256: 701f8bd168d8171b42de1f98144c4a8fd195bf161315b4ca8424297c34d5d6ae
Characters (including whitespace): 64
Words: 10
Sentences: 3
Reading grade (rough ARI, 1-18): 5
Frequent terms: power (3), clean (1), helps (1), homes (1), make (1)
Longest sentence (24 characters): Solar panels make power.
Extractive summary:
1. Solar panels make power.
2. Power helps homes!
`},
];

test('fixed inputs produce byte-exact golden results and distinct purchased work',()=>{
  assert.equal(serviceId,'dacs-public-text-report');assert.equal(serviceVersion,'1');assert.equal(maxInput,4096);assert.equal(maxContent,4096);
  for(const {input,inputHash,outputHash,text} of goldens){
    const result=produce(input);
    assert.deepEqual(result,{serviceId,serviceVersion,inputHash,outputHash,mediaType:'text/plain; charset=utf-8',text});
    assert.deepEqual(Object.keys(result),['serviceId','serviceVersion','inputHash','outputHash','mediaType','text']);
    assert.deepEqual(Buffer.from(result.text),Buffer.from(text));
  }
  assert.notEqual(produce(cats).text,produce(solar).text);assert.notEqual(produce(cats).outputHash,produce(solar).outputHash);
});

test('fresh processes repeat complete result bytes across locale, timezone and invocation order',()=>{
  const inputs=[cats,solar,"Zed. Ace. Dog.",'cat\r\ncat.',cats];
  const expected=JSON.stringify(inputs.map(produce));
  const script="import {readFileSync} from 'node:fs'; const {producePublicTextReport}=await import(process.argv[1]); process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(producePublicTextReport)));";
  for(const [LANG,TZ] of [['C','Etc/UTC'],['tr_TR.UTF-8','Pacific/Honolulu']]){
    const result=spawnSync(process.execPath,['--input-type=module','--eval',script,String(moduleUrl)],{input:JSON.stringify(inputs),encoding:'utf8',env:{...process.env,LANG,LC_ALL:LANG,TZ}});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,expected);
  }
});

test('hashes bind exact raw input and final LF text without normalized-input collisions',()=>{
  for(const input of ['cat\r\ncat.','cat\ncat.',' cat cat. ','cat cat.']){
    const result=produce(input);assert.equal(result.inputHash,digest(input));assert.equal(result.outputHash,digest(result.text));
    assert.match(result.text,new RegExp(`Input SHA-256: ${digest(input)}\n`));assert.ok(result.text.endsWith('\n'));
  }
  assert.notEqual(produce('cat\r\ncat.').inputHash,produce('cat\ncat.').inputHash);
});

test('word and sentence grammar, ASCII case folding and fixed stop words',()=>{
  const text=produce("THE cat-cat can't CAT_42 fox... \tA fox!\r\nAnd? tail").text;
  assert.match(text,/Words: 10\nSentences: 4\n/);
  assert.match(text,/Frequent terms: cat \(3\), fox \(2\), can't \(1\), tail \(1\)\n/);
  assert.match(text,/Longest sentence \(31 characters\): THE cat-cat can't CAT_42 fox\.\.\.\n/);
  assert.match(produce('... 123! cat? 456. dog').text,/Words: 2\nSentences: 2\n/);
  const stops='a an and are as at be been but by for from had has have he her his i in is it its not of on or our she that the their them they this to was we were will with you your';
  assert.match(produce(stops.toUpperCase()).text,/Frequent terms: \(none\)\n/);
});

test('term ties use ASCII order and the top-five count is fixed',()=>{
  assert.match(produce('Zebra yak wolf violet tiger snake.').text,/Frequent terms: snake \(1\), tiger \(1\), violet \(1\), wolf \(1\), yak \(1\)\n/);
});

test('longest and summary ties choose earliest sentences, including zero scores',()=>{
  const text=produce('Zed. Ace. Dog.').text;
  assert.match(text,/Longest sentence \(4 characters\): Zed\.\n/);
  assert.ok(text.endsWith('Extractive summary:\n1. Zed.\n2. Ace.\n'));
  assert.ok(produce('The. And. Your.').text.endsWith('Extractive summary:\n1. The.\n2. And.\n'));
});

test('summary ranks global term frequencies then restores original sentence order',()=>{
  const text=produce('Zebra zebra. Alpha alpha alpha. Cat.').text;
  assert.ok(text.endsWith('Extractive summary:\n1. Zebra zebra.\n2. Alpha alpha alpha.\n'));
  const ranked=produce('Aside. Power power. Power power power.').text;
  assert.ok(ranked.endsWith('Extractive summary:\n1. Power power.\n2. Power power power.\n'));
  assert.ok(produce('A rare detail covers many subjects. Power power. Power power.').text.endsWith('Extractive summary:\n1. Power power.\n2. Power power.\n'));
  assert.ok(produce('Echo echo echo echo. Alpha beta gamma delta epsilon. Alpha beta gamma delta epsilon.').text.endsWith('Extractive summary:\n1. Echo echo echo echo.\n2. Alpha beta gamma delta epsilon.\n'));
});

test('reading grade uses exact ceiling, excludes digits and clamps to 1-18',()=>{
  for(const [input,grade] of [['a.',1],['abcde.',3],['abcde 123.',3],['abcdefg.',13],["can't.",1],['abcdefghij.',18]])
    assert.match(produce(input).text,new RegExp(`Reading grade \\(rough ARI, 1-18\\): ${grade}\n`));
});

test('malformed, wordless, non-ASCII and control inputs refuse without coercion',()=>{
  let coerced=false;
  const invalid=[undefined,null,0,true,{},[],Buffer.from('cat'),new String('cat'),{toString(){coerced=true;return 'cat';}},'', ' \t\r\n', '123...?!','caf\u00e9','cat\ud800','cat\udc00','cat\ud83d\ude00'];
  for(let code=0;code<32;code++) if(![9,10,13].includes(code)) invalid.push(`cat${String.fromCharCode(code)}`);
  invalid.push('cat\x7f');
  for(const input of invalid) assert.throws(()=>produce(input),(e)=>e instanceof TypeError && e.code==='public-text-input');
  assert.equal(coerced,false);
});

test('exact input limit accepts, one byte over refuses and single-sentence reports do not truncate',()=>{
  assert.match(produce(`a${' '.repeat(4095)}`).text,/Characters \(including whitespace\): 4096\n/);
  assert.throws(()=>produce(`a${' '.repeat(4096)}`),(e)=>e.code==='public-text-input');
  assert.throws(()=>produce('x'.repeat(2000)),(e)=>e.code==='public-text-output');
  assert.ok(produce('cat').text.endsWith('Extractive summary:\n1. cat\n'));
});

test('serialized output bound counts JSON escaping and never clips selected sentences',()=>{
  const plain=`${' '.repeat(100)}${'x'.repeat(1000)}.`;
  const escaped=`${'"\\'.repeat(500)}x.`;
  assert.ok(produce(plain).text.includes('x'.repeat(1000)));
  assert.throws(()=>produce(escaped),(e)=>e.code==='public-text-output');
  let last;
  for(let n=1;n<=4096;n++){
    try{last=produce(`"\\${'x'.repeat(n)}.`);}
    catch(e){assert.equal(e.code,'public-text-output');assert.ok(last);assert.ok(Buffer.byteLength(JSON.stringify({mediaType:last.mediaType,text:last.text}))<=4096);return;}
  }
  assert.fail('expected complete report refusal below the input limit');
});

test('module imports only hashing and contains no clocks, randomness, locales, execution or network',()=>{
  const source=readFileSync(moduleUrl,'utf8');
  assert.deepEqual(source.match(/\bimport[\s\S]*?;/g),["import { createHash } from 'node:crypto';"]);
  assert.deepEqual([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match)=>match[1]),['node:crypto']);
  assert.doesNotMatch(source,/\b(?:Date|Intl|fetch|WebSocket|XMLHttpRequest|eval|Function|process|require)\b|Math\s*\.\s*random|localeCompare|toLocale\w*|toFixed|toPrecision|\bimport\s*\(/);
  const saved={Date:globalThis.Date,Intl:globalThis.Intl,fetch:globalThis.fetch,random:Math.random};
  const denied=()=>{throw new Error('ambient capability used');};
  try{
    globalThis.Date=denied;globalThis.Intl=denied;globalThis.fetch=denied;Math.random=denied;
    const input='fetch("https://example.test"); eval("run"); rm -rf /';
    const first=produce(input);assert.deepEqual(produce(input),first);assert.ok(first.text.includes('https://example.'));
  }finally{globalThis.Date=saved.Date;globalThis.Intl=saved.Intl;globalThis.fetch=saved.fetch;Math.random=saved.random;}
});
