// fetchBoundedJson has one deadline for the whole request. When it fires after the headers have arrived,
// while the body is still being read, the caller gets the same refusal as a deadline before the headers:
// OutboundError 'unavailable', 'request timed out'. A real loopback server and the runtime's fetch are used, so
// these tests show the deadline itself ending body consumption; content errors keep their own refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OutboundError as ClientOutboundError } from '@kynesyslabs/dacs-client';
import { fetchBoundedJson } from '../src/util/http.mjs';

const TIMEOUT_MS = 1_000;
// A request the deadline does not end fails here instead of holding the file open.
const STALL_TEST_MS = 20_000;
const MAX_BYTES = 64;
const JSON_HEADERS = { 'content-type': 'application/json' };

// Serves one route per test. Responses that are never ended are tracked so the test can show the client
// closed the connection, and every socket is closed after the test so the file exits on its own.
async function serve(t, handler) {
  const closed = [];
  const server = createServer((request, response) => {
    closed.push(new Promise((resolve) => response.on('close', () => resolve(performance.now()))));
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/data`, closed };
}

// The runtime's fetch, recording when the response headers arrived.
function timedFetch() {
  const seen = {};
  const fetchImpl = async (target, init) => {
    const response = await globalThis.fetch(target, init);
    seen.headersAt = performance.now();
    seen.status = response.status;
    return response;
  };
  return { seen, fetchImpl };
}

const refusal = (kind, message) => (error) => {
  assert.ok(error instanceof ClientOutboundError, `expected the client's OutboundError, got ${error?.name}: ${error?.message}`);
  assert.deepEqual({ kind: error.kind, message: error.message }, { kind, message });
  return true;
};

// Headers and `prefix` are sent at once; the body is then never finished.
const stalls = [
  ['after part of a JSON body', Buffer.from('{"partial":')],
  ['with headers only and no body bytes', Buffer.alloc(0)],
  ['inside a multi-byte UTF-8 sequence (the first two of the three bytes of U+20AC)', Buffer.from('{"price":"\u20ac', 'utf8').subarray(0, -1)],
];

for (const [label, prefix] of stalls) {
  test(`a body that stalls ${label} until the request deadline is refused as unavailable / request timed out, not as invalid UTF-8`, { timeout: STALL_TEST_MS }, async (t) => {
    const { url, closed } = await serve(t, (request, response) => {
      response.writeHead(200, JSON_HEADERS);
      response.flushHeaders();
      if (prefix.length) response.write(prefix);
    });
    const { seen, fetchImpl } = timedFetch();
    const started = performance.now();
    await assert.rejects(fetchBoundedJson(url, { fetchImpl, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES }), refusal('unavailable', 'request timed out'));
    const settled = performance.now();

    assert.equal(seen.status, 200, 'the headers arrived, so the deadline fired while the body was being read');
    assert.ok(seen.headersAt - started < TIMEOUT_MS, `headers arrived after ${Math.round(seen.headersAt - started)} ms, inside the ${TIMEOUT_MS} ms deadline`);
    assert.ok(settled - started >= TIMEOUT_MS - 5, `refused after ${Math.round(settled - started)} ms, not before the deadline`);
    assert.ok(settled - started < TIMEOUT_MS + 10_000, `refused after ${Math.round(settled - started)} ms, close to the deadline`);
    // The server never ended the response: the connection closed because the client gave up at the deadline.
    let timer;
    const closedAt = await Promise.race([closed[0], new Promise((resolve) => { timer = setTimeout(resolve, 5_000, null); })]);
    clearTimeout(timer);
    assert.ok(closedAt !== null, 'the client closed the stalled connection');
  });
}

test('a body stream that errors with AbortError is refused as unavailable / request timed out (mocked stream: shows the AbortError name is classified, not that the deadline covers the body)', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new DOMException('This operation was aborted', 'AbortError')); } });
  const fetchImpl = async () => new Response(body, { status: 200, headers: JSON_HEADERS });
  await assert.rejects(fetchBoundedJson('https://upstream.example/data', { fetchImpl, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES }), refusal('unavailable', 'request timed out'));
});

// Controls over the same real server and fetch: each finished response keeps its existing result.
const finished = [
  ['a healthy JSON body sent in two chunks is parsed', (response) => {
    response.writeHead(200, JSON_HEADERS);
    response.write('{"ok":true,');
    response.end('"n":1}');
  }, { value: { ok: true, n: 1 } }],
  ['a body with an invalid UTF-8 byte is invalid / response body is not valid UTF-8', (response) => {
    response.writeHead(200, JSON_HEADERS);
    response.end(Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  }, { kind: 'invalid', message: 'response body is not valid UTF-8' }],
  ['a chunked body over the byte ceiling is invalid / response exceeds byte limit', (response) => {
    response.writeHead(200, JSON_HEADERS);
    response.write(`{"pad":"${'x'.repeat(MAX_BYTES)}`);
    response.end('"}');
  }, { kind: 'invalid', message: 'response exceeds byte limit' }],
  ['a finished body that is not JSON is invalid / upstream returned malformed JSON', (response) => {
    response.writeHead(200, JSON_HEADERS);
    response.end('{"truncated":');
  }, { kind: 'invalid', message: 'upstream returned malformed JSON' }],
  ['an HTTP 503 is unavailable / upstream returned HTTP 503', (response) => {
    response.writeHead(503, JSON_HEADERS);
    response.end('{}');
  }, { kind: 'unavailable', message: 'upstream returned HTTP 503' }],
];

for (const [label, handler, expected] of finished) {
  test(`over real HTTP, ${label}`, async (t) => {
    const { url } = await serve(t, (request, response) => handler(response));
    const run = fetchBoundedJson(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    if ('value' in expected) assert.deepEqual(await run, expected.value);
    else await assert.rejects(run, refusal(expected.kind, expected.message));
  });
}

test('over real HTTP, a server that sends no headers before the deadline is still unavailable / request timed out', { timeout: STALL_TEST_MS }, async (t) => {
  const { url } = await serve(t, () => {});
  const { seen, fetchImpl } = timedFetch();
  await assert.rejects(fetchBoundedJson(url, { fetchImpl, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES }), refusal('unavailable', 'request timed out'));
  assert.equal(seen.headersAt, undefined, 'no headers arrived');
});
