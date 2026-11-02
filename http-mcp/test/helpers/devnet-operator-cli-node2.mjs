import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapTestWalletCustody } from '../../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './devnet-operator-node2.mjs';

const freePort=()=>new Promise((resolvePort,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolvePort(port));});});

export async function createOperatorCliNode2(){
  const node2=await startOperatorNode2(),root=await mkdtemp(join(tmpdir(),'devnet-operator-cli-')),[appPort,sellerPort,directoryPort]=await Promise.all([freePort(),freePort(),freePort()]);
  const publicOrigin=`http://127.0.0.1:${appPort}`,sellerOrigin=`https://127.0.0.1:${sellerPort}`,directoryOrigin=`http://127.0.0.1:${directoryPort}`,custodyDirectory=join(root,'custody'),stateDirectory=join(root,'state');
  const custody=await bootstrapTestWalletCustody({directory:custodyDirectory,publicOrigin}),buyer=custody.wallets.find((entry)=>entry.role==='buyer'),seller=custody.wallets.find((entry)=>entry.role==='seller');
  const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl}),authority='TEST-RUN-operator-cli-001',admission=admitObservedNode2Identity({observation,authority,transportAuthority:'TEST-owned-operator-cli-node2',pinVersion:'TEST-operator-cli-pin-v1',reviewedChainIdentity:observation.chainIdentity});
  const admissionPath=join(root,'admission.json'),sellerKeyPath=join(root,'seller-key.pem'),sellerCertificatePath=join(root,'seller-cert.pem');await writeFile(admissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});await writeFile(sellerKeyPath,node2.key,{mode:0o600});await writeFile(sellerCertificatePath,node2.cert,{mode:0o600});
  const config={format:'dacs-node2-demo-operator/v1',authority,publicOrigin,sellerOrigin,sellerTls:{keyPath:sellerKeyPath,certificatePath:sellerCertificatePath},directoryOrigin,stateDirectory,custodyDirectory,networkAdmissionPath:admissionPath,listing:{listingId:'operator-cli-report',listingVersion:1,displayName:'Operator CLI Seller',title:'TTY approved purchased report',description:'Purchased only through the unchanged operator CLI and exact TTY approvals.',category:'services.market-report',tags:['report','operator','cli'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},sellerFeeBudget:{maxTotalOs:'10000000000'},buyerFeeBudget:{maxTotalOs:'12000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Genuine CLI-purchased bytes from the built-in operator seller.'}};
  const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});let closed=false;
  return Object.freeze({root,node2,config,configPath,admission,buyer,seller,sellerCertificatePath,effects:()=>({creates:node2.chain.wire.record.accepted.length,payments:node2.chain.record.accepted.length}),async close(){if(closed)return;closed=true;await node2.close();await rm(root,{recursive:true,force:true});}});
}
