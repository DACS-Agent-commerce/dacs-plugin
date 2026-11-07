// An in-memory IndexedDB double for the durable effect records. It models what the store depends on: a transaction
// is active only inside its creation task and inside its own request callbacks (any other await ends it), it
// commits by itself once no request is pending, its `durability` attribute is whatever the browser reports, and a
// request can succeed inside a transaction that then aborts. A kill cut ends the "process" at a commit: `before`
// discards the transaction, `after` keeps its writes but never delivers `complete`. `restart()` is a new process
// over the data that was committed; every transaction of the old one stays frozen.
import { EFFECT_RECORDS_DB_NAME } from '../../public/portal/embedded-wallet/effect-records.mjs';

const key = (value) => JSON.stringify(value);

function keyOf(keyPath, value) {
  return Array.isArray(keyPath) ? keyPath.map((name) => value[name]) : value[keyPath];
}

export function createFakeIndexedDb({ strictDurability = true, data = new Map() } = {}) {
  const idb = {
    data, dead: false, transactions: [], cut: null, abortRule: null, opens: 0,
    // Kill the process at the next commit whose `records` writes satisfy `match`.
    cutAt(match, when) { idb.cut = { match, when }; },
    // Abort the next commits whose `records` writes satisfy `match`, after their requests have succeeded.
    abortAt(match, error) { idb.abortRule = { match, error }; },
    openTransactionCount: () => idb.transactions.filter((tx) => tx.state === 'active').length,
    committedRecords(lane) {
      const rows = idb.data.get(EFFECT_RECORDS_DB_NAME)?.stores.get('records')?.rows ?? new Map();
      return [...rows.values()].filter((row) => row.lane === lane).sort((a, b) => a.seq - b.seq).map((row) => structuredClone(row));
    },
    restart: () => createFakeIndexedDb({ strictDurability, data }),
    open,
  };

  function commit(tx) {
    for (const [storeName, rows] of tx.working) idb.data.get(tx.dbName).stores.get(storeName).rows = rows;
    tx.state = 'committed';
  }

  function finish(tx) {
    if (idb.dead || tx.state !== 'active') return;
    const written = tx.writes.filter((write) => write.store === 'records').map((write) => write.value);
    const cut = tx.mode === 'readwrite' && idb.cut?.match(written) ? idb.cut : null;
    if (cut?.when === 'before') { idb.dead = true; return; }
    if (cut) { commit(tx); idb.dead = true; return; }
    if (tx.mode === 'readwrite' && idb.abortRule?.match(written)) {
      tx.error = idb.abortRule.error;
      tx.state = 'aborted';
      tx.onabort?.();
      return;
    }
    commit(tx);
    tx.oncomplete?.();
  }

  const settle = (tx) => queueMicrotask(() => { if (tx.pending === 0 && !tx.inCallback) finish(tx); });

  function abort(tx, error) {
    if (tx.state !== 'active') return;
    tx.state = 'aborted';
    if (error) tx.error = error;
    queueMicrotask(() => { if (!idb.dead) tx.onabort?.(); });
  }

  function enqueue(tx, run) {
    if (tx.state !== 'active' || !(tx.creationWindow || tx.inCallback)) throw new DOMException('the transaction is not active', 'TransactionInactiveError');
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    tx.pending += 1;
    queueMicrotask(() => {
      if (idb.dead || tx.state !== 'active') return;
      try { request.result = run(); } catch (error) { request.error = error; }
      tx.pending -= 1;
      tx.inCallback = true;
      try {
        if (request.error) { request.onerror?.(); abort(tx, request.error); } else request.onsuccess?.();
      } catch (error) {
        abort(tx, error);
      } finally {
        tx.inCallback = false;
      }
      settle(tx);
    });
    return request;
  }

  function objectStore(tx, name) {
    const definition = idb.data.get(tx.dbName).stores.get(name);
    const rows = () => {
      if (!tx.working.has(name)) tx.working.set(name, new Map(definition.rows));
      return tx.working.get(name);
    };
    const write = (value, overwrite) => enqueue(tx, () => {
      const rowKey = key(keyOf(definition.keyPath, value));
      if (!overwrite && rows().has(rowKey)) throw new DOMException('the key already exists', 'ConstraintError');
      rows().set(rowKey, structuredClone(value));
      tx.writes.push({ store: name, value: structuredClone(value) });
      return rowKey;
    });
    return {
      get: (wanted) => enqueue(tx, () => { const row = (tx.working.get(name) ?? definition.rows).get(key(wanted)); return row === undefined ? undefined : structuredClone(row); }),
      add: (value) => write(value, false),
      put: (value) => write(value, true),
    };
  }

  function connection(dbName) {
    return {
      close() {},
      transaction(storeNames, mode, options) {
        const tx = {
          dbName, mode, state: 'active', pending: 0, creationWindow: true, inCallback: false, working: new Map(), writes: [], error: null,
          durability: strictDurability ? (options?.durability ?? 'default') : 'default',
          oncomplete: null, onabort: null, onerror: null,
          objectStore: (name) => objectStore(tx, name),
          abort: () => abort(tx),
        };
        if (!storeNames.every((name) => idb.data.get(dbName).stores.has(name))) throw new DOMException('no such object store', 'NotFoundError');
        idb.transactions.push(tx);
        setImmediate(() => { tx.creationWindow = false; if (tx.pending === 0) finish(tx); });
        return tx;
      },
    };
  }

  function open(dbName) {
    idb.opens += 1;
    const request = { result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
    queueMicrotask(() => {
      if (idb.dead) return;
      if (!idb.data.has(dbName)) {
        idb.data.set(dbName, { stores: new Map() });
        request.result = { createObjectStore: (name, { keyPath }) => idb.data.get(dbName).stores.set(name, { keyPath, rows: new Map() }) };
        request.onupgradeneeded?.();
      }
      request.result = connection(dbName);
      request.onsuccess?.();
    });
    return request;
  }

  return idb;
}
