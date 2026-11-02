/** Replace C0/C1 control characters (incl. newline, ESC) and bidi overrides so a line stays one inert line. */
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

export function printable(s: string): string {
  return String(s).replace(UNSAFE, '?');
}
