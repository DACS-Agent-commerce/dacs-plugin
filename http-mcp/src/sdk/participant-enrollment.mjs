// The operator's participant enrollment file: <dataDir>/participant-enrollment.json.
//
// It lists the seller implementations the operator has approved, in the entry
// shape the client's authority reader reads from `participantImplementations`:
// `{claim, profile, modules, evidence, revoked}`. The file is read once, when
// the source is loaded at startup; nothing reloads or writes it, so an edit or
// a revocation takes effect at the next restart. See docs/PARTICIPANT-ENROLLMENT.md.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { admitWireJson, isTp1WireProfile, TESTNET_PROFILE_TP1, WireError } from '@kynesyslabs/dacs/wire';

const ENROLLMENT_FILE_NAME = 'participant-enrollment.json';
const ENROLLMENT_FORMAT = 'dacs-participant-enrollment/v1';
const MAX_ENROLLMENT_FILE_BYTES = 1024 * 1024;
const MAX_ENROLLMENT_ENTRIES = 1024;
const MAX_EVIDENCE_CHARACTERS = 1024;
// The status the SDK's wire gives a refusal caused by this host's own configuration.
const HOST_CONFIGURATION_STATUS = 500;
const INVALID = 'tp1_enrollment_invalid';
const UNREADABLE = 'tp1_enrollment_unreadable';

const DOCUMENT_KEYS = Object.freeze(['format', 'entries']);
const ENTRY_KEYS = Object.freeze(['claim', 'profile', 'modules', 'evidence', 'revoked']);
const MODULE_KEYS = Object.freeze(Object.keys(TESTNET_PROFILE_TP1.tuple));
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
// The file never opens through a symlink and never blocks on a FIFO.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const invalid = (detail) => new WireError(INVALID, HOST_CONFIGURATION_STATUS, detail);

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const isModules = (modules) => hasExactKeys(modules, MODULE_KEYS)
  && MODULE_KEYS.every((key) => typeof modules[key] === 'string' && modules[key] !== '');

const isEvidence = (evidence) => typeof evidence === 'string' && evidence !== '' && evidence.length <= MAX_EVIDENCE_CHARACTERS;

function checkEntry(entry) {
  if (!hasExactKeys(entry, ENTRY_KEYS)) throw invalid('entry_fields');
  if (typeof entry.claim !== 'string' || !CLAIM.test(entry.claim)) throw invalid('entry_claim');
  if (!isTp1WireProfile(entry.profile)) throw invalid('entry_profile');
  if (!isModules(entry.modules)) throw invalid('entry_modules');
  if (!isEvidence(entry.evidence)) throw invalid('entry_evidence');
  if (typeof entry.revoked !== 'boolean') throw invalid('entry_revoked');
}

// The admitted document's entries by claim. Every entry is checked before any is kept, so a file with one
// bad entry gives no source at all.
function entriesByClaim(document) {
  if (!hasExactKeys(document, DOCUMENT_KEYS)) throw invalid('document_fields');
  if (document.format !== ENROLLMENT_FORMAT) throw invalid('format');
  if (!Array.isArray(document.entries)) throw invalid('entries');
  if (document.entries.length > MAX_ENROLLMENT_ENTRIES) throw invalid('too_many_entries');
  const byClaim = new Map();
  for (const entry of document.entries) {
    checkEntry(entry);
    if (byClaim.has(entry.claim)) throw invalid('duplicate_claim');
    byClaim.set(entry.claim, entry);
  }
  return byClaim;
}

// Up to one byte past the limit, so the admission below refuses a longer file without reading the rest of it.
async function readBounded(handle) {
  const buffer = Buffer.alloc(MAX_ENROLLMENT_FILE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

// The file's bytes, or null when no file is there.
async function readEnrollmentFile(path) {
  let handle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new WireError(UNREADABLE, HOST_CONFIGURATION_STATUS, error.code ?? 'open_failed', error);
  }
  try {
    if (!(await handle.stat()).isFile()) throw new WireError(UNREADABLE, HOST_CONFIGURATION_STATUS, 'not_a_regular_file');
    return await readBounded(handle);
  } catch (error) {
    if (error instanceof WireError) throw error;
    throw new WireError(UNREADABLE, HOST_CONFIGURATION_STATUS, error.code ?? 'read_failed', error);
  } finally {
    await handle.close();
  }
}

/**
 * Loads the participant enrollment source from `<dataDir>/participant-enrollment.json`, once.
 *
 * Returns a frozen `{ entriesFor(claim) }`: for an enrolled claim, a new array holding its one entry
 * `{claim, profile, modules, evidence, revoked}` (deep-frozen, a revoked entry included, as the client's
 * authority reader refuses it itself); for any other value, an empty array. The answers never change
 * after loading. With no file at that path, every claim answers an empty array.
 *
 * Rejects with the SDK's WireError (status 500): `tp1_enrollment_unreadable` when the file cannot be
 * opened or read, is a symlink or is not a regular file (detail: the error code, original error as
 * `cause`); `tp1_enrollment_invalid` when it is over 1 MiB, is not one JSON document (as the wire admits
 * JSON: no byte order mark, no member written twice), or breaks the closed format: unknown or missing
 * fields at any level, another format version, more than 1024 entries or a claim listed twice.
 */
export async function loadParticipantEnrollment({ dataDir }) {
  const bytes = await readEnrollmentFile(join(dataDir, ENROLLMENT_FILE_NAME));
  const byClaim = bytes === null ? new Map() : entriesByClaim(admitWireJson(bytes, MAX_ENROLLMENT_FILE_BYTES, INVALID, HOST_CONFIGURATION_STATUS));
  return Object.freeze({
    entriesFor(claim) {
      const entry = byClaim.get(claim);
      return entry === undefined ? [] : [entry];
    },
  });
}
