// The stop file. An operator creates <dataDir>/KILL to stop new purchase
// effects; the check below fills the client's required `stopped` seam.
//
// The check makes two lstat calls: the state directory must be a real
// directory (not a symlink), and only ENOENT on KILL means "absent". Anything
// at that path, a symlink in either place, or any failure to look means
// "present", with its cause logged. lstat never follows a link, so a broken or
// looping symlink named KILL still stops writes.
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from './config.mjs';

const STOP_FILE_NAME = 'KILL';
const PRIVATE_DIRECTORY_MODE = 0o700;

function directoryProblem(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  return stats.isDirectory() ? null : 'not_a_directory';
}

/**
 * Creates the stop check for `dataDir`. The returned async function resolves
 * false only when `dataDir` is a real directory and lstat of `dataDir/KILL`
 * fails with ENOENT; in every other state it resolves true and logs
 * `stop_file_stopped` with the path and cause through `logger.warn`. It
 * never rejects.
 */
export function createStopFileCheck({ dataDir, logger }) {
  const stopFile = join(dataDir, STOP_FILE_NAME);
  const stopped = (path, cause) => {
    logger.warn('stop_file_stopped', { path, cause });
    return true;
  };
  return async function isStopped() {
    let directory;
    try {
      directory = await lstat(dataDir);
    } catch (error) {
      return stopped(dataDir, error.code ?? 'lstat_failed');
    }
    const problem = directoryProblem(directory);
    if (problem) return stopped(dataDir, problem);
    try {
      await lstat(stopFile);
    } catch (error) {
      return error.code === 'ENOENT' ? false : stopped(stopFile, error.code ?? 'lstat_failed');
    }
    return stopped(stopFile, 'present');
  };
}

/**
 * Creates `dataDir` (and missing parents) with mode 0700 when it is absent,
 * and leaves an existing real directory as it is. Throws ConfigError when the
 * path is a symlink or not a directory.
 */
export async function ensureStateDirectory(dataDir) {
  try {
    await mkdir(dataDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTDIR') throw error;
  }
  const problem = directoryProblem(await lstat(dataDir));
  if (problem) throw new ConfigError(`DACS_DATA_DIR must be a real directory (${problem}): ${dataDir}`);
}
