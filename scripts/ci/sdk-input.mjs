import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChoiceError, parseChoice, parseFlags } from '../lib/choice.mjs';
import { GateInputError } from '../public-gate/objects.mjs';
import { writeDiagnostic, writeRecord } from '../public-gate/redact.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const INVENTORY_FILE = path.join(SCRIPT_DIRECTORY, 'dependency-roots.json');
const PREPARATIONS = ['root', 'http-mcp', 'stdio', 'buyer'];
const FLAGS = ['--prepare', '--candidate-dir', '--repo'];
const EXIT = { available: 0, refused: 1, unavailable: 2 };
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const SDK_SCOPE = '@kynesyslabs/';
const REGISTRY = 'https://registry.npmjs.org';
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SDK_PATH_KEY = /(?:^|\/)node_modules\/(@kynesyslabs\/[^/]+)$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ARCHIVE_NAME = /\.(?:tgz|tar|tar\.gz)$/i;
const DIRECT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const CONSTRAINT_SECTIONS = [...DIRECT_SECTIONS, 'peerDependencies'];
/** The one local-path SDK input F records, kept until P41a publishes the candidate archive. */
const LEGACY_ENTRY = Object.freeze({ root: 'http-mcp', name: '@kynesyslabs/dacs', spec: 'file:vendor/kynesyslabs-dacs-0.1.0-alpha.0.tgz' });
/** Root states, worst first; a root reports the worst state among its findings. */
const STATE_RANK = ['refused', 'unverifiable', 'legacy-unavailable', 'candidate', 'published', 'none'];

const refused = (cause) => ({ state: 'refused', cause });
const unverifiable = (cause) => ({ state: 'unverifiable', cause });
const LOCAL_SPEC = refused('local-path-spec');
const ALIAS_SPEC = refused('alias-spec');
const LOCAL_RESOLUTION = refused('lock-local-resolution');
const IDENTITY_MISMATCH = refused('lock-identity-mismatch');
const COMMITTED_ARCHIVE = refused('committed-archive');
const UNCLASSIFIABLE = unverifiable('unclassifiable-spec');
const LEGACY = { state: 'legacy-unavailable', cause: 'recorded-legacy-file-vendor' };

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLocalSpec = (spec) => (URL_SCHEME.test(spec) && !spec.startsWith('npm:')) || spec.includes('/') || spec.startsWith('.');
const registryTarball = (name, version) => `${REGISTRY}/${name}/-/${name.split('/')[1]}-${version}.tgz`;
const candidateArchiveName = ({ name, version }) => `${name.slice(1).replace('/', '-')}-${version}.tgz`;
const isRecordedLegacy = (rootPath, name, spec) => rootPath === LEGACY_ENTRY.root && name === LEGACY_ENTRY.name && spec === LEGACY_ENTRY.spec;

/** Reads a regular JSON object of at most MAX_JSON_BYTES. Throws GateInputError(`<kind>-unreadable`, `<kind>-malformed` or file-too-large). */
async function readJsonObject(file, kind) {
  const found = await lstat(file).catch(() => null);
  if (!found?.isFile()) throw new GateInputError(`${kind}-unreadable`, `${kind} is not a readable regular file`);
  if (found.size > MAX_JSON_BYTES) throw new GateInputError('file-too-large', `${kind} is over ${MAX_JSON_BYTES} bytes`);
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (isPlainObject(value)) return value;
  } catch { /* falls through to the malformed error */ }
  throw new GateInputError(`${kind}-malformed`, `${kind} is not a JSON object`);
}

/** Reads and validates the inventory. Throws GateInputError(inventory-malformed) when it is not `{ roots: [{ path, reason, prepare, optional? }] }`. */
async function readInventory() {
  const inventory = await readJsonObject(INVENTORY_FILE, 'inventory').catch(() => ({}));
  const valid = Array.isArray(inventory.roots) && inventory.roots.length > 0 && inventory.roots.every((entry) => isPlainObject(entry)
    && typeof entry.path === 'string' && typeof entry.reason === 'string' && Array.isArray(entry.prepare) && entry.prepare.every((name) => PREPARATIONS.includes(name)));
  if (!valid) throw new GateInputError('inventory-malformed', 'dependency-roots.json is malformed');
  return inventory.roots;
}

