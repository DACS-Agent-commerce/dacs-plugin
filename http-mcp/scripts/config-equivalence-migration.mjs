#!/usr/bin/env node
// One-off migration evidence for moving the simple feature switches into
// src/switches/. Not a test: it is run by hand, pins nothing, and a
// later legitimate change to loadConfig is expected to make it report
// mismatches against an old baseline. The repository test is
// test/config-equivalence.test.mjs, which pins only the nine converted
// switches (test/fixtures/switch-slice-v1-baseline.json, written by this script).
//
//   node scripts/config-equivalence-migration.mjs [--baseline-ref REF | --baseline-dir DIR] [--full]
//   node scripts/config-equivalence-migration.mjs --write-fixture
//
// Compares this tree's loadConfig with the baseline's (default: the ref `v1-baseline`, the
// last main that parsed every switch inline; this repository has no such ref, so give
// --baseline-ref or --baseline-dir) over a generated env matrix:
// the same object (keys, values, nesting, frozenness) or the same error class
// and message, so the same first-error precedence, for every input. --full
// runs the whole product of the nine switches' values (about 5M inputs).
// --baseline-dir takes an http-mcp tree without git. --write-fixture writes
// the switch slice of the v1 baseline to the test fixture.
//
// Exit 0: no mismatch. Exit 1: mismatches (the first five are printed).
// Exit 2: the comparison could not run (for example, the baseline cannot be read).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(PLUGIN, 'test/fixtures/switch-slice-v1-baseline.json');
// The nine converted switches, with their config keys.
export const CONVERTED = {
  DACS_SHOWCASE_RECEIPT: 'showcaseReceipt', DACS_SELLER_WRITE_BATCHES: 'sellerWriteBatches', DACS_PORTAL_AUTO_ADVANCE: 'portalAutoAdvance',
  DACS_DELIVERY_DEADLINE_WATCH: 'deliveryDeadlineWatch', DACS_SHOWCASE_WALKTHROUGH: 'showcaseWalkthrough', DACS_SHOWCASE_LEDGER: 'showcaseLedger',
  DACS_SHOWCASE_PUBLICATION_VIEW: 'showcasePublicationView', DACS_WALLET_EXTENSION_PROBE: 'walletExtensionProbe', DACS_READBACK_CACHE: 'readbackCache',
};
const ENUMS = ['DACS_SHOWCASE_RECEIPT', 'DACS_SELLER_WRITE_BATCHES', 'DACS_PORTAL_AUTO_ADVANCE', 'DACS_DELIVERY_DEADLINE_WATCH', 'DACS_SHOWCASE_WALKTHROUGH'];
const FLAGS = ['DACS_SHOWCASE_LEDGER', 'DACS_SHOWCASE_PUBLICATION_VIEW', 'DACS_WALLET_EXTENSION_PROBE', 'DACS_READBACK_CACHE'];
const ABSENT = Symbol('absent');
export const BASE = Object.freeze({ DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) });
// Every non-switch check before and after the switches, plus valid variants.
const OTHERS = [
  {},
  { DACS_PUBLIC_ORIGIN: ABSENT },
  { DACS_PUBLIC_ORIGIN: 'http://plugin.example' },
  { DACS_PUBLIC_ORIGIN: 'https://plugin.example/path' },
  { DACS_AUTH_MODE: 'other' },
  { DACS_AUTH_MODE: '' },
  { DACS_AUTH_MODE: 'external' },
  { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'https://issuer.example', DACS_OAUTH_COOKIE_KEYS: ABSENT },
  { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'not a url' },
  { DACS_AUTH_MODE: 'external', DACS_OAUTH_ISSUER: 'https://issuer.example', DACS_OAUTH_JWKS_URI: 'http://jwks.example' },
  { DACS_OAUTH_COOKIE_KEYS: ABSENT },
  { DACS_OAUTH_COOKIE_KEYS: 'short' },
  { DACS_OAUTH_COOKIE_KEYS: `REPLACE_ME${'x'.repeat(40)}` },
  { DACS_IDENTITY_WRITES: 'other' },
  { DACS_IDENTITY_WRITES: '' },
  { DACS_IDENTITY_WRITES: 'simulated-fixture-only' },
  { DACS_DIRECTORY_ORIGIN: 'ftp://directory.example' },
  { DACS_DIRECTORY_ORIGIN: 'https://directory.example', DACS_DIRECTORY_TIMEOUT_MS: '1' },
  { DACS_CHAIN_RPC_URL: 'not a url' },
  { DACS_CHAIN_RPC_URL: 'https://rpc.example', DACS_CHAIN_TIMEOUT_MS: 'x', DACS_CHAIN_NETWORK: 'demos-testnet' },
  { DACS_EMBEDDED_WALLET_WRITES: 'other' },
  { DACS_EMBEDDED_WALLET_WRITES: 'testnet-held' },
  { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_CHAIN_RPC_URL: 'http://127.0.0.1:9', DACS_ALLOW_INSECURE_LOCALHOST: '1' },
  { DACS_DEM_AMOUNT_ENCODING: 'other' },
  { PORT: 'x' },
  { DACS_ACCESS_TOKEN_TTL_SECONDS: '1' },
  { DACS_RATE_LIMIT_PER_MINUTE: '1' },
  { DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '0' },
  { DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT: 'acct_owner', DACS_TRUST_PROXY: '1', DACS_LOG_LEVEL: 'debug', HOST: '0.0.0.0' },
  { DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_PUBLIC_ORIGIN: 'http://localhost:8787', DACS_DATA_DIR: '/var/lib/dacs-chatgpt' },
  // Main's seller identity and GitHub signal settings, checked between the cookie keys and the switches.
  { DACS_SELLER_IDENTITIES: 'on' },
  { DACS_SELLER_IDENTITIES: '' },
  { DACS_SELLER_IDENTITIES: 'bogus' },
  { DACS_IDENTITY_GITHUB_SIGNALS: 'on' },
  { DACS_IDENTITY_GITHUB_SIGNALS: 'bogus' },
  { DACS_SELLER_IDENTITIES: 'on', DACS_IDENTITY_GITHUB_SIGNALS: 'on', DACS_IDENTITY_GITHUB_TOKEN: 'ghp_abc123' },
  { DACS_SELLER_IDENTITIES: 'on', DACS_IDENTITY_GITHUB_SIGNALS: 'off' },
  { DACS_IDENTITY_GITHUB_TOKEN: '' },
  { DACS_IDENTITY_GITHUB_TOKEN: 'not a token' },
  { DACS_IDENTITY_GITHUB_TOKEN: 'x'.repeat(1025) },
  { DACS_OAUTH_COOKIE_KEYS: 'short', DACS_SELLER_IDENTITIES: 'bogus' },
  { DACS_IDENTITY_WRITES: 'other', DACS_IDENTITY_GITHUB_SIGNALS: 'on' },
  // Main's commit-on-signature and Start intent settings, checked among the switches.
  { DACS_COMMIT_ON_SIGNATURE: 'on' },
  { DACS_COMMIT_ON_SIGNATURE: 'bogus' },
  { DACS_INTENT_APPROVAL: 'on' },
  { DACS_INTENT_APPROVAL: 'bogus' },
  { DACS_COMMIT_ON_SIGNATURE: 'on', DACS_INTENT_APPROVAL: 'on' },
  { DACS_COMMIT_ON_SIGNATURE: 'bogus', DACS_INTENT_APPROVAL: 'bogus' },
  { DACS_OAUTH_COOKIE_KEYS: 'short', DACS_COMMIT_ON_SIGNATURE: 'bogus' },
  { DACS_OAUTH_COOKIE_KEYS: 'short', DACS_INTENT_APPROVAL: 'bogus' },
  { DACS_IDENTITY_GITHUB_SIGNALS: 'bogus', DACS_COMMIT_ON_SIGNATURE: 'bogus', DACS_INTENT_APPROVAL: 'bogus' },
  { DACS_IDENTITY_WRITES: 'other', DACS_COMMIT_ON_SIGNATURE: 'bogus' },
  { DACS_IDENTITY_WRITES: 'other', DACS_INTENT_APPROVAL: 'bogus' },
  { DACS_IDENTITY_WRITES: 'other', DACS_INTENT_APPROVAL: 'on' },
  { DACS_EMBEDDED_WALLET_WRITES: 'other', DACS_COMMIT_ON_SIGNATURE: 'on', DACS_INTENT_APPROVAL: 'on' },
];
// Non-switch settings main added after the v1 baseline, with their config keys. A row
// that sets one is skipped against a baseline without it, and their keys are
// left out of the comparison there.
const ADDED_STATIC = {
  DACS_SELLER_IDENTITIES: 'sellerIdentities', DACS_IDENTITY_GITHUB_SIGNALS: 'identityGithubSignals', DACS_IDENTITY_GITHUB_TOKEN: 'identityGithubToken',
  DACS_COMMIT_ON_SIGNATURE: 'commitOnSignature', DACS_INTENT_APPROVAL: 'intentApproval',
};
// The two of them that are off/on enums checked among the switches (docs/SWITCHES.md).
const STATIC_AMONG_SWITCHES = ['DACS_COMMIT_ON_SIGNATURE', 'DACS_INTENT_APPROVAL'];

