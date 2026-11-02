// Structured logger that never prints tokens, signatures or request bodies.
// Callers pass explicit fields; anything matching a sensitive key is dropped.
const SENSITIVE = /token|secret|password|authorization|cookie|signature|code_verifier|^code$|private|seed|mnemonic/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function scrub(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (SENSITIVE.test(key)) continue;
    out[key] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return out;
}

export function createLogger({ level = 'info', sink = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (event, fields) => {
    if (LEVELS[lvl] < threshold) return;
    sink(JSON.stringify({ at: new Date().toISOString(), level: lvl, event, ...scrub(fields) }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
