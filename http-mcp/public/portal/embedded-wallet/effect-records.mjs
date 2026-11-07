// The crash-durable lane records behind the effect boundary's pass (effect-boundary.mjs). IndexedDB database
// `dacs-wallet-effects-v1` holds append-only `records` keyed by `[lane, seq]` and one `heads` row `{lane, revision}`
// per lane. Every durable transition is its own short `readwrite` transaction opened with `{durability: 'strict'}`:
// it reads the head, compares its revision with the one the caller read (the compare-and-swap), adds one record and
// advances the head. It resolves only on the transaction's `complete` event, never on a request's `success`, and
// nothing is carried across an authority, stop, signer or network await. A record is never updated or deleted.
// Record kinds: `signed` (always first, with the workflow and the exact signed bytes), `signed-held`, for each stage
// `dispatch`, `confirm` and `broadcast` `<stage>-started` (the intent) and then `-acknowledged`, `-unknown` or
// `-withheld` from the same pass, and `observed`. An outcome that does not follow its own pass's intent is refused.
// What is kept: the exact signed bytes (a transaction, or a signature over public bytes), the operation, lane, pin
// version and approval revision, and the bounded cause of a hold. Never keys or phrases. Local tampering with the
// browser profile is out of scope. `deriveDispatchHistory` reads the whole lane: an intent is cleared only by its
// own pass's `-withheld`, and a later held or withheld record never clears an earlier intent, unknown or acknowledged
// one. No page loads this yet.
import { createEffectBoundary } from './effect-boundary.mjs';
import { refuse } from './wallet-fence.mjs';

/** Name of the IndexedDB database that holds the lane records. */
export const EFFECT_RECORDS_DB_NAME = 'dacs-wallet-effects-v1';
/** Largest `signed` record, in bytes. */
export const MAX_SIGNED_BYTES = 1_048_576;
/** Most records one lane may hold; the next append is refused `eb_lane_full`. */
export const MAX_LANE_RECORDS = 64;

const DB_VERSION = 1;
const RECORDS = 'records';
const HEADS = 'heads';
const STAGES = ['dispatch', 'confirm', 'broadcast'];
const OUTCOME_PHASES = ['acknowledged', 'unknown', 'withheld'];
const STAGE_KINDS = new Set(STAGES.flatMap((stage) => ['started', ...OUTCOME_PHASES].map((phase) => `${stage}-${phase}`)));
const RECORD_KINDS = new Set(['signed', 'signed-held', 'observed', ...STAGE_KINDS]);
const IDENTITY_FIELDS = ['operationId', 'lane', 'pinVersion', 'approvalRevision', 'passId'];
const nonemptyString = (value) => typeof value === 'string' && value !== '';
const invalidRecord = (detail) => refuse('eb_record_invalid', new TypeError(detail));
const phaseOf = (record) => record.kind.slice(record.stage.length + 1);

function assertRecord(lane, record) {
  if (!RECORD_KINDS.has(record?.kind)) throw invalidRecord(`unknown record kind ${record?.kind}`);
  for (const field of IDENTITY_FIELDS) if (!nonemptyString(record[field])) throw invalidRecord(`${field} must be a non-empty string`);
  if (record.lane !== lane) throw invalidRecord('record lane differs from the lane appended to');
  if (record.kind === 'signed-held' || STAGE_KINDS.has(record.kind)) {
    if (!STAGES.includes(record.stage)) throw invalidRecord('a held or stage record names its stage');
    if (record.kind !== 'signed-held' && !record.kind.startsWith(`${record.stage}-`)) throw invalidRecord('stage differs from the record kind');
  }
  if (record.kind !== 'signed') {
    if (record.bytes !== undefined || record.workflow !== undefined) throw invalidRecord('only a signed record carries bytes and a workflow');
    return;
  }
  if (!nonemptyString(record.workflow)) throw invalidRecord('a signed record names its workflow');
  if (!(record.bytes instanceof Uint8Array) || record.bytes.length === 0 || record.bytes.length > MAX_SIGNED_BYTES) throw invalidRecord(`signed bytes must be 1 to ${MAX_SIGNED_BYTES} bytes`);
}

// Validates a private copy of the caller's record, so what is checked is what is stored.
function snapshotRecord(lane, record) {
  let snapshot;
  try { snapshot = structuredClone(record); } catch (cause) { throw refuse('eb_record_invalid', cause); }
  assertRecord(lane, snapshot);
  return snapshot;
}

