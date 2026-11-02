/**
 * SecretGuard — the last line of defence between key material and any output
 * channel (tool results, error messages, logs).
 *
 * Every secret the process ever holds (mnemonic, derived private key / seed,
 * keystore passphrase, confirmation codes) is registered here. `scrub()` is
 * applied to every serialized tool result and every log line. If a registered
 * secret, or a long-enough fragment of one, appears in an output, the output is
 * blocked (tool results) or redacted (logs). Detection is fail-closed: the guard
 * also blocks output that merely looks like a BIP-39 mnemonic or a raw 32/64-byte
 * private key in a key-named field, even if it was never registered.
 */

const MIN_FRAGMENT = 12; // shortest registered STRING secret redacted from logs
/**
 * Byte-level minimums. A 12-hex-char fragment at an odd nibble offset still contains 5 whole
 * bytes, so windows are 5 bytes; hex runs must be >= 12 chars, decimal lists >= 6 values,
 * base64 windows 8 chars.
 */
const WINDOW_BYTES = 5;
const MIN_HEX_CHARS = 12;
const MIN_B64_CHARS = 8;
const MIN_DEC_BYTES = 6;

export class SecretLeakError extends Error {
  constructor() {
    super('output blocked: it contained secret material (see SECURITY.md)');
    this.name = 'SecretLeakError';
  }
}

export class SecretGuard {
  private readonly secrets = new Set<string>();
  private readonly mnemonicWordSets: string[][] = [];
  /** Every 5-byte window of every registered key byte-string, as lowercase hex. */
  private readonly byteWindows = new Set<string>();
  /** Every 8-char window of the base64 / base64url encodings of each key at byte offsets 0, 1, 2. */
  private readonly b64Windows = new Set<string>();

  register(secret: string | undefined | null): void {
    if (!secret) return;
    const s = secret.trim();
    if (s.length < 6) return;
    this.secrets.add(s);
    const lower = s.toLowerCase();
    if (lower !== s) this.secrets.add(lower);
    if (s.startsWith('0x')) this.secrets.add(s.slice(2));
    const words = s.split(/\s+/);
    if (words.length >= 12) this.mnemonicWordSets.push(words.map((w) => w.toLowerCase()));
  }

  /**
   * Register raw key bytes. Detection is derived from the bytes themselves, so every
   * representation of the key (or of any 6-byte stretch of it) is caught: hex in any case,
   * 0x-prefixed, space/colon/comma/dash-separated hex, base64 and base64url at any byte
   * offset (so DER/PKCS8 wrappers and leading-byte shifts), and JSON byte arrays.
   */
  registerBytes(bytes: Uint8Array | undefined | null): void {
    if (!bytes || bytes.length < 16) return;
    const b = Buffer.from(bytes);
    for (let i = 0; i + WINDOW_BYTES <= b.length; i++) this.byteWindows.add(b.subarray(i, i + WINDOW_BYTES).toString('hex'));
    const addB64 = (core: string) => {
      for (let i = 0; i + MIN_B64_CHARS <= core.length; i++) {
        const w = core.slice(i, i + MIN_B64_CHARS);
        this.b64Windows.add(w);
        this.b64Windows.add(w.replace(/\+/g, '-').replace(/\//g, '_'));
      }
    };
    addB64(b.toString('base64').replace(/=+$/, '')); // the key's own encoding, final char included
    for (let k = 0; k < 3; k++) {
      // encode with k leading filler bytes; keep only chars determined entirely by key bits
      const enc = Buffer.concat([Buffer.alloc(k), b]).toString('base64').replace(/=+$/, '');
      const first = Math.ceil((8 * k) / 6);
      const totalBits = 8 * (k + b.length);
      const last = Math.floor(totalBits / 6); // exclusive: drop a trailing char padded with zero bits
      addB64(enc.slice(first, last));
    }
  }

  /**
   * Register an ed25519 private key. The SDK form is 64 bytes, seed || public key, and on
   * Demos the public key IS the wallet address. Registering all 64 bytes would make every
   * output that names the wallet's own address look like a key fragment and be blocked
   * (found on the first live testnet write: every prepare was refused). Only the 32-byte
   * seed is secret; any leak of the full key contains it and is still caught.
   */
  registerEd25519PrivateKey(priv: Uint8Array): void {
    if (priv.length !== 32 && priv.length !== 64) throw new Error('unexpected ed25519 private key length');
    this.registerBytes(priv.slice(0, 32));
  }

  /**
   * True if `text` contains any registered secret or a suspicious fragment of one.
   * Also checks a JSON-unescaped view, so escaping (\" \\ \uXXXX) cannot hide a secret.
   */
  leaks(text: string): boolean {
    if (!text) return false;
    if (this.leaksRaw(text)) return true;
    const unescaped = jsonUnescape(text);
    return unescaped !== text && this.leaksRaw(unescaped);
  }

  /** Walk a value and check every string (keys included) before serialization. */
  valueLeaks(value: unknown, depth = 0): boolean {
    if (depth > 64) return false;
    if (typeof value === 'string') return this.leaks(value);
    if (Array.isArray(value)) return value.some((v) => this.valueLeaks(v, depth + 1));
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (this.leaks(k) || this.valueLeaks(v, depth + 1)) return true;
      }
    }
    return false;
  }

