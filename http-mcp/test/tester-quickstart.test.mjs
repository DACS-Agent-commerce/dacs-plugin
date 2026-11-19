// Tester quickstart: the guide ships in the package, names real package
// paths/settings, keeps account creation inside the user's own wallet, and
// its documented loopback startup really answers /health and MCP with honest
// not_configured results. The installed-tarball boot is covered by
// `npm run check:package`; this file boots the source binary the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SWITCHES } from '../src/config.mjs';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/TESTER-QUICKSTART.md';
const doc = readFileSync(join(root, DOC), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the quickstart is part of the packed package', async () => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = JSON.parse(stdout)[0].files.map((f) => f.path);
  assert.ok(files.includes(DOC), `${DOC} is packed`);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /docs\/TESTER-QUICKSTART\.md/, 'README links the quickstart');
});

test('the quickstart names the real package, binary, engine and tarball', () => {
  const [binName] = Object.keys(pkg.bin);
  assert.match(doc, new RegExp(`npx ${binName}\\b`));
  assert.ok(doc.includes(`Node.js \`${pkg.engines.node}\` (\`engines.node\`)`));
  const tarball = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
  assert.ok(doc.includes(tarball), `documents the npm pack file name ${tarball}`);
  assert.match(doc, /--ignore-scripts/);
  assert.match(doc, /not published to npm/);
});

// Every documentation link must work in the installed package: it resolves to
// a packed file, never outside the package root. A reference that only makes
// sense in a source checkout must say so on the same line.
test('documentation links resolve inside the packed package (or say "source checkout")', async () => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = new Set(JSON.parse(stdout)[0].files.map((f) => f.path));
  const docs = [...files].filter((p) => p === 'README.md' || /^(docs|skills)\/.+\.md$/.test(p)).sort();
  assert.ok(docs.includes('docs/TESTING.md') && docs.includes('docs/TESTER-QUICKSTART.md'), 'tester docs are packed');
  let checked = 0;
  const sourceOnly = [];
  for (const docPath of docs) {
    const lines = readFileSync(join(root, docPath), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/`((?:\.\.?\/)*[\w./-]+\.(?:md|example))`|\]\(([^)#:\s]+)\)/g)) {
        const ref = m[1] ?? m[2];
        const resolved = posix.normalize(posix.join(posix.dirname(docPath), ref));
        const where = `${docPath}:${i + 1} -> ${ref}`;
        assert.ok(!resolved.startsWith('..'), `${where} points outside the package`);
        if (files.has(resolved)) { checked += 1; continue; }
        assert.match(line, /source checkout/, `${where} is not packed and is not marked source-checkout-only`);
        sourceOnly.push(where);
      }
    });
  }
  assert.ok(checked >= 10, `checked ${checked} packed links`);
  assert.deepEqual(sourceOnly, [
    'README.md:29 -> PROVENANCE.md',
    'README.md:190 -> PROVENANCE.md',
    'docs/CHATGPT-DEVELOPER-MODE.md:73 -> ../deploy/dacs-chatgpt.env.example',
    'docs/CI.md:5 -> PROVENANCE.md',
    'docs/EMBEDDED-WALLET-PACKAGING.md:52 -> AGENTS.md',
    'docs/EMBEDDED-WALLET-PACKAGING.md:52 -> STATUS.md',
    'docs/EMBEDDED-WALLET-PACKAGING.md:52 -> ACCEPTANCE.md',
    'docs/SHOWCASE-SAFETY.md:168 -> ../src/devnet-demo/artifact-anchor.mjs',
    'docs/TESTING.md:3 -> PROVENANCE.md',
  ]);
});

test('every setting the quickstart mentions is a real configuration variable', () => {
  // src/config.mjs names plus the feature switch files (docs/SWITCHES.md).
  const known = new Set([...readFileSync(join(root, 'src/config.mjs'), 'utf8').matchAll(/\bDACS_[A-Z_]+/g)].map((m) => m[0]).concat(SWITCHES.map((s) => s.env)));
  const mentioned = new Set([...doc.matchAll(/\bDACS_[A-Z_]+/g)].map((m) => m[0]));
  assert.ok(mentioned.size >= 5);
  for (const name of mentioned) assert.ok(known.has(name), `${name} is read by src/config.mjs`);
});

