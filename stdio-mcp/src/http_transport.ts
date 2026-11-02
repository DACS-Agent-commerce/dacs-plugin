/**
 * Local streamable-HTTP transport for the keyless surface.
 * Binds 127.0.0.1 only. Each request gets its own server. No keystore and no submit.
 * A per-start bearer lives only in a mode-0600 file. Host and Origin must be local.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type Deps } from './server.js';

export const KEYLESS_BIND = '127.0.0.1';
export const AUTH_FILE_NAME = 'http-auth.json';

function headerOne(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return undefined;
  return value.trim();
}

function localHosts(port: number): Set<string> {
  const text = String(port);
  return new Set([`127.0.0.1:${text}`, `localhost:${text}`, `[::1]:${text}`]);
}

function localOrigins(port: number): Set<string> {
  const text = String(port);
  return new Set([`http://127.0.0.1:${text}`, `http://localhost:${text}`, `http://[::1]:${text}`]);
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function writeAuthFile(stateDir: string, token: string): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, AUTH_FILE_NAME);
  writeFileSync(path, JSON.stringify({ bearer: token }) + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'forbidden' }));
}

export async function listenKeyless(deps: Deps, port = 0): Promise<{ url: string; port: number; authPath: string; close: () => Promise<void> }> {
  if (deps.surface !== 'keyless') throw new Error('HTTP transport requires the keyless surface');
  const token = randomBytes(32).toString('hex');
  const authPath = writeAuthFile(deps.config.stateDir, token);
  let boundPort = 0;
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!bearerMatches(headerOne(req.headers.authorization), token)) {
      refuse(res, 401);
      return;
    }
    const host = headerOne(req.headers.host);
    if (!host || !localHosts(boundPort).has(host.toLowerCase())) {
      refuse(res, 403);
      return;
    }
    const origin = headerOne(req.headers.origin);
    if (origin !== undefined && !localOrigins(boundPort).has(origin)) {
      refuse(res, 403);
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'keyless', holds_keys: false, submit: false }));
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const mcp = createServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'transport failed' }));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, KEYLESS_BIND, () => {
      const addr = http.address();
      if (!addr || typeof addr === 'string' || addr.address !== KEYLESS_BIND) {
        http.close();
        reject(new Error('HTTP transport refused a non-local bind'));
        return;
      }
      boundPort = addr.port;
      resolve();
    });
  });
  return {
    url: `http://${KEYLESS_BIND}:${boundPort}/mcp`,
    port: boundPort,
    authPath,
    close: () => new Promise((resolve, reject) => http.close((err) => (err ? reject(err) : resolve()))),
  };
}