function sdkEntries(table, kind) {
  if (table === undefined) return [];
  if (!isPlainObject(table)) throw new GateInputError(`${kind}-malformed`, `${kind} holds a dependency table that is not an object`);
  return Object.entries(table).filter(([name]) => name.startsWith(SDK_SCOPE));
}

/** A version or range written as a constraint (a peer range, or a lock's own dependency table): a registry range passes, anything pointing elsewhere is refused. */
function classifyConstraint(spec) {
  if (typeof spec !== 'string') return UNCLASSIFIABLE;
  if (spec.startsWith('npm:')) return ALIAS_SPEC;
  return isLocalSpec(spec) ? LOCAL_SPEC : null;
}

function classifyDirectSpec(rootPath, name, spec) {
  const constraint = classifyConstraint(spec);
  if (constraint) return isRecordedLegacy(rootPath, name, spec) ? { ...LEGACY, name } : constraint;
  return EXACT_VERSION.test(spec) ? { state: 'published', cause: 'registry-exact-version-with-integrity', name } : UNCLASSIFIABLE;
}

function classifyManifest(rootPath, manifest) {
  const direct = DIRECT_SECTIONS.flatMap((section) => sdkEntries(manifest[section], 'manifest').map(([name, spec]) => classifyDirectSpec(rootPath, name, spec)));
  const constraints = ['peerDependencies', 'overrides'].flatMap((section) => sdkEntries(manifest[section], 'manifest').map(([, spec]) => classifyConstraint(spec)));
  return [...direct, ...constraints].filter(Boolean);
}

function classifyRegistryRecord(name, { version, resolved, integrity }) {
  if (typeof resolved !== 'string' || typeof version !== 'string' || !EXACT_VERSION.test(version)) return unverifiable('lock-record-incomplete');
  if (!resolved.startsWith(`${REGISTRY}/`)) return LOCAL_RESOLUTION;
  if (resolved !== registryTarball(name, version)) return IDENTITY_MISMATCH;
  if (typeof integrity !== 'string' || !SHA512_INTEGRITY.test(integrity)) return unverifiable('lock-integrity-missing');
  return { state: 'published', cause: 'registry-exact-version-with-integrity', record: { name, version, integrity } };
}

/** Classifies a lock record that is an SDK package by its path key or claims to be one by its name. */
function classifySdkRecord(rootPath, key, record) {
  const keyName = SDK_PATH_KEY.exec(key)?.[1];
  const claimsSdk = keyName !== undefined || (typeof record.name === 'string' && record.name.startsWith(SDK_SCOPE));
  if (!claimsSdk) return null;
  if (keyName === undefined || (record.name !== undefined && record.name !== keyName)) return IDENTITY_MISMATCH;
  if (record.link === true) return LOCAL_RESOLUTION;
  return isRecordedLegacy(rootPath, keyName, record.resolved) ? LEGACY : classifyRegistryRecord(keyName, record);
}

function classifyLock(rootPath, lock) {
  if (!isPlainObject(lock.packages)) throw new GateInputError('lock-malformed', 'lock has no packages table');
  return Object.entries(lock.packages).flatMap(([key, record]) => {
    if (!isPlainObject(record)) throw new GateInputError('lock-malformed', 'lock holds a record that is not an object');
    const constraints = CONSTRAINT_SECTIONS.flatMap((section) => sdkEntries(record[section], 'lock')
      .map(([name, spec]) => (key === '' && isRecordedLegacy(rootPath, name, spec) ? LEGACY : classifyConstraint(spec))));
    return [...constraints, key === '' ? null : classifySdkRecord(rootPath, key, record)];
  }).filter(Boolean);
}

/** A committed SDK archive: any archive file at the root's top level or in its `vendor` folder. */
async function findCommittedArchive(dir) {
  for (const folder of [dir, path.join(dir, 'vendor')]) {
    const names = await readdir(folder).catch(() => []);
    if (names.length > MAX_DIRECTORY_ENTRIES) throw new GateInputError('file-too-large', 'a root folder holds too many entries');
    if (names.some((name) => ARCHIVE_NAME.test(name))) return [COMMITTED_ARCHIVE];
  }
  return [];
}

const worstOf = (findings) => STATE_RANK.map((state) => findings.find((finding) => finding.state === state)).find(Boolean) ?? { state: 'none', cause: 'no-sdk-input' };

