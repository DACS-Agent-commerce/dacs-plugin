// The stop file. An operator creates <dataDir>/KILL to stop new purchase
// effects. The synchronous check below is the Agreement CREATE delivery
// gate's stop, in the form the client's required `stopped` seam takes.
//
// The check makes two lstat calls: the state directory must be a real
// directory (not a symlink), and only ENOENT on KILL means "absent". Anything
// at that path, a symlink in either place, or any failure to look means
// "present", with its cause logged. lstat never follows a link, so a broken or
// looping symlink named KILL still stops writes.
import { lstatSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from './config.mjs';

const STOP_FILE_NAME = 'KILL';
const PRIVATE_DIRECTORY_MODE = 0o700;

function directoryProblem(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  return stats.isDirectory() ? null : 'not_a_directory';
}

// Each lstat result is { stats } or { error }. Why the state directory stops writes, or null when it is a real directory.
const directoryCause = ({ stats, error }) => (error ? error.code ?? 'lstat_failed' : directoryProblem(stats));
// Why KILL stops writes, or null when it is absent (ENOENT, and only ENOENT).
const stopFileCause = ({ error }) => (error ? (error.code === 'ENOENT' ? null : error.code ?? 'lstat_failed') : 'present');
const lookAsync = (path) => lstat(path).then((stats) => ({ stats }), (error) => ({ error }));
function lookSync(path) {
  try {
    return { stats: lstatSync(path) };
  } catch (error) {
    return { error };
  }
}

// The answer for one check: false when nothing stops writes, else true with the stopping path and cause logged.
function stopAnswer(logger, path, cause) {
  if (cause === null) return false;
  logger.warn('stop_file_stopped', { path, cause });
  return true;
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
  return async function isStopped() {
    const cause = directoryCause(await lookAsync(dataDir));
    if (cause !== null) return stopAnswer(logger, dataDir, cause);
    return stopAnswer(logger, stopFile, stopFileCause(await lookAsync(stopFile)));
  };
}

/**
 * Creates the synchronous form of the stop check for `dataDir`, for the
 * client's `stopped` seam and the Agreement CREATE delivery gate, which call
 * it without awaiting. Each call reads both paths again and returns a boolean:
 * the same answer, logged cause and classification as createStopFileCheck. It
 * never throws.
 */
export function createStopFileCheckSync({ dataDir, logger }) {
  const stopFile = join(dataDir, STOP_FILE_NAME);
  return function isStopped() {
    const cause = directoryCause(lookSync(dataDir));
    if (cause !== null) return stopAnswer(logger, dataDir, cause);
    return stopAnswer(logger, stopFile, stopFileCause(lookSync(stopFile)));
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
