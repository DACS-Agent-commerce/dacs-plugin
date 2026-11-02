/**
 * DEM amounts. 1 DEM = 1_000_000_000 OS (the SDK's smallest unit).
 * All arithmetic is bigint OS; DEM strings are display / input only.
 * Inputs are strict: no exponent, no sign, at most 9 fractional digits.
 */

export const OS_PER_DEM = 1_000_000_000n;

const DEM_RE = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,9})?$/;
const OS_RE = /^(0|[1-9][0-9]{0,35})$/;

export function demToOs(dem: string): bigint {
  const s = dem.trim();
  if (!DEM_RE.test(s)) {
    throw new Error(`invalid DEM amount "${dem}": use a plain decimal like "1" or "0.25" (max 9 decimals, no sign/exponent)`);
  }
  const [i = '0', f = ''] = s.split('.');
  return BigInt(i) * OS_PER_DEM + BigInt((f || '').padEnd(9, '0') || '0');
}

export function parseOs(os: string): bigint {
  const s = os.trim();
  if (!OS_RE.test(s)) throw new Error(`invalid OS amount "${os}": base-unit digit string expected`);
  return BigInt(s);
}

/** CD-1 canonical decimal (minimal digits, no trailing zeros). */
export function osToDem(os: bigint): string {
  const neg = os < 0n;
  const a = neg ? -os : os;
  const i = a / OS_PER_DEM;
  const f = (a % OS_PER_DEM).toString().padStart(9, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}

/** CORE §B.2 CD-1: is `s` a minimal-digit canonical positive decimal? */
export function isCanonicalDecimal(s: string): boolean {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(s)) return false;
  return s !== '0';
}
