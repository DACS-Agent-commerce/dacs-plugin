/**
 * Human confirmation gate.
 *
 * Every write is two calls: *_prepare returns a summary and a prepared_id; the
 * server generates a one-time code and sends it ONLY over out-of-band channels
 * the human sees (terminal tty, desktop notification, phone webhook, or stderr
 * for clients without a shell). The code is never in a tool result, so a model
 * that only has the MCP tools cannot complete a write by itself: it has to ask
 * the human, and the human reads the action summary from the out-of-band message,
 * not from the model.
 *
 * Properties:
 *  - code: 8 symbols from a 32-symbol alphabet (40 bits), CSPRNG;
 *  - stored only as an HMAC under a per-process random key, compared in constant time;
 *  - bound to (prepared_id, action digest): a code for one action cannot confirm another;
 *  - single use; expires (default 5 min); 3 wrong attempts void the action;
 *  - 10 wrong attempts in one process lock all writes until restart.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import type { ConfirmChannelName } from './config.js';
import type { SecretGuard } from './secrets.js';
import { printable } from './confirm-text.js';
import type { ApprovalCard, ApprovalServer, InteractiveSpec } from './approval.js';

export type ApprovedBy = 'local-approval-page' | 'out-of-band-code';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 symbols, no 0/O/1/I
const CODE_LEN = 8;
const MAX_ATTEMPTS = 3;
const LOCKOUT_FAILURES = 10;

export { printable } from './confirm-text.js';

export interface ConfirmMessage {
  preparedId: string;
  code: string;
  digest: string;
  title: string;
  lines: string[];
  expiresAt: number;
  /** Single-use local approval URL (approval off the chat channel), when enabled. */
  approveUrl?: string;
}

export interface ConfirmChannel {
  readonly name: string;
  deliver(m: ConfirmMessage): Promise<boolean>;
}

export class ConfirmError extends Error {
  constructor(message: string, readonly voided: boolean) {
    super(message);
    this.name = 'ConfirmError';
  }
}

interface Entry {
  mac: Buffer;
  digest: string;
  expiresAt: number;
  attempts: number;
  approved: boolean;
}

export class ConfirmationGate {
  private readonly key = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  private failures = 0;

  constructor(
    private readonly channels: ConfirmChannel[],
    private readonly ttlMs: number,
    private readonly guard: SecretGuard,
    private readonly now: () => number = Date.now,
    private readonly approval: ApprovalServer | null = null,
    /** Accept the typed code as an alternative to the approval page (fallback). */
    private readonly codeFallback = true,
  ) {
    approval?.setDecisionHandler((id, ok) => {
      const e = this.entries.get(id);
      if (!e) return;
      if (ok) e.approved = true;
      else this.entries.delete(id); // deny voids the action
    });
  }

  get approvalPageEnabled(): boolean {
    return this.approval !== null;
  }

  get locked(): boolean {
    return this.failures >= LOCKOUT_FAILURES;
  }

  private mac(preparedId: string, digest: string, code: string): Buffer {
    return createHmac('sha256', this.key).update(`${preparedId}\n${digest}\n${code}`).digest();
  }

  /**
   * Generate a code for this prepared action and push it to every channel.
   * Returns the channels that accepted it; throws if none did (fail closed).
   */
  async issue(preparedId: string, digest: string, title: string, lines: string[], card?: ApprovalCard): Promise<{ deliveredVia: string[]; expiresAt: number; approvalPage: boolean }> {
    if (this.locked) throw new ConfirmError('writes locked: too many wrong confirmation codes this session (restart the server)', true);
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    this.guard.register(code);
    this.guard.register(`${code.slice(0, 4)}-${code.slice(4)}`);
    const expiresAt = this.now() + this.ttlMs;
    // model-influenced text (memo, URLs, claims, ids) must not be able to forge or overwrite summary
    // lines on the human's channel: strip control characters (newlines, ANSI escapes) from every line
    const msg: ConfirmMessage = { preparedId, code: `${code.slice(0, 4)}-${code.slice(4)}`, digest, title: printable(title), lines: lines.map(printable), expiresAt };
    // install the entry BEFORE the link can be used, so a decision made while channels are
    // still delivering is never lost
    this.entries.set(preparedId, { mac: this.mac(preparedId, digest, code), digest, expiresAt, attempts: 0, approved: false });
    if (this.approval) {
      msg.approveUrl = await this.approval.register(preparedId, card ?? { headline: title, rows: lines.map((l, i) => [String(i + 1), l]), digest }, expiresAt);
      this.guard.register(msg.approveUrl.split('/a/')[1]);
    }
    const deliveredVia: string[] = [];
    for (const ch of this.channels) {
      try {
        if (await ch.deliver(msg)) deliveredVia.push(ch.name);
      } catch {
        /* a failing channel is simply not counted */
      }
    }
    if (deliveredVia.length === 0) {
      this.approval?.revoke(preparedId);
      this.entries.delete(preparedId);
      throw new ConfirmError(
        `no confirmation channel reached the human (tried: ${this.channels.map((c) => c.name).join(', ') || 'none'}); the action was not prepared`,
        true,
      );
    }
    if (!this.entries.has(preparedId)) {
      throw new ConfirmError('the human denied this action while it was being delivered', true);
    }
    return { deliveredVia, expiresAt, approvalPage: !!msg.approveUrl };
  }

