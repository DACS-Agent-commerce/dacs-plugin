// Synthetic projects for the purchase-path checker tests: a package with a locked registry
// client, five tool registrations in src/server.ts, and an inventory shaped like the real one.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkThinPlugin} from '../scripts/check-thin-plugin.mjs';

export const names = ['dacs_search', 'dacs_get_listing', 'dacs_buy_prepare', 'dacs_buy', 'dacs_purchase_status'];
export const CLIENT = '@kynesyslabs/dacs-client';
export const integrityOf = text => `sha512-${createHash('sha512').update(text).digest('base64')}`;
export const policy = {
  dependencyRoots: [{path: '.'}],
  forbiddenDirs: ['src/dacs/'],
  entries: names.map(name => ({name, modules: [{file: 'src/server.ts', registration: name}]})),
  primitives: [
    {id: 'canonical-json', names: ['canonicalize', 'canonicalBytes'], calls: ['JSON.stringify', 'sort']},
    {id: 'artifact-crypto', names: ['signArtifact', 'verifyArtifact'], calls: ['sign'], literals: ['dacs-agreement:v1:']},
    {id: 'job-id', names: ['deriveJobId']},
    {id: 'agreement-hash', names: ['agreementHash'], calls: ['createHash'], literals: ['dacs-agreement:v1:']},
    {id: 'payment-state', names: ['paymentStateMachine'], calls: ['Map'], literals: ['payment-pending']},
    {id: 'execution-readback', names: ['readExecution'], calls: ['getTxByHash'], references: ['getTxByHash']},
  ],
};
export const registrations = names.map(n => `server.registerTool('${n}', {}, () => sdk);`).join('\n');

export function fixture(t, body = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-plugin-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), {recursive: true}); fs.writeFileSync(path.join(root, f), typeof s === 'string' ? s : JSON.stringify(s, null, 2)); };
  const pkg = {name: 'thin-fixture', type: 'module', dependencies: {[CLIENT]: '0.1.0'}};
  const lock = {lockfileVersion: 3, packages: {'': {dependencies: {...pkg.dependencies}}, [`node_modules/${CLIENT}`]: {version: '0.1.0', resolved: `https://registry.npmjs.org/${CLIENT}/-/dacs-client-0.1.0.tgz`, integrity: integrityOf('registry')}}};
  put('package.json', pkg); put('package-lock.json', lock);
  put(`node_modules/${CLIENT}/package.json`, {name: CLIENT, version: '0.1.0', exports: {'.': {import: './index.js', require: './other.js'}, './api': './index.js'}});
  put(`node_modules/${CLIENT}/index.js`, 'export const sdk = {};'); put(`node_modules/${CLIENT}/other.js`, '');
  put('src/server.ts', `import {sdk} from '${CLIENT}';\n${registrations}\n${body}`);
  const config = structuredClone(policy);
  const run = () => checkThinPlugin(root, config);
  const change = (f, edit) => { const p = path.join(root, f), v = JSON.parse(fs.readFileSync(p)); edit(v); put(f, v); };
  return {root, put, run, change, config};
}