function* product(names, values) {
  if (!names.length) { yield {}; return; }
  const [first, ...rest] = names;
  for (const tail of product(rest, values)) for (const value of values(first)) yield { [first]: value, ...tail };
}

function env(...parts) {
  const out = {};
  for (const part of parts) for (const [k, v] of Object.entries(part)) { if (v === ABSENT) delete out[k]; else out[k] = v; }
  return out;
}

function outcome(load, input) {
  try {
    return { config: load(input) };
  } catch (error) {
    return { error: { name: error.constructor.name, message: error.message } };
  }
}

// Which objects are frozen, by path (the top level and some nested objects are).
const frozenShape = (value, path = '$') => (value === null || typeof value !== 'object' ? [] : [`${path}:${Object.isFrozen(value)}`, ...Object.entries(value).flatMap(([k, v]) => frozenShape(v, `${path}.${k}`))]);

// The behaviour of the given switches, read from loadConfig and the contract
// view alone: each switch's contract entry, the result or exact error for a
// fixed set of values, the order in which their errors win, and where that
// block sits among the other checks. test/config-equivalence.test.mjs
// compares this with the fixture written from the v1 baseline.
const CANDIDATES = [ABSENT, '', '0', '1', 'true', 'off', 'on', 'ON', 'bogus'];
export function switchSlice(load, variables, switches) {
  const run = (input) => {
    try {
      return { config: load(input) };
    } catch (error) {
      return { error: `${error.constructor.name}: ${error.message}` };
    }
  };
  const slice = { switches: {} };
  for (const [name, configKey] of Object.entries(switches)) {
    const outcomes = {};
    for (const value of CANDIDATES) {
      const r = run(value === ABSENT ? { ...BASE } : { ...BASE, [name]: value });
      outcomes[value === ABSENT ? '(unset)' : value] = r.error ? { error: r.error } : { value: Object.hasOwn(r.config, configKey) ? r.config[configKey] : '(no such key)' };
    }
    slice.switches[name] = { configKey, contract: variables[name] ?? null, outcomes };
  }
  // The switches that refuse an invalid value, and a value of each that loadConfig holds.
  const refusing = Object.keys(switches).filter((n) => slice.switches[n].outcomes.bogus.error);
  const heldValue = (n) => Object.entries(slice.switches[n].outcomes).find(([, o]) => o.error && !o.error.includes(`${n} must be`))?.[0];
  const ownError = (message) => refusing.find((n) => message.startsWith(`${n} `) || message.startsWith(`${n}=`));
  // Which switch's error comes first, then next once it is fixed, and so on.
  const peel = (bad) => {
    const input = { ...BASE, ...Object.fromEntries(refusing.map((n) => [n, bad(n)])) };
    const order = [];
    for (let k = 0; k <= refusing.length; k += 1) {
      const r = run(input);
      if (!r.error) break;
      const hit = ownError(r.error.replace(/^\w+: /, ''));
      if (!hit) return [...order, `(not a switch error: ${r.error})`];
      order.push(hit);
      delete input[hit];
    }
    return order;
  };
  slice.precedence = { invalid: peel(() => 'bogus'), heldOrInvalid: peel((n) => heldValue(n) ?? 'bogus') };
  const firstError = (input) => run(input).error?.replace(/^\w+: /, '');
  const [first, last] = [slice.precedence.invalid[0], slice.precedence.invalid.at(-1)];
  slice.checkedAfterCookieKeys = !ownError(firstError({ ...BASE, DACS_OAUTH_COOKIE_KEYS: 'short', [first]: 'bogus' }) ?? '');
  slice.checkedBeforeIdentityWrites = Boolean(ownError(firstError({ ...BASE, DACS_IDENTITY_WRITES: 'bogus', [last]: 'bogus' }) ?? ''));
  return slice;
}