  /**
   * Interactive page-only step (onboarding: create wallet, set limit). No code fallback: the
   * human acts on the page itself. Fails closed if no approval page or no channel reached them.
   */
  async issueInteractive(id: string, title: string, lines: string[], card: ApprovalCard, spec: InteractiveSpec): Promise<{ deliveredVia: string[]; expiresAt: number }> {
    if (!this.approval) throw new ConfirmError('this step needs the local approval page (DEMOS_APPROVAL_PAGE=1)', true);
    const expiresAt = this.now() + Math.max(this.ttlMs, 15 * 60_000);
    const url = await this.approval.register(id, card, expiresAt, spec);
    this.guard.register(url.split('/a/')[1]);
    const msg: ConfirmMessage = { preparedId: id, code: '', digest: card.digest, title: printable(title), lines: lines.map(printable), expiresAt, approveUrl: url };
    const deliveredVia: string[] = [];
    for (const ch of this.channels) {
      try {
        if (await ch.deliver(msg)) deliveredVia.push(ch.name);
      } catch {
        /* not counted */
      }
    }
    if (deliveredVia.length === 0) {
      this.approval.revoke(id);
      throw new ConfirmError('no channel reached the human with the page link; nothing was started', true);
    }
    return { deliveredVia, expiresAt };
  }

