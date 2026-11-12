// Offline installs for the isolated package checks. SDK archives are pinned by sha512 in a candidate
// manifest and every other production archive by the frozen lockfile. A fresh npm cache is seeded
// through a loopback registry that serves only those archives and is closed before the install,
// which runs with --offline, so nothing can be fetched and no registry is a fallback.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

/** Names the archive directory: MANIFEST.json, the SDK archives and the locked closure's archives. It lives outside the repository. */
export const CANDIDATE_DIR_ENV = 'DACS_SDK_CANDIDATE_DIR';
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_NPM_OUTPUT_BYTES = 64 * 1024 * 1024;
const NPM_TIMEOUT_MS = 300_000;
const TAR_BLOCK_BYTES = 512;
const MODULES_PREFIX = 'node_modules/';

const sha512Integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const archiveFilename = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
const packageNameOf = (key, record) => record.name ?? key.slice(key.lastIndexOf(MODULES_PREFIX) + MODULES_PREFIX.length);
const isOmitted = (record) => record.dev || record.optional || record.devOptional;

/** The environment of an isolated npm run: scripts off, TLS on, two empty configs, cache in `work`/npm-cache; inherited npm_config_* values are dropped. */
export function isolatedNpmEnv(work) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const [userconfig, globalconfig] = ['npm-userconfig', 'npm-globalconfig'].map((name) => join(work, name));
  for (const file of [userconfig, globalconfig]) writeFileSync(file, '');
  return {
    ...env,
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(work, 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_strict_ssl: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
}

/** Reads MANIFEST.json from `archiveDir`: { archiveDir, sdk }, `sdk` mapping name to { version, filename, integrity }. Throws when the directory is inside `repoRoot` or the manifest is absent or malformed. */
export function readCandidate(archiveDir, repoRoot) {
  if (!archiveDir) throw new Error(`no archive directory: set ${CANDIDATE_DIR_ENV}`);
  const directory = realpathSync(archiveDir);
  const fromRepo = relative(realpathSync(repoRoot), directory);
  if (!(fromRepo === '..' || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo))) throw new Error(`the archive directory is inside the repository: ${directory}`);
  let archives;
  try {
    archives = JSON.parse(readFileSync(join(directory, 'MANIFEST.json'), 'utf8')).archives;
  } catch (error) {
    throw new Error(`the candidate manifest is unreadable: ${error.message}`, { cause: error });
  }
  const valid = Array.isArray(archives) && archives.length > 0 && archives.every((archive) => ['package', 'version', 'filename'].every((field) => typeof archive?.[field] === 'string')
    && basename(archive.filename) === archive.filename && SHA512_INTEGRITY.test(archive.integrity));
  if (!valid) throw new Error('the candidate manifest lists no archives or a malformed one');
  return { archiveDir: directory, sdk: new Map(archives.map(({ package: name, version, filename, integrity }) => [name, { version, filename, integrity }])) };
}

/**
 * The production closure of `lock` (records that are neither dev nor optional), keyed by name and version, as { name, version, filename, integrity }.
 * Throws on a record that is not a public-registry archive or has no sha512, an SDK record that differs from the manifest, or a manifest package the lock lacks.
 */
export function lockedClosure(lock, candidate) {
  const entries = new Map();
  for (const [key, record] of Object.entries(lock.packages ?? {})) {
    if (key === '' || isOmitted(record)) continue;
    const name = packageNameOf(key, record);
    const sdk = candidate.sdk.get(name);
    if (typeof record.resolved !== 'string' || !record.resolved.startsWith(PUBLIC_REGISTRY)) throw new Error(`${name} is not a public-registry archive in the lockfile`);
    if (!SHA512_INTEGRITY.test(record.integrity)) throw new Error(`${name} has no sha512 integrity in the lockfile`);
    if (sdk && (sdk.version !== record.version || sdk.integrity !== record.integrity)) throw new Error(`${name} in the lockfile differs from the candidate manifest`);
    entries.set(`${name}@${record.version}`, { name, version: record.version, filename: sdk?.filename ?? archiveFilename(name, record.version), integrity: record.integrity });
  }
  for (const [name, { version }] of candidate.sdk) {
    if (!entries.has(`${name}@${version}`)) throw new Error(`${name}@${version} from the candidate manifest is not in the lockfile`);
  }
  return entries;
}

function readArchive(archiveDir, entry) {
  const file = join(archiveDir, entry.filename);
  const found = statSync(file, { throwIfNoEntry: false });
  if (!found?.isFile()) throw new Error(`archive missing: ${entry.filename}`);
  if (found.size > MAX_ARCHIVE_BYTES) throw new Error(`archive too large: ${entry.filename}`);
  const bytes = readFileSync(file);
  if (sha512Integrity(bytes) !== entry.integrity) throw new Error(`archive sha512 differs from its pin: ${entry.filename}`);
  return bytes;
}

