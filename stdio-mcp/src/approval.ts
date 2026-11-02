/**
 * Local approval page — approval OFF the chat channel.
 *
 * For each prepared write the server mints a single-use, short-lived approval
 * URL (256-bit random token, stored only as a hash). The URL goes to the human
 * over the out-of-band channels (desktop notification, terminal, phone webhook),
 * never to the model. The human opens it, sees the approval card, and taps
 * Approve or Deny. The model only learns "approved" when it calls
 * demos_tx_submit; it never sees or relays the approval secret.
 *
 *  - GET never changes state (link previewers cannot approve); POST does.
 *  - Host header must match the bound host (DNS-rebinding defence); a present
 *    Origin must match too.
 *  - Strict CSP, no scripts, no external resources.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { printable } from './confirm-text.js';

export interface ApprovalCard {
  headline: string;
  rows: Array<[string, string]>;
  untrusted?: Array<[string, string]>;
  digest: string;
}

/** A form field shown on an interactive approval page. Values never go to the model. */
export interface FormField {
  name: string;
  label: string;
  type: 'password' | 'text' | 'number' | 'checkbox';
  value?: string;
  min?: string;
  max?: string;
  step?: string;
}

/**
 * Interactive approval: the page shows a form; on Approve the server runs `onApprove`
 * with the submitted values (local only). It may return HTML to show ONCE (e.g. a new
 * recovery phrase) and ask the human to acknowledge it with a second POST.
 */
export interface InteractiveSpec {
  fields?: FormField[];
  approveLabel?: string;
  onApprove: (form: Record<string, string>) => Promise<{ error?: string; html?: string; ackLabel?: string }>;
  onAck?: () => void;
  onDeny?: () => void;
}

interface Entry {
  preparedId: string;
  tokenHash: Buffer;
  card: ApprovalCard;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied' | 'awaiting-ack';
  spec?: InteractiveSpec;
  busy?: boolean;
}

export type Decision = (preparedId: string, approved: boolean) => void;