  /** Wait (bounded) until the human approves on the page, denies, or the action expires. */
  async waitForApproval(preparedId: string, maxMs: number, check?: () => void): Promise<void> {
    const until = Math.min(this.now() + maxMs, this.entries.get(preparedId)?.expiresAt ?? 0);
    while (this.now() < until) {
      check?.();
      const e = this.entries.get(preparedId);
      if (!e || e.approved) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Verify and consume. Succeeds if the human approved on the approval page, or
   * (fallback) the exact out-of-band code is given. Throws ConfirmError otherwise.
   */
  verify(preparedId: string, rawCode: string | undefined, digest: string): ApprovedBy {
    if (this.locked) throw new ConfirmError('writes locked: too many wrong confirmation codes this session (restart the server)', true);
    const e = this.entries.get(preparedId);
    if (!e) throw new ConfirmError('unknown, denied or already-used prepared_id', true);
    if (this.now() >= e.expiresAt) {
      this.entries.delete(preparedId);
      this.approval?.revoke(preparedId);
      throw new ConfirmError('confirmation expired; prepare the action again', true);
    }
    if (e.approved && e.digest === digest) {
      this.entries.delete(preparedId);
      this.approval?.revoke(preparedId);
      return 'local-approval-page';
    }
    if (rawCode === undefined || rawCode === '') {
      throw new ConfirmError('not approved yet: the human has not approved this action on the approval page', false);
    }
    if (!this.codeFallback) throw new ConfirmError('code confirmation is disabled; approve on the approval page', false);
    const code = String(rawCode ?? '').toUpperCase().replace(/[\s-]/g, '');
    const ok =
      e.digest === digest &&
      code.length === CODE_LEN &&
      timingSafeEqual(this.mac(preparedId, digest, code), e.mac);
    if (!ok) {
      e.attempts++;
      this.failures++;
      if (e.attempts >= MAX_ATTEMPTS) {
        this.entries.delete(preparedId);
        throw new ConfirmError('wrong confirmation code; attempts exhausted, the action is void', true);
      }
      throw new ConfirmError(`wrong confirmation code (${MAX_ATTEMPTS - e.attempts} attempt(s) left)`, false);
    }
    this.entries.delete(preparedId); // single use
    this.approval?.revoke(preparedId);
    return 'out-of-band-code';
  }

  cancel(preparedId: string): boolean {
    this.approval?.revoke(preparedId);
    return this.entries.delete(preparedId);
  }

  has(preparedId: string): boolean {
    return this.entries.has(preparedId);
  }
}

// ---------------------------------------------------------------------------
// Channels

export function formatMessage(m: ConfirmMessage): string {
  const mins = Math.max(1, Math.round((m.expiresAt - Date.now()) / 60_000));
  return [
    '',
    '==================== DEMOS WALLET: CONFIRMATION REQUIRED ====================',
    m.title,
    ...m.lines.map((l) => `  ${l}`),
    `  action digest: ${m.digest.slice(0, 16)}`,
    '',
    ...(m.approveUrl
      ? [`  OPEN THIS PAGE: ${m.approveUrl}`, ...(m.code ? [`  (fallback) confirmation code: ${m.code}`] : [])]
      : [`  CONFIRMATION CODE: ${m.code}`]),
    `  expires in ${mins} min, single use`,
    '',
    '  Approve ONLY if the action above is exactly what you want. Read it here,',
    '  not in the chat. If you did not ask for this, deny or ignore it: until you',
    '  approve, nothing is signed and nothing is sent to the network.',
    '=============================================================================',
    '',
  ].join('\n');
}

export class StderrChannel implements ConfirmChannel {
  readonly name = 'stderr';
  async deliver(m: ConfirmMessage): Promise<boolean> {
    return process.stderr.write(formatMessage(m) + '\n') || true;
  }
}

export class TtyChannel implements ConfirmChannel {
  readonly name = 'tty';
  constructor(private readonly path = '/dev/tty') {}
  async deliver(m: ConfirmMessage): Promise<boolean> {
    if (process.platform === 'win32') return false;
    let fd: number | null = null;
    try {
      fd = openSync(this.path, 'w');
      writeSync(fd, formatMessage(m).replace(/\n/g, '\r\n') + '\r\n');
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}

export class DesktopChannel implements ConfirmChannel {
  readonly name = 'desktop';
  async deliver(m: ConfirmMessage): Promise<boolean> {
    const body = `${m.lines.join('\n')}\ndigest ${m.digest.slice(0, 16)}\n${m.approveUrl ? `Open: ${m.approveUrl}${m.code ? `\n(fallback code ${m.code})` : ''}` : `CODE: ${m.code}`}`;
    const run = (cmd: string, args: string[]) =>
      new Promise<boolean>((resolve) => {
        execFile(cmd, args, { timeout: 5_000 }, (err) => resolve(!err));
      });
    // with an approval page, also open it in the default browser (the human sees the card there)
    const openPage = async () => {
      if (!m.approveUrl) return false;
      if (process.platform === 'darwin') return run('open', [m.approveUrl]);
      if (process.platform === 'linux') return run('xdg-open', [m.approveUrl]);
      return false;
    };
    if (process.platform === 'darwin') {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // non-blocking banner (display dialog would block and be killed by the timeout)
      const shown = await run('osascript', ['-e', `display notification "${esc(body)}" with title "Demos wallet" subtitle "${esc(m.title)}"`]);
      const opened = await openPage();
      return shown || opened;
    }
    if (process.platform === 'linux') {
      const shown = await run('notify-send', ['--urgency=critical', '--expire-time=0', `Demos wallet: ${m.title}`, body]);
      const opened = await openPage();
      return shown || opened;
    }
    return false;
  }
}

export class WebhookChannel implements ConfirmChannel {
  readonly name = 'webhook';
  constructor(private readonly url: string) {}
  async deliver(m: ConfirmMessage): Promise<boolean> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', title: 'Demos wallet confirmation' },
        body: `${m.title}\n${m.lines.join('\n')}\ndigest ${m.digest.slice(0, 16)}\n${m.approveUrl ? `Open: ${m.approveUrl}${m.code ? `\n(fallback code ${m.code})` : ''}` : `CODE: ${m.code}`}`,
        signal: AbortSignal.timeout(8_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function buildChannels(names: ConfirmChannelName[], webhookUrl?: string): ConfirmChannel[] {
  return names.map((n) => {
    switch (n) {
      case 'stderr':
        return new StderrChannel();
      case 'tty':
        return new TtyChannel();
      case 'desktop':
        return new DesktopChannel();
      case 'webhook':
        return new WebhookChannel(webhookUrl!);
    }
  });
}
