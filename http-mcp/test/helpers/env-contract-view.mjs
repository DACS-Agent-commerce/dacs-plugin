// The env contract as the tests see it (deploy/env-contract.json plus the
// switch files in src/switches/) and the env names the runtime reads. Tests
// assert these instead of a committed digest of src/config.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SWITCH_DIR, SWITCH_SUFFIX, SwitchFileError, readSwitchFiles, switchContractEntry } from '../../src/switch-files.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// src/config.mjs reads an env name only as env.NAME or env['NAME']; the switch files' names come from the parser.
const ENV_READ = /\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*'([A-Z][A-Z0-9_]*)'\s*\])/g;

/** The switch files of the package rooted at dir: `{ entries, errors }`, entries keyed by env name. Never throws. */
export function readSwitchRegistry(dir) {
  const { switches, errors } = readSwitchFiles(join(dir, SWITCH_DIR));
  return { entries: Object.fromEntries(switches.map((s) => [s.env, s])), errors };
}

/** The contract with one entry per switch file added. Throws the first switch file error, or one for a switch named like a static entry. */
export function envContract(contract, dir) {
  const { entries, errors } = readSwitchRegistry(dir);
  if (errors.length) throw errors[0];
  const shadow = Object.keys(entries).find((env) => Object.hasOwn(contract.variables, env));
  if (shadow) throw new SwitchFileError(`${shadow}${SWITCH_SUFFIX}`, `${shadow} is also a static env-contract.json entry; a switch cannot replace it`);
  const switches = Object.fromEntries(Object.entries(entries).map(([env, s]) => [env, switchContractEntry(s)]));
  return { ...contract, variables: { ...contract.variables, ...switches } };
}

/** The env names a config source reads, sorted. */
export function envNamesFromSource(source) {
  return [...new Set([...source.matchAll(ENV_READ)].map((match) => match[1] ?? match[2]))].sort();
}

/** The contract of this package; reads deploy/env-contract.json, which only a source checkout with `deploy/` has. */
export function contractView() {
  return envContract(JSON.parse(readFileSync(new URL('../../deploy/env-contract.json', import.meta.url), 'utf8')), root);
}

/** The sorted env names the runtime reads: those in src/config.mjs and the switches'. */
export function runtimeNames() {
  const switches = Object.keys(readSwitchRegistry(root).entries);
  return [...new Set([...envNamesFromSource(readFileSync(new URL('../../src/config.mjs', import.meta.url), 'utf8')), ...switches])].sort();
}