test('every relative file the quickstart points at exists', () => {
  const refs = [...doc.matchAll(/`((?:\.\.\/)?[\w./-]+\.(?:md|example))`/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4);
  for (const ref of refs) assert.ok(existsSync(join(root, 'docs', ref)), `${ref} exists relative to docs/`);
});

test('account creation stays inside the user\'s own wallet, and open items stay open', () => {
  assert.match(doc, /only inside the Demos wallet extension/);
  assert.match(doc, /never ask for, display, store or log a seed phrase, mnemonic or private key/);
  assert.match(doc, /never create a wallet for you/);
  assert.match(doc, /public address/);
  assert.match(doc, /never merges two plugin accounts/);
  assert.match(doc, /fixed-price DEM testnet/);
  assert.match(doc, /\*\*Buyers\*\*/);
  assert.match(doc, /\*\*Sellers\*\*/);
  // The plain-string sign request matches the reviewed 0.5.7 source only; the
  // installed wallet and its network stay unconfirmed.
  assert.match(doc, /`params: \[message\]`/);
  assert.match(doc, /matches the source only/);
  assert.match(doc, /\*\*not\*\* been tried with an installed wallet/);
  assert.match(doc, /A label in the portal is not proof/);
  assert.match(doc, /has \*\*not\*\* been accepted/);
  // No instructions to paste secrets anywhere.
  assert.doesNotMatch(doc, /(enter|paste|type) (your )?(seed|mnemonic|private key)/i);
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});

// The card-owned startup failure (P42aa) is Node's report of one missing module and nothing else.
// Every nonblank line of the complete stderr must belong to that report; any other line is a different failure.
const CARD_CAUSE = /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module '(?:[^'\n]*\/)?src\/util\/purchase-readback-cache\.mjs' imported from \S.*\.m?js$/;
const NODE_REPORT_LINES = [
  /^node:internal\/[\w/.-]+:\d+$/,
  /^ {4}throw new ERR_MODULE_NOT_FOUND\($/,
  /^ +\^$/,
  /^ {4}at (?:\S+ \(node:internal\/[\w/.-]+:\d+:\d+\)|node:internal\/[\w/.-]+:\d+:\d+)(?: \{)?$/,
  /^ {2}code: 'ERR_MODULE_NOT_FOUND',$/,
  /^ {2}url: 'file:\/\/[^'\n]*\/src\/util\/purchase-readback-cache\.mjs'$/,
  /^\}$/,
  /^Node\.js v\d+\.\d+\.\d+$/,
];
function onlyCardCause(stderr) {
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.filter((line) => CARD_CAUSE.test(line)).length === 1 &&
    lines.every((line) => CARD_CAUSE.test(line) || NODE_REPORT_LINES.some((pattern) => pattern.test(line)));
}

