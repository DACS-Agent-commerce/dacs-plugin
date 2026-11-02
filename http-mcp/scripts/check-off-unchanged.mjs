#!/usr/bin/env node
// "Every switch off is unchanged": compares the default-env public surface of
// this checkout (its working tree) with that of `git merge-base HEAD <base-ref>`
// (with MERGE_HEAD too while a merge is uncommitted).
//
//   node scripts/check-off-unchanged.mjs <base-ref> [--allow-surface-change] [--capture-from <ref>]
//   e.g. node scripts/check-off-unchanged.mjs origin/main
//
// The merge base is checked out as a temporary detached git worktree under
// TMPDIR that shares this checkout's node_modules by symlink; nothing is
// fetched or installed. scripts/off-surface.mjs captures both trees: loadConfig
// defaults, MCP instructions, tools and UI resources, and portal asset/page
// bytes and headers (docs/SWITCHES.md says what it does not cover).
//
// This checkout's copies of off-surface.mjs and of this runner are never the
// only oracle, or a change could hide itself by editing them. The oracle is
// the merge base's two files, or, when the merge base has none (before this
// runner is on main), the two files of the commit named by --capture-from,
// which the reviewer chooses and checks by the blob ids printed. Without
// either, the check exits 2. Both trees are captured with the oracle's
// off-surface.mjs, by the oracle's runner, run from a temporary file. When
// this checkout's copies differ from the oracle's, the check exits 2; after
// reviewing that edit, --allow-surface-change runs the oracle and then this
// checkout's copies too, and prints both results.
//
// --checkout DIR and --as-oracle are how one copy runs another: DIR is the
// plugin directory to check (default: the one this file is in), and
// --as-oracle captures and compares once, with no further runner.
//
// Exit 0: no difference. Exit 1: differences (each one is printed; the PR
// description says which are intended). Exit 2: the check could not run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACE = 'scripts/off-surface.mjs';
const RUNNER = 'scripts/check-off-unchanged.mjs';
const ALLOW_SURFACE_CHANGE = '--allow-surface-change';
const CAPTURE_FROM = '--capture-from';
// A runner whose text has this line can be the oracle: it accepts --checkout
// and --as-oracle, so it can be run from a temporary file.
export const ORACLE_PROTOCOL = 'check-off-unchanged oracle protocol 1';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

// URL paths for every file the portal could serve from public/ in either tree.
function publicPaths(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), next);
      else out.push(next);
    }
  };
  if (existsSync(join(root, 'public'))) walk(join(root, 'public'), '');
  return out.flatMap((rel) => {
    const [top, ...rest] = rel.split('/');
    const inner = rest.join('/');
    return top === 'portal' ? [`/portal/assets/${inner}`] : [`/portal/${top}`, `/portal/${top}/${inner}`, `/portal/${top}/assets/${inner}`];
  });
}

function capture(script, tree, pathsFile) {
  // No inherited switch or deployment settings reach either capture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DACS_') && k !== 'HOST' && k !== 'PORT'));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, tree, pathsFile], { cwd: tree, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300_000 });
  if (r.status !== 0) throw new Error(`surface capture failed in ${tree}: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-5).join(' / ')}`);
  return JSON.parse(r.stdout);
}

function flatten(value, path = '$', out = new Map()) {
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) out.set(path, Array.isArray(value) ? '[]' : '{}');
    for (const key of keys) flatten(value[key], Array.isArray(value) ? `${path}[${key}]` : `${path}.${JSON.stringify(key)}`, out);
  } else out.set(path, value);
  return out;
}

function show(value) {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

// For long strings, the first differing offset with a little context.
function describe(before, after) {
  if (typeof before === 'string' && typeof after === 'string' && (before.length > 120 || after.length > 120)) {
    let i = 0;
    while (i < before.length && before[i] === after[i]) i += 1;
    const at = Math.max(0, i - 40);
    return `first difference at offset ${i} (lengths ${before.length} -> ${after.length}): ${JSON.stringify(before.slice(at, i + 60))} -> ${JSON.stringify(after.slice(at, i + 60))}`;
  }
  return `${show(before)} -> ${show(after)}`;
}

export function diffSurfaces(base, head) {
  const a = flatten(base), b = flatten(head);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => a.get(k) !== b.get(k)).map((path) => ({ path, base: a.get(path), head: b.get(path) }));
}

