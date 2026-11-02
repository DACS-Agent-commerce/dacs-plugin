/**
 * Logging. stdout belongs to the MCP JSON-RPC stream, so nothing else may write
 * there. The Demos SDK prints with console.log (e.g. "nativeOperation: send"),
 * which would corrupt the protocol stream, so `installConsoleGuard` reroutes
 * every console method to stderr, through the SecretGuard redactor.
 */
import type { SecretGuard } from './secrets.js';

let guard: SecretGuard | null = null;
let quiet = false;

export function installConsoleGuard(g: SecretGuard, opts: { quiet?: boolean } = {}): void {
  guard = g;
  quiet = !!opts.quiet;
  const write = (level: string) => (...args: unknown[]) => {
    if (quiet && level !== 'error') return;
    const line = args.map((a) => (typeof a === 'string' ? a : safeInspect(a))).join(' ');
    process.stderr.write(`[demos-mcp:${level}] ${g.redact(line)}\n`);
  };
  console.log = write('sdk');
  console.info = write('sdk');
  console.debug = write('sdk');
  console.warn = write('warn');
  console.error = write('error');
}

function safeInspect(a: unknown): string {
  try {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    return JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 2000) ?? String(a);
  } catch {
    return '[unserializable]';
  }
}

export function log(msg: string): void {
  const line = guard ? guard.redact(msg) : msg;
  process.stderr.write(`[demos-mcp] ${line}\n`);
}
