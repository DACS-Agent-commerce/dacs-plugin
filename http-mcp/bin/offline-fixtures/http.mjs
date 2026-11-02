// Small loopback HTTP helpers shared by the offline tester fixtures. Every
// fixture listens on 127.0.0.1 only, bounds request bodies and times, and
// marks responses with x-dacs-simulation so the plugin labels its evidence
// as simulated.
import http from 'node:http';

export const SIMULATION_HEADERS = Object.freeze({ 'x-dacs-simulation': 'fixture', 'cache-control': 'no-store' });
export const MAX_BODY_BYTES = 256 * 1024;

export class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...SIMULATION_HEADERS, ...extraHeaders });
  res.end(text);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text), ...SIMULATION_HEADERS, ...extraHeaders });
  res.end(text);
}

// Reads at most maxBytes; a larger body is refused with 413 before parsing.
export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyError(413, 'request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req, maxBytes) {
  const text = await readBody(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, 'request body is not JSON');
  }
}

// Creates a server bound to 127.0.0.1 with bounded timeouts. The handler may
// throw a BodyError; anything else becomes a 500 without echoing details.
export function createLoopbackServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof BodyError) {
        sendJson(res, error.status, { error: error.message }, { connection: 'close' });
        if (error.status === 413) req.destroy();
        return;
      }
      sendJson(res, 500, { error: 'fixture_error' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  return server;
}

export function listenLoopback(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

// Closes one owned server: stops accepting, drops idle and then any remaining
// connections, and resolves once the listening handle is gone.
export function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}
