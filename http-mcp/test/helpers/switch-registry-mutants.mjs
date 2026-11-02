// Mutants for the feature switch files and their contract view (docs/SWITCHES.md).
// Run from http-mcp: node test/helpers/switch-registry-mutants.mjs [out.jsonl]
// Each mutation runs its test files in a private mirror under TMPDIR; the
// checkout is never written. A mutant is killed only when a named test fails.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registry = 'test/switch-registry.test.mjs', equivalence = 'test/config-equivalence.test.mjs';
const validate = 'deploy/test/validate-package.test.mjs', preflight = 'deploy/test/preflight-env.test.mjs';
const stage = 'deploy/test/stage-runtime.test.mjs', defaults = 'test/env-contract-defaults.test.mjs', offCheck = 'test/check-off-unchanged.test.mjs';
// [name, file, before, after, test files]
export const mutations = [
  ['wrong default in a switch file', 'src/switches/DACS_SHOWCASE_RECEIPT.switch', '"default": "off"', '"default": "on"', [registry, equivalence]],
  ['wrong default in the shared enum parse', 'src/config.mjs', 'const value = env[s.env] ?? s.default;', 'const value = env[s.env] ?? s.values.at(-1);', [registry]],
  ['held value accepted (switch file)', 'src/switches/DACS_SELLER_WRITE_BATCHES.switch', '  "held": {\n    "on": "DACS_SELLER_WRITE_BATCHES=on is held until native SDK preparation and batch transport integration are reviewed"\n  },\n', '', [registry, equivalence]],
  ['held value accepted (shared parse)', 'src/config.mjs', '    if (Object.hasOwn(s.held, value)) throw new ConfigError(s.held[value]);\n', '', [registry]],
  ['wrong deploy value accepted by validate-package', 'deploy/scripts/lib/rules.mjs', '...(s.deployValue !== null && s.deployValue !== undefined ? { deployValue: s.deployValue } : {}),', '', [validate]],
  ['wrong deploy value accepted by preflight', 'deploy/scripts/lib/rules.mjs', '...(s.deployValue !== null && s.deployValue !== undefined ? { deployValue: s.deployValue } : {}),', '', [preflight]],
  ['switch entries missing from the shared contract view', 'deploy/scripts/lib/rules.mjs', 'return { ...contract, variables: { ...contract.variables, ...entries } };', 'return { ...contract, variables: { ...contract.variables } };', [preflight, 'deploy/test/stage-runtime.test.mjs', registry]],
  ['switch entries missing from validate-package\'s view', 'deploy/scripts/validate-package.mjs', 'ctx.contract = { ...contract, variables: { ...contract.variables, ...switches.entries } };', 'ctx.contract = { ...contract, variables: { ...contract.variables } };', [validate]],
  ['switch names missing from the runtime names', 'deploy/scripts/lib/rules.mjs', '...envNamesFromSource(configSource), ...Object.keys(switchEntries)', '...envNamesFromSource(configSource)', [validate]],
  ['contract entry differs from runtime parsing', 'deploy/scripts/lib/rules.mjs', "...(s.kind === 'enum' ? { values: [...s.values] } : {}),", "...(s.kind === 'enum' ? { values: [...s.values, 'auto'] } : {}),", [registry]],
  ['changed first-error precedence (switch order)', 'src/switches/DACS_SELLER_WRITE_BATCHES.switch', '"order": 20', '"order": 35', [registry, equivalence]],
  // Identity writes checked ahead of the whole switch block, as if the block came after it.
  ['changed first-error precedence (switches after identity writes)', 'src/config.mjs', '  const switches = parseSwitches(env, { before: COMMIT_ON_SIGNATURE_ORDER });\n', "  if (!['held', 'simulated-fixture-only'].includes(env.DACS_IDENTITY_WRITES || 'held')) throw new ConfigError('DACS_IDENTITY_WRITES must be held or simulated-fixture-only');\n  const switches = parseSwitches(env, { before: COMMIT_ON_SIGNATURE_ORDER });\n", [registry, equivalence]],
  // Same text as today for two-value enums; the registry test's three-value switch tells them apart.
  ['enum error message changed', 'src/config.mjs', "const choices = (values) => `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;", "const choices = (values) => values.join(' or ');", [registry, equivalence]],
  ['malformed switch file accepted', 'src/switch-files.mjs', "    if (!values.includes(entry.default)) throw fail('default must be one of values');\n", '', [registry]],
  // One shared parser, sound env names, a non-pinning equivalence test, the off check.
  ['duplicate JSON keys accepted', 'src/switch-files.mjs', '  if (duplicate !== null) throw', '  if (false) throw', [registry, validate]],
  ['symbolic link switch file followed', 'src/switch-files.mjs', '    if (!type.isFile()) {', '    if (!type.isFile() && !type.isSymbolicLink()) {', [registry, validate]],
  ['missing switch directory tolerated', 'src/switch-files.mjs', "    fail(null, 'the directory is missing; the package is incomplete (every package ships its switch files)');\n", '', [registry, validate, preflight]],
  ['flag held value ignored', 'src/config.mjs', "      if (env[s.env] === '1' && Object.hasOwn(s.held, '1')) throw new ConfigError(s.held['1']);\n", '', [registry]],
  ['static entry shadowed by a switch in the contract view', 'deploy/scripts/lib/rules.mjs', '  if (shadow) throw', '  if (false) throw', [registry, preflight]],
  ['validate-package skips the runtime loadConfig check', 'deploy/scripts/validate-package.mjs', "  } catch (error) { return switchError(error) || failed('calling loadConfig', error); }", '  } catch { /* skipped */ }', [validate]],
  ['bracket env reads not counted', 'deploy/scripts/lib/rules.mjs', '        names.add(value);\n', '', [validate, registry]],
  ['computed env reads accepted', 'deploy/scripts/lib/rules.mjs', "      } else ok = token === 'env' && /^\\s*\\[\\s*s\\s*\\.\\s*env\\s*\\]/.test(rest) && inSwitchLoop(m.index);", '      } else ok = true;', [validate]],
  ['source and packed switch files not compared when staging', 'deploy/scripts/stage-runtime.mjs', '  if (missing.length || extra.length) {', '  if (false) {', [stage]],
  ['static contract default drifts from loadConfig', 'src/config.mjs', "env.DACS_CHAIN_TIMEOUT_MS, 10000,", "env.DACS_CHAIN_TIMEOUT_MS, 5000,", [defaults]],
  ['off check captures with an edited off-surface.mjs', 'scripts/check-off-unchanged.mjs', '  if (edited.length && !args.allow) {', '  if (false) {', [offCheck]],
  ['converted switch order 25 -> 35', 'src/switches/DACS_PORTAL_AUTO_ADVANCE.switch', '"order": 25', '"order": 35', [equivalence]],
  // The package code child, its confinement, the env scan, the off check's oracle.
  ['package code check: a failure record counted as a pass', 'deploy/scripts/validate-package.mjs', "  if (record.result === 'failed') return fail(", "  if (record.result === 'failed') return { unconfined: false }; (", [validate]],
  ['package code check: empty output counted as a pass', 'deploy/scripts/validate-package.mjs', '  if (!isRecord(record) || record.nonce !== nonce) {', '  if (!r.stdout) return { unconfined: false };\n  if (!isRecord(record) || record.nonce !== nonce) {', [validate]],
  ['package code check: the nonce not checked', 'deploy/scripts/validate-package.mjs', '  if (!isRecord(record) || record.nonce !== nonce) {', '  if (!isRecord(record)) {', [validate]],
  ['package code check: the timeout not passed on', 'deploy/scripts/validate-package.mjs', 'timeout: timeoutMs, killSignal', 'timeout: 60_000, killSignal', [validate]],
  ['package code child inherits the full environment', 'deploy/scripts/validate-package.mjs', '    const env = { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };\n    const nonce', '    const env = { ...process.env };\n    const nonce', [validate]],
  ['package code child without the permission model', 'deploy/scripts/validate-package.mjs', '  if (!flag) return null;\n  return [flag, `--allow-fs-read=${dir}`,', '  return null;\n  return [flag, `--allow-fs-read=${dir}`,', [validate]],
  ['package code child may read anywhere', 'deploy/scripts/validate-package.mjs', '`--allow-fs-read=${dir}`', "'--allow-fs-read=*'", [validate]],
  ['env scan: <expr>.env.NAME not counted', 'deploy/scripts/lib/rules.mjs', '      if (name) names.add(name);\n', '      if (name) void name;\n', [validate]],
  ['env scan: any import accepted', 'deploy/scripts/lib/rules.mjs', '    else if (!CONFIG_IMPORTS.includes(specifier)) refuse(', '    else if (false) refuse(', [validate]],
  // Sweep follow-ups: the confinement requirement, the result record's one line, and the contract version.
  ['package code check: a requested permission model not required', 'deploy/scripts/validate-package.mjs', '    if (confine && record.confined !== true) return fail(', '    if (false) return fail(', [validate]],
  ['package code check: output after the record accepted', 'deploy/scripts/validate-package.mjs', "record = lines.length === 2 && lines[1] === '' ? JSON.parse(lines[0])", 'record = lines.length >= 2 ? JSON.parse(lines[0])', [validate]],
  ['env-contract.json version not checked', 'deploy/scripts/lib/rules.mjs', '  return version === ENV_CONTRACT_VERSION ? null', '  return true ? null', [validate]],
  ['env scan: globalThis and global accepted', 'deploy/scripts/lib/rules.mjs', '(?:globalThis|global|eval|Function|arguments|require)', '(?:eval|Function|arguments|require)', [validate]],
  ['off check: the oracle runner not run', 'scripts/check-off-unchanged.mjs', '  const fromOracle = runOracle(oracle, plugin, args);', "  const fromOracle = compare({ ...context, surface: readFileSync(join(plugin, SURFACE)), title: `${oracle.label}'s copies` });", [offCheck]],
  ['off check: this checkout\'s copies used when the base has none', 'scripts/check-off-unchanged.mjs', '  if (!captureFrom) {\n    throw new Error(', "  if (!captureFrom) {\n    return { label: 'this checkout', commit: base, files: Object.fromEntries([SURFACE, RUNNER].map((rel) => [rel, { id: '-', bytes: readFileSync(join(plugin, rel)) }])) };\n    throw new Error(", [offCheck]],
  ['off check: an edited runner not refused', 'scripts/check-off-unchanged.mjs', '  const edited = [SURFACE, RUNNER].filter(', '  const edited = [SURFACE].filter(', [offCheck]],
  // DACS_COMMIT_ON_SIGNATURE and DACS_INTENT_APPROVAL stay static, checked among the switches.
  ['commit on signature checked after every switch', 'src/config.mjs', 'const COMMIT_ON_SIGNATURE_ORDER = 27;', 'const COMMIT_ON_SIGNATURE_ORDER = Infinity;', [registry]],
  ['commit on signature checked before every switch', 'src/config.mjs', 'const COMMIT_ON_SIGNATURE_ORDER = 27;', 'const COMMIT_ON_SIGNATURE_ORDER = -Infinity;', [registry]],
  ['switches ordered 27 and later never checked', 'src/config.mjs', '  Object.assign(switches, parseSwitches(env, { from: COMMIT_ON_SIGNATURE_ORDER }));\n', '', [registry, equivalence]],
  ['intent approval and auto-advance pair accepted', 'src/config.mjs', "  if (intentApproval === 'on' && switches.portalAutoAdvance === 'on') throw", '  if (false) throw', [registry, 'test/start-intent-compose.test.mjs']],
  ['commit on signature returned as its string', 'src/config.mjs', "    commitOnSignature: commitOnSignature === 'on',", '    commitOnSignature,', [registry, 'test/commit-on-signature.test.mjs']],
  ['env scan: env as a later parseSwitches argument accepted', 'deploy/scripts/lib/rules.mjs', '      ok = (/[(,]\\s*$/.test(before)', '      ok = /\\bparseSwitches\\s*\\([^)]*,\\s*$/.test(before) || (/[(,]\\s*$/.test(before)', [validate]],
];

