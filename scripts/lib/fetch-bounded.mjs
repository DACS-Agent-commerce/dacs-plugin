import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { GateInputError } from '../public-gate/objects.mjs';

/** Most redirects one download follows. */
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DIGITS = /^\d+$/;
/** Network error codes a later attempt can get past: the connection closed or reset, or a connect or name lookup timed out. */
const TRANSIENT_NETWORK_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN']);

const transientStatus = (status) => status === 429 || (status >= 500 && status <= 599);
const transientNetworkError = (error) => TRANSIENT_NETWORK_CODES.has(error?.code) || TRANSIENT_NETWORK_CODES.has(error?.cause?.code);

const refusal = (cause, message) => new GateInputError(cause, message);
const ignore = () => {};

/**
 * The default transport: one `fetch` that never follows a redirect itself. Resolves { status, location, contentLength, body,
 * release } where `body` is an async iterable of byte chunks and `release()` cancels it; both are safe to call twice.
 */
async function fetchTransport(url, { signal }) {
  const response = await fetch(url, { redirect: 'manual', signal });
  const length = response.headers.get('content-length');
  return {
    status: response.status,
    location: response.headers.get('location'),
    contentLength: length !== null && DIGITS.test(length) ? Number(length) : null,
    body: response.body,
    release: () => { response.body?.cancel().catch(ignore); },
  };
}

