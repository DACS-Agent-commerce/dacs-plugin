import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, outputPath, preloadPath] = process.argv.slice(2);
if (!['main', 'recording-failure'].includes(mode) || !path.isAbsolute(outputPath) || !path.isAbsolute(preloadPath)) throw new Error('observer unit child arguments are invalid');

const origin = 'https://127.0.0.1:7443';
const target = `${origin}/dacs/v1/payments`;
const secretBody = 'BODY_SENTINEL_DO_NOT_RECORD';
const secretHeader = 'HEADER_SENTINEL_DO_NOT_RECORD';
const secretQuery = 'QUERY_SENTINEL_DO_NOT_RECORD';
const secretCapability = 'CAPABILITY_SENTINEL_DO_NOT_RECORD';
const secretTransport = 'TRANSPORT_SENTINEL_DO_NOT_RECORD';
const calls = [];
const results = [];

globalThis.fetch = (input, options) => {
  calls.push({ input, options });
  const next = results.shift();
  if (!next) throw new Error('unit stub has no queued result');
  return next(input, options);
};
process.env.DACS_TEST_SELLER_ORIGIN = origin;
process.env.DACS_TEST_SELLER_OBSERVER_PATH = outputPath;
await import(`${pathToFileURL(preloadPath).href}?unit=${process.pid}`);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'recording-failure') {
  const response = new Response('safe');
  results.push(() => Promise.resolve(response));
  assert.strictEqual(await globalThis.fetch(target, { method: 'POST' }), response);
  const transport = Object.assign(new TypeError(secretTransport), { code: 'ECONNRESET' });
  results.push(() => Promise.reject(transport));
  await assert.rejects(globalThis.fetch(target, { method: 'POST' }), (error) => error === transport);
  await pause(80);
  process.stdout.write(`${JSON.stringify({ mode, responseIdentity: true, rejectionIdentity: true, calls: calls.length })}\n`);
  process.exit(0);
}

const nonTargetCases = [
  `https://localhost:7443/dacs/v1/payments`,
  `${origin}/dacs/v1/not-a-route`,
  `${target}?capability=${secretQuery}`,
];
for (const input of nonTargetCases) {
  const options = { method: 'POST', signal: Object.freeze({ unitSignal: true }), body: secretBody };
  const response = new Response('passthrough');
  const promised = Promise.resolve(response);
  results.push((seenInput, seenOptions) => {
    assert.strictEqual(seenInput, input);
    assert.strictEqual(seenOptions, options);
    assert.strictEqual(seenOptions.signal, options.signal);
    return promised;
  });
  const returned = globalThis.fetch(input, options);
  assert.strictEqual(returned, promised);
  assert.strictEqual(await returned, response);
}
await pause(20);
assert.equal(fs.existsSync(outputPath), false);

const getResponse = new Response(secretBody, { headers: { 'x-dacs-seller-peer': secretHeader, 'x-private-unit': secretCapability } });
results.push(() => Promise.resolve(getResponse));
const returnedGet = await globalThis.fetch(`${origin}/dacs/v1/agreements/state`);
assert.strictEqual(returnedGet, getResponse);
assert.equal(returnedGet.headers.get('x-dacs-seller-peer'), secretHeader);
assert.equal(await returnedGet.text(), secretBody);

const postOptions = { method: 'post', signal: Object.freeze({ postSignal: true }), headers: { authorization: secretCapability }, body: secretBody };
const postResponse = new Response(null, { status: 204 });
results.push((seenInput, seenOptions) => {
  assert.equal(seenInput, `${origin}/dacs/v1/commitments`);
  assert.strictEqual(seenOptions, postOptions);
  assert.strictEqual(seenOptions.signal, postOptions.signal);
  return Promise.resolve(postResponse);
});
assert.strictEqual(await globalThis.fetch(`${origin}/dacs/v1/commitments`, postOptions), postResponse);