// What the transaction may append after `last`: `signed` opens a lane, an outcome answers its own pass's intent.
function sequenceProblem(record, last) {
  if (record.kind === 'signed') return last === undefined ? null : 'signed must be the first record of a lane';
  if (last === undefined) return `${record.kind} needs signed bytes first`;
  if (STAGE_KINDS.has(record.kind) && phaseOf(record) !== 'started' && (last.kind !== `${record.stage}-started` || last.passId !== record.passId)) {
    return `${record.kind} must follow the ${record.stage}-started of the same pass`;
  }
  return null;
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let request, failed = false;
    const fail = (cause) => { failed = true; reject(refuse('eb_indexeddb_unavailable', cause)); };
    try {
      request = indexedDB.open(EFFECT_RECORDS_DB_NAME, DB_VERSION);
    } catch (cause) {
      return fail(cause);
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECORDS, { keyPath: ['lane', 'seq'] });
      request.result.createObjectStore(HEADS, { keyPath: 'lane' });
    };
    // A connection that opens after the open was given up is closed, not kept.
    request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error('opening the effect records was blocked'));
    return undefined;
  });
}

// One transaction. `work({records, heads}, abortWith)` issues requests only now and from request callbacks and
// returns a function that builds the result once the transaction has completed. Only `complete` resolves.
function transact(database, mode, work) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction([RECORDS, HEADS], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    } catch (cause) {
      return reject(refuse('eb_persist_failed', cause));
    }
    if (mode === 'readwrite' && tx.durability !== 'strict') {
      tx.abort();
      return reject(refuse('eb_durability_unavailable', new Error(`the transaction reports durability ${tx.durability}`)));
    }
    let failure;
    const abortWith = (error) => { failure = error; tx.abort(); };
    tx.onabort = () => reject(failure ?? refuse('eb_persist_failed', tx.error ?? undefined));
    try {
      const result = work({ records: tx.objectStore(RECORDS), heads: tx.objectStore(HEADS) }, abortWith);
      tx.oncomplete = () => {
        try { resolve(result()); } catch (error) { reject(error); }
      };
    } catch (cause) {
      abortWith(refuse('eb_persist_failed', cause));
    }
    return undefined;
  });
}

// Reads the lane's records in order, in one read-only transaction.
const readLaneRecords = (database, lane) => transact(database, 'readonly', ({ records, heads }, abortWith) => {
  const requests = [];
  const headRequest = heads.get(lane);
  headRequest.onsuccess = () => {
    const revision = headRequest.result?.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > MAX_LANE_RECORDS) return abortWith(refuse('eb_lane_corrupt', new RangeError(`lane head revision ${revision}`)));
    for (let seq = 1; seq <= revision; seq += 1) requests.push(records.get([lane, seq]));
    return undefined;
  };
  return () => requests.map((request, index) => {
    if (request.result?.seq !== index + 1) throw refuse('eb_lane_corrupt', new RangeError(`lane ${lane} lacks record ${index + 1}`));
    return request.result;
  });
});

// Adds one record when the lane is at `expectedRevision`; any other revision aborts the transaction.
const appendLaneRecord = (database, lane, expectedRevision, record) => transact(database, 'readwrite', ({ records, heads }, abortWith) => {
  let next;
  const headRequest = heads.get(lane);
  const write = (revision, last) => {
    const problem = sequenceProblem(record, last);
    if (problem !== null) return abortWith(refuse('eb_record_out_of_sequence', new Error(problem)));
    next = revision + 1;
    records.add({ ...record, seq: next });
    heads.put({ lane, revision: next });
    return undefined;
  };
  headRequest.onsuccess = () => {
    const revision = headRequest.result?.revision ?? 0;
    if (revision !== expectedRevision) return abortWith(refuse('eb_revision_conflict', new Error(`lane ${lane} is at revision ${revision}, expected ${expectedRevision}`)));
    if (revision >= MAX_LANE_RECORDS) return abortWith(refuse('eb_lane_full'));
    if (revision === 0) return write(0, undefined);
    const lastRequest = records.get([lane, revision]);
    lastRequest.onsuccess = () => write(revision, lastRequest.result);
    return undefined;
  };
  return () => ({ revision: next });
});

// The pass's view of a lane: the revision, the opening `signed` record and the newest record, as stored.
const toLaneHead = (laneRecords) => ({
  revision: laneRecords.length,
  signed: laneRecords[0]?.kind === 'signed' ? laneRecords[0] : undefined,
  last: laneRecords.at(-1),
});