/** One shared stop: it fires on the deadline or the caller's abort, `race` lets it win every tie and `error()` is what it fired with. */
function createStop({ deadlineMs, signal }) {
  const controller = new AbortController();
  const started = performance.now();
  let timer;
  let stopError = null;
  let onAbort;
  const fired = new Promise((_, reject) => {
    const fire = (cause, message) => {
      stopError = refusal(cause, message);
      reject(stopError);
      controller.abort();
    };
    timer = setTimeout(() => fire('download-timeout', `the download took longer than ${deadlineMs} ms`), deadlineMs);
    onAbort = () => fire('interrupted', 'the download was interrupted');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  fired.catch(ignore);
  return {
    signal: controller.signal,
    error: () => stopError,
    remainingMs: () => deadlineMs - (performance.now() - started),
    race: (work) => Promise.race([fired, work]),
    release() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function requireHttps(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    throw refusal('download-redirect-refused', 'the download address is not a valid URL');
  }
  if (parsed.protocol !== 'https:') throw refusal('download-redirect-refused', 'only https addresses are followed');
  return parsed.href;
}

/** Follows redirects by hand from `address`; returns the first non-redirect response, with every earlier one released. */
async function followRedirects({ address, maxRedirects, transport, stop }) {
  let current = requireHttps(address);
  for (let hop = 0; ; hop += 1) {
    const pending = transport(current, { signal: stop.signal });
    pending.then((late) => { if (stop.error()) late.release(); }, ignore);
    const response = await stop.race(pending);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    response.release();
    if (hop === maxRedirects) throw refusal('download-too-many-redirects', `more than ${maxRedirects} redirects`);
    if (!response.location) throw refusal('download-redirect-refused', 'a redirect came without a Location');
    current = requireHttps(new URL(response.location, current).href);
  }
}

/** Writes the body to `file` as it arrives, refusing past `maxBytes`; returns { received, digest } (hex SHA-256 of the bytes written). */
async function streamToFile({ body, file, maxBytes, stop }) {
  const hash = createHash('sha256');
  const chunks = body[Symbol.asyncIterator]();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await stop.race(chunks.next());
      if (done) return { received, digest: hash.digest('hex') };
      received += value.length;
      if (received > maxBytes) throw refusal('download-too-large', `the download is over ${maxBytes} bytes`);
      hash.update(value);
      await file.appendFile(value);
    }
  } finally {
    Promise.resolve(chunks.return?.()).catch(ignore);
  }
}

async function removePartial(file, destination) {
  if (!file) return;
  await file.close().catch(ignore);
  await rm(destination, { force: true });
}

async function createNewFile(destination) {
  try {
    return await open(destination, 'wx');
  } catch (error) {
    throw refusal(error.code === 'EEXIST' ? 'download-destination-exists' : 'download-failed', `the download file cannot be created (${error.code ?? error.name})`);
  }
}

/** Resolves after `ms`, or at once when `signal` aborts; leaves no timer or listener behind either way. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * One attempt from `address`: resolves { result } for a complete, verified file, or { failure, transient } where `failure` is the
 * GateInputError to report and `transient` says a later attempt could succeed (HTTP 429 or 5xx, or a network error in
 * TRANSIENT_NETWORK_CODES, and the stop has not fired). The response is released and a partial file removed before it resolves.
 */
async function downloadOnce({ address, destination, sha256, maxBytes, maxRedirects, transport, stop }) {
  let response;
  let file;
  let transient = false;
  try {
    response = await followRedirects({ address, maxRedirects, transport, stop });
    if (response.status !== 200) {
      transient = transientStatus(response.status);
      throw refusal('download-http-failure', `the server answered HTTP ${response.status}`);
    }
    if (response.contentLength > maxBytes) throw refusal('download-too-large', `the server announced more than ${maxBytes} bytes`);
    file = await createNewFile(destination);
    const { received, digest } = await streamToFile({ body: response.body, file, maxBytes, stop });
    if (response.contentLength !== null && received !== response.contentLength) throw refusal('download-truncated', `the body held ${received} bytes, not the announced ${response.contentLength}`);
    if (digest !== sha256) throw refusal('download-checksum-mismatch', 'the download does not match its SHA-256');
    await file.close();
    // Closing is asynchronous too: a stop during it must not become success.
    if (stop.error()) throw stop.error();
    return { result: { bytes: received, sha256: digest } };
  } catch (error) {
    const stopped = stop.error();
    const failure = stopped ?? (error instanceof GateInputError ? error : refusal('download-failed', `the download failed (${error.code ?? error.name})`));
    await removePartial(file, destination);
    return { failure, transient: !stopped && (transient || transientNetworkError(error)) };
  } finally {
    response?.release();
  }
}

/**
 * Downloads `url` (https only, at most `maxRedirects` redirects) to the new file `destination` and checks its SHA-256 against `sha256`.
 * The whole download must end within `deadlineMs` and the body may not pass `maxBytes`, both enforced while it streams.
 * `retryDelaysMs` (default none) lists the waits before each further attempt: an attempt is repeated, from `url`, only after an
 * HTTP 429 or 5xx or a network error in TRANSIENT_NETWORK_CODES, and only while the wait ends before the deadline, which covers
 * every attempt and wait; otherwise that attempt's failure is reported. Every attempt keeps the byte cap and the SHA-256 check.
 * `transport(url, { signal })` defaults to `fetch`, resolves { status, location, contentLength, body, release } and may ignore
 * `signal`; what it delivers after the download ended is discarded. `signal` interrupts. Resolves { bytes, sha256 } for a complete,
 * verified file. Throws GateInputError with a cause download-too-large, download-timeout, interrupted, download-http-failure,
 * download-truncated, download-checksum-mismatch, download-redirect-refused, download-too-many-redirects,
 * download-destination-exists or download-failed; a failure after the file was created removes it.
 */
export async function fetchBounded({
  url, destination, sha256, maxBytes, deadlineMs, maxRedirects = MAX_REDIRECTS, retryDelaysMs = [], transport = fetchTransport, signal,
}) {
  const stop = createStop({ deadlineMs, signal });
  try {
    for (let attempt = 0; ; attempt += 1) {
      const { result, failure, transient } = await downloadOnce({ address: url, destination, sha256, maxBytes, maxRedirects, transport, stop });
      if (result) return result;
      const delay = retryDelaysMs[attempt];
      if (!transient || delay === undefined || delay >= stop.remainingMs()) throw failure;
      await stop.race(wait(delay, stop.signal));
    }
  } catch (error) {
    throw stop.error() ?? error;
  } finally {
    stop.release();
  }
}
