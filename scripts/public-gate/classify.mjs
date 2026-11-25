import { createHash } from 'node:crypto';
import path from 'node:path';
import { decodeUtf8Strict } from './objects.mjs';

/**
 * Decides how a blob is scanned. `config` holds `textExtensions` and `binaryDispositions` ({ path, sha256, reason }).
 * Returns { binary: false } for a blob with no NUL byte that is valid UTF-8, whatever its extension. A blob with a NUL
 * byte or invalid UTF-8 is unscannable ('nul-or-invalid-utf8-text') when its file's extension is listed in
 * `textExtensions`; any other such blob is binary: { binary: true } with a reviewed disposition for this exact path and
 * content, otherwise unscannable ('binary-without-disposition'). Classification only chooses how the bytes are read;
 * no check is skipped.
 */
export function classifyBlob(filePath, bytes, config) {
  if (!bytes.includes(0) && decodeUtf8Strict(bytes) !== null) return { binary: false };
  if (config.textExtensions.includes(path.posix.extname(filePath).toLowerCase())) return { problem: 'nul-or-invalid-utf8-text' };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const reviewed = config.binaryDispositions.some((entry) => entry.path === filePath && entry.sha256 === digest);
  return reviewed ? { binary: true } : { problem: 'binary-without-disposition' };
}
