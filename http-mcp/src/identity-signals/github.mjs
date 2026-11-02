import { createHash, createPublicKey, verify } from 'node:crypto';
import { GITHUB_HANDLE } from '../identities.mjs';
import { createGithubHttp, GITHUB_ORIGIN } from './github-http.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const handle = (v) => typeof v === 'string' && v.length <= 39 && GITHUB_HANDLE.test(v) && !/\s/u.test(v) && !/(?:^-|-$|--)/.test(v);
const id = (v) => Number.isSafeInteger(v) && v > 0;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unresolved = () => ({ bindingStatus: 'unresolved' });
const SOURCE = 'GitHub REST API (plugin server HTTPS)';
const DAY = 86400_000;
const CUT_TTL = 30_000;
export const GITHUB_SEARCH_CAP = 10;
export const GITHUB_JOB_WAITER_CAP = 64;
export const GITHUB_ENTRY_CAP = 8;
export const GITHUB_PROOF_URL_CAP = 256;
export const GITHUB_CACHE_BYTE_CAP = 4 * 1024 * 1024;
// Every signals object opens with these two plugin-fixed fields, ahead of any
// GitHub data, so buyers and the model read them before the numbers. They are
// never derived from GitHub or chain data; a Vet-backed result will be a
// separate field, not a change of this value.
export const GITHUB_VET_STATUS = 'not-vet';
export const GITHUB_DISPLAY_ONLY_PREFIX = 'Display only — not a DACS Vet result; nothing recorded on chain.';

// Retain only bounded fields used to check a binding; never retain client IDs,
// presentations, invalid URLs or unrelated chain fields.
export function sanitizeGithubEntry(entry) {
  const login = entry?.username ?? entry?.handle;
  if (!handle(login)) return {};
  if (entry?.proofType === 'tlsn') return { username: login, proofType: 'tlsn' };
  if (!gistIdFor(entry, login) || (entry?.proofType !== undefined && (typeof entry.proofType !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(entry.proofType)))) return { username: login };
  return { username: login, proof: entry.proof, ...(entry.proofType ? { proofType: entry.proofType } : {}) };
}

export function gistIdFor(entry, login) {
  if (!handle(login) || typeof entry?.proof !== 'string' || entry.proof.length > GITHUB_PROOF_URL_CAP) return null;
  const match = /^https:\/\/gist\.github\.com\/([A-Za-z0-9-]+)\/([0-9a-f]{1,64})$/.exec(entry.proof);
  return match && match[0] === entry.proof && handle(match[1]) && match[1].toLowerCase() === login.toLowerCase() ? match[2].toLowerCase() : null;
}

export function checkTlsnBinding(entry) { return entry?.proofType === 'tlsn' ? { bindingStatus: 'tlsn-unchecked' } : null; }

export async function checkGistBinding({ entry, login, seller, request, deadline }) {
  const gistId = gistIdFor(entry, login);
  if (!gistId || !/^0x[0-9a-f]{64}$/.test(seller)) return unresolved();
  let gist;
  try { ({ data: gist } = await request(`/gists/${gistId}`, deadline)); }
  catch (error) { return { ...unresolved(), refreshFailed: true, ...(Number.isFinite(error?.cutoff) ? { cutoff: error.cutoff } : {}) }; }
  if (!object(gist) || !handle(gist.owner?.login) || gist.owner.login.toLowerCase() !== login.toLowerCase() || !id(gist.owner.id) || !object(gist.files) || Object.keys(gist.files).length !== 1) return unresolved();
  const file = Object.values(gist.files)[0];
  if (!object(file) || file.truncated !== false || typeof file.content !== 'string') return unresolved();
  // One final LF is the sole editor tolerance; everything else must match the
  // stored bytes exactly before decoding.
  const content = file.content.endsWith('\n') ? file.content.slice(0, -1) : file.content;
  if (!/^demos:dw2p:ed25519:(0x)?[0-9a-f]{128}$/.test(content) || /\s/u.test(content)) return { ...unresolved(), reason: 'Proof content must be exact, with at most one trailing LF.' };
  const signature = Buffer.from(content.split(':')[3].replace(/^0x/, ''), 'hex');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(seller.slice(2), 'hex')]), format: 'der', type: 'spki' });
  if (verify(null, Buffer.from(`demos-web2:v1:github:${login.toLowerCase()}:${seller}`), publicKey, signature)) return { bindingStatus: 'bound', accountId: gist.owner.id, gistId };
  return verify(null, Buffer.from('dw2p'), publicKey, signature) ? { bindingStatus: 'legacy-proof' } : unresolved();
}

