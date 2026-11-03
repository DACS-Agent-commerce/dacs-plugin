import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fetchBounded } from '../../scripts/lib/fetch-bounded.mjs';
import { installGitleaks } from '../../scripts/ci/install-gitleaks.mjs';
import { archiveTransport, buildFakeArchive, fakePin, installFolder } from './fake-gitleaks.mjs';
import { makeTempDir } from './gate-fixtures.mjs';

const URL_ONE = 'https://download.example.invalid/archive.tgz';
const URL_TWO = 'https://mirror.example.invalid/archive.tgz';
const CAP = 64;
const DEADLINE_MS = 40;
const GENEROUS_DEADLINE_MS = 5000;
const PAYLOAD = Buffer.from('payload bytes for the download tests');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const countTimers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
const nextTurn = () => new Promise((resolve) => { setImmediate(resolve); });

/** A body that yields `chunks` and then ends. */
async function* chunksThenEnd(chunks) {
  yield* chunks;
}

/** A body fed by the test: `push` adds a chunk, and the body waits (with no timer) while none is queued. */
function controlledBody() {
  const queue = [];
  let wake = () => {};
  const iterator = {
    async next() {
      while (queue.length === 0) await new Promise((resolve) => { wake = resolve; });
      return { done: false, value: queue.shift() };
    },
    async return() { return { done: true, value: undefined }; },
  };
  return { body: { [Symbol.asyncIterator]: () => iterator }, push(chunk) { queue.push(chunk); wake(); } };
}

/** A transport that answers each url from `routes` ({ status, location, contentLength, body }) and records its calls. */
function scriptedTransport(routes) {
  const calls = { urls: [], released: 0, signals: [] };
  const transport = async (url, { signal }) => {
    calls.urls.push(url);
    calls.signals.push(signal);
    const route = routes[url] ?? { status: 404 };
    return { status: 200, location: null, contentLength: null, body: chunksThenEnd([]), ...route, release() { calls.released += 1; } };
  };
  return { transport, calls };
}

const freshPath = () => path.join(makeTempDir('download'), 'archive.tgz');
const download = (overrides) => fetchBounded({
  url: URL_ONE, destination: freshPath(), sha256: digest(PAYLOAD), maxBytes: CAP, deadlineMs: GENEROUS_DEADLINE_MS, ...overrides,
});
/** Returns the rejection of `promise`; fails the test when it resolves. */
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);
const serving = (body, extra) => scriptedTransport({ [URL_ONE]: { body: chunksThenEnd([body]), contentLength: body.length, ...extra } });

test('an oversized response and a response that never ends abort at the byte cap and the total deadline, remove the partial file and keep distinct causes; an injected transport ignores abort and delivers late bytes: reject once with timeout, discard late chunks, keep the partial path absent afterwards and leave no handle keeping the event loop alive', async (t) => {
  await t.test('a body over the cap aborts at the cap with the too-large cause', async () => {
    const destination = freshPath();
    const { transport } = scriptedTransport({ [URL_ONE]: { body: chunksThenEnd([Buffer.alloc(40), Buffer.alloc(40)]) } });
    const error = await rejection(download({ destination, transport }));
    assert.equal(error.cause, 'download-too-large');
    assert.equal(existsSync(destination), false);
  });

  await t.test('a Content-Length over the cap is refused before any byte is read or file created', async () => {
    const destination = freshPath();
    const { transport } = scriptedTransport({ [URL_ONE]: { contentLength: CAP + 1, body: chunksThenEnd([Buffer.alloc(1)]) } });
    assert.equal((await rejection(download({ destination, transport }))).cause, 'download-too-large');
    assert.equal(existsSync(destination), false);
  });

  await t.test('a body that never ends aborts at the total deadline with the timeout cause', async () => {
    const destination = freshPath();
    const never = controlledBody();
    never.push(Buffer.from('first'));
    const { transport, calls } = scriptedTransport({ [URL_ONE]: { body: never.body } });
    const error = await rejection(download({ destination, transport, deadlineMs: DEADLINE_MS }));
    assert.equal(error.cause, 'download-timeout');
    assert.equal(existsSync(destination), false);
    assert.equal(calls.signals[0].aborted, true);
    assert.equal(calls.released, 1);
  });

  await t.test('the deadline also covers a transport that never answers', async () => {
    const transport = () => new Promise(() => {});
    assert.equal((await rejection(download({ transport, deadlineMs: DEADLINE_MS }))).cause, 'download-timeout');
  });

  await t.test('a response that arrives after the deadline is released, not left open', async () => {
    let answer = () => {};
    const calls = { released: 0 };
    const transport = () => new Promise((resolve) => { answer = resolve; });
    assert.equal((await rejection(download({ transport, deadlineMs: DEADLINE_MS }))).cause, 'download-timeout');
    answer({ status: 200, location: null, contentLength: null, body: chunksThenEnd([]), release() { calls.released += 1; } });
    await nextTurn();
    assert.equal(calls.released, 1);
  });

  await t.test('a transport that ignores abort and delivers late bytes rejects once, discards them and holds no handle', async () => {
    const destination = freshPath();
    const stubborn = controlledBody();
    stubborn.push(Buffer.from('before the deadline'));
    const { transport, calls } = scriptedTransport({ [URL_ONE]: { body: stubborn.body } });
    const timersBefore = countTimers();
    const outcomes = [];
    const running = download({ destination, transport, deadlineMs: DEADLINE_MS });
    running.then(() => outcomes.push('resolved'), (error) => outcomes.push(error.cause));
    await rejection(running);
    stubborn.push(Buffer.from('late bytes'));
    stubborn.push(Buffer.from('later bytes'));
    await nextTurn();
    await nextTurn();
    assert.deepEqual(outcomes, ['download-timeout']);
    assert.equal(existsSync(destination), false);
    assert.equal(calls.released, 1);
    assert.equal(countTimers(), timersBefore);
  });
});

