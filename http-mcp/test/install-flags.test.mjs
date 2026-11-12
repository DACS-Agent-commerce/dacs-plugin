import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const flag = /--omit=optional(?:[\s'"\],;&|]|$)/;
// The wallet-build install is the one install that must keep optional packages:
// esbuild's platform binary is an optional dependency.
const walletBuildStep = /^( *)- run: [^\n]*\n\1 {2}working-directory: http-mcp\/wallet-build\n/gm;

function missingFlags(file, source) {
  // Preserve offsets for diagnostics, including continued shell commands.
  const code = source.replace(/^\s*(?:\/\/|#)[^\n]*/gm, (s) => s.replace(/[^\n]/g, ' '))
    .replace(walletBuildStep, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/\\\r?\n/g, (s) => ' '.repeat(s.length));
  const commands = /\b(installOffline)\([^,]*,\s*\[[^\]]*\]|\bnpm\s+(?:ci|install)\b[^\n;&|`'"]*|\[\s*(?:npmCli\(['"]npm['"]\)\s*,\s*)?['"](?:ci|install)['"][^\]]*\]/g;
  return [...code.matchAll(commands)].filter(([command, helper]) => !helper && !flag.test(command))
    .map((match) => `${file}:${source.slice(0, match.index).split('\n').length}: install requires --omit=optional`);
}

function requireFlags(files) {
  const problems = files.flatMap(([file, source]) => missingFlags(file, source));
  assert.deepEqual(problems, [], problems.join('\n'));
}

function filesUnder(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.name === 'node_modules') return [];
    return entry.isDirectory() ? filesUnder(file) : /\.(?:[cm]?js|sh|json)$/.test(file) && !file.endsWith('package-lock.json') ? [file] : [];
  });
}

test('http-mcp installs always pass --omit=optional', () => {
  const workflows = readdirSync(join(root, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`)
    .filter((file) => /http-mcp|wallet-build/.test(readFileSync(join(root, file), 'utf8')));
  const files = [...filesUnder('http-mcp/scripts'), ...filesUnder('http-mcp/test/helpers'),
    ...filesUnder('http-mcp/wallet-build'), 'http-mcp/package.json',
    'http-mcp/Dockerfile', 'http-mcp/test/overnight-package.test.mjs', ...workflows];
  requireFlags(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
  // These callers use a shared helper that appends the flag to every command.
  const helper = readFileSync(join(root, 'http-mcp/scripts/candidate-archives.mjs'), 'utf8');
  assert.match(helper, /export const installOffline\b[^;]*\.\.\.npmArgs[^;]*['"]--omit=optional['"]/);
  assert.equal(existsSync(join(root, 'http-mcp/.npmrc')), false);
});

test('wallet-build installs keep optional packages so esbuild finds its platform binary', () => {
  const lock = JSON.parse(readFileSync(join(root, 'http-mcp/wallet-build/package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@esbuild/linux-x64'].optional, true);
  const workflow = readFileSync(join(root, '.github/workflows/http-mcp-tests.yml'), 'utf8');
  const installs = [...workflow.matchAll(/^ *- run: (npm (?:ci|install)[^\n]*)\n *working-directory: http-mcp\/wallet-build\n/gm)];
  assert.equal(installs.length, 1);
  assert.doesNotMatch(installs[0][1], /--omit=optional/);
  const instructions = readFileSync(join(root, 'http-mcp/docs/EMBEDDED-WALLET-SDK.md'), 'utf8');
  const buildInstall = instructions.match(/^cd wallet-build\n(npm (?:ci|install)[^\n]*)\n/m);
  assert.ok(buildInstall, 'the build instructions show the wallet-build install');
  assert.doesNotMatch(buildInstall[1], /--omit=optional/);
});

test('install flag fixture exempts only a workflow step that runs in wallet-build', () => {
  const step = (directory) => `    steps:\n      - run: npm ci --ignore-scripts\n        working-directory: ${directory}\n`;
  assert.deepEqual(missingFlags('workflow.yml', step('http-mcp/wallet-build')), []);
  assert.deepEqual(missingFlags('workflow.yml', step('http-mcp')), [
    'workflow.yml:2: install requires --omit=optional',
  ]);
});

test('install flag fixture reports the file and line of each missing flag', () => {
  const file = relative(root, join(root, 'fixtures/install.sh'));
  const source = '# setup\nnpm ci --ignore-scripts\nnpm install --omit=optional && npm ci\n';
  assert.throws(() => requireFlags([[file, source]]), /fixtures\/install\.sh:2:[\s\S]*fixtures\/install\.sh:3:/);
  assert.deepEqual(missingFlags(file, source), [
    'fixtures/install.sh:2: install requires --omit=optional',
    'fixtures/install.sh:3: install requires --omit=optional',
  ]);
  assert.deepEqual(missingFlags('fixture.mjs', "runNpm([\n  'install', tarball\n]);"), [
    'fixture.mjs:1: install requires --omit=optional',
  ]);
  assert.deepEqual(missingFlags('fixture.sh', 'npm ci \\\n  --omit=optional\n'), []);
});
