// Encrypted vault for the EXPERIMENTAL embedded wallet. Standard Web Crypto
// only, no custom cryptography: PBKDF2-SHA-256 derives an AES-GCM-256 key from
// the user's password, and AES-GCM encrypts the recovery phrase. The public
// header (format, KDF and cipher parameters, address, public key) is bound as
// additional authenticated data, so a swapped address or weakened KDF in a
// stored record or backup file makes decryption fail instead of succeeding.
// A vault record holds ciphertext and public fields only; it is both the
// stored form and the portable encrypted backup file.

export const VAULT_FORMAT = 'dacs-embedded-wallet-vault';
export const VAULT_VERSION = 1;
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;
// Bounds for records read back from storage or an imported backup file: a
// weak KDF is refused, and a hostile file cannot stall the page for minutes.
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MAX_CIPHERTEXT_CHARS = 8192;
const MAX_BACKUP_CHARS = 32_768;

const ADDRESS = /^0x[0-9a-f]{64}$/;
const PUBLIC_KEY = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new VaultError('crypto_unavailable', 'Web Crypto is not available here (a secure https or localhost page is required).');
  return s;
}

function toBase64(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text, field) {
  if (typeof text !== 'string' || text.length % 4 !== 0 || !BASE64.test(text)) throw new VaultError('invalid_backup', `vault field ${field} is not base64`);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// Passwords are Unicode-normalized so the same typed password derives the same
// key on every platform; they are never trimmed or otherwise altered.
const passwordBytes = (password) => new TextEncoder().encode(password.normalize('NFC'));

export function checkPassword(password, confirm) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_LENGTH) {
    throw new VaultError('weak_password', `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (confirm !== undefined && confirm !== password) throw new VaultError('password_mismatch', 'The two passwords do not match.');
}

function checkAccount(account) {
  if (!ADDRESS.test(account?.address ?? '') || !PUBLIC_KEY.test(account?.publicKey ?? '')) {
    throw new VaultError('invalid_account', 'wallet account must have a 0x+64-hex address and 64-hex public key');
  }
}

// Validates a record and returns a frozen copy holding ONLY the known public
// and ciphertext fields. Unknown keys are dropped, so nothing else (such as a
// plaintext field) can ride along into storage or a backup file.
export function assertVaultRecord(value) {
  const bad = (why) => new VaultError('invalid_backup', `not a valid encrypted wallet backup: ${why}`);
  if (!value || typeof value !== 'object') throw bad('not an object');
  if (value.format !== VAULT_FORMAT) throw bad('unknown format');
  if (value.version !== VAULT_VERSION) throw bad('unsupported version');
  checkAccount(value);
  const { kdf, cipher } = value;
  if (kdf?.name !== 'PBKDF2' || kdf?.hash !== 'SHA-256') throw bad('unsupported key derivation');
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < MIN_ITERATIONS || kdf.iterations > MAX_ITERATIONS) throw bad('key derivation iterations out of range');
  if (fromBase64(kdf.salt, 'kdf.salt').length !== SALT_BYTES) throw bad('salt length');
  if (cipher?.name !== 'AES-GCM') throw bad('unsupported cipher');
  if (fromBase64(cipher.iv, 'cipher.iv').length !== IV_BYTES) throw bad('iv length');
  if (typeof value.ciphertext !== 'string' || value.ciphertext.length > MAX_CIPHERTEXT_CHARS || fromBase64(value.ciphertext, 'ciphertext').length <= 16) throw bad('ciphertext');
  const createdAt = typeof value.createdAt === 'string' && value.createdAt.length <= 40 ? value.createdAt : null;
  return Object.freeze({
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    address: value.address,
    publicKey: value.publicKey,
    kdf: Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: kdf.salt }),
    cipher: Object.freeze({ name: 'AES-GCM', iv: cipher.iv }),
    ciphertext: value.ciphertext,
    createdAt,
  });
}

function additionalData(record) {
  const { format, version, address, publicKey, kdf, cipher } = record;
  return new TextEncoder().encode(JSON.stringify([format, version, address, publicKey, kdf.name, kdf.hash, kdf.iterations, kdf.salt, cipher.name, cipher.iv]));
}

async function deriveKey(password, salt, iterations) {
  const bytes = passwordBytes(password);
  try {
    const base = await subtle().importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    bytes.fill(0);
  }
}

// account is the public result of the SDK session's create/importMnemonic.
export async function encryptVault({ mnemonic, password, account, iterations = KDF_ITERATIONS, now = () => Date.now() }) {
  if (typeof mnemonic !== 'string' || !mnemonic.trim()) throw new VaultError('invalid_mnemonic', 'nothing to encrypt');
  checkPassword(password);
  checkAccount(account);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    address: account.address,
    publicKey: account.publicKey,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
  };
  const key = await deriveKey(password, salt, iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic }));
  try {
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(header), tagLength: 128 }, key, plaintext);
    return assertVaultRecord({ ...header, ciphertext: toBase64(ciphertext), createdAt: new Date(now()).toISOString() });
  } finally {
    plaintext.fill(0);
  }
}

// Returns the recovery phrase for immediate local use (SDK import or the
// deliberate backup view). Callers must not keep or forward it.
export async function decryptVault(value, password) {
  const record = assertVaultRecord(value);
  if (typeof password !== 'string' || !password) throw new VaultError('wrong_password_or_corrupt', 'Wrong password, or the stored wallet is damaged.');
  const key = await deriveKey(password, fromBase64(record.kdf.salt, 'kdf.salt'), record.kdf.iterations);
  let plaintext;
  try {
    plaintext = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(record.cipher.iv, 'cipher.iv'), additionalData: additionalData(record), tagLength: 128 }, key, fromBase64(record.ciphertext, 'ciphertext')));
  } catch {
    throw new VaultError('wrong_password_or_corrupt', 'Wrong password, or the stored wallet is damaged.');
  }
  try {
    const { mnemonic } = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof mnemonic !== 'string' || !mnemonic) throw new Error('empty');
    return { mnemonic };
  } catch {
    throw new VaultError('wrong_password_or_corrupt', 'Wrong password, or the stored wallet is damaged.');
  } finally {
    plaintext.fill(0);
  }
}

// The backup file is the validated record plus a human-readable notice; the
// notice is dropped again on import.
export function serializeBackup(value) {
  const record = assertVaultRecord(value);
  return JSON.stringify({
    notice: 'Encrypted DACS embedded wallet backup (experimental). It cannot be opened without the password you chose. Keep both safe; anyone with this file and the password controls the wallet.',
    ...record,
  }, null, 2);
}

export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) throw new VaultError('invalid_backup', 'the backup is empty');
  if (text.length > MAX_BACKUP_CHARS) throw new VaultError('invalid_backup', 'the backup file is too large');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VaultError('invalid_backup', 'the backup is not valid JSON');
  }
  return assertVaultRecord(value);
}
