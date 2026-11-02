// scripts/check-off-unchanged.mjs (docs/SWITCHES.md): its diff, and the CLI in
// throwaway git repositories whose off-surface.mjs prints a committed
// surface.json, so the check runs in seconds without starting the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSurfaces } from '../scripts/check-off-unchanged.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-off-unchanged.mjs', import.meta.url));
const FAKE_SURFACE = "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst surface = JSON.parse(readFileSync(join(process.argv[2], 'surface.json'), 'utf8'));\nprocess.stdout.write(JSON.stringify(surface));\n";
// A blinding edit: the capture no longer records the instructions.
const BLIND_SURFACE = FAKE_SURFACE.replace('JSON.stringify(surface)', 'JSON.stringify({ ...surface, instructions: null })');
// The same, in the runner: its diff skips the instructions.
const blindRunner = (text) => text.replace('.filter((k) => a.get(k) !== b.get(k))', ".filter((k) => a.get(k) !== b.get(k) && !k.includes('instructions'))");
const surface = (instructions) => ({ loadConfigDefaults: { feature: 'off' }, instructions, tools: [{ name: 'a' }], resources: {}, http: { '/health': { status: 200 } } });

test('diffSurfaces lists every changed, added and removed path', () => {
  assert.deepEqual(diffSurfaces({ a: { b: 1, c: [1, 2] }, gone: true }, { a: { b: 2, c: [1, 2, 3] }, added: {} }), [
    { path: '$."a"."b"', base: 1, head: 2 },
    { path: '$."a"."c"[2]', base: undefined, head: 3 },
    { path: '$."added"', base: undefined, head: '{}' },
    { path: '$."gone"', base: true, head: undefined },
  ]);
  assert.deepEqual(diffSurfaces({ x: 'same' }, { x: 'same' }), []);
});

// A git repository with http-mcp/surface.json committed on main, and the
// off-check scripts committed on main too or only on a later branch.
function repository(t, { scriptsOnMain }) {
  const repo = mkdtempSync(join(tmpdir(), 'off-unchanged-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const plugin = join(repo, 'http-mcp');
  mkdirSync(join(plugin, 'node_modules'), { recursive: true });
  writeFileSync(join(plugin, 'surface.json'), JSON.stringify(surface('plain')));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const addScripts = () => {
    mkdirSync(join(plugin, 'scripts'), { recursive: true });
    cpSync(SCRIPT, join(plugin, 'scripts/check-off-unchanged.mjs'));
    writeFileSync(join(plugin, 'scripts/off-surface.mjs'), FAKE_SURFACE);
  };
  if (scriptsOnMain) addScripts();
  git('init', '--quiet', '-b', 'main');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  git('checkout', '--quiet', '-b', 'feature');
  if (!scriptsOnMain) {
    addScripts();
    git('add', '.');
    git('commit', '--quiet', '-m', 'the reviewed off check');
    git('tag', 'reviewed');
  }
  const edit = (rel, content) => writeFileSync(join(plugin, rel), typeof content === 'function' ? content(readFileSync(join(plugin, rel), 'utf8')) : content);
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['scripts/check-off-unchanged.mjs', ...args], { cwd: plugin, encoding: 'utf8' });
    return { ...r, out: r.stdout + r.stderr };
  };
  const blob = (rel) => git('rev-parse', `HEAD:http-mcp/${rel}`);
  return { git, edit, run, blob, plugin };
}