function git(args) {
  return spawnSync('git', ['-C', PLUGIN, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

// The baseline's src/config.mjs, with its switch files and parser if it has
// them, copied into dir; and its static env contract.
function readBaseline({ ref, dir: from }, dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  if (from) {
    if (!existsSync(join(from, 'src/config.mjs'))) throw new Error(`${from} has no src/config.mjs`);
    for (const rel of ['src/config.mjs', 'src/switch-files.mjs', 'src/switches']) {
      if (existsSync(join(from, rel))) cpSync(join(from, rel), join(dir, rel), { recursive: true });
    }
    return JSON.parse(readFileSync(join(from, 'deploy/env-contract.json'), 'utf8'));
  }
  const prefix = git(['rev-parse', '--show-prefix']);
  if (prefix.status !== 0) throw new Error('not a git checkout; use --baseline-dir');
  const show = (rel) => {
    const r = git(['show', `${ref}:${prefix.stdout.trim()}${rel}`]);
    if (r.status !== 0) throw new Error(`git show ${ref}:${rel} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  writeFileSync(join(dir, 'src/config.mjs'), show('src/config.mjs'));
  // --full-tree: from a subdirectory, ls-tree otherwise lists only paths under it.
  const switches = git(['ls-tree', '--full-tree', '--name-only', `${ref}:${prefix.stdout.trim()}src/switches`]);
  if (switches.status === 0) {
    mkdirSync(join(dir, 'src/switches'));
    for (const file of switches.stdout.trim().split('\n').filter(Boolean)) writeFileSync(join(dir, 'src/switches', file), show(`src/switches/${file}`));
    const parser = git(['cat-file', '-e', `${ref}:${prefix.stdout.trim()}src/switch-files.mjs`]);
    if (parser.status === 0) writeFileSync(join(dir, 'src/switch-files.mjs'), show('src/switch-files.mjs'));
  }
  return JSON.parse(show('deploy/env-contract.json'));
}

function parseArgs(argv) {
  const args = { ref: null, dir: null, full: false, writeFixture: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline-ref') args.ref = argv[++i];
    else if (argv[i] === '--baseline-dir') args.dir = resolve(argv[++i]);
    else if (argv[i] === '--full') args.full = true;
    else if (argv[i] === '--write-fixture') args.writeFixture = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (args.ref && args.dir) throw new Error('give --baseline-ref or --baseline-dir, not both');
  if (args.writeFixture && (args.ref || args.dir)) throw new Error('--write-fixture always uses the v1 baseline');
  args.ref ??= args.dir ? null : 'v1-baseline';
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const tmp = mkdtempSync(join(tmpdir(), 'config-equivalence-'));
  try {
    const baseContract = readBaseline(args, tmp);
    const legacyModule = await import(pathToFileURL(join(tmp, 'src/config.mjs')).href);
    const legacy = legacyModule.loadConfig;
    const { SWITCHES, loadConfig } = await import(pathToFileURL(join(PLUGIN, 'src/config.mjs')).href);
    const label = args.dir ?? args.ref;
    const legacyKeys = new Set(Object.keys(legacy(BASE)));
    for (const [name, key] of Object.entries(CONVERTED)) if (!legacyKeys.has(key)) throw new Error(`baseline ${label} has no ${key} (${name})`);

    if (args.writeFixture) {
      const { switchContractEntry } = await import(pathToFileURL(join(PLUGIN, 'deploy/scripts/lib/rules.mjs')).href);
      const variables = { ...baseContract.variables, ...Object.fromEntries((legacyModule.SWITCHES ?? []).map((s) => [s.env, switchContractEntry(s)])) };
      const slice = switchSlice(legacy, variables, CONVERTED);
      writeFileSync(FIXTURE, `${JSON.stringify({ generatedFrom: `${args.ref}: src/config.mjs and deploy/env-contract.json`, by: 'node scripts/config-equivalence-migration.mjs --write-fixture', ...slice }, null, 2)}\n`);
      console.log(`wrote ${FIXTURE.slice(PLUGIN.length + 1)} from ${args.ref}`);
      return 0;
    }

    // Switches added after the baseline appear only in the new config, at their default.
    const added = SWITCHES.filter((s) => !legacyKeys.has(s.configKey));
    // Main's later static settings this baseline does not have.
    const unknownStatic = Object.entries(ADDED_STATIC).filter(([, key]) => !legacyKeys.has(key));
    const ignored = [...added.map((s) => s.configKey), ...unknownStatic.map(([, key]) => key)];
    const mismatches = [];
    let cases = 0, errors = 0, skipped = 0;
    const compare = (input) => {
      if (unknownStatic.some(([name]) => Object.hasOwn(input, name))) { skipped += 1; return; }
      cases += 1;
      const a = outcome(legacy, input), b = outcome(loadConfig, input);
      if (b.config) {
        for (const s of added) if (b.config[s.configKey] !== (s.kind === 'flag' ? false : s.default)) mismatches.push({ input, added: s.env });
        b.config = Object.fromEntries(Object.entries(b.config).filter(([k]) => !ignored.includes(k)));
      }
      if (a.error) errors += 1;
      const same = JSON.stringify(a.error ?? null) === JSON.stringify(b.error ?? null) && isDeepStrictEqual(a.config, b.config)
        && (!a.config || isDeepStrictEqual(frozenShape(loadConfig(input)).filter((p) => !ignored.some((k) => p.startsWith(`$.${k}:`))), frozenShape(legacy(input))));
      if (!same) mismatches.push({ input, baseline: a, current: b });
    };
    const full = (name) => ([...ENUMS, ...STATIC_AMONG_SWITCHES].includes(name) ? [ABSENT, '', 'off', 'on', 'bogus', 'ON'] : [ABSENT, '', '0', '1', 'true']);
    const reduced = (name) => (ENUMS.includes(name) ? [ABSENT, 'on', 'bogus'] : [ABSENT, '1']);
    const mixed = (fullFor) => (name) => (fullFor.includes(name) ? full(name) : reduced(name));
    if (args.full) {
      // Every combination of every switch's values.
      for (const switches of product([...ENUMS, ...FLAGS], full)) compare(env(BASE, switches));
    } else {
      // 1. Every combination of the enums' values (which decide the first error), with each flag off or on.
      for (const switches of product([...ENUMS, ...FLAGS], mixed(ENUMS))) compare(env(BASE, switches));
      // 2. Every combination of the flags' values, with each enum absent, valid or held, or invalid.
      for (const switches of product([...ENUMS, ...FLAGS], mixed(FLAGS))) compare(env(BASE, switches));
    }
    // 3. Each non-switch variant with a valid, invalid or held value for every switch, so a
    // switch error meets each earlier and later check.
    for (const other of OTHERS) for (const switches of product([...ENUMS, ...FLAGS], reduced)) compare(env(BASE, other, switches));
    // 4. Every combination of the enums' values and the two static settings checked among them
    // (where each error wins, and the intent / auto-advance pair). Flags are left unset: they never throw.
    for (const switches of product([...ENUMS, ...STATIC_AMONG_SWITCHES], full)) compare(env(BASE, switches));
    console.log(`config-equivalence: baseline ${label}: ${cases} env inputs (${errors} refused, ${cases - errors} accepted); switches added since: ${added.map((s) => s.env).join(',') || 'none'}`);
    if (unknownStatic.length) console.log(`config-equivalence: the baseline has no ${unknownStatic.map(([name]) => name).join(',')}: ${skipped} inputs that set them skipped, their keys not compared`);
    for (const m of mismatches.slice(0, 5)) console.log(`  MISMATCH ${JSON.stringify(m, (k, v) => (typeof v === 'symbol' ? '(absent)' : v)).slice(0, 600)}`);
    console.log(mismatches.length ? `config-equivalence: ${mismatches.length} mismatch(es)` : 'config-equivalence: no mismatch');
    return mismatches.length ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`config-equivalence-migration: ${error.message}`);
    process.exitCode = 2;
  }
}
