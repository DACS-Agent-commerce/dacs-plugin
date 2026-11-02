import { writeFileSync } from 'node:fs';
import { GateInputError } from './objects.mjs';

/** Longest value any emitted field or diagnostic line may have, marker included. */
export const MAX_FIELD_CHARS = 4096;

const TRUNCATION_MARKER = '…[truncated]';

/**
 * Every diagnostic route. All output leaves through the emitter on one of these: a `report` route takes an object that
 * is checked field by field, a `text` route takes a message that is scrubbed and bounded. Later checkers register theirs.
 */
export const DIAGNOSTIC_ROUTES = Object.freeze({
  'gate.stdout': { sink: 'stdout', form: 'report' },
  'gate.report-file': { sink: 'file', form: 'report' },
  'gate.stderr': { sink: 'stderr', form: 'text' },
});

/** Returns `text` when it fits the field limit, else its start followed by a truncation marker. */
function limitField(text) {
  return text.length <= MAX_FIELD_CHARS ? text : `${text.slice(0, MAX_FIELD_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function* stringsIn(value) {
  if (typeof value === 'string') yield value;
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) yield* [key, ...stringsIn(item)];
}

function writeOnce(file, text, subject) {
  try {
    writeFileSync(file, text, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new GateInputError(`${subject}-exists`, `the ${subject} file already exists`);
    throw new GateInputError(`${subject}-unwritable`, `the ${subject} file cannot be written (${error.code ?? error.name})`);
  }
}

/**
 * Creates the one writer for diagnostics; `matcher` is the private-list matcher (null in generic scope).
 * - `locate(entry)`: the exact path when harmless (bounded to the field limit), `<commit>:entry-<n>` when it holds list
 *   entry n, `<commit>:invalid-path-<position>` when the name is not valid UTF-8.
 * - `report(route, object, file)`: throws GateInputError(private-value-in-output) when any string holds a list entry,
 *   else writes JSON to stdout or, for `gate.report-file`, to a new file.
 * - `text(route, message)`: writes one scrubbed line within the field limit.
 * - `writePrivateMapping(file)`: the only output holding exact paths; written to a new file.
 */
export function createEmitter({ commit, matcher }) {
  const mapping = new Map();
  const remember = (id, exact) => mapping.set(id, [...(mapping.get(id) ?? []), exact]);
  const deliver = (route, form, text, file) => {
    const { sink, form: declared } = DIAGNOSTIC_ROUTES[route] ?? {};
    if (declared !== form) throw new Error(`${route} is not a registered ${form} route`);
    if (sink === 'file') writeOnce(file, text, 'output');
    else process[sink].write(text);
  };
  return {
    locate(entry) {
      const number = entry.path === null ? 0 : matcher?.firstEntryIn(entry.path) ?? 0;
      if (entry.path !== null && number === 0) return limitField(entry.path);
      const id = `${commit}:${entry.path === null ? `invalid-path-${entry.position}` : `entry-${number}`}`;
      remember(id, entry.path ?? `hex:${entry.pathBytes.toString('hex')}`);
      return id;
    },
    report(route, object, file) {
      if (matcher && [...stringsIn(object)].some((text) => matcher.firstEntryIn(text) > 0)) {
        throw new GateInputError('private-value-in-output', 'a report field holds a private-list entry; nothing was written');
      }
      deliver(route, 'report', `${JSON.stringify(object, null, 2)}\n`, file);
    },
    text: (route, message) => deliver(route, 'text', `${limitField(matcher ? matcher.scrub(message) : message)}\n`),
    writePrivateMapping(file) {
      const sorted = [...mapping].sort(([first], [second]) => (first < second ? -1 : 1));
      writeOnce(file, `${JSON.stringify(Object.fromEntries(sorted.map(([id, paths]) => [id, [...new Set(paths)].sort()])), null, 2)}\n`, 'evidence');
    },
  };
}
