import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Deps } from '../../src/server.js';

// Run the real module with mocked I/O and constructors on both supported Node
// versions, without starting a listener or writing an authentication file.
const source = readFileSync(new URL('../../src/http_transport.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Failure = 'server' | 'transport' | 'connect' | 'request' | undefined;

class Response extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  status = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  end(body: string): void {
    this.body = body;
    this.writableEnded = true;
    this.emit('close');
  }
}

async function requestWithFailure(failure: Failure) {
  const calls = { server: 0, transport: 0, connect: 0, request: 0, serverClosed: 0, transportClosed: 0, responseClosed: 0 };
  const fail = (stage: Failure) => {
    if (failure === stage) throw new Error(`${stage} failed`);
  };
  let handler: (request: object, response: Response) => Promise<void>;
  const http = {
    once() {},
    listen(_port: number, _host: string, ready: () => void) { ready(); },
    address: () => ({ address: '127.0.0.1', port: 12345 }),
    close(done: () => void) { done(); },
  };
  const modules: Record<string, unknown> = {
    'node:crypto': {
      randomBytes: () => ({ toString: () => 'unit-test-placeholder' }),
      timingSafeEqual: (left: Buffer, right: Buffer) => left.equals(right),
    },
    'node:fs': { mkdirSync() {}, writeFileSync() {}, chmodSync() {} },
    'node:path': { join },
    'node:http': {
      createServer(callback: typeof handler) { handler = callback; return http; },
    },
    './server.js': {
      createServer() {
        calls.server += 1;
        fail('server');
        return {
          async connect() { calls.connect += 1; fail('connect'); },
          async close() { calls.serverClosed += 1; },
        };
      },
    },
    '@modelcontextprotocol/sdk/server/streamableHttp.js': {
      StreamableHTTPServerTransport: class {
        constructor() { calls.transport += 1; fail('transport'); }
        async handleRequest(_request: object, response: Response) {
          calls.request += 1;
          fail('request');
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        }
        async close() { calls.transportClosed += 1; }
      },
    },
  };
  const exports = {} as typeof import('../../src/http_transport.js');
  runInNewContext(compiled, {
    exports,
    Buffer,
    require(name: string) {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  const deps = { surface: 'keyless', config: { stateDir: '/unused' } } as Deps;
  const listening = await exports.listenKeyless(deps);
  const response = new Response();
  response.once('close', () => { calls.responseClosed += 1; });
  try {
    await assert.doesNotReject(handler!({
      method: 'POST', url: '/mcp',
      headers: { authorization: 'Bearer unit-test-placeholder', host: '127.0.0.1:12345' },
    }, response));
    assert.equal(response.writableEnded, true);
    assert.equal(calls.responseClosed, 1);
    assert.equal(response.headers['content-type'], 'application/json');
    return { response, calls };
  } finally {
    await listening.close();
  }
}

for (const failure of ['server', 'transport', 'connect', 'request'] as const) {
  test(`keyless http ends with 500 and cleans up when ${failure} fails`, async () => {
    const { response, calls } = await requestWithFailure(failure);
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), { error: 'transport failed' });
    assert.equal(calls.server, 1);
    assert.equal(calls.transport, failure === 'server' ? 0 : 1);
    assert.equal(calls.connect, failure === 'server' || failure === 'transport' ? 0 : 1);
    assert.equal(calls.request, failure === 'request' ? 1 : 0);
    assert.equal(calls.serverClosed, failure === 'server' ? 0 : 1);
    assert.equal(calls.transportClosed, failure === 'server' || failure === 'transport' ? 0 : 1);
  });
}

test('keyless http closes both resources after a successful request', async () => {
  const { response, calls } = await requestWithFailure(undefined);
  assert.equal(response.status, 200);
  assert.equal(response.body, '{}');
  assert.equal(calls.request, 1);
  assert.equal(calls.serverClosed, 1);
  assert.equal(calls.transportClosed, 1);
});