// Every mutation whose text is not exactly once in its file: [name, file, count].
// The runner refuses to start with any, so a stale anchor never ends a run half done.
export function staleAnchors(base = root) {
  return mutations.map(([name, path, before]) => [name, path, readFileSync(join(base, path), 'utf8').split(before).length - 1]).filter(([, , count]) => count !== 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stale = staleAnchors();
  if (stale.length) throw new Error(`Mutation anchors missing or repeated, nothing run:\n${stale.map(([name, path, count]) => `  ${name} (${path}: ${count} matches)`).join('\n')}`);
  const mirror = mkdtempSync(join(tmpdir(), 'switch-registry-mutants-'));
  const results = [];
  try {
    // The mirror has no git history; none of these tests needs it.
    for (const path of readdirSync(root)) if (path !== 'node_modules') cpSync(join(root, path), join(mirror, path), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(mirror, 'node_modules'), 'dir');
    // No --test-force-exit: it can end a file before its tests register and still exit 0.
    const runTest = (test) => {
      const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', '--test-reporter=tap', test], { cwd: mirror, env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 900000, maxBuffer: 50_000_000 });
      return { exit: run.status, failing: [...run.stdout.matchAll(/^not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1]).filter((t) => t !== test) };
    };
    // Tests that fail in the unmutated mirror (staging cannot copy its node_modules link) never count as a kill.
    const baseline = Object.fromEntries([...new Set(mutations.flatMap(([, , , , tests]) => tests))].map((test) => [test, runTest(test).failing]));
    console.log(JSON.stringify({ baseline }));
    for (const [name, path, before, after, tests] of mutations) {
      const file = join(mirror, path), source = readFileSync(file, 'utf8');
      if (source.split(before).length !== 2) throw new Error(`Mutation anchor missing or repeated: ${name}`);
      writeFileSync(file, source.replace(before, after));
      const runs = [];
      try {
        for (const test of tests) {
          const { exit, failing } = runTest(test);
          runs.push({ test, exit, failing, killed: exit !== 0 && failing.some((t) => !baseline[test].includes(t)) });
        }
      } finally { writeFileSync(file, source); }
      const result = { name, killed: runs.some((r) => r.killed), runs };
      results.push(result); console.log(JSON.stringify(result));
    }
  } finally {
    rmSync(mirror, { recursive: true, force: true });
    if (process.argv[2]) writeFileSync(process.argv[2], results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  if (results.some((result) => !result.killed)) process.exitCode = 1;
}