test('redirects are followed over https only, up to the named hop count; exhausting it fails', async (t) => {
  const redirect = (location) => ({ status: 302, location });

  await t.test('a redirect to another https address is followed and the final body is stored', async () => {
    const destination = freshPath();
    const { transport, calls } = scriptedTransport({ [URL_ONE]: redirect(URL_TWO), [URL_TWO]: { body: chunksThenEnd([PAYLOAD]) } });
    const result = await download({ destination, transport });
    assert.deepEqual(calls.urls, [URL_ONE, URL_TWO]);
    assert.deepEqual(result, { bytes: PAYLOAD.length, sha256: digest(PAYLOAD) });
    assert.deepEqual(readFileSync(destination), PAYLOAD);
  });

  await t.test('a relative Location is resolved against the address that sent it', async () => {
    const moved = 'https://download.example.invalid/moved/archive.tgz';
    const { transport, calls } = scriptedTransport({ [URL_ONE]: redirect('/moved/archive.tgz'), [moved]: { body: chunksThenEnd([PAYLOAD]) } });
    await download({ transport });
    assert.equal(calls.urls[1], moved);
  });

  await t.test('a redirect to http is refused and never requested', async () => {
    const { transport, calls } = scriptedTransport({ [URL_ONE]: redirect('http://download.example.invalid/archive.tgz') });
    assert.equal((await rejection(download({ transport }))).cause, 'download-redirect-refused');
    assert.deepEqual(calls.urls, [URL_ONE]);
  });

  await t.test('a first address that is not https is refused without calling the transport', async () => {
    const { transport, calls } = scriptedTransport({});
    assert.equal((await rejection(download({ url: 'http://download.example.invalid/a', transport }))).cause, 'download-redirect-refused');
    assert.equal((await rejection(download({ url: 'file:///etc/passwd', transport }))).cause, 'download-redirect-refused');
    assert.deepEqual(calls.urls, []);
  });

  await t.test('a redirect without a Location is refused', async () => {
    const { transport } = scriptedTransport({ [URL_ONE]: { status: 301 } });
    assert.equal((await rejection(download({ transport }))).cause, 'download-redirect-refused');
  });

  await t.test('exactly the hop count succeeds and one more fails with the too-many-redirects cause', async () => {
    const hops = 3;
    const hopUrl = (index) => `https://hop${index}.example.invalid/`;
    const chain = (length) => Object.fromEntries(Array.from({ length }, (_, index) => [hopUrl(index),
      index === length - 1 ? { body: chunksThenEnd([PAYLOAD]) } : redirect(hopUrl(index + 1))]));
    await download({ url: hopUrl(0), maxRedirects: hops, transport: scriptedTransport(chain(hops + 1)).transport });
    const refused = scriptedTransport(chain(hops + 2));
    const error = await rejection(download({ url: hopUrl(0), maxRedirects: hops, transport: refused.transport }));
    assert.equal(error.cause, 'download-too-many-redirects');
    assert.equal(refused.calls.released, hops + 1);
  });
});