// Waits for `child` to answer /health and MCP, then checks its SIGTERM shutdown.
// `beforeShutdown(exited)` lets a fixture finish exiting before that check.
// A startup failure is reported only after the child has stopped and its stderr is complete.
async function checkLoopbackServer(child, origin, beforeShutdown, diagnostic = () => {}) {
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const closed = new Promise((resolve) => child.once('close', resolve));
  let startupFailed = false;
  try {
    let health = null;
    for (let i = 0; i < 50 && !health; i += 1) {
      await Promise.race([new Promise((r) => setTimeout(r, 200)), exited]);
      if (child.exitCode !== null || child.signalCode || /Cannot find module/i.test(stderr)) {
        startupFailed = true;
        break;
      }
      health = await fetch(`${origin}/health`).then((r) => r.json()).catch(() => null);
    }
    if (!startupFailed) {
      assert.equal(health?.status, 'ok', stderr.slice(0, 300));
      assert.equal(health.dependencies.directory.configured, false);
      assert.equal(health.dependencies.chain.configured, false);
      const client = new Client({ name: 'quickstart', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
      try {
        const { tools } = await client.listTools();
        assert.ok(tools.some((t) => t.name === 'search_agents'));
        const search = await client.callTool({ name: 'search_agents', arguments: {} });
        assert.equal(search.isError, true);
        assert.match(search.content[0].text, /not configured/);
      } finally {
        await client.close();
      }
    }
  } finally {
    await beforeShutdown?.(exited);
    const running = child.exitCode === null && !child.signalCode;
    if (startupFailed) {
      // The startup error is the one to report; only stop a process that is still up.
      if (running) { child.kill('SIGTERM'); await exited; }
      await closed;
      diagnostic(stderr);
    } else {
      assert.ok(running, `server exited on its own before SIGTERM (${child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`})`);
      child.kill('SIGTERM');
      assert.equal(await exited, 0, 'graceful SIGTERM shutdown');
    }
  }
  if (startupFailed) {
    // The child has exited and its stderr has closed, so this is the complete output.
    assert.ok(!onlyCardCause(stderr), 'Quickstart startup failed: missing src/util/purchase-readback-cache.mjs');
    throw new Error(stderr.trim() || `Server exited before /health answered (${child.exitCode ?? child.signalCode})`);
  }
}

test('the documented loopback startup answers /health and MCP with honest not_configured results', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'dacs-quickstart-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, pkg.bin['dacs-chatgpt-plugin'])], {
    cwd: work,
    // Exactly the variables the quickstart sets, nothing inherited.
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_DATA_DIR: join(work, 'data'), DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'), DACS_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await checkLoopbackServer(child, origin, undefined, (stderr) => t.diagnostic(stderr));
  } finally {
    rmSync(work, { recursive: true });
  }
});

test('the startup check fails a server that answers, then exits by itself before SIGTERM', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'test/fixtures/quickstart-exits-by-itself.mjs')], {
    env: { PATH: process.env.PATH, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await assert.rejects(checkLoopbackServer(child, `http://127.0.0.1:${port}`, (exited) => exited), /server exited on its own before SIGTERM \(exit code 0\)/);
  } finally {
    child.kill('SIGKILL');
  }
});

// A real Node process that crashes on the card's missing module, with optional other stderr
// before the crash or while it is being stopped.
function cardCrash(work, { before = '', onSigterm = null } = {}) {
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src/app.mjs'), "import './util/purchase-readback-cache.mjs';\n");
  const script = [
    "import { spawnSync } from 'node:child_process';",
    `process.stderr.write(${JSON.stringify(before)});`,
    `spawnSync(process.execPath, [${JSON.stringify(join(work, 'src/app.mjs'))}], { stdio: ['ignore', 'ignore', 'inherit'] });`,
    onSigterm === null
      ? 'process.exitCode = 1;'
      : `process.on('SIGTERM', () => process.stderr.write(${JSON.stringify(onSigterm)}, () => process.exit(1))); setInterval(() => {}, 1000);`,
  ].join('\n');
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
}

const CARD_MESSAGE = 'Quickstart startup failed: missing src/util/purchase-readback-cache.mjs';

test('the startup check reports the card message for Node\'s complete missing-module report', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dacs-quickstart-card-'));
  const child = cardCrash(work);
  try {
    await assert.rejects(checkLoopbackServer(child, `http://127.0.0.1:${await freePort()}`), { message: CARD_MESSAGE });
  } finally {
    child.kill('SIGKILL');
    rmSync(work, { recursive: true });
  }
});

test('the startup check reports an unrelated stderr line beside the missing module as its own failure', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dacs-quickstart-card-'));
  const child = cardCrash(work, { before: 'unrelated failure: response was invalid\n' });
  try {
    await assert.rejects(checkLoopbackServer(child, `http://127.0.0.1:${await freePort()}`), (error) =>
      error.message !== CARD_MESSAGE && error.message.includes('unrelated failure: response was invalid'));
  } finally {
    child.kill('SIGKILL');
    rmSync(work, { recursive: true });
  }
});

test('the startup check includes stderr written while the failed server is stopped', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dacs-quickstart-card-'));
  const child = cardCrash(work, { onSigterm: 'TypeError: unrelated teardown failure\n' });
  try {
    await assert.rejects(checkLoopbackServer(child, `http://127.0.0.1:${await freePort()}`), (error) =>
      error.message !== CARD_MESSAGE && error.message.includes('TypeError: unrelated teardown failure'));
  } finally {
    child.kill('SIGKILL');
    rmSync(work, { recursive: true });
  }
});
