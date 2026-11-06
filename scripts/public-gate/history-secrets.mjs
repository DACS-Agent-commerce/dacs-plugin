import { GateInputError } from './objects.mjs';

/** The path every commit or tag object is scanned under; no default scanner rule tests it, so it never earns a path suffix. */
const OBJECT_PATH = 'commit-object';

/** The part of a raw commit or tag object that line `line` (1-based) is in: a header (a person's own, or `header`) or the message with its own line number. */
function fieldAt(raw, line, people) {
  const lines = raw.toString('utf8').split('\n');
  const blank = lines.indexOf('');
  if (blank >= 0 && line > blank + 1) return { kind: 'message', field: 'message', line: line - blank - 1 };
  const [word] = (lines[line - 1] ?? '').split(' ');
  const field = people.includes(word) ? word : 'header';
  return { kind: field, field };
}

/**
 * Collects what the history's secret scan reads. Every distinct (path, mode, blob) of every commit tree is one occurrence,
 * numbered once whatever the order the commits come in, and every commit or tag object is one more entry, so the scanner
 * gets one neutral name per occurrence and no original path layer. Blob bytes are copied once per blob.
 * Returns { addTree, addObject, scanEntries, treeOccurrences, locate }.
 */
export function createSecretInput(limits) {
  const occurrences = new Map();
  const objects = [];
  const sources = new Map();
  const blobs = new Map();
  let blobBytes = 0;
  let nextPosition = 1;

  const sharedBlob = ({ oid, bytes }) => {
    if (!blobs.has(oid)) {
      blobBytes += bytes.length;
      if (blobBytes > limits.maxTotalBlobBytes) throw new GateInputError('limit:maxTotalBlobBytes', `the history's distinct blobs hold more than ${limits.maxTotalBlobBytes} bytes`);
      blobs.set(oid, Buffer.from(bytes));
    }
    return blobs.get(oid);
  };

  return {
    /**
     * Records the readable entries of `commit`'s tree (from readCommitObjects) that no earlier call recorded; the first commit
     * to hold an occurrence is where it is located. Throws GateInputError past maxHistoryOccurrences or maxTotalBlobBytes.
     */
    addTree(commit, entries) {
      for (const entry of entries.filter(({ bytes }) => bytes)) {
        const key = [entry.pathBytes.toString('hex'), entry.mode, entry.oid].join(':');
        if (occurrences.has(key)) continue;
        if (occurrences.size >= limits.maxHistoryOccurrences) throw new GateInputError('limit:maxHistoryOccurrences', `the history holds more than ${limits.maxHistoryOccurrences} distinct occurrences`);
        const position = nextPosition++;
        occurrences.set(key, { ...entry, position, bytes: sharedBlob(entry) });
        sources.set(position, { commit, listed: entry.position });
      }
    },

    /** Records a raw commit or tag object `{ sha, raw }`; `people` are the header kinds that name a person in it. */
    addObject({ sha, raw }, people) {
      const position = nextPosition++;
      const bytes = Buffer.from(raw);
      objects.push({ position, path: OBJECT_PATH, oid: sha, bytes });
      sources.set(position, { commit: sha, raw: bytes, people });
    },

    /** Every entry the scanner reads, for scanSecrets. */
    scanEntries: () => [...occurrences.values(), ...objects],

    /** The tree occurrences alone, in the order they were first seen. */
    treeOccurrences: () => [...occurrences.values()],

    /** Turns a scanSecrets finding into a history finding: a tree one at its first commit and that tree's position, an object one at its field. */
    locate({ rule, entry, line }) {
      const { commit, listed, raw, people } = sources.get(entry.position);
      if (!raw) return { rule, kind: 'content', commit, entry: { position: listed }, ...(line === undefined ? {} : { line }) };
      const { kind, field, line: fieldLine } = fieldAt(raw, line, people);
      return { rule, kind, commit, field, ...(fieldLine === undefined ? {} : { line: fieldLine }) };
    },
  };
}