test('with the scripts on the merge base, its copies are the oracle; an edit to either is refused unless allowed', (t) => {
  const { git, edit, run, blob, plugin } = repository(t, { scriptsOnMain: true });
  const same = run('main');
  assert.equal(same.status, 0, same.out);
  assert.match(same.stdout, /oracle the merge base/);
  assert.ok(same.stdout.includes(`scripts/off-surface.mjs blob ${blob('scripts/off-surface.mjs')}`) && same.stdout.includes(`scripts/check-off-unchanged.mjs blob ${blob('scripts/check-off-unchanged.mjs')}`), same.stdout);
  assert.match(same.stdout, /the merge base's copies: merge base .* vs HEAD/);
  assert.match(same.stdout, /off-unchanged: no difference/);

  // A change on the surface (uncommitted here) is reported with its path.
  edit('surface.json', JSON.stringify(surface('changed')));
  const changed = run('main');
  assert.equal(changed.status, 1, changed.out);
  assert.match(changed.stdout, /plus uncommitted changes/);
  assert.match(changed.stdout, /DIFF \$\."instructions": "plain" -> "changed"/);

  for (const [rel, blinded] of [['scripts/off-surface.mjs', BLIND_SURFACE], ['scripts/check-off-unchanged.mjs', blindRunner]]) {
    edit(rel, blinded);
    // Editing the capture script or the runner to hide that change is refused...
    const hidden = run('main');
    assert.equal(hidden.status, 2, hidden.out);
    assert.match(hidden.stderr, new RegExp(`this checkout's ${rel} differs from the merge base's`));
    // ...unless allowed: the merge base's copies still see the change, and this checkout's copies are reported too.
    const allowed = run('main', '--allow-surface-change');
    assert.equal(allowed.status, 1, allowed.out);
    assert.match(allowed.stdout, new RegExp(`${rel} blob \\w+ \\(this checkout differs\\)`));
    assert.match(allowed.stdout, /NOTE .* differs from these copies \(--allow-surface-change\)/);
    assert.match(allowed.stdout, /DIFF \$\."instructions": "plain" -> "changed"/);
    assert.match(allowed.stdout, /this checkout's copies: merge base/);
    assert.match(allowed.stdout, /off-unchanged: exit 1 with the merge base's copies, 0 with this checkout's \(--allow-surface-change\)/);
    git('checkout', '--quiet', '--', `http-mcp/${rel}`);
  }
  // --capture-from is only for a base without the scripts.
  assert.equal(run('main', '--capture-from', 'main').status, 2);

  // An untracked file alone counts as an uncommitted change.
  git('checkout', '--quiet', '--', '.');
  writeFileSync(join(plugin, 'untracked.txt'), 'x');
  assert.match(run('main').stdout, /plus uncommitted changes/);
  assert.equal(run('no-such-ref').status, 2);
});

test('with no scripts on the merge base, the check needs --capture-from and never uses only this checkout\'s copies', (t) => {
  const { edit, run, blob } = repository(t, { scriptsOnMain: false });
  // Not this checkout's copies alone, even when allowed.
  for (const flags of [[], ['--allow-surface-change']]) {
    const refused = run('main', ...flags);
    assert.equal(refused.status, 2, refused.out);
    assert.match(refused.stderr, /the merge base has no scripts\/off-surface\.mjs or scripts\/check-off-unchanged\.mjs, so this checkout's copies would be the only oracle\. Rerun with --capture-from <ref>/);
  }
  // A ref without the scripts cannot be the oracle.
  assert.equal(run('main', '--capture-from', 'main').status, 2);

  // The reviewed commit's copies are the oracle, by blob id.
  const same = run('main', '--capture-from', 'reviewed');
  assert.equal(same.status, 0, same.out);
  assert.match(same.stdout, /oracle --capture-from reviewed \(\w{12}\), because the merge base has no/);
  assert.ok(same.stdout.includes(`scripts/off-surface.mjs blob ${blob('scripts/off-surface.mjs')}`), same.stdout);
  assert.match(same.stdout, /off-unchanged: no difference/);
  edit('surface.json', JSON.stringify(surface('changed')));
  assert.equal(run('main', '--capture-from', 'reviewed').status, 1);

  // A blinding edit: an instructions change plus a capture script that drops them.
  edit('scripts/off-surface.mjs', BLIND_SURFACE);
  const hidden = run('main', '--capture-from', 'reviewed');
  assert.equal(hidden.status, 2, hidden.out);
  assert.match(hidden.stderr, /this checkout's scripts\/off-surface\.mjs differs from --capture-from reviewed's/);
  const allowed = run('main', '--capture-from', 'reviewed', '--allow-surface-change');
  assert.equal(allowed.status, 1, allowed.out);
  assert.match(allowed.stdout, /DIFF \$\."instructions": "plain" -> "changed"/);
  assert.match(allowed.stdout, /off-unchanged: exit 1 with --capture-from reviewed's copies, 0 with this checkout's/);
});
