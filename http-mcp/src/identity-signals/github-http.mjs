import { createHash } from 'node:crypto';

export const GITHUB_ORIGIN = 'https://api.github.com';
const failure = () => new Error('GitHub fetch unavailable');
// A failure caused by a caller's own deadline names that deadline, so the cache
// can tell a caller's cutoff from a GitHub failure or the five-second ceiling.
const cutoff = (deadline) => Object.assign(failure(), { cutoff: deadline });
const settled = (error) => Number.isFinite(error?.cutoff) ? error : failure();

export function createGithubQueue({ now = () => Date.now() } = {}) {
  const waiting = [], quotas = new Map();
  let active = 0, blockedUntil = 0;
  function pump() {
    while (active < 2 && waiting.length) {
      const job = waiting.shift();
      if (job.expired) continue;
      let quota = quotas.get(job.lane);
      if (!quota || now() >= quota.reset) {
        quota = { remaining: job.lane === 'anonymous' ? 60 : 5000, reset: now() + 3600_000 };
        quotas.set(job.lane, quota);
      }
      if (now() < blockedUntil || quota.remaining <= 0) { job.reject(failure()); continue; }
      if (performance.now() >= job.deadline) { job.reject(job.expire()); continue; }
      quota.remaining--; active++; job.running = true;
      Promise.resolve().then(job.run).then(job.resolve, (error) => job.reject(settled(error)));
    }
  }
  function observe(response, lane) {
    const h = response.headers, time = now(), hour = time + 3600_000;
    const resetHeader = h.get('x-ratelimit-reset');
    const resetSeconds = resetHeader !== null && /^\d+$/.test(resetHeader) ? Number(resetHeader) : NaN;
    const reset = resetSeconds * 1000 >= time ? Math.min(hour, resetSeconds * 1000) : null;
    const remainingHeader = h.get('x-ratelimit-remaining');
    const remaining = remainingHeader !== null && /^\d+$/.test(remainingHeader) && Number.isSafeInteger(Number(remainingHeader)) ? Number(remainingHeader) : null;
    const quota = quotas.get(lane);
    if (quota && remaining !== null) {
      quota.remaining = Math.min(quota.remaining, remaining);
      if (reset !== null) quota.reset = reset;
    }
    if (response.status === 403 || response.status === 429 || remaining === 0) {
      const retry = h.get('retry-after');
      // Date.parse accepts strings such as '-1'; only an HTTP date is eligible.
      const retryTime = retry !== null && /^\d+$/.test(retry) ? Math.min(hour, time + Number(retry) * 1000)
        : retry && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) ? Date.parse(retry) : NaN;
      blockedUntil = Math.max(blockedUntil, time + 60_000, reset ?? 0, Number.isFinite(retryTime) && retryTime >= time ? Math.min(hour, retryTime) : 0);
    }
  }

  // `cut` is the caller deadline when it, not the request ceiling, ends the job.
  function schedule(run, deadline, lane, cut = null) {
    if (waiting.length >= 1000 || now() < blockedUntil) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const job = { run, deadline, lane, expired: false, running: false, expire: () => cut === null ? failure() : cutoff(cut) };
      const finish = (value, error) => {
        if (job.expired) return; // Late transport settlement cannot release twice.
        job.expired = true; clearTimeout(job.timer);
        const i = waiting.indexOf(job); if (i >= 0) waiting.splice(i, 1);
        if (job.running) active--;
        if (error) reject(error); else resolve(value);
        pump();
      };
      job.resolve = (v) => finish(v);
      job.reject = (e) => finish(null, e);
      job.timer = setTimeout(() => job.reject(job.expire()), Math.max(1, deadline - performance.now()));
      waiting.push(job); pump();
    });
  }
  return { schedule, observe };
}
const globalQueue = createGithubQueue();

export function createGithubHttp({ fetchImpl = globalThis.fetch, token, queue = globalQueue } = {}) {
  const pending = new Map();
  const lane = token ? createHash('sha256').update(token).digest('hex') : 'anonymous';
  async function request(path, deadline) {
    const url = new URL(path, GITHUB_ORIGIN);
    if (url.origin !== GITHUB_ORIGIN || url.username || url.password || url.hash) throw failure();
    const key = url.href;
    if (!pending.has(key)) {
      if (pending.size >= 1000) throw failure();
      if (deadline <= performance.now()) throw cutoff(deadline);
      const end = Math.min(deadline, performance.now() + 5000), cut = end === deadline ? deadline : null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, end - performance.now()));
      const task = queue.schedule(async () => { try {
        const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw failure(); }
        queue.observe(response, lane);
        if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) { void response.body?.cancel().catch(() => {}); throw failure(); }
        if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '') || Number(response.headers.get('content-length')) > 1_000_000 || !response.body) { void response.body?.cancel().catch(() => {}); throw failure(); }
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0, text = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1_000_000) { void reader.cancel().catch(() => {}); throw failure(); }
            text += decoder.decode(value, { stream: true });
          }
          return { data: JSON.parse(text + decoder.decode()), link: response.headers.get('link') };
        } catch { throw failure(); }
      } catch { throw controller.signal.aborted && cut !== null ? cutoff(cut) : failure(); } }, end, lane, cut).finally(() => { clearTimeout(timer); controller.abort(); pending.delete(key); });
      pending.set(key, task);
    }
    let timer;
    const wait = deadline - performance.now();
    try { return await Promise.race([pending.get(key), new Promise((_, reject) => { timer = setTimeout(() => reject(wait <= 5000 ? cutoff(deadline) : failure()), Math.max(1, Math.min(5000, wait))); })]); }
    catch (error) { throw settled(error); }
    finally { clearTimeout(timer); }
  }
  return { request };
}