/** The package.json inside an npm archive. Throws when it is absent or names another package than `entry`. The registry's version string is the lock's, so an archive's own spelling of it (1.0.01 for 1.0.1) is not compared. */
function readPackageJson(archive, entry) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  for (let offset = 0; offset + TAR_BLOCK_BYTES <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, end) => header.toString('utf8', start, end).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (Number.isNaN(size)) throw new Error(`archive is malformed: ${entry.filename}`);
    const body = offset + TAR_BLOCK_BYTES;
    if (/^[^/]+\/package\.json$/.test(field(0, 100))) {
      const manifest = JSON.parse(tar.toString('utf8', body, body + size));
      if (manifest.name !== entry.name) throw new Error(`archive holds ${manifest.name}, not ${entry.name}: ${entry.filename}`);
      return manifest;
    }
    offset = body + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  throw new Error(`archive has no package.json: ${entry.filename}`);
}

/** Starts a loopback registry serving the version metadata and archive of each `served` item ({ entry, archive, packageJson }) and 404 for anything else. Resolves { url, requests, close }. */
export async function startClosureRegistry(served) {
  const requests = [];
  const archives = new Map(served.map(({ entry, archive }) => [entry.filename, archive]));
  const versionsByName = new Map();
  for (const { entry, packageJson } of served) versionsByName.set(entry.name, { ...versionsByName.get(entry.name), [entry.version]: { packageJson, entry } });
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const path = decodeURIComponent((request.url ?? '').split('?')[0]);
    const tarball = path.startsWith('/-/') ? archives.get(path.slice(3)) : undefined;
    const versions = tarball === undefined ? versionsByName.get(path.slice(1)) : undefined;
    if (request.method !== 'GET' || (!tarball && !versions)) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    } else if (tarball) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarball);
    } else {
      const base = `http://127.0.0.1:${server.address().port}`;
      const listed = Object.entries(versions).map(([version, { packageJson, entry }]) => [version, { ...packageJson, name: entry.name, version, dist: { integrity: entry.integrity, tarball: `${base}/-/${entry.filename}` } }]);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: path.slice(1), 'dist-tags': { latest: listed.at(-1)[0] }, versions: Object.fromEntries(listed) }));
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

async function runNpm(args, { cwd, env, signal }) {
  try {
    return (await execFileAsync('npm', args, { cwd, env, signal, timeout: NPM_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_NPM_OUTPUT_BYTES })).stdout;
  } catch (error) {
    throw new Error(`npm ${args[0]} failed: ${String(error.stderr || error.message).slice(0, 400)}`, { cause: error });
  }
}

/**
 * Verifies every archive of `lock`'s closure against its pin, seeds the fresh npm cache `env.npm_config_cache` from them through
 * a loopback registry, and closes the registry. Resolves { entries, env, registryUrl }. Throws, before any registry starts, when an
 * archive is missing, differs from its pin or lacks its package.json, or when the cache is not fresh.
 */
export async function seedOfflineCache({ archiveDir, lock, repoRoot, env }) {
  const candidate = readCandidate(archiveDir, repoRoot);
  const entries = lockedClosure(lock, candidate);
  const served = [...entries.values()].map((entry) => {
    const archive = readArchive(candidate.archiveDir, entry);
    return { entry, archive, packageJson: readPackageJson(archive, entry) };
  });
  if (existsSync(join(env.npm_config_cache, '_cacache'))) throw new Error('the npm cache is not fresh');
  mkdirSync(env.npm_config_cache, { recursive: true });
  const registry = await startClosureRegistry(served);
  try {
    await runNpm(['cache', 'add', ...entries.keys(), '--registry', registry.url], { env });
  } finally {
    await registry.close();
  }
  return { entries, env, registryUrl: registry.url };
}

/** Runs `npm <npmArgs>` in `cwd` in the seeded environment, offline, scripts off, no optional packages, against the closed registry. Rejects with npm's error. */
export const installOffline = ({ env, registryUrl }, npmArgs, { cwd, signal }) => runNpm(
  [...npmArgs, '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--registry', registryUrl], { cwd, env, signal });

/** Problems in the lockfile an install wrote: a package outside the closure or with another integrity than the manifest's (SDK) or the frozen lockfile's. `ownKey` is the package under test. */
export function lockProblems(seed, lockFile, ownKey) {
  const { packages = {} } = JSON.parse(readFileSync(lockFile, 'utf8'));
  return Object.entries(packages).filter(([key, record]) => key !== '' && key !== ownKey && !isOmitted(record)).flatMap(([key, record]) => {
    const name = packageNameOf(key, record);
    const expected = seed.entries.get(`${name}@${record.version}`);
    if (!expected) return [`${name}@${record.version} is not in the locked closure`];
    return record.integrity === expected.integrity ? [] : [`${name}@${record.version} has integrity ${record.integrity}, expected ${expected.integrity}`];
  });
}