test('truncation, an HTTP failure, a checksum mismatch and an interruption remove the partial file and keep the cause; a retry into a fresh temporary path succeeds; only the verified archive is extracted', async (t) => {
  await t.test('a body shorter than its Content-Length is truncated and removed', async () => {
    const destination = freshPath();
    const { transport } = serving(PAYLOAD.subarray(0, 10), { contentLength: PAYLOAD.length });
    assert.equal((await rejection(download({ destination, transport }))).cause, 'download-truncated');
    assert.equal(existsSync(destination), false);
  });

  for (const status of [404, 500]) {
    await t.test(`an HTTP ${status} is a failure and leaves no file`, async () => {
      const destination = freshPath();
      const { transport } = scriptedTransport({ [URL_ONE]: { status } });
      const error = await rejection(download({ destination, transport }));
      assert.equal(error.cause, 'download-http-failure');
      assert.match(error.message, new RegExp(String(status)));
      assert.equal(existsSync(destination), false);
    });
  }

  await t.test('a checksum mismatch removes the full file and names the checksum', async () => {
    const destination = freshPath();
    const { transport } = serving(Buffer.from('other bytes of the same kind'));
    assert.equal((await rejection(download({ destination, transport }))).cause, 'download-checksum-mismatch');
    assert.equal(existsSync(destination), false);
  });

  await t.test('an abort during the body is an interruption and removes the partial file', async () => {
    const destination = freshPath();
    const controller = new AbortController();
    const stalled = controlledBody();
    stalled.push(Buffer.from('some'));
    const { transport } = scriptedTransport({ [URL_ONE]: { body: stalled.body } });
    const running = download({ destination, transport, signal: controller.signal });
    controller.abort();
    assert.equal((await rejection(running)).cause, 'interrupted');
    assert.equal(existsSync(destination), false);
  });

  for (const stalledPart of ['headers', 'body']) {
    await t.test(`a transport that rejects with an AbortError as soon as its signal aborts still reports the deadline and the caller's abort while waiting for the ${stalledPart}`, async () => {
      const abortReacting = (signal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      });
      const transport = async (url, { signal }) => {
        if (stalledPart === 'headers') return abortReacting(signal);
        const body = { [Symbol.asyncIterator]: () => ({ next: () => abortReacting(signal), return: async () => ({ done: true, value: undefined }) }) };
        return { status: 200, location: null, contentLength: null, body, release() {} };
      };
      const destination = freshPath();
      assert.equal((await rejection(download({ destination, transport, deadlineMs: DEADLINE_MS }))).cause, 'download-timeout');
      assert.equal(existsSync(destination), false);
      const controller = new AbortController();
      const running = download({ destination, transport, signal: controller.signal });
      await nextTurn();
      controller.abort();
      assert.equal((await rejection(running)).cause, 'interrupted');
      assert.equal(existsSync(destination), false);
    });
  }

  await t.test('a stop that coincides with a ready chunk wins over the chunk', async () => {
    const controller = new AbortController();
    const readyChunks = { [Symbol.asyncIterator]: () => ({ next: () => { controller.abort(); return Promise.resolve({ done: false, value: Buffer.alloc(1) }); } }) };
    const { transport } = scriptedTransport({ [URL_ONE]: { body: readyChunks } });
    assert.equal((await rejection(download({ transport, signal: controller.signal }))).cause, 'interrupted');
  });

  await t.test('a transport that throws is a failed download with its own cause', async () => {
    const transport = async () => { throw new TypeError('fetch failed'); };
    assert.equal((await rejection(download({ transport }))).cause, 'download-failed');
  });

  await t.test('an existing destination is refused and left untouched', async () => {
    const destination = freshPath();
    await download({ destination, transport: serving(PAYLOAD).transport });
    const error = await rejection(download({ destination, transport: serving(PAYLOAD).transport }));
    assert.equal(error.cause, 'download-destination-exists');
    assert.deepEqual(readFileSync(destination), PAYLOAD);
  });

  await t.test('a retry into a fresh path after a failure succeeds', async () => {
    const failed = freshPath();
    const corrupted = serving(Buffer.from('corrupted bytes')).transport;
    assert.equal((await rejection(download({ destination: failed, transport: corrupted }))).cause, 'download-checksum-mismatch');
    const retried = freshPath();
    await download({ destination: retried, transport: serving(PAYLOAD).transport });
    assert.deepEqual(readFileSync(retried), PAYLOAD);
    assert.equal(existsSync(failed), false);
  });

  await t.test('the installer extracts only the archive that matches its pin: a valid archive with another digest fails on the checksum, never on its content', async () => {
    const verified = buildFakeArchive();
    const impostor = buildFakeArchive({ version: '9.9.9' });
    const directory = installFolder();
    const error = await rejection(installGitleaks({ directory, pin: fakePin(verified), transport: archiveTransport(impostor) }));
    assert.equal(error.cause, 'download-checksum-mismatch');
    assert.deepEqual(readdirSync(directory), []);
    const binary = await installGitleaks({ directory, pin: fakePin(verified), transport: archiveTransport(verified) });
    assert.deepEqual(readdirSync(directory), ['gitleaks']);
    assert.equal(binary, path.join(directory, 'gitleaks'));
  });

  await t.test('the default transport asks for no automatic redirect and passes the abort signal', async () => {
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, options) => {
      seen.push({ url, redirect: options.redirect, aborted: options.signal.aborted });
      return new Response(PAYLOAD, { status: 200, headers: { 'content-length': String(PAYLOAD.length) } });
    };
    try {
      await download();
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(seen, [{ url: URL_ONE, redirect: 'manual', aborted: false }]);
  });
});