const request = new Request(`${origin}/dacs/v1/bundles/request`, { method: 'PATCH', headers: { authorization: secretCapability } });
const requestResponse = new Response('{}', { headers: { 'content-type': 'application/json' } });
results.push((seenInput, seenOptions) => {
  assert.strictEqual(seenInput, request);
  assert.equal(seenOptions, undefined);
  return Promise.resolve(requestResponse);
});
assert.strictEqual(await globalThis.fetch(request), requestResponse);

const knownText = JSON.stringify({ error: 'operation_uncertain', message: secretBody, capability: secretCapability });
const knownResponse = new Response(knownText, { status: 503, headers: { 'content-type': 'application/json', 'x-dacs-seller-peer': secretHeader } });
results.push(() => Promise.resolve(knownResponse));
assert.strictEqual(await globalThis.fetch(target, { method: 'POST' }), knownResponse);
assert.equal(await knownResponse.text(), knownText);

const unknownText = JSON.stringify({ error: secretCapability, message: secretBody });
const unknownResponse = new Response(unknownText, { status: 422, headers: { 'content-type': 'application/json' } });
results.push(() => Promise.resolve(unknownResponse));
assert.strictEqual(await globalThis.fetch(`${origin}/dacs/v1/bundles/countersignature`, { method: 'POST' }), unknownResponse);
assert.equal(await unknownResponse.text(), unknownText);

const oversizedText = JSON.stringify({ error: 'operation_uncertain', padding: 'x'.repeat(5000), private: secretCapability });
const oversizedResponse = new Response(oversizedText, { status: 503, headers: { 'content-type': 'application/json' } });
results.push(() => Promise.resolve(oversizedResponse));
assert.strictEqual(await globalThis.fetch(`${origin}/dacs/v1/bundles/buyer-copy`, { method: 'POST' }), oversizedResponse);
assert.equal(await oversizedResponse.text(), oversizedText);

const stalledResponse = {
  status: 503,
  headers: new Headers({ 'x-dacs-seller-peer': secretHeader }),
  clone() {
    return { status: 503, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) }) } };
  },
};
results.push(() => Promise.resolve(stalledResponse));
const stalledOutcome = await Promise.race([
  globalThis.fetch(`${origin}/dacs/v1/agreements/proposals`, { method: 'POST' }).then((response) => ({ response })),
  pause(25).then(() => ({ timeout: true })),
]);
assert.equal(stalledOutcome.timeout, undefined);
assert.strictEqual(stalledOutcome.response, stalledResponse);

const cloneFailureResponse = {
  status: 503,
  headers: new Headers({ 'x-dacs-seller-peer': secretHeader }),
  clone() { throw new Error(secretCapability); },
};
results.push(() => Promise.resolve(cloneFailureResponse));
assert.strictEqual(await globalThis.fetch(`${origin}/dacs/v1/agreements/proposals`, { method: 'POST' }), cloneFailureResponse);

const transport = Object.assign(new TypeError(secretTransport), { code: 'ECONNRESET' });
results.push(() => Promise.reject(transport));
await assert.rejects(globalThis.fetch(target, { method: 'POST' }), (error) => error === transport);

const unknownTransport = Object.assign(new Error(secretTransport), { name: secretCapability, code: secretCapability });
results.push(() => Promise.reject(unknownTransport));
await assert.rejects(globalThis.fetch(target, { method: 'POST' }), (error) => error === unknownTransport);

const synchronousTransport = Object.assign(new TypeError(secretTransport), { code: 'ETIMEDOUT' });
results.push(() => { throw synchronousTransport; });
assert.throws(() => globalThis.fetch(target, { method: 'POST' }), (error) => error === synchronousTransport);

await pause(140);
assert.equal(results.length, 0);
process.stdout.write(`${JSON.stringify({ mode, calls: calls.length, nonTargets: nonTargetCases.length, targetCalls: calls.length - nonTargetCases.length })}\n`);