function parseArgs(argv) {
  const args = { ref: null, allow: false, captureFrom: null, checkout: null, asOracle: false };
  const value = (i) => {
    if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === ALLOW_SURFACE_CHANGE) args.allow = true;
    else if (argv[i] === CAPTURE_FROM) args.captureFrom = value(i++);
    else if (argv[i] === '--checkout') args.checkout = value(i++);
    else if (argv[i] === '--as-oracle') args.asOracle = true;
    else if (!argv[i].startsWith('-') && !args.ref) args.ref = argv[i];
    else throw new Error(`usage: check-off-unchanged.mjs <base-ref> [${ALLOW_SURFACE_CHANGE}] [${CAPTURE_FROM} <ref>]`);
  }
  if (!args.ref) throw new Error(`usage: check-off-unchanged.mjs <base-ref> [${ALLOW_SURFACE_CHANGE}] [${CAPTURE_FROM} <ref>]`);
  return args;
}

// The two files at a commit: { [rel]: { id, bytes } or null }.
function filesAt(plugin, prefix, commit) {
  return Object.fromEntries([SURFACE, RUNNER].map((rel) => {
    const id = spawnSync('git', ['rev-parse', '-q', '--verify', `${commit}:${prefix}${rel}`], { cwd: plugin, encoding: 'utf8' }).stdout.trim();
    if (!id) return [rel, null];
    const blob = spawnSync('git', ['cat-file', 'blob', id], { cwd: plugin, maxBuffer: 64 * 1024 * 1024 });
    if (blob.status !== 0) throw new Error(`git cat-file blob ${id} failed`);
    return [rel, { id, bytes: blob.stdout }];
  }));
}

const usable = (files) => Boolean(files[SURFACE] && files[RUNNER]?.bytes.includes(ORACLE_PROTOCOL));

// The oracle: the merge base's two files, or --capture-from's when the base has none.
export function chooseOracle({ plugin, prefix, base, captureFrom }) {
  const fromBase = filesAt(plugin, prefix, base);
  if (usable(fromBase)) {
    if (captureFrom) throw new Error(`the merge base has its own ${SURFACE} and ${RUNNER}, which are the oracle; ${CAPTURE_FROM} is only for a base without them`);
    return { label: 'the merge base', commit: base, files: fromBase };
  }
  const missing = [SURFACE, RUNNER].filter((rel) => !fromBase[rel]);
  const why = missing.length ? `the merge base has no ${missing.join(' or ')}` : `the merge base's ${RUNNER} cannot be run as the oracle (it predates that)`;
  if (!captureFrom) {
    throw new Error(`${why}, so this checkout's copies would be the only oracle. Rerun with ${CAPTURE_FROM} <ref>, naming a reviewed commit whose ${SURFACE} and ${RUNNER} capture both trees, and check the blob ids it prints`);
  }
  const commit = git(['rev-parse', '--verify', `${captureFrom}^{commit}`], plugin);
  const files = filesAt(plugin, prefix, commit);
  if (!usable(files)) throw new Error(`${CAPTURE_FROM} ${captureFrom} has no ${SURFACE} and ${RUNNER} that can be the oracle`);
  return { label: `${CAPTURE_FROM} ${captureFrom}`, commit, files, why };
}

// Captures the merge base and this checkout with the given capture script
// bytes and prints the differences. Returns 0 or 1.
function compare({ plugin, prefix, ref, base, head, merging, dirty, surface, title, note }) {
  const tmp = mkdtempSync(join(tmpdir(), 'off-unchanged-'));
  const worktree = join(tmp, 'base');
  let added = false, link = null;
  try {
    git(['worktree', 'add', '--detach', '--quiet', worktree, base], plugin);
    added = true;
    const baseTree = join(worktree, prefix);
    if (!existsSync(join(baseTree, 'node_modules'))) symlinkSync(join(plugin, 'node_modules'), link = join(baseTree, 'node_modules'), 'dir');
    // In the base worktree, so its imports resolve as the base's own copy's would.
    const script = join(baseTree, 'scripts', '.off-surface-capture.mjs');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, surface);
    const paths = [...new Set([...publicPaths(plugin), ...publicPaths(baseTree)])].sort();
    const pathsFile = join(tmp, 'paths.json');
    writeFileSync(pathsFile, JSON.stringify(paths));
    const before = capture(script, baseTree, pathsFile);
    const after = capture(script, plugin, pathsFile);
    const diffs = diffSurfaces(before, after);
    console.log(`off-unchanged: ${title}: merge base ${base.slice(0, 12)} (${ref}) vs HEAD ${head.slice(0, 12)}${merging ? ` merging ${merging.slice(0, 12)}` : ''}${dirty ? ' plus uncommitted changes' : ''}`);
    if (note) console.log(`  NOTE ${note}`);
    console.log(`  compared ${flatten(after).size} surface values (${after.tools.length} tools, ${Object.keys(after.resources).length} UI resources, ${Object.keys(after.http).length} HTTP paths)`);
    for (const d of diffs) console.log(`  DIFF ${d.path}: ${describe(d.base, d.head)}`);
    console.log(diffs.length ? `off-unchanged: ${diffs.length} difference(s); list the intended ones in the PR description` : 'off-unchanged: no difference');
    return diffs.length ? 1 : 0;
  } finally {
    // The shared node_modules link goes first, so no cleanup can reach the real modules.
    if (link) unlinkSync(link);
    if (added) spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: plugin });
    rmSync(tmp, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: plugin });
  }
}

