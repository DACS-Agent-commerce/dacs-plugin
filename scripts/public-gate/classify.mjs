import { createHash } from 'node:crypto';
import path from 'node:path';
import { decodeUtf8Strict } from './objects.mjs';

/**
 * Decides how a blob is scanned. `config` holds `textExtensions` and `binaryDispositions` ({ path, sha256, reason }).
 * Returns { binary: false } for valid UTF-8 text, { binary: true } for a binary blob with a reviewed disposition for
 * this exact path and content, or { problem } when the blob is unscannable: a code, config or doc file with a NUL byte
 * or invalid UTF-8 ('nul-or-invalid-utf8-text'), or any other binary blob without a disposition
 * ('binary-without-disposition'). Classification only chooses how the bytes are read; no check is skipped.
 */
export function classifyBlob(filePath, bytes, config) {
  if (!bytes.includes(0) && decodeUtf8Strict(bytes) !== null) return { binary: false };
  if (config.textExtensions.includes(path.posix.extname(filePath).toLowerCase())) return { problem: 'nul-or-invalid-utf8-text' };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const reviewed = config.binaryDispositions.some((entry) => entry.path === filePath && entry.sha256 === digest);
  return reviewed ? { binary: true } : { problem: 'binary-without-disposition' };
}
