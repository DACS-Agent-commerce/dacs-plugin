import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectedTests, killed, runNodeTest } from './node-test-child.mjs';

const source=readFileSync(new URL('../../src/devnet-demo/services/public-text-report.mjs',import.meta.url),'utf8');
const mutations=[
  ['fixed service identity',"PUBLIC_TEXT_REPORT_SERVICE_ID='dacs-public-text-report'","PUBLIC_TEXT_REPORT_SERVICE_ID='other'"],
  ['fixed service version',"PUBLIC_TEXT_REPORT_SERVICE_VERSION='1'","PUBLIC_TEXT_REPORT_SERVICE_VERSION='2'"],
  ['input type guard',"typeof input!=='string' || ",''],
  ['input byte bound','input.length>PUBLIC_TEXT_REPORT_MAX_INPUT_BYTES','false'],
  ['ASCII/control admission',"/[^\\x20-\\x7e\\t\\r\\n]/.test(input)",'false'],
  ['wordless refusal',"if(words.length===0) fail('public-text-input','public text must contain an ASCII word');",''],
  ['internal apostrophe grammar',"[A-Za-z]+(?:'[A-Za-z]+)?",'[A-Za-z]+'],
  ['sentence punctuation grammar','[^.!?]+(?:[.!?]+|$)','[^.]+(?:[.]+|$)'],
  ['wordless sentence filter',".filter((text)=>wordsOf(text).length>0)",''],
  ['excerpt whitespace normalization',"text.replace(/[ \\t\\r\\n]+/g,' ').trim()",'text'],
  ['ASCII term case folding','const term=word.toLowerCase()','const term=word'],
  ['fixed stop words','if(!stopWords.has(term))','if(true)'],
  ['whole-input term frequencies','(frequencies.get(term) ?? 0)+1','1'],
  ['descending term counts','bc-ac || (a<b?-1:a>b?1:0)','ac-bc || (a<b?-1:a>b?1:0)'],
  ['ASCII term tie-break','(a<b?-1:a>b?1:0)','0'],
  ['top-five term limit','.slice(0,5)',''],
  ['summary global-frequency scoring','(frequencies.get(word.toLowerCase()) ?? 0)','1'],
  ['summary repetitions',"score:wordsOf(text).reduce",'score:[...new Set(wordsOf(text))].reduce'],
  ['descending summary scores','b.score-a.score || a.index-b.index','a.score-b.score || a.index-b.index'],
  ['summary earliest tie-break','b.score-a.score || a.index-b.index','b.score-a.score || b.index-a.index'],
  ['two-sentence summary limit','.slice(0,2)',''],
  ['summary source order','.sort((a,b)=>a.index-b.index)',''],
  ['longest earliest tie-break','sentence.length>longest.length','sentence.length>=longest.length'],
  ['reading letters exclude apostrophes',"word.replace(/'/g,'').length",'word.length'],
  ['exact reading coefficient','471n*letters*s','470n*letters*s'],
  ['integer reading ceiling','(numerator+denominator-1n)/denominator','numerator/denominator'],
  ['reading lower clamp','grade<1n?1n:grade>18n?18n:grade','grade>18n?18n:grade'],
  ['reading upper clamp','grade>18n?18n:grade','grade'],
  ['raw input hash','const inputHash=hash(input)','const inputHash=hash(input.trim())'],
  ['raw character count','${input.length}','${input.trim().length}'],
  ['report final LF',"),''].join('\\n')", ")].join('\\n')"],
  ['serialized output refusal',"if(Buffer.byteLength(JSON.stringify({mediaType,text}),'utf8')>PUBLIC_TEXT_REPORT_MAX_CONTENT_BYTES)",'if(false)'],
  ['JSON escaping budget',"Buffer.byteLength(JSON.stringify({mediaType,text}),'utf8')",'text.length'],
  ['report output hash','outputHash:hash(text)','outputHash:inputHash'],
  ['fixed media type',"const mediaType='text/plain; charset=utf-8'","const mediaType='text/html'"],
  ['buyer-specific work','const words=wordsOf(input);',"input='Cats chase mice. Cats nap.'; const words=wordsOf(input);"],
  ['no clock','const words=wordsOf(input);','void Date.now(); const words=wordsOf(input);'],
  ['no randomness','const words=wordsOf(input);','void Math.random(); const words=wordsOf(input);'],
  ['no locale functions','word.toLowerCase()','word.toLocaleLowerCase()'],
  ['no network import',"import { createHash } from 'node:crypto';","import 'node:http'; import { createHash } from 'node:crypto';"],
];
// Also callable without constructing mutants: tests exercise the real baseline and verdict path.
export async function checkMutation(name, modulePath, { cwd = process.cwd(), env = process.env } = {}) {
  const onSpawn=(pid)=>console.log(`${name}: process group ${pid}`);
  const {PUBLIC_TEXT_REPORT_TEST_MODULE,...unmutatedEnv}=env;
  const expected=await expectedTests('test/public-text-report.test.mjs',{cwd,timeoutMs:30000,env:unmutatedEnv,onSpawn});
  const result=await runNodeTest('test/public-text-report.test.mjs',
    {cwd,timeoutMs:30000,env:{...env,PUBLIC_TEXT_REPORT_TEST_MODULE:pathToFileURL(modulePath).href},expected,onSpawn});
  const row={mutant:name,file:result.file,nodeVersion:result.nodeVersion,exit:result.exit,tests:result.tests,pass:result.pass,fail:result.fail,incomplete:result.incomplete};
  console.log(JSON.stringify(row));
  assert.equal(result.incomplete,null,`mutant run has no complete results: ${name}: ${result.incomplete}\n${result.stdout}\n${result.stderr}`);
  assert.ok(killed(result),`mutant survived: ${name}\n${result.stdout}\n${result.stderr}`);
  return row;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const directory=mkdtempSync(join(tmpdir(),'public-text-report-mutants-'));
let detected=0;
try{
  const modulePath=join(directory,'public-text-report.mjs');
  for(const [name,before,after] of mutations){
    assert.ok(source.includes(before),`missing mutation target: ${name}`);
    writeFileSync(modulePath,source.replace(before,after));
    await checkMutation(name,modulePath);
    detected++;
  }
}finally{rmSync(directory,{recursive:true,force:true});}
console.log(JSON.stringify({detected,total:mutations.length}));
}
