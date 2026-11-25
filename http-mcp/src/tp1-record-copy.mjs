// The startup check of the browser's TP-1 identity record copy
// (public/portal/tp1-identity-record.mjs) against the SDK's approved record.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_APPROVED_IDENTITY_RECORD_DIGESTS } from '@kynesyslabs/dacs/wire';
import { TP1_IDENTITY_RECORD, TP1_IDENTITY_RECORD_DIGEST } from '../public/portal/tp1-identity-record.mjs';

/** The browser record copy differs from the SDK's approved record; `code` is tp1_record_copy_drift. */
export class Tp1RecordCopyDrift extends Error {
  constructor(failures) {
    super(`tp1_record_copy_drift: the browser record copy ${failures.join('; ')}; refusing to start`);
    this.name = 'Tp1RecordCopyDrift';
    this.code = 'tp1_record_copy_drift';
  }
}

/**
 * Compares `copy` with the SDK's approved record by canonical JSON bytes,
 * checks that `digest` is the SHA-256 of those bytes, and that the SDK
 * approves `digest`. Returns nothing; throws Tp1RecordCopyDrift naming each
 * comparison that failed, never the record's values.
 */
export function assertTp1RecordCopy(copy = TP1_IDENTITY_RECORD, digest = TP1_IDENTITY_RECORD_DIGEST) {
  const bytes = canonicalize(copy);
  const failures = [];
  if (bytes !== canonicalize(TP1_APPROVED_IDENTITY_RECORD)) failures.push('differs from the SDK\'s approved record in its canonical bytes');
  if (sha256Hex(bytes) !== digest) failures.push('states a digest that is not the SHA-256 of its canonical bytes');
  if (!TP1_APPROVED_IDENTITY_RECORD_DIGESTS.includes(digest)) failures.push('states a digest the SDK has not approved');
  if (failures.length > 0) throw new Tp1RecordCopyDrift(failures);
}
