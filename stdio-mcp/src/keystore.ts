/**
 * Key sources. The wallet mnemonic is loaded from exactly one of:
 *   - an encrypted keystore (scrypt + AES-256-GCM), passphrase from env or a file;
 *   - a plaintext mnemonic file the user points at (must be chmod 600) — discouraged.
 * The mnemonic never comes from a tool argument and is never returned, logged,
 * or passed to the model; every loaded secret is registered with the SecretGuard.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Config } from './config.js';
import type { SecretGuard } from './secrets.js';

export interface KeystoreFile {
  version: 1;
  kdf: 'scrypt';
  kdfparams: { N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
  /** Public address, informational only (never trusted for signing). */
  address?: string;
  /** Set when /demos-onboard created this wallet: its backup must be acknowledged for this address. */
  onboarding?: { createdAt: string };
}

const DEFAULT_N = 2 ** 17;

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

export function encryptMnemonic(mnemonic: string, passphrase: string, opts: { N?: number; address?: string } = {}): KeystoreFile {
  if (passphrase.length < 8) throw new Error('keystore passphrase must be at least 8 characters');
  const N = opts.N ?? DEFAULT_N;
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, N, 8, 1);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(mnemonic.trim(), 'utf8'), c.final()]);
  key.fill(0);
  return {
    version: 1,
    kdf: 'scrypt',
    kdfparams: { N, r: 8, p: 1, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
    ...(opts.address ? { address: opts.address } : {}),
  };
}

export function decryptKeystore(ks: KeystoreFile, passphrase: string): string {
  if (ks.version !== 1 || ks.kdf !== 'scrypt' || ks.cipher !== 'aes-256-gcm') throw new Error('unsupported keystore format');
  const { N, r, p, salt } = ks.kdfparams;
  if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20 || r !== 8 || p !== 1) throw new Error('keystore KDF parameters out of range');
  const key = deriveKey(passphrase, Buffer.from(salt, 'base64'), N, r, p);
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ks.iv, 'base64'));
    d.setAuthTag(Buffer.from(ks.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ks.ciphertext, 'base64')), d.final()]).toString('utf8');
  } catch {
    // never echo the underlying error (it can include buffer fragments)
    throw new Error('keystore decryption failed (wrong passphrase or corrupted file)');
  } finally {
    key.fill(0);
  }
}

function assertPrivateFile(path: string, what: string): void {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${what} is not a regular file`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`${what} must not be readable by group/others (chmod 600 ${path})`);
  }
}

function validateMnemonic(m: string): string {
  const words = m.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length) || !words.every((w) => /^[a-z]+$/.test(w))) {
    throw new Error('key source does not contain a valid BIP-39 mnemonic');
  }
  return words.join(' ');
}

/** Load the mnemonic from the configured source. Registers every secret with the guard. */
export class NoWalletError extends Error {
  constructor(path: string) {
    super(`no wallet yet (no keystore at ${path}): run demos_onboard_create_wallet, or set DEMOS_KEYSTORE`);
    this.name = 'NoWalletError';
  }
}

/** Passphrase held in memory for this process only (set when onboarding creates a wallet without remembering it). */
let sessionPassphrase: string | null = null;
export function setSessionPassphrase(p: string | null): void {
  sessionPassphrase = p;
}

export function loadMnemonic(cfg: Config, guard: SecretGuard): string {
  if (cfg.keystorePath) {
    if (!existsSync(cfg.keystorePath)) throw new NoWalletError(cfg.keystorePath);
    let pass = cfg.keystorePassphrase ?? sessionPassphrase ?? undefined;
    if (!pass && cfg.keystorePassphraseFile && existsSync(cfg.keystorePassphraseFile)) {
      assertPrivateFile(cfg.keystorePassphraseFile, 'keystore passphrase file');
      // the file holds the passphrase plus one trailing newline; onboarding refuses passphrases with edge whitespace
      pass = readFileSync(cfg.keystorePassphraseFile, 'utf8').replace(/\r?\n$/, '');
    }
    if (!pass) throw new Error('the keystore needs a passphrase (DEMOS_KEYSTORE_PASSPHRASE or DEMOS_KEYSTORE_PASSPHRASE_FILE)');
    guard.register(pass);
    assertPrivateFile(cfg.keystorePath, 'keystore');
    const ks = JSON.parse(readFileSync(cfg.keystorePath, 'utf8')) as KeystoreFile;
    const m = validateMnemonic(decryptKeystore(ks, pass));
    guard.register(m);
    return m;
  }
  if (cfg.mnemonicFile) {
    assertPrivateFile(cfg.mnemonicFile, 'mnemonic file');
    const m = validateMnemonic(readFileSync(cfg.mnemonicFile, 'utf8'));
    guard.register(m);
    return m;
  }
  throw new Error('no key source configured');
}

export function writeKeystore(path: string, ks: KeystoreFile): void {
  writeFileSync(path, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