function nextPage(link, path) {
  if (!link) return null;
  const next = link.split(',').filter((p) => /;\s*rel="next"/.test(p));
  if (!next.length) return null;
  if (next.length !== 1) throw Error('invalid pagination');
  const match = /^\s*<([^>]+)>;/.exec(next[0]);
  const url = new URL(match?.[1]);
  if (url.origin !== GITHUB_ORIGIN || url.pathname !== path || url.username || url.password || url.hash || url.searchParams.get('type') !== 'owner' || url.searchParams.get('per_page') !== '100' || url.searchParams.get('sort') !== 'full_name' || url.searchParams.get('direction') !== 'asc' || !/^[1-9][0-9]*$/.test(url.searchParams.get('page') ?? '') || [...url.searchParams.keys()].some((k) => !['type','per_page','sort','direction','page'].includes(k))) throw Error('invalid pagination');
  return url.pathname + url.search;
}

// `valid` is checked before every request, so a fetch nobody still needs stops early.
export async function fetchGithubStatistics({ accountId, request, deadline, now = () => Date.now(), valid = () => true }) {
  if (!valid()) throw Error('no current link');
  const { data: user } = await request(`/user/${accountId}`, deadline);
  if (!object(user) || user.id !== accountId || user.type !== 'User' || !handle(user.login) || typeof user.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(user.created_at) || !Number.isFinite(Date.parse(user.created_at)) || Date.parse(user.created_at) > now() || new Date(user.created_at).toISOString().replace('.000Z','Z') !== user.created_at || (user.followers !== undefined && !count(user.followers))) throw Error('invalid profile');
  const path = `/users/${user.login}/repos`, repos = new Map(), pages = new Set();
  let next = `${path}?type=owner&per_page=100&sort=full_name&direction=asc`, complete = false, omitted = false, partialFailure = false, cut;
  for (let page = 0; page < 10; page++) {
    if (!valid()) throw Error('no current link');
    try {
      if (pages.has(next)) { partialFailure = true; break; }
      pages.add(next);
      const { data, link } = await request(next, deadline);
      if (!Array.isArray(data) || data.length > 100) { partialFailure = true; break; }
      for (const r of data) {
        if (!object(r) || !id(r.id) || !id(r.owner?.id) || typeof r.fork !== 'boolean') { omitted = true; continue; }
        if (r.owner.id !== accountId || r.fork) continue;
        if (typeof r.name !== 'string' || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(r.name) || !count(r.stargazers_count) || typeof r.archived !== 'boolean') { omitted = true; continue; }
        if (!repos.has(r.id)) repos.set(r.id, { name: r.name, stars: r.stargazers_count, archived: r.archived, url: `https://github.com/${user.login}/${r.name}` });
      }
      next = nextPage(link, path);
      if (!next) { complete = !omitted; break; }
    } catch (error) { partialFailure = true; if (Number.isFinite(error?.cutoff)) cut = error.cutoff; break; }
  }
  const all = [...repos.values()], total = all.reduce((sum, r) => sum + r.stars, 0);
  if (!count(total)) throw Error('invalid star total');
  return { partialFailure: partialFailure || omitted, ...(cut === undefined ? {} : { cutoff: cut }), login: user.login, createdAt: user.created_at, ...(user.followers !== undefined ? { followers: user.followers } : {}), stars: { total, repositories: all.length, complete, top: all.sort((a,b) => b.stars - a.stars || a.name.localeCompare(b.name)).slice(0,3) } };
}

const label = (value) => `${GITHUB_DISPLAY_ONLY_PREFIX} ${caveats(value)}`;