/** Applies the policy to one root without any installation. Returns { root, state, cause, records }: the worst finding plus the lock's registry records. */
async function checkRootPolicy(repo, { path: rootPath, optional }) {
  const dir = path.join(repo, rootPath);
  const present = await lstat(dir).then((found) => found.isDirectory(), () => false);
  if (!present) return { root: rootPath, ...(optional ? { state: 'absent', cause: 'optional-root-absent' } : unverifiable('root-absent')), records: [] };
  const findings = await findCommittedArchive(dir).catch((error) => [unverifiable(error.cause)]);
  try {
    const manifestFindings = classifyManifest(rootPath, await readJsonObject(path.join(dir, 'package.json'), 'manifest'));
    const lock = await readJsonObject(path.join(dir, 'package-lock.json'), 'lock');
    const missing = manifestFindings.some(({ name }) => name !== undefined && !isPlainObject(lock.packages?.[`node_modules/${name}`]));
    findings.push(...manifestFindings, ...classifyLock(rootPath, lock), ...(missing ? [unverifiable('lock-record-missing')] : []));
  } catch (error) {
    if (!(error instanceof GateInputError)) throw error;
    findings.push(unverifiable(error.cause));
  }
  const { state, cause } = worstOf(findings);
  return { root: rootPath, state, cause, records: findings.flatMap(({ record }) => (record ? [record] : [])) };
}

async function sha512Integrity(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file, { end: MAX_ARCHIVE_BYTES })) hash.update(chunk);
  return `sha512-${hash.digest('base64')}`;
}

/** Returns the finding for a root's registry records against the archives in `candidateDir`: each archive must exist and match its lock sha512. */
async function checkCandidateArchives(candidateDir, records) {
  for (const record of records) {
    const file = path.join(candidateDir, candidateArchiveName(record));
    const found = await lstat(file).catch(() => null);
    if (!found?.isFile()) return unverifiable('candidate-archive-missing');
    if (await sha512Integrity(file) !== record.integrity) return unverifiable('candidate-archive-sha512-mismatch');
  }
  return { state: 'candidate', cause: 'candidate-archive-sha512-match' };
}

/**
 * Checks every inventoried root in the checkout `repo` (default: this repository) and then whether the roots the preparation
 * `prepare` needs are available; with `candidateDir`, a needed root's registry records must match archives in it by sha512.
 * Read-only. Returns { exitCode, report }: 1 when any root is refused, 2 when any is unverifiable or a needed root is unavailable, else 0.
 * Throws GateInputError(inventory-malformed).
 */
export async function checkSdkInput({ prepare, candidateDir, repo = DEFAULT_REPO }) {
  const inventory = await readInventory();
  const roots = await Promise.all(inventory.map(async (entry) => {
    const result = await checkRootPolicy(repo, entry);
    const needed = entry.prepare.includes(prepare);
    const upgraded = needed && candidateDir && result.state === 'published' ? await checkCandidateArchives(candidateDir, result.records) : result;
    return { root: result.root, state: upgraded.state, cause: upgraded.cause, needed };
  }));
  const states = new Set(roots.map(({ state }) => state));
  const unavailable = roots.some(({ needed, state }) => needed && state === 'legacy-unavailable');
  const exitCode = states.has('refused') ? EXIT.refused : states.has('unverifiable') || unavailable ? EXIT.unavailable : EXIT.available;
  return { exitCode, report: { prepare, available: exitCode === EXIT.available, roots: roots.map(({ root, state, cause }) => ({ root, state, cause })) } };
}

/** Parses the command line, prints the per-root report on stdout and returns the exit code; a refused command line prints one cause on stderr and returns 2. */
async function main(argv) {
  try {
    const flags = parseFlags(argv, FLAGS);
    const prepare = parseChoice('--prepare', flags['--prepare'], PREPARATIONS);
    const { exitCode, report } = await checkSdkInput({ prepare, candidateDir: flags['--candidate-dir'], repo: flags['--repo'] });
    await writeRecord(`${JSON.stringify(report, null, 2)}\n`, 'sdk-input.stdout');
    if (exitCode !== EXIT.available) await writeDiagnostic(exitCode === EXIT.refused ? 'sdk-input-refused' : 'sdk-input-unavailable', 'sdk-input.stderr');
    return exitCode;
  } catch (error) {
    const known = error instanceof ChoiceError || error instanceof GateInputError;
    await writeDiagnostic(known ? error.cause : 'internal-error', 'sdk-input.stderr');
    return EXIT.unavailable;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
