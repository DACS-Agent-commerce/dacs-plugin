import { realpathSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChoiceError, parseFlags } from '../lib/choice.mjs';
import { fetchBounded } from '../lib/fetch-bounded.mjs';
import { runBounded } from '../lib/run-bounded.mjs';
import { GateInputError } from '../public-gate/objects.mjs';
import { writeDiagnostic } from '../public-gate/redact.mjs';

/** The gitleaks release the SDK's secret scan uses: its version and the SHA-256 of its linux x64 archive. */
export const GITLEAKS_PIN = Object.freeze({
  version: '8.30.1',
  platform: 'linux',
  arch: 'x64',
  archiveUrl: 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
  archiveSha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
});

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_DEADLINE_MS = 120_000;
/** Waits before the second and third download attempts, after an HTTP 429 or 5xx or a dropped connection; all inside the deadline. */
export const DOWNLOAD_RETRY_DELAYS_MS = Object.freeze([2_000, 6_000]);
const SUBPROCESS_DEADLINE_MS = 30_000;
const SUBPROCESS_OUTPUT_BYTES = 64 * 1024;
const BINARY_NAME = 'gitleaks';
const WORK_DIRECTORY_PREFIX = '.gitleaks-install-';
const FLAGS = ['--dir'];
const EXIT = { installed: 0, failed: 2 };

const subprocessLimits = { maxOutputBytes: SUBPROCESS_OUTPUT_BYTES, deadlineMs: SUBPROCESS_DEADLINE_MS };
const subprocessEnvironment = () => ({ PATH: process.env.PATH, LC_ALL: 'C' });

async function extractBinary({ archive, into, signal }) {
  const result = await runBounded({
    command: 'tar', args: ['-xzf', archive, '-C', into, '--no-same-owner', BINARY_NAME], env: subprocessEnvironment(), signal, ...subprocessLimits,
  });
  if (result.status !== 0) throw new GateInputError('install-extract-failed', `tar exited ${result.status ?? result.signal}`);
  const binary = path.join(into, BINARY_NAME);
  const found = await lstat(binary).catch(() => null);
  if (!found?.isFile()) throw new GateInputError('install-binary-invalid', 'the archive does not hold gitleaks as a regular file');
  return binary;
}

async function requireVersion({ binary, version, signal }) {
  const result = await runBounded({ command: binary, args: ['version'], env: subprocessEnvironment(), signal, ...subprocessLimits });
  if (result.status !== 0 || result.stdout.toString().trim() !== version) {
    throw new GateInputError('install-version-mismatch', `the binary does not report version ${version}`);
  }
}

/**
 * Downloads the pinned gitleaks archive, extracts only its `gitleaks` file, checks that it reports the pinned version and
 * links it as `<directory>/gitleaks`. The archive is extracted only after its SHA-256 matched; the work folder inside
 * `directory` is removed on every exit, and an existing `<directory>/gitleaks` is never replaced or trusted. A transient download
 * failure is tried again after each of `retryDelaysMs` (fetchBounded decides which failures and keeps the one deadline).
 * Returns the path of the installed binary. Throws GateInputError (or RunBoundedError) with a cause from fetchBounded or
 * runBounded, or unsupported-platform, install-exists, install-dir-unwritable, install-extract-failed, install-binary-invalid
 * or install-version-mismatch.
 */
export async function installGitleaks({ directory, pin = GITLEAKS_PIN, retryDelaysMs = DOWNLOAD_RETRY_DELAYS_MS, transport, signal }) {
  if (process.platform !== pin.platform || process.arch !== pin.arch) {
    throw new GateInputError('unsupported-platform', `the pinned gitleaks archive is for ${pin.platform} ${pin.arch}`);
  }
  const target = path.join(directory, BINARY_NAME);
  const work = await mkdir(directory, { recursive: true }).then(() => mkdtemp(path.join(directory, WORK_DIRECTORY_PREFIX)))
    .catch((error) => { throw new GateInputError('install-dir-unwritable', `${directory} cannot be prepared (${error.code ?? error.name})`); });
  try {
    const archive = path.join(work, 'archive.tar.gz');
    await fetchBounded({
      url: pin.archiveUrl, destination: archive, sha256: pin.archiveSha256, maxBytes: MAX_ARCHIVE_BYTES, deadlineMs: DOWNLOAD_DEADLINE_MS, retryDelaysMs, transport, signal,
    });
    const binary = await extractBinary({ archive, into: work, signal });
    await requireVersion({ binary, version: pin.version, signal });
    await link(binary, target).catch((error) => {
      throw new GateInputError(error.code === 'EEXIST' ? 'install-exists' : 'install-dir-unwritable', `${target} cannot be created (${error.code ?? error.name})`);
    });
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Parses `--dir <folder>` and installs gitleaks there; returns the exit code (0 installed, 2 refused) after writing one cause line to stderr on failure. */
async function main(argv, signal) {
  try {
    const flags = parseFlags(argv, FLAGS);
    if (!flags['--dir']) throw new ChoiceError('bad-arguments', '--dir is required');
    await installGitleaks({ directory: flags['--dir'], signal });
    return EXIT.installed;
  } catch (error) {
    const known = error instanceof ChoiceError || error instanceof GateInputError;
    await writeDiagnostic(known ? error.cause : 'internal-error', 'install-gitleaks.stderr');
    return EXIT.failed;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const interrupt = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => interrupt.abort());
  process.exitCode = await main(process.argv.slice(2), interrupt.signal);
}