function caveats(value) {
  if (value.bindingStatus === 'legacy-proof') return 'GitHub account binding could not be checked: this link uses the old Demos proof format, which does not name the account. Statistics withheld.';
  if (value.bindingStatus === 'tlsn-unchecked') return 'Linked with TLSNotary. This plugin does not check TLSNotary proofs yet, so statistics are withheld.';
  if (value.bindingStatus !== 'bound') return 'GitHub account binding could not be checked; statistics withheld.';
  let text = value.stars ? `GitHub account and public repository statistics checked by this plugin server at ${value.dataFetchedAt}. Original proof gist checked; GitHub account ID ${value.accountId}. Chain link is one node's read. ${value.stars.complete ? '' : 'at least '}${value.stars.total} stars across ${value.stars.repositories} ${value.stars.complete ? 'public, non-fork repositories currently owned by this GitHub account' : 'checked repositories'}. Stars may be purchased; repository ownership does not prove authorship. GitHub account created ${value.createdAt.slice(0,10)}. This is account age, not this seller's tenure.` : 'Identity statistics unavailable from GitHub. No conclusion about this seller. Original proof gist checked.';
  if (value.followers !== undefined) text += ` ${value.followers} followers reported; private profiles may report zero to other users.`;
  if (value.cache === 'stale') text += ` Cached result last checked ${[value.dataFetchedAt, value.checkedAt].filter(Boolean).sort()[0]}; refresh unavailable.`;
  return text;
}

