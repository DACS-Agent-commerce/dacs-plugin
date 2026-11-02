import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync,statSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import {createLoopbackTestTlsMaterial} from './helpers/loopback-test-tls.mjs';
function ownedRoot(t){const p=mkdtempSync(join(tmpdir(),'tls-helper-unit-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
test('loopback TLS creates matching ephemeral key/certificate and leaves no files',t=>{
  const temporaryRoot=ownedRoot(t),material=createLoopbackTestTlsMaterial({temporaryRoot});
  const key=createPrivateKey(material.key),cert=new X509Certificate(material.cert);
  assert.equal(key.asymmetricKeyDetails.modulusLength,2048);assert.equal(cert.subject,'CN=TEST-loopback-native');assert.match(cert.subjectAltName,/IP Address:127\.0\.0\.1/);
  assert.deepEqual(createPublicKey(key).export({type:'spki',format:'der'}),cert.publicKey.export({type:'spki',format:'der'}));
  assert.deepEqual(readdirSync(temporaryRoot),[]);
});
test('TLS subprocess failure is observable, redacted and cleaned before any fixture starts',t=>{
  const temporaryRoot=ownedRoot(t);let invoked=false;
  assert.throws(()=>createLoopbackTestTlsMaterial({temporaryRoot,run:(command,argv,options)=>{
    invoked=true;assert.equal(command,'/usr/bin/openssl');assert.equal(argv.includes('/dev/stdout'),false);assert.deepEqual(options.stdio,['ignore','ignore','pipe']);
    const keyPath=argv[argv.indexOf('-keyout')+1],certPath=argv[argv.indexOf('-out')+1];assert.equal(statSync(keyPath).mode&0o777,0o600);assert.equal(statSync(certPath).mode&0o777,0o600);
    return {status:1,signal:null,stderr:'TEST ordinary failure\n-----BEGIN PRIVATE KEY-----\nNOT-A-REAL-KEY\n-----END PRIVATE KEY-----\n'};
  }}),e=>e.message.includes('TEST ordinary failure')&&e.message.includes('[ephemeral PEM redacted]')&&!e.message.includes('NOT-A-REAL-KEY'));
  assert.equal(invoked,true);assert.deepEqual(readdirSync(temporaryRoot),[]);
  for(const file of ['./helpers/devnet-agreement-transport-harness.mjs','./helpers/devnet-native-transport-harness.mjs','./helpers/devnet-operator-node2.mjs']){
    // A harness may take caller-supplied TLS material, but must otherwise create it before starting the chain.
    const source=readFileSync(new URL(file,import.meta.url),'utf8'),tls=source.search(/const \{key,cert\}=(?:tlsFixture\?\?)?createLoopbackTestTlsMaterial\(\);/);
    assert.ok(tls>=0&&source.indexOf('const chain=await startNativeAgreementChain(')>tls,file);
  }
});
test('a successful command returning incomplete TLS material fails and removes temporary files',t=>{
  const temporaryRoot=ownedRoot(t);
  assert.throws(()=>createLoopbackTestTlsMaterial({temporaryRoot,run:()=>({status:0,signal:null,stderr:''})}),/incomplete material/);
  assert.deepEqual(readdirSync(temporaryRoot),[]);
});