/**
 * Reads a lane's records (oldest first, as stored) and says what they prove about dispatch: `signed` (the first
 * record is the signed bytes), `neverDispatched` (no transmission-stage intent without its own pass's `-withheld`,
 * and no `observed`), `confirmation` (`none`, `acknowledged`, or `unknown` for any confirm intent without its own
 * `-acknowledged` or `-withheld`, or any `confirm-unknown`) and `mayBroadcast` (signed, confirmation acknowledged,
 * and no possible broadcast yet). An unknown confirmation is never cleared by a later acknowledgement.
 */
export function deriveDispatchHistory(laneRecords) {
  const latestPhase = new Map();
  let observed = false;
  for (const record of laneRecords) {
    if (record.kind === 'observed') observed = true;
    else if (STAGE_KINDS.has(record.kind)) latestPhase.set(`${record.passId}/${record.stage}`, { stage: record.stage, phase: phaseOf(record) });
  }
  const attempts = [...latestPhase.values()];
  const possiblySent = (stage) => attempts.some((attempt) => attempt.stage === stage && attempt.phase !== 'withheld');
  const confirmations = attempts.filter((attempt) => attempt.stage === 'confirm');
  const signed = laneRecords[0]?.kind === 'signed';
  let confirmation = 'none';
  if (confirmations.some((attempt) => attempt.phase === 'started' || attempt.phase === 'unknown')) confirmation = 'unknown';
  else if (confirmations.some((attempt) => attempt.phase === 'acknowledged')) confirmation = 'acknowledged';
  const neverDispatched = !observed && !possiblySent('dispatch') && !possiblySent('broadcast');
  return { signed, neverDispatched, confirmation, mayBroadcast: signed && confirmation === 'acknowledged' && neverDispatched };
}

/**
 * The durable record store the effect boundary's pass is given: `head(lane)` -> `{revision, signed, last}` (the
 * stored records, each with its `seq`), `append(lane, expectedRevision, record)` -> `{revision}`, `history(lane)`
 * (every record of the lane) and `ready()`. `ready()` refuses before any signer call when Web Locks or IndexedDB is
 * missing (`eb_web_locks_unavailable`, `eb_indexeddb_unavailable`, cause kept) or a transaction does not report
 * strict durability (`eb_durability_unavailable`). `append` rejects with `eb_revision_conflict` when another writer
 * moved the lane, `eb_record_invalid`, `eb_record_out_of_sequence`, `eb_lane_full`, or `eb_persist_failed` (cause
 * kept) when the transaction aborts; a record whose transaction did not complete is not persisted. A lane whose head
 * and records disagree is refused `eb_lane_corrupt`. A bad `lane` or `expectedRevision` throws a `TypeError`.
 */
export function createDurableRecordStore({ indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks } = {}) {
  let opening;
  const database = () => {
    opening ??= openDatabase(indexedDB).then((opened) => {
      opened.onversionchange = () => { opened.close(); opening = undefined; };
      return opened;
    }, (error) => { opening = undefined; throw error; });
    return opening;
  };
  const requireLane = (lane) => {
    if (!nonemptyString(lane)) throw new TypeError('lane must be a non-empty string');
  };
  const history = async (lane) => {
    requireLane(lane);
    return readLaneRecords(await database(), lane);
  };

  return {
    history,
    head: async (lane) => toLaneHead(await history(lane)),
    async ready() {
      if (typeof locks?.request !== 'function') throw refuse('eb_web_locks_unavailable');
      if (typeof indexedDB?.open !== 'function') throw refuse('eb_indexeddb_unavailable');
      await transact(await database(), 'readwrite', () => () => undefined);
    },
    async append(lane, expectedRevision, record) {
      requireLane(lane);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative integer');
      return appendLaneRecord(await database(), lane, expectedRevision, snapshotRecord(lane, record));
    },
  };
}

/**
 * The effect boundary over the durable records: `createEffectBoundary` with a durable store, whose `runPass` first
 * awaits `records.ready()`, so a missing primitive or non-strict durability refuses before the pass signs. Takes the
 * boundary's options (except `records`) plus `indexedDB` and `locks` (the same Web Locks manager the fence uses).
 * Returns `{ runPass, records }`.
 */
export function createDurableEffectBoundary({ indexedDB, locks, ...boundaryOptions }) {
  const records = createDurableRecordStore({ indexedDB, locks });
  const boundary = createEffectBoundary({ ...boundaryOptions, records });
  return {
    records,
    async runPass(request) {
      await records.ready();
      return boundary.runPass(request);
    },
  };
}