  private leaksRaw(text: string): boolean {
    const lower = text.toLowerCase();
    for (const s of this.secrets) {
      if (lower.includes(s.toLowerCase())) return true;
    }
    if (this.byteWindows.size && (this.hexLeaks(text) || this.decimalLeaks(text))) return true;
    if (this.b64Windows.size && this.base64Leaks(text)) return true;
    // any run of 4 consecutive words from a registered mnemonic
    if (this.mnemonicWordSets.length) {
      // words in order, whatever separates them: spaces, commas, newlines, numbering ("1. legal 2. winner"),
      // or nothing at all ("legalwinnerthank...")
      const spaced = ' ' + lower.split(/[^a-z]+/).filter(Boolean).join(' ') + ' ';
      const squashed = lower.replace(/[^a-z]+/g, '');
      for (const words of this.mnemonicWordSets) {
        for (let i = 0; i + 4 <= words.length; i++) {
          const run = words.slice(i, i + 4);
          if (spaced.includes(' ' + run.join(' ') + ' ') || squashed.includes(run.join(''))) return true;
        }
      }
    }
    return looksLikeKeyMaterial(text);
  }

  private windowsHit(bytes: Buffer): boolean {
    for (let i = 0; i + WINDOW_BYTES <= bytes.length; i++) {
      if (this.byteWindows.has(bytes.subarray(i, i + WINDOW_BYTES).toString('hex'))) return true;
    }
    return false;
  }

  /** Hex runs, tolerating 0x prefixes and space/colon/comma/dash separators, at both nibble parities. */
  private hexLeaks(text: string): boolean {
    const runs = text.match(/(?:0x)?[0-9a-f]+(?:[\s:,\-]+(?:0x)?[0-9a-f]+)*/gi) ?? [];
    for (const run of runs) {
      const hex = run.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '').toLowerCase();
      if (hex.length < MIN_HEX_CHARS) continue;
      for (const off of [0, 1]) {
        const h = hex.slice(off, off + ((hex.length - off) & ~1));
        if (this.windowsHit(Buffer.from(h, 'hex'))) return true;
      }
    }
    return false;
  }

  /** Decimal byte lists such as JSON byte arrays ([12, 250, ...]) or Buffer JSON. */
  private decimalLeaks(text: string): boolean {
    const runs = text.match(/\d{1,3}(?:\s*[,;\s]\s*\d{1,3}){5,}/g) ?? [];
    for (const run of runs) {
      const nums = run.split(/[^\d]+/).filter(Boolean).map(Number);
      // split at values > 255 into byte segments
      let seg: number[] = [];
      for (const n of [...nums, 256]) {
        if (n <= 255) {
          seg.push(n);
          continue;
        }
        if (seg.length >= MIN_DEC_BYTES && this.windowsHit(Buffer.from(seg))) return true;
        seg = [];
      }
    }
    return false;
  }

  /** Any 8-char window of a base64/base64url run (any alignment, incl. DER-wrapped keys). */
  private base64Leaks(text: string): boolean {
    const runs = text.match(/[A-Za-z0-9+/_-]{8,}/g) ?? [];
    for (const run of runs) {
      for (let i = 0; i + MIN_B64_CHARS <= run.length; i++) {
        if (this.b64Windows.has(run.slice(i, i + MIN_B64_CHARS))) return true;
      }
    }
    return false;
  }

  /** Throws SecretLeakError if `text` leaks; returns it unchanged otherwise. */
  assertClean(text: string): string {
    if (this.leaks(text)) throw new SecretLeakError();
    return text;
  }

  /** Redacts registered secrets (for logs, where blocking the whole line is not needed). */
  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) {
      if (s.length < MIN_FRAGMENT && !/\s/.test(s)) continue;
      out = out.split(s).join('[REDACTED]');
    }
    if (this.leaks(out)) return '[log line redacted: possible secret material]';
    return out;
  }
}

/**
 * Heuristics for unregistered key material: a JSON field whose name says it is a
 * private key / seed / mnemonic carrying a non-trivial value.
 */
const KEY_FIELD_RE = /"(private_?key|privkey|secret_?key|seed|mnemonic|passphrase|master_?seed)"\s*:\s*"([^"]{16,})"/i;

function jsonUnescape(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["\\/bfnrt])/g, (_m, c: string) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] ?? c);
}

function looksLikeKeyMaterial(text: string): boolean {
  return KEY_FIELD_RE.test(text);
}
