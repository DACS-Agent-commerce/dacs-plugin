/**
 * Approval links stop working at their deadline, and the page takes decisions
 * only from its own origin. Drives the real handler without opening a listener.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalServer } from '../../src/approval.js';
import { loadConfig } from '../../src/config.js';

const card = { headline: 'Approve', rows: [['Amount', '1 DEM']] as Array<[string, string]>, digest: 'a'.repeat(64) };

function fixture(t: TestContext, base = 'http://127.0.0.1:32123') {
  let now = 1000;
  const decisions: Array<[string, boolean]> = [];
  const page = new ApprovalServer('127.0.0.1', 0, base, () => now);
  t.mock.method(page, 'start', async () => {});
  page.setDecisionHandler((id, ok) => decisions.push([id, ok]));
  const host = new URL(base).host;
  function request(url: string, { method = 'POST', origin, body = '' }: { method?: string; origin?: string; body?: string } = {}) {
    const req: any = new PassThrough();
    req.method = method;
    req.url = new URL(url).pathname;
    req.headers = { host, ...(origin === undefined ? {} : { origin }) };
    let resolve!: (r: { status: number; body: string }) => void;
    const done = new Promise<{ status: number; body: string }>((r) => (resolve = r));
    const res: any = {
      writeHead(status: number) {
        this.status = status;
      },
      end(text: string) {
        resolve({ status: this.status, body: text });
      },
    };
    (page as any).handle(req, res);
    return { done, end: () => req.end(body) };
  }
  return { page, decisions, request, setNow: (n: number) => (now = n) };
}

test('registration replaces only its own live token and prunes expired ones', async (t) => {
  const h = fixture(t);
  const a = await h.page.register('A', card, 2000);
  const b = await h.page.register('B', card, 2000);
  const expired = await h.page.register('old', card, 1000);
  const next = await h.page.register('A', card, 2000);
  for (const url of [a, expired]) assert.equal((await h.request(url + '/approve').done).status, 404);
  for (const url of [b, next]) assert.equal((await h.request(url + '/approve').done).status, 200);
  assert.deepEqual(h.decisions, [['B', true], ['A', true]]);
});

test('a public URL ending in a slash still yields a working /a/<token> link', async (t) => {
  const h = fixture(t, 'https://approve.example/');
  const url = await h.page.register('A', card, 2000);
  assert.match(url, /^https:\/\/approve\.example\/a\/[A-Za-z0-9_-]{43}$/);
  assert.equal((await h.request(url, { method: 'GET' }).done).status, 200);
});

test('an approval posted exactly at its deadline is refused', async (t) => {
  const h = fixture(t);
  const url = await h.page.register('A', card, 2000);
  h.setNow(2000);
  assert.equal((await h.request(url + '/approve').done).status, 404);
  assert.deepEqual(h.decisions, []);
});

test('an interactive approval whose body completes at the deadline never runs onApprove', async (t) => {
  const h = fixture(t);
  let effects = 0;
  const url = await h.page.register('A', card, 2000, {
    onApprove: async () => {
      effects++;
      return {};
    },
  });
  const pending = h.request(url + '/approve', { body: 'approve=yes' });
  h.setNow(2000);
  pending.end();
  const r = await pending.done;
  assert.equal(r.status, 410);
  assert.equal(effects, 0);
  assert.deepEqual(h.decisions, []);
});

for (const origin of ['https://foreign.example', 'null', 'not a URL', 'https://127.0.0.1:32123', 'http://127.0.0.1:32124']) {
  test(`a POST with Origin ${origin} is refused and the token stays usable once`, async (t) => {
    const h = fixture(t);
    const url = await h.page.register('A', card, 2000);
    assert.equal((await h.request(url + '/approve', { origin }).done).status, 403);
    assert.deepEqual(h.decisions, []);
    assert.equal((await h.request(url + '/approve', { origin: 'http://127.0.0.1:32123' }).done).status, 200);
    assert.equal((await h.request(url + '/approve', { origin: 'http://127.0.0.1:32123' }).done).status, 410);
    assert.deepEqual(h.decisions, [['A', true]]);
  });
}

test('a mixed-case configured origin accepts the browser lower-case POST once', async (t) => {
  const h = fixture(t, 'https://EXAMPLE.test');
  const url = await h.page.register('A', card, 2000);
  for (const origin of ['https://other.test', 'http://example.test']) assert.equal((await h.request(url + '/approve', { origin }).done).status, 403);
  assert.equal((await h.request(url + '/approve', { origin: 'https://example.test' }).done).status, 200);
  assert.equal((await h.request(url + '/approve', { origin: 'https://example.test' }).done).status, 410);
  assert.deepEqual(h.decisions, [['A', true]]);
});

test('the page asks browsers to send its real origin on its own posts', async (t) => {
  const h = fixture(t);
  const url = await h.page.register('A', card, 2000);
  let headers: Record<string, string> = {};
  const req: any = new PassThrough();
  req.method = 'GET';
  req.url = new URL(url).pathname;
  req.headers = { host: '127.0.0.1:32123' };
  await new Promise<void>((resolve) =>
    (h.page as any).handle(req, {
      writeHead(_s: number, h2: Record<string, string>) {
        headers = h2;
      },
      end: () => resolve(),
    }),
  );
  assert.equal(headers['referrer-policy'], 'same-origin');
});

test('instant table: invalid expiries refuse; a valid one works until expiresAt - 1 only', async (t) => {
  const h = fixture(t);
  for (const bad of [undefined, Number.NaN, '2000', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    await assert.rejects(h.page.register('A', card, bad as any), /^Error: approval_expiry_invalid$/);
  }
  for (const [at, ok] of [[1999, true], [2000, false], [2001, false], [9999, false]] as const) {
    for (const method of ['GET', 'POST']) {
      const url = await h.page.register(`A${at}${method}`, card, 2000);
      h.setNow(at);
      const r = await h.request(method === 'GET' ? url : url + '/approve', { method }).done;
      if (ok) assert.equal(r.status, 200, `${method} at ${at}`);
      else assert.notEqual(r.status, 200, `${method} at ${at}`);
      h.setNow(1000);
    }
  }
});

test('a fractional confirmation TTL still gives a whole-millisecond approval deadline', async (t) => {
  const config = loadConfig({ DEMOS_STATE_DIR: mkdtempSync(join(tmpdir(), 'approval-ttl-')), DEMOS_CONFIRM_TTL_SEC: '30.0001' });
  assert.equal(config.confirmTtlMs, 30_000);
  const h = fixture(t);
  const url = await h.page.register('A', card, 1000 + config.confirmTtlMs);
  assert.equal((await h.request(url + '/approve').done).status, 200);
});
