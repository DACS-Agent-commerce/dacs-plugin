#!/usr/bin/env node
// Captures the default-env ("every switch off") public surface of one plugin
// tree as JSON on stdout. Used by check-off-unchanged.mjs, which runs the
// oracle's copy of this file (the merge base's, or --capture-from's) against
// both the merge base and the checkout, so both sides are captured by the same
// code.
//
//   node scripts/off-surface.mjs <plugin dir> <paths.json>
//
// The surface: loadConfig defaults; the MCP server instructions, tool list
// (names, descriptions, schemas, annotations, _meta) and UI resources (full
// HTML); and, for every path in paths.json plus the fixed portal pages and
// OAuth metadata, the status, body sha256 and headers. The app runs on
// loopback with a private temporary data dir and no chain, directory or
// switch settings. Nothing outside loopback is contacted.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [dirArg, pathsArg] = process.argv.slice(2);
if (!dirArg || !pathsArg) throw new Error('usage: off-surface.mjs <plugin dir> <paths.json>');
const dir = resolve(dirArg);
const load = (rel) => import(pathToFileURL(join(dir, rel)).href);
const { loadConfig } = await load('src/config.mjs');
const { createApp } = await load('src/app.mjs');
const { createLogger } = await load('src/util/log.mjs');

// Headers that vary per run or only restate the body.
const VOLATILE = new Set(['date', 'etag', 'last-modified', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);
// Portal pages served from public/portal/index.html; one per route family.
const PAGES = ['/portal/link', '/portal/authorize/x', '/portal/purchase/x', '/portal/publish/x', '/portal/identity/x', '/health',
  '/.well-known/oauth-protected-resource/mcp', '/oauth/.well-known/openid-configuration'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const dataDir = mkdtempSync(join(tmpdir(), 'off-surface-'));
const server = http.createServer();
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const origin = `http://127.0.0.1:${server.address().port}`;
const normalise = (text) => text.split(origin).join('http://127.0.0.1:PORT').split(dir).join('<plugin>').split(dataDir).join('<data>');
let app;
try {
  const surface = {};
  // Defaults as an operator gets them: only the two required settings.
  surface.loadConfigDefaults = JSON.parse(normalise(JSON.stringify(loadConfig({ DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) }))));
  const config = loadConfig({ DACS_PUBLIC_ORIGIN: origin, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64), DACS_DATA_DIR: dataDir, DACS_LOG_LEVEL: 'error' });
  app = await createApp({ config, logger: createLogger({ level: 'error', sink: () => {} }) });
  server.on('request', app.app);

  const client = new Client({ name: 'off-surface', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  surface.serverVersion = client.getServerVersion();
  surface.instructions = client.getInstructions();
  surface.tools = (await client.listTools()).tools;
  surface.resources = {};
  for (const resource of (await client.listResources()).resources) {
    surface.resources[resource.uri] = { listing: resource, contents: (await client.readResource({ uri: resource.uri })).contents };
  }
  await client.close();

  surface.http = {};
  for (const path of [...PAGES, ...JSON.parse(readFileSync(pathsArg, 'utf8'))]) {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries([...response.headers].filter(([name]) => !VOLATILE.has(name)).sort(([a], [b]) => (a < b ? -1 : 1)));
    const type = headers['content-type'] ?? '';
    const text = /^(text\/|application\/(json|javascript))/.test(type) ? normalise(body.toString('utf8')) : null;
    surface.http[path] = { status: response.status, headers: JSON.parse(normalise(JSON.stringify(headers))), ...(text === null ? { bytes: body.length, sha256: sha256(body) } : { bytes: Buffer.byteLength(text), sha256: sha256(text) }) };
  }
  process.stdout.write(`${normalise(JSON.stringify(surface))}\n`);
} finally {
  const closed = new Promise((ok) => server.close(ok));
  server.closeAllConnections?.();
  await closed;
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}