const esc = (s: string) => printable(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hashToken = (t: string) => createHash('sha256').update(t).digest();

export class ApprovalServer {
  private server: Server | null = null;
  private port = 0;
  private readonly entries = new Map<string, Entry>(); // key: token hash hex
  private onDecision: Decision = () => {};

  constructor(
    private readonly host = '127.0.0.1',
    private readonly fixedPort = 0,
    private readonly publicBase?: string,
    private readonly now: () => number = Date.now,
  ) {}

  setDecisionHandler(fn: Decision): void {
    this.onDecision = fn;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const srv = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(this.fixedPort, this.host, () => resolve());
    });
    srv.unref();
    const addr = srv.address();
    this.port = typeof addr === 'object' && addr ? addr.port : this.fixedPort;
    this.server = srv;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private base(): string {
    return this.publicBase ?? `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`;
  }

  /** Mint a single-use approval URL for this prepared action. */
  async register(preparedId: string, card: ApprovalCard, expiresAt: number, spec?: InteractiveSpec): Promise<string> {
    await this.start();
    for (const [k, e] of this.entries) if (e.preparedId === preparedId || this.now() > e.expiresAt) this.entries.delete(k);
    const token = randomBytes(32).toString('base64url');
    const th = hashToken(token);
    this.entries.set(th.toString('hex'), { preparedId, tokenHash: th, card, expiresAt, state: 'pending', spec });
    return `${this.base()}/a/${token}`;
  }

  revoke(preparedId: string): void {
    for (const [k, e] of this.entries) if (e.preparedId === preparedId) this.entries.delete(k);
  }

  private lookup(token: string): Entry | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const th = hashToken(token);
    const e = this.entries.get(th.toString('hex'));
    if (!e || !timingSafeEqual(e.tokenHash, th)) return null;
    if (this.now() > e.expiresAt) {
      this.entries.delete(th.toString('hex'));
      return null;
    }
    return e;
  }

  private hostOk(req: IncomingMessage): boolean {
    const expectedHost = this.publicBase ? new URL(this.publicBase).host : `${this.host.includes(':') ? `[${this.host}]` : this.host}:${this.port}`;
    if (req.headers.host !== expectedHost) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null' && new URL(origin).host !== expectedHost) return false;
    return true;
  }

  private send(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  private readBody(req: IncomingMessage): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      const timer = setTimeout(() => {
        reject(new Error('body read timeout'));
        req.destroy();
      }, 10_000);
      req.on('close', () => clearTimeout(timer));
      req.on('data', (c: string) => {
        body += c;
        if (body.length > 8192) {
          reject(new Error('body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        const out: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(body)) out[k] = v;
        resolve(out);
      });
      req.on('error', reject);
    });
  }

  private async handleInteractive(req: IncomingMessage, res: ServerResponse, e: Entry, token: string, action: string | undefined): Promise<void> {
    const spec = e.spec!;
    if (req.method === 'GET' && !action) {
      if (e.state !== 'pending') return this.send(res, 410, page('Already decided', `<p>This step was already ${e.state === 'awaiting-ack' ? 'approved' : e.state}.</p>`));
      return this.send(res, 200, cardPage(e.card, token, spec));
    }
    if (req.method !== 'POST' || !action) return this.send(res, 405, page('Method not allowed', ''));
    if (action === 'ack') {
      if (e.state !== 'awaiting-ack') return this.send(res, 410, page('Nothing to confirm', ''));
      e.state = 'approved';
      spec.onAck?.();
      this.onDecision(e.preparedId, true);
      return this.send(res, 200, page('Done', '<p>Confirmed. You can close this page and go back to the assistant.</p>'));
    }
    if (e.state !== 'pending' || e.busy) return this.send(res, 410, page('Already decided', `<p>This step was already ${e.state}.</p>`));
    if (action === 'deny') {
      e.state = 'denied';
      spec.onDeny?.();
      this.onDecision(e.preparedId, false);
      return this.send(res, 200, page('Denied', '<p>Denied. Nothing was created or sent.</p>'));
    }
    e.busy = true;
    try {
      const form = await this.readBody(req);
      // re-check after the (bounded) body read: a POST that started before expiry must not commit after it
      if (this.now() > e.expiresAt) return this.send(res, 410, page('Expired', '<p>This link expired; nothing was changed. Ask the assistant to start this step again.</p>'));
      const r = await spec.onApprove(form);
      if (r.error) return this.send(res, 200, cardPage(e.card, token, spec, r.error)); // stays pending: fix and retry
      if (r.html !== undefined && r.ackLabel) {
        e.state = 'awaiting-ack';
        e.expiresAt = this.now() + 15 * 60_000; // a fresh, bounded window to acknowledge
        return this.send(res, 200, page('Done — one more step', `${r.html}<form method="post" action="/a/${token}/ack"><button class="ok" type="submit">${esc(r.ackLabel)}</button></form>`));
      }
      e.state = 'approved';
      this.onDecision(e.preparedId, true);
      return this.send(res, 200, page('Approved', r.html ?? '<p>Approved. You can go back to the assistant.</p>'));
    } finally {
      e.busy = false;
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (!this.hostOk(req)) return this.send(res, 403, page('Refused', '<p>Bad host.</p>'));
      const m = /^\/a\/([A-Za-z0-9_-]+)(\/(approve|deny|ack))?$/.exec((req.url ?? '').split('?')[0]!);
      const e = m ? this.lookup(m[1]!) : null;
      if (!m || !e) return this.send(res, 404, page('Not found', '<p>This approval link is unknown, used or expired.</p>'));
      if (e.spec) {
        this.handleInteractive(req, res, e, m[1]!, m[3]).catch(() =>
          this.send(res, 500, page('Error', '<p>Something went wrong. Ask the assistant for the onboarding status: if a wallet was created, it will offer a page to see its recovery phrase again with your passphrase.</p>')),
        );
        return;
      }
      if (req.method === 'GET' && !m[2]) {
        if (e.state !== 'pending') return this.send(res, 410, page('Already decided', `<p>This action was already ${e.state}.</p>`));
        return this.send(res, 200, cardPage(e.card, m[1]!));
      }
      if (req.method === 'POST' && m[3] === 'ack') return this.send(res, 405, page('Method not allowed', ''));
      if (req.method === 'POST' && m[2]) {
        if (e.state !== 'pending') return this.send(res, 410, page('Already decided', `<p>This action was already ${e.state}.</p>`));
        const approved = m[3] === 'approve';
        e.state = approved ? 'approved' : 'denied';
        this.onDecision(e.preparedId, approved);
        return this.send(res, 200, page(approved ? 'Approved' : 'Denied', approved ? '<p>Approved. Tell the assistant to submit; nothing else is needed.</p>' : '<p>Denied. Nothing will be signed or sent.</p>'));
      }
      return this.send(res, 405, page('Method not allowed', ''));
    } catch {
      this.send(res, 400, page('Bad request', ''));
    }
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.4 system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;background:#fff;color:#111}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.u{background:#3a2a00!important}}
h1{font-size:20px}table{width:100%;border-collapse:collapse}td{padding:6px 4px;border-bottom:1px solid #8884;vertical-align:top}
td:first-child{color:#888;width:34%}.u{background:#fff4d6;padding:8px;border-radius:6px;margin-top:12px}
button{font-size:18px;padding:12px 20px;margin:8px 8px 0 0;border-radius:8px;border:0;cursor:pointer}
.ok{background:#1a7f37;color:#fff}.no{background:#cf222e;color:#fff}code{word-break:break-all}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export function escapeHtml(s: string): string {
  return esc(s);
}

function fieldHtml(f: FormField): string {
  const attrs = [`name="${esc(f.name)}"`, `type="${f.type}"`, 'autocomplete="off"'];
  if (f.value !== undefined && f.type !== 'checkbox') attrs.push(`value="${esc(f.value)}"`);
  if (f.type === 'checkbox' && f.value === 'on') attrs.push('checked');
  for (const k of ['min', 'max', 'step'] as const) if (f[k] !== undefined) attrs.push(`${k}="${esc(f[k]!)}"`);
  const input = `<input ${attrs.join(' ')} style="font-size:16px;padding:6px;${f.type === 'checkbox' ? '' : 'width:100%;box-sizing:border-box'}">`;
  return f.type === 'checkbox' ? `<p><label>${input} ${esc(f.label)}</label></p>` : `<p><label>${esc(f.label)}<br>${input}</label></p>`;
}

function cardPage(c: ApprovalCard, token: string, spec?: InteractiveSpec, error?: string): string {
  if (spec) {
    const rows = c.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    return page(
      'Demos wallet',
      `<p style="font-size:20px"><b>${esc(c.headline)}</b></p><table>${rows}</table>${error ? `<p style="color:#cf222e"><b>${esc(error)}</b></p>` : ''}
<form method="post" action="/a/${token}/approve">${(spec.fields ?? []).map(fieldHtml).join('')}<button class="ok" type="submit">${esc(spec.approveLabel ?? 'Approve')}</button></form>
<form method="post" action="/a/${token}/deny"><button class="no" type="submit">Cancel</button></form>`,
    );
  }
  const rows = c.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const untrusted = c.untrusted?.length
    ? `<div class="u"><b>Counterparty-supplied text (untrusted, shown for reference only):</b><table>${c.untrusted
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v.slice(0, 300))}</td></tr>`)
        .join('')}</table></div>`
    : '';
  return page(
    'Demos wallet approval',
    `<p style="font-size:20px"><b>${esc(c.headline)}</b></p><table>${rows}<tr><td>digest</td><td><code>${esc(c.digest.slice(0, 16))}</code></td></tr></table>${untrusted}
<form method="post" action="/a/${token}/approve" style="display:inline"><button class="ok" type="submit">Approve</button></form>
<form method="post" action="/a/${token}/deny" style="display:inline"><button class="no" type="submit">Deny</button></form>
<p style="color:#888;font-size:13px">Approve only if this is exactly what you asked for. If you did not ask for it, press Deny.</p>`,
  );
}