// Runs the oracle's runner from a temporary file as --as-oracle. Returns its exit code.
function runOracle(oracle, plugin, args) {
  const tmp = mkdtempSync(join(tmpdir(), 'off-unchanged-oracle-'));
  try {
    const file = join(tmp, 'check-off-unchanged.mjs');
    writeFileSync(file, oracle.files[RUNNER].bytes);
    const r = spawnSync(process.execPath, [file, args.ref, '--checkout', plugin, '--as-oracle', ...(args.allow ? [ALLOW_SURFACE_CHANGE] : []), ...(args.captureFrom ? [CAPTURE_FROM, args.captureFrom] : [])],
      { cwd: plugin, stdio: 'inherit' });
    return r.status ?? 2;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const worst = (a, b) => (a === 2 || b === 2 ? 2 : Math.max(a, b));

function main(argv) {
  const args = parseArgs(argv);
  const plugin = args.checkout ? resolve(args.checkout) : HERE;
  const prefix = git(['rev-parse', '--show-prefix'], plugin);
  const head = git(['rev-parse', 'HEAD'], plugin);
  // During an uncommitted merge the working tree is the merge commit to be
  // made, so the base is taken against HEAD and MERGE_HEAD together.
  const merging = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: plugin, encoding: 'utf8' }).stdout.trim();
  const base = git(['merge-base', args.ref, 'HEAD', ...(merging ? [merging] : [])], plugin);
  // Untracked files are captured too, so they count as uncommitted.
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', '.'], plugin);
  const oracle = chooseOracle({ plugin, prefix, base, captureFrom: args.captureFrom });
  const edited = [SURFACE, RUNNER].filter((rel) => !existsSync(join(plugin, rel)) || !readFileSync(join(plugin, rel)).equals(oracle.files[rel].bytes));
  if (edited.length && !args.allow) {
    throw new Error(`this checkout's ${edited.join(' and ')} ${edited.length > 1 ? 'differ' : 'differs'} from ${oracle.label}'s, so a change could hide itself from this check. Review that edit, then rerun with ${ALLOW_SURFACE_CHANGE} to see the results with ${oracle.label}'s copies and with this checkout's`);
  }
  const context = { plugin, prefix, ref: args.ref, base, head, merging, dirty };
  if (args.asOracle) {
    const note = edited.length ? `${edited.join(' and ')} differ${edited.length > 1 ? '' : 's'} from these copies (${ALLOW_SURFACE_CHANGE}); surface this checkout's edit adds is not compared` : null;
    return compare({ ...context, surface: oracle.files[SURFACE].bytes, title: `${oracle.label}'s copies`, note });
  }
  console.log(`off-unchanged: oracle ${oracle.label} (${oracle.commit.slice(0, 12)})${oracle.why ? `, because ${oracle.why}` : ''}`);
  for (const rel of [SURFACE, RUNNER]) console.log(`  ${rel} blob ${oracle.files[rel].id}${edited.includes(rel) ? ' (this checkout differs)' : ''}`);
  const fromOracle = runOracle(oracle, plugin, args);
  if (!edited.length) return fromOracle;
  let fromCheckout;
  try {
    fromCheckout = compare({ ...context, surface: readFileSync(join(plugin, SURFACE)), title: "this checkout's copies" });
  } catch (error) {
    console.log(`off-unchanged: this checkout's copies: could not run: ${error.message}`);
    fromCheckout = 2;
  }
  console.log(`off-unchanged: exit ${fromOracle} with ${oracle.label}'s copies, ${fromCheckout} with this checkout's (${ALLOW_SURFACE_CHANGE})`);
  return worst(fromOracle, fromCheckout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-off-unchanged: ${error.message}`);
    process.exitCode = 2;
  }
}