export function createGithubSignals({ config, fetchImpl, now = () => Date.now(), queue, maxEntries = 1000, maxCacheBytes = GITHUB_CACHE_BYTE_CAP, maxWaiters = GITHUB_JOB_WAITER_CAP } = {}) {
  const http = createGithubHttp({ fetchImpl, token: config?.identityGithubToken, queue });
  maxEntries = Math.max(1, Math.min(1000, Math.floor(Number.isFinite(maxEntries) ? maxEntries : 1000)));
  maxCacheBytes = Math.max(1, Math.min(GITHUB_CACHE_BYTE_CAP, Math.floor(Number.isFinite(maxCacheBytes) ? maxCacheBytes : GITHUB_CACHE_BYTE_CAP)));
  maxWaiters = Math.max(1, Math.min(GITHUB_JOB_WAITER_CAP, Math.floor(Number.isFinite(maxWaiters) ? maxWaiters : GITHUB_JOB_WAITER_CAP)));
  const cache = new Map(), pending = new Map(), subjects = new Map();
  const sizes = new Map();
  let cacheBytes = 0;
  const remove = (key) => { cacheBytes -= sizes.get(key) ?? 0; sizes.delete(key); cache.delete(key); };
  const subjectKey = (network, seller) => digest([network, seller]);
  const statsKeyFor = (accountId) => digest(['statistics:v1', accountId]);
  let searchStart = now(), searchReads = 0;
  const usable = (saved) => saved && saved.expires > now() && (!saved.stale || now() - saved.good.time <= DAY);
  const put = (key, value) => {
    remove(key);
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxCacheBytes) return;
    while (cache.size >= maxEntries || cacheBytes + bytes > maxCacheBytes) remove(cache.keys().next().value);
    cache.set(key, value); sizes.set(key, bytes); cacheBytes += bytes;
  };
  // Each observed link carries a mark that lasts while the link stays on chain.
  // A removed and re-added link gets a new mark, so work started for the old
  // one can neither be saved nor shown for it.
  function observe(network, seller, entries) {
    const subject = subjectKey(network, seller), previous = subjects.get(subject) ?? new Map(), keys = new Map();
    for (const e of entries.slice(0, GITHUB_ENTRY_CAP)) {
      const key = bindingKey(network, seller, sanitizeGithubEntry(e));
      if (key && !keys.has(key)) keys.set(key, previous.get(key) ?? {});
    }
    for (const key of previous.keys()) if (!keys.has(key)) remove(key);
    subjects.delete(subject);
    while (subjects.size >= maxEntries) {
      // An evicted seller can no longer see a link removed, so its bindings go too.
      const [evicted, evictedKeys] = subjects.entries().next().value;
      for (const key of evictedKeys.keys()) remove(key);
      subjects.delete(evicted);
    }
    subjects.set(subject, keys);
  }
  const markOf = (network, seller, key) => subjects.get(subjectKey(network, seller))?.get(key);
  function bindingKey(network, seller, entry) {
    const login = entry?.username ?? entry?.handle;
    if (!handle(login)) return null;
    const gistId = gistIdFor(entry, login);
    if (!gistId && entry?.proofType !== 'tlsn') return null;
    return digest([network, seller, login.toLowerCase(), gistId, entry?.proofType ?? 'gist']);
  }
  // A pending job is joined by callers whose link is current under the same mark
  // (binding jobs) or by any seller bound to the same GitHub account (statistics
  // jobs). Each link waits once (keyed by its mark), with its latest deadline.
  // The job runs while any waiter's link is current; once none is, it stops,
  // only settles, and is never joined again. Only a new job is charged.
  async function lookup(key, ttl, load, deadline, { allow = true, charge = () => true, mark, owner = mark, valid = () => true } = {}) {
    const old = cache.get(key);
    const fallback = () => old?.good && now() - old.good.time <= DAY ? { ...old.good.value, cache: 'stale' } : null;
    if (usable(old)) return { ...old.value, cache: old.stale ? 'stale' : 'cached' };
    if (!allow || deadline <= performance.now()) return fallback();
    let job = pending.get(key);
    if (job && (job.mark !== mark || job.stopped)) job = null;
    if (job) {
      const waiter = job.waiters.get(owner);
      if (waiter) waiter.deadline = Math.max(waiter.deadline, deadline);
      else if (job.waiters.size < maxWaiters) job.waiters.set(owner, { valid, deadline });
    } else {
      if (!pending.has(key) && pending.size >= maxEntries) return null;
      if (!charge()) return fallback();
      const started = { mark, stopped: false, waiters: new Map([[owner, { valid, deadline }]]) };
      const live = () => {
        if (started.stopped) return false;
        for (const waiter of started.waiters.values()) if (waiter.valid()) return true;
        started.stopped = true;
        return false;
      };
      // A result cut short by one caller's deadline while a current waiter has a
      // later deadline is kept for 30 seconds, not five minutes: the later waiter's
      // next call soon checks again, and short overlapping deadlines can't refetch
      // GitHub on every call. GitHub failures and the five-second request ceiling
      // are cached as usual.
      const outlived = (cut) => Number.isFinite(cut) && [...started.waiters.values()].some((w) => w.deadline > cut && w.valid());
      const brief = (saved, cut) => outlived(cut) ? { ...saved, expires: Math.min(saved.expires, now() + CUT_TTL) } : saved;
      // Links can leave the chain before this microtask runs; then nothing is fetched.
      const task = Promise.resolve().then(() => { if (!live()) throw Error('no current link'); return load(live); }).then(({ cutoff: cut, ...value }) => {
        if (value.refreshFailed || (value.partialFailure && old?.good && now() - old.good.time <= DAY)) throw Object.assign(Error('refresh unavailable'), { cutoff: cut });
        const time = now(), good = value.bindingStatus && value.bindingStatus !== 'bound' ? null : { value: { ...value, time }, time };
        const saved = { value: { ...value, time }, good, expires: time + (good && !value.partialFailure ? ttl : 300_000), stale: false };
        if (live()) put(key, value.partialFailure ? brief(saved, cut) : saved);
        return { ...saved.value, cache: 'fresh' };
      }).catch((error) => {
        const good = old?.good && now() - old.good.time <= DAY ? old.good : null;
        const saved = { value: good?.value ?? { ...unresolved(), time: now() }, good, expires: now() + 300_000, stale: !!good };
        if (live()) put(key, brief(saved, error?.cutoff));
        return { ...saved.value, cache: good ? 'stale' : 'fresh' };
      }).finally(() => { if (pending.get(key)?.task === task) pending.delete(key); });
      job = Object.assign(started, { task });
      pending.set(key, job);
    }
    let timer;
    try { return await Promise.race([job.task, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback()), Math.max(1, deadline - performance.now())); })]); }
    finally { clearTimeout(timer); }
  }
  async function signals(network, seller, entry, login, { deadline = performance.now(), search = false, cachedOnly = false } = {}) {
    entry = sanitizeGithubEntry(entry);
    const key = bindingKey(network, seller, entry);
    if (!key) return present(unresolved(), null);
    const tlsn = checkTlsnBinding(entry);
    // A search is charged once, and only when it starts new GitHub work.
    let charged = false;
    const charge = () => {
      if (!search || charged) return true;
      if (now() - searchStart >= 60_000) { searchStart = now(); searchReads = 0; }
      if (searchReads >= GITHUB_SEARCH_CAP) return false;
      searchReads++;
      return (charged = true);
    };
    // `current()` gates every fetch and save inside lookup(); the checks here are
    // early exits that also keep a removed link from holding a pending slot.
    const mark = markOf(network, seller, key), current = () => mark !== undefined && markOf(network, seller, key) === mark;
    if (!current()) return present(null, null);
    const options = { allow: !cachedOnly, charge, valid: current };
    const binding = tlsn ?? await lookup(key, 900_000, () => checkGistBinding({ entry, login, seller, request: http.request, deadline }), deadline, { ...options, mark });
    let stats = null;
    if (!current()) return present(null, null);
    if (binding?.bindingStatus === 'bound') stats = await lookup(statsKeyFor(binding.accountId), 3600_000, (live) => fetchGithubStatistics({ accountId: binding.accountId, request: http.request, deadline, now, valid: live }), deadline, { ...options, owner: mark });
    if (!current()) return present(null, null);
    return present(binding, stats);
  }
  function present(binding, stats) {
    if (!binding) return { vetStatus: GITHUB_VET_STATUS, label: `${GITHUB_DISPLAY_ONLY_PREFIX} Not checked yet. GitHub account binding could not be checked; statistics withheld.`, ...unresolved(), source: SOURCE, cache: 'cached' };
    let value = { bindingStatus: binding.bindingStatus, source: SOURCE, cache: binding.cache ?? 'fresh', ...(binding.time !== undefined ? { checkedAt: new Date(binding.time).toISOString() } : {}) };
    if (binding.bindingStatus === 'bound') {
      value.accountId = binding.accountId;
      if (stats?.stars) {
        const { time, cache: state, partialFailure, ...data } = stats;
        value = { ...value, ...data, dataFetchedAt: new Date(time).toISOString(), cache: binding.cache === 'stale' || state === 'stale' ? 'stale' : state };
      }
    }
    const vetStatus = GITHUB_VET_STATUS, displayLabel = label(value) + (binding.reason ? ` ${binding.reason}` : '');
    return { vetStatus, label: displayLabel, ...value, vetStatus, label: displayLabel };
  }
  function cached(network, seller, entry, login) {
    const get = (key) => {
      const saved = cache.get(key);
      if (usable(saved)) return { ...saved.value, cache: saved.stale ? 'stale' : 'cached' };
      return saved?.good && now() - saved.good.time <= DAY ? { ...saved.good.value, cache: 'stale' } : null;
    };
    entry = sanitizeGithubEntry(entry);
    const key = bindingKey(network, seller, entry);
    if (!key) return present(unresolved(), null);
    const binding = markOf(network, seller, key) ? checkTlsnBinding(entry) ?? get(key) : null;
    return present(binding, binding?.bindingStatus === 'bound' ? get(statsKeyFor(binding.accountId)) : null);
  }
  // Payload bytes are bounded separately from the fixed map/set overhead.
  function retainedSize() {
    const subjectKeys = [...subjects.values()].flatMap((keys) => [...keys.keys()]);
    return { cacheBytes, subjectBytes: [...subjects.keys(), ...subjectKeys].reduce((sum, key) => sum + Buffer.byteLength(key), 0),
      subjects: subjects.size, cacheEntries: cache.size, subjectKeys, pendingJobs: pending.size, pendingWaiters: [...pending.values()].reduce((sum, job) => sum + job.waiters.size, 0) };
  }
  return { observe, signals, cached, notChecked: () => present(null, null), retainedSize };
}
