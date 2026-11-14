/**
 * "Bring your agent to Demos" — onboarding in about five minutes.
 *
 *   demos_onboard_status        what is set up, and the single next step
 *   demos_onboard_create_wallet new keypair generated LOCALLY; recovery phrase shown ONCE on the
 *                               local approval page (never to the model); keystore chmod 600
 *   demos_onboard_fund          testnet faucet request (testnet only; clear message when it is down)
 *   demos_onboard_check_proof   verify the human's published GitHub gist / X post before attesting
 *   demos_onboard_set_limit     a starter daily spending limit, edited and approved on the page
 *   demos_onboard_test_payment  optional 1 DEM payment to yourself through the normal approval flow
 *
 * Linking the identity itself reuses demos_identity_proof_payload → (human posts) →
 * demos_identity_attest_prepare → off-chat approval → demos_tx_submit.
 */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { ChainReader, Wallet } from './chain.js';
import type { ConfirmationGate } from './confirm.js';
import type { SpendLedger } from './spend.js';
import type { SecretGuard } from './secrets.js';
import { escapeHtml } from './approval.js';
import { decryptKeystore, encryptMnemonic, setSessionPassphrase, type KeystoreFile } from './keystore.js';
import { demToOs, osToDem } from './amount.js';
import { printable } from './confirm-text.js';

export interface WalletFactory {
  newMnemonic(): string;
  addressOf(mnemonic: string): Promise<string>;
}

/** Fetches a published proof. Injected so tests use fixtures and never touch the network. */
export interface ProofFetcher {
  gist(id: string): Promise<{ owner: string; contents: string[] } | null>;
  tweet(url: string): Promise<{ author: string; text: string } | null>;
}

export interface OnboardDeps {
  config: Config;
  guard: SecretGuard;
  chain: ChainReader;
  gate: ConfirmationGate;
  ledger: SpendLedger;
  getWallet: () => Promise<Wallet>;
  walletFactory: WalletFactory;
  proofFetcher: ProofFetcher;
  fetchImpl: typeof fetch;
  /** The normal pay prepare (approval card + off-chat approval), allowed to pay the wallet itself. */
  prepareSelfPayment: (address: string) => Promise<unknown>;
  guarded: <A>(fn: (a: A) => Promise<unknown>) => (a: A) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
  writesBlocked: string | null;
  /** The write blocker evaluated now: a purchase-only marker can appear after start-up. */
  writesBlockedNow: () => string | null;
  now: () => number;
}

interface OnboardState {
  version: 1;
  address?: string;
  walletCreatedAt?: string;
  backupAcknowledged?: boolean;
  faucet?: { at: string; ok: boolean; status?: number; txHash?: string }[];
}

const FAUCET_MIN_INTERVAL_MS = 5 * 60_000;
const FAUCET_MAX_REPLY_BYTES = 16 * 1024;

/** Reads at most `max` bytes of a reply body; a longer body throws. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`reply larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** True if anything exists at p, including a dangling symlink. */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

function phrasePage(address: string, mnemonic: string, verb: string): string {
  const words = mnemonic.split(' ');
  return (
    `<p>Your wallet <code>${escapeHtml(address)}</code> ${escapeHtml(verb)}.</p>` +
    `<p><b>Write these ${words.length} words down, in order, on paper.</b> They are the only way to recover the wallet. Close this page when you are done.</p>` +
    `<ol style="font:18px/1.6 ui-monospace,monospace;columns:2">${words.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ol>` +
    `<p>Never paste them into a chat, an assistant, or a website.</p>`
  );
}

export function registerOnboardTools(server: McpServer, d: OnboardDeps): void {
  const { config, chain, gate, ledger, guard } = d;
  const statePath = join(config.stateDir, 'onboard.json');
  const pendingSteps = new Map<string, { kind: string; done: boolean; denied: boolean }>();
  // the stricter of the start-up value (it decided which tools exist) and the value now
  const blockedNow = () => d.writesBlocked ?? d.writesBlockedNow();

  const readState = (): OnboardState => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8')) as OnboardState;
    } catch {
      return { version: 1 };
    }
  };
  const writeState = (st: OnboardState) => {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, statePath);
  };

  /** The wallet address without decrypting anything: the keystore's public `address` field. */
  const walletAddress = (): string | null => {
    if (config.keystorePath && existsSync(config.keystorePath)) {
      try {
        const ks = JSON.parse(readFileSync(config.keystorePath, 'utf8')) as KeystoreFile;
        if (ks.address && /^0x[0-9a-f]{64}$/.test(ks.address)) return ks.address;
      } catch {
        /* fall through */
      }
      return readState().address ?? 'unknown (keystore has no public address field)';
    }
    return null;
  };

  const testnet = config.network === 'testnet' && config.rpcIsKnownTestnet;

  /**
   * Backup state is anchored in the keystore itself: a wallet created by onboarding carries an
   * `onboarding` marker, and counts as backed up only when onboard.json holds an
   * acknowledgement for THAT address. A crash between publishing the keystore and writing
   * onboard.json therefore still leads to the recovery page, never to "backed up".
   */
  const backupPending = (): boolean => {
    if (!config.keystorePath || !existsSync(config.keystorePath)) return false;
    let ks: KeystoreFile;
    try {
      ks = JSON.parse(readFileSync(config.keystorePath, 'utf8')) as KeystoreFile;
    } catch {
      return false;
    }
    if (!ks.onboarding) return false; // a keystore the user brought; its backup is theirs
    const st = readState();
    return !(st.backupAcknowledged === true && st.address === ks.address);
  };
  const acknowledge = () => {
    writeState({ ...readState(), address: walletAddress() ?? undefined, backupAcknowledged: true });
  };

  // -------------------------------------------------------------------------
  server.registerTool(
    'demos_onboard_status',
    {
      title: 'Onboarding status',
      description:
        'Bring your agent to Demos: shows what is set up (wallet, backup confirmed, testnet funds, linked identity, spending limit) and the single next step, with the tool to call. When everything is ready, returns a ready card. Read-only. Optional wait_seconds waits for a pending onboarding page step.',
      inputSchema: { wait_seconds: z.number().int().min(0).max(120).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    d.guarded(async (a: { wait_seconds?: number }) => {
      if (a.wait_seconds) {
        const until = d.now() + a.wait_seconds * 1000;
        while (d.now() < until && [...pendingSteps.values()].some((p) => !p.done && !p.denied)) await new Promise((r) => setTimeout(r, 250));
      }
      const st = readState();
      const address = walletAddress();
      let balanceOs: bigint | null = null;
      let identities: string[] = [];
      let chainNote: string | null = null;
      if (address && address.startsWith('0x')) {
        try {
          balanceOs = (await chain.addressInfo(address)).balanceOs;
          const ids = (await chain.identities(address)) as Record<string, any>;
          for (const [ctx, list] of Object.entries(ids?.web2 ?? {})) {
            for (const it of Array.isArray(list) ? list : []) {
              const u = it?.username;
              if (typeof u === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(u)) identities.push(`${ctx}:${u}`);
            }
          }
        } catch (e) {
          chainNote = `chain lookup failed: ${printable((e as Error).message).slice(0, 120)}`;
        }
      }
      // read after the awaited chain lookups above, so a marker that appeared meanwhile is seen
      const blocked = blockedNow();
      const writes = blocked ? `disabled: ${blocked}` : 'enabled';
      const limitOs = ledger.userLimitOs();
      const steps = {
        writes_enabled: !blocked,
        wallet: address ? address : null,
        recovery_phrase_backed_up: !!address && !backupPending(),
        funded: balanceOs !== null ? balanceOs > 0n : null,
        identity_linked: identities.length ? identities : null,
        spending_limit_dem: limitOs !== null ? osToDem(limitOs) : null,
      };
      let next: { step: string; tool?: string; say: string };
      if (blocked && blocked.startsWith('purchase-only wallet')) next = { step: 'wallet fenced', say: `Writes are off (${blocked}). This wallet is fenced for purchase-only use; enabling wallet writes does not lift that, so nothing more can be done here.` };
      else if (blocked) next = { step: 'enable writes', say: `Writes are off (${blocked}). In Claude Code: /config → demos plugin → "Enable wallet writes", then reconnect (/mcp).` };
      else if (!address) next = { step: 'create wallet', tool: 'demos_onboard_create_wallet', say: 'Create a wallet. The recovery phrase is shown once, on your local page, never in this chat.' };
      else if (!steps.recovery_phrase_backed_up) next = { step: 'confirm backup', tool: 'demos_onboard_create_wallet', say: 'The recovery phrase was not confirmed yet. Calling demos_onboard_create_wallet again opens a page where the human enters their passphrase to see it once more and confirm.' };
      else if (steps.funded === false) next = testnet ? { step: 'fund (testnet)', tool: 'demos_onboard_fund', say: 'Get free testnet DEM from the faucet.' } : { step: 'fund', say: 'Send DEM to this address from another wallet.' };
      else if (!steps.identity_linked)
        next = { step: 'link identity', tool: 'demos_identity_proof_payload', say: 'Link your GitHub (or X): get the proof text, post it publicly yourself, then check it with demos_onboard_check_proof and attest.' };
      else if (limitOs === null) next = { step: 'set spending limit', tool: 'demos_onboard_set_limit', say: 'Set a small daily spending limit on your approval page.' };
      else next = { step: 'ready', tool: 'demos_onboard_test_payment', say: 'You are ready. Optionally send yourself 1 DEM to see the full approval flow.' };
      return {
        network: config.network,
        writes,
        steps,
        next,
        ...(next.step === 'ready'
          ? {
              ready_card: {
                headline: `READY · ${config.network} · ${identities[0] ?? address}`,
                wallet: address,
                balance_dem: balanceOs !== null ? osToDem(balanceOs) : null,
                linked_identity: identities,
                daily_limit_dem: limitOs !== null ? osToDem(limitOs) : null,
                cap_left_today_dem: osToDem(ledger.remainingToday()),
                every_write: 'prepared unsigned, approved by you on the local page, then signed',
              },
            }
          : {}),
        ...(chainNote ? { note: chainNote } : {}),
      };
    }),
  );

  if (d.writesBlocked) return;

  // -------------------------------------------------------------------------
  /**
   * Finish an interrupted backup (lost page, expiry, restart, crash after creation): the human
   * proves knowledge of the passphrase on the local page; only then is the phrase shown again.
   */
  const revealForBackup = async (path: string) => {
    const id = randomBytes(12).toString('hex');
    const step = { kind: 'reveal-backup', done: false, denied: false };
    pendingSteps.set(id, step);
    const card = {
      headline: 'FINISH YOUR WALLET BACKUP',
      rows: [
        ['why', 'the recovery phrase of your existing wallet was never confirmed as written down'],
        ['wallet', walletAddress() ?? 'unknown'],
        ['what happens', 'enter your passphrase; the phrase is shown once more on this page'],
      ] as Array<[string, string]>,
      digest: id,
    };
    const { deliveredVia, expiresAt } = await gate.issueInteractive(id, card.headline, card.rows.map(([k, v]) => `${k}: ${v}`), card, {
      approveLabel: 'Show my recovery phrase',
      fields: [{ name: 'passphrase', label: 'Wallet passphrase', type: 'password' }],
      onApprove: async (form) => {
        if (blockedNow()) return { error: 'This wallet is fenced for purchase-only use; the recovery phrase is not shown.' };
        let mnemonic: string;
        try {
          const ks = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
          guard.register(form.passphrase ?? '');
          mnemonic = decryptKeystore(ks, form.passphrase ?? '');
        } catch {
          return { error: 'That passphrase does not unlock this wallet.' };
        }
        guard.register(mnemonic);
        return { html: phrasePage(walletAddress() ?? '', mnemonic, 'exists; here is its recovery phrase again'), ackLabel: 'I have written the words down' };
      },
      onAck: () => {
        acknowledge();
        step.done = true;
      },
      onDeny: () => {
        step.denied = true;
      },
    });
    return {
      status: 'awaiting_human_on_local_page',
      step: 'finish backup of the existing wallet',
      delivered_via: deliveredVia,
      expires_at: new Date(expiresAt).toISOString(),
      instruction: 'A link to a local page was sent to the human out-of-band; they enter their passphrase there to see and confirm their recovery phrase. Do not ask for either. Then call demos_onboard_status with wait_seconds.',
    };
  };

  server.registerTool(
    'demos_onboard_create_wallet',
    {
      title: 'Create a wallet (onboarding)',
      description:
        'Create a new Demos wallet on this machine. A link to a local page goes to the human out-of-band; there they choose a passphrase, the keypair is generated locally and encrypted into a chmod-600 keystore, and the 12-word recovery phrase is shown ONCE on that page for them to write down. The phrase and passphrase never come back to you. Then poll demos_onboard_status (wait_seconds).',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    d.guarded(async () => {
      const path = config.keystorePath;
      if (!path) throw new Error('a mnemonic file is configured (DEMOS_MNEMONIC_FILE); onboarding wallet creation is not used');
      const fenced = blockedNow();
      if (fenced) throw new Error(`wallet onboarding is unavailable: ${fenced}`);
      if (existsSync(path)) {
        if (backupPending()) return await revealForBackup(path);
        return { status: 'wallet_exists', wallet: walletAddress(), note: 'A wallet already exists; nothing was created. Use demos_onboard_status for the next step.' };
      }
      const id = randomBytes(12).toString('hex');
      const step = { kind: 'create-wallet', done: false, denied: false };
      pendingSteps.set(id, step);
      let created = false;
      const card = {
        headline: `CREATE A NEW DEMOS WALLET · ${config.network}`,
        rows: [
          ['what happens', 'a new keypair is generated on this computer and encrypted with your passphrase'],
          ['keystore', path],
          ['recovery phrase', 'shown once on the next screen; write it down offline'],
        ] as Array<[string, string]>,
        digest: id,
      };
      const { deliveredVia, expiresAt } = await gate.issueInteractive(id, card.headline, card.rows.map(([k, v]) => `${k}: ${v}`), card, {
        approveLabel: 'Create wallet',
        fields: [
          { name: 'passphrase', label: 'Passphrase (at least 10 characters)', type: 'password' },
          { name: 'confirm', label: 'Repeat passphrase', type: 'password' },
          { name: 'remember', label: 'Remember the passphrase on this computer (chmod-600 file) so the assistant can use the wallet after a restart', type: 'checkbox', value: 'on' },
        ],
        onApprove: async (form) => {
          if (blockedNow()) return { error: 'This wallet is fenced for purchase-only use; no wallet is created.' };
          if (created || existsSync(path)) return { error: 'A wallet was already created. Check demos_onboard_status.' };
          const pass = form.passphrase ?? '';
          if (pass.length < 10) return { error: 'Passphrase must be at least 10 characters.' };
          if (pass !== pass.trim() || /[\r\n]/.test(pass)) return { error: 'Passphrase must not start or end with spaces or contain line breaks.' };
          if (pass !== form.confirm) return { error: 'The two passphrases differ.' };
          if (config.keystorePassphrase !== undefined && config.keystorePassphrase !== pass) {
            return { error: 'A different passphrase is configured for this server (DEMOS_KEYSTORE_PASSPHRASE). Use that one, or remove it from the configuration first.' };
          }
          const remember = form.remember === 'on' && !!config.keystorePassphraseFile && config.keystorePassphrase === undefined;
          if (remember) {
            const pf = config.keystorePassphraseFile!;
            if (resolve(pf) === resolve(path)) return { error: 'The passphrase file path equals the keystore path; fix the configuration.' };
            if (lexists(pf)) return { error: `A passphrase file already exists at ${pf}. Remove it (or untick "remember") and try again.` };
          }
          guard.register(pass);
          const mnemonic = d.walletFactory.newMnemonic();
          guard.register(mnemonic); // the guard covers the phrase from the moment it exists
          const address = (await d.walletFactory.addressOf(mnemonic)).toLowerCase();
          if (blockedNow()) return { error: 'This wallet is fenced for purchase-only use; no wallet is created.' }; // the address lookup awaited
          const ks: KeystoreFile = { ...encryptMnemonic(mnemonic, pass, { address }), onboarding: { createdAt: new Date(d.now()).toISOString() } };
          if (decryptKeystore(ks, pass) !== mnemonic) return { error: 'Internal check failed; nothing was created.' };
          const bytes = Buffer.from(JSON.stringify(ks, null, 2) + '\n', 'utf8');
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          // 1. passphrase file first (exclusive, private; never follows or replaces an existing path)
          if (remember) writeFileSync(config.keystorePassphraseFile!, pass + '\n', { mode: 0o600, flag: 'wx' });
          // 2. keystore: write + fsync a private temp file, then publish with link() (fails if the
          //    target exists, so an existing wallet is never replaced and readers never see a partial file)
          const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
          let fencedLate = false;
          try {
            const fd = openSync(tmp, 'wx', 0o600);
            try {
              writeFileSync(fd, bytes); // writes the whole buffer (loops over short writes) or throws
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
            // publish only what verifiably round-trips from disk
            const onDisk = readFileSync(tmp);
            if (!onDisk.equals(bytes) || decryptKeystore(JSON.parse(onDisk.toString('utf8')) as KeystoreFile, pass) !== mnemonic) {
              throw new Error('keystore did not verify after writing');
            }
            if (blockedNow()) {
              fencedLate = true;
              throw new Error('fenced');
            }
            linkSync(tmp, path);
          } catch (e) {
            if (remember) safeUnlink(config.keystorePassphraseFile!); // we created it a moment ago
            if (fencedLate) return { error: 'This wallet is fenced for purchase-only use; no wallet is created.' };
            throw e;
          } finally {
            safeUnlink(tmp);
          }
          const stateBefore = readState();
          /**
           * A marker appeared after publication: take back what was just published (it was never shown), but only the
           * exact files. The keystore carries a fresh salt and IV, so equal bytes are the file this call wrote.
           */
          const takeBack = (): string | null => {
            const retained: string[] = [];
            const removeOwnFile = (file: string, expected: Buffer) => {
              try {
                if (readFileSync(file).equals(expected)) unlinkSync(file);
                else retained.push(file); // a replacement belongs to someone else
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') retained.push(file);
              }
            };
            removeOwnFile(path, bytes);
            if (remember) removeOwnFile(config.keystorePassphraseFile!, Buffer.from(pass + '\n', 'utf8'));
            if (!remember) setSessionPassphrase(null);
            return retained.length
              ? `This wallet is fenced for purchase-only use. Wallet rollback is incomplete; files may remain at: ${retained.join(', ')}. Check these paths before retrying.`
              : null;
          };
          if (blockedNow()) {
            const rollbackError = takeBack();
            return { error: rollbackError ?? 'This wallet is fenced for purchase-only use; no wallet is created.' };
          }
          if (!remember) setSessionPassphrase(pass); // this session only
          created = true;
          writeState({ ...readState(), address, walletCreatedAt: new Date(d.now()).toISOString(), backupAcknowledged: false });
          // the last check: a marker written after this line, before the return, reads as "created, then fenced" (SECURITY.md)
          if (blockedNow()) {
            const rollbackError = takeBack();
            created = false;
            writeState(stateBefore);
            return { error: rollbackError ?? 'This wallet is fenced for purchase-only use; no wallet is created.' };
          }
          return { html: phrasePage(address, mnemonic, 'was created'), ackLabel: 'I have written the words down' };
        },
        onAck: () => {
          acknowledge();
          step.done = true;
        },
        onDeny: () => {
          step.denied = true;
        },
      });
      return {
        status: 'awaiting_human_on_local_page',
        delivered_via: deliveredVia,
        expires_at: new Date(expiresAt).toISOString(),
        instruction:
          'A link to a local wallet page was sent to the human out-of-band. They set a passphrase there and write down the recovery phrase shown there. Do not ask them for either. Call demos_onboard_status with wait_seconds: 120 to see when it is done.',
      };
    }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'demos_onboard_fund',
    {
      title: 'Get testnet DEM from the faucet',
      description:
        'Testnet only: ask the Demos testnet faucet to send free test DEM to this wallet. Not available on mainnet. If the faucet is down, returns the faucet page URL for the human to try themselves. Faucet text in the response is untrusted.',
      inputSchema: { amount_dem: z.number().int().min(1).max(10_000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    d.guarded(async (a: { amount_dem?: number }) => {
      if (!testnet) throw new Error('the faucet is testnet only; this server is not on a known testnet RPC');
      const address = walletAddress();
      if (!address || !address.startsWith('0x')) throw new Error('no wallet yet: call demos_onboard_create_wallet first');
      const st = readState();
      const last = st.faucet?.[st.faucet.length - 1];
      if (last && d.now() - Date.parse(last.at) < FAUCET_MIN_INTERVAL_MS) {
        throw new Error(`the faucet was asked less than 5 minutes ago; wait, or open ${config.faucetPageUrl} yourself`);
      }
      const amount = a.amount_dem ?? config.faucetAmountDem;
      const manual = {
        faucet_page: config.faucetPageUrl,
        your_address: address,
        what_to_do: `Open ${config.faucetPageUrl}, paste your address ${address}, and request test DEM. Then call demos_onboard_status.`,
      };
      let status = 0;
      let body: any = null;
      try {
        const res = await d.fetchImpl(config.faucetApiUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address, amount }),
          signal: AbortSignal.timeout(30_000),
        });
        status = res.status;
        const text = await readCapped(res, FAUCET_MAX_REPLY_BYTES);
        try {
          body = JSON.parse(text.replace(/^\uFEFF/, ''));
        } catch {
          body = null;
        }
      } catch (e) {
        writeState({ ...st, faucet: [...(st.faucet ?? []), { at: new Date(d.now()).toISOString(), ok: false, status: 0 }].slice(-20) });
        return { ok: false, reason: 'faucet_unreachable', message: `The Demos testnet faucet could not be reached (${printable((e as Error).message).slice(0, 80)}).`, ...manual };
      }
      const ok = status === 200 && body && typeof body === 'object' && body.status === 200;
      const txHash = ok && typeof body.body?.txHash === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(body.body.txHash) ? body.body.txHash.replace(/^0x/, '').toLowerCase() : undefined;
      writeState({ ...st, faucet: [...(st.faucet ?? []), { at: new Date(d.now()).toISOString(), ok: !!ok, status, txHash }].slice(-20) });
      if (ok) {
        return { ok: true, amount_dem: amount, tx_hash: txHash ?? null, next: 'Funds can take a few seconds to land. Call demos_onboard_status to check the balance.' };
      }
      const faucetText = typeof body?.body === 'string' ? printable(body.body).slice(0, 200) : null;
      if (status >= 500) {
        return {
          ok: false,
          reason: 'faucet_down',
          message: `The Demos testnet faucet is down right now (HTTP ${status}). This is on the faucet's side, not yours.`,
          ...manual,
          ...(faucetText ? { untrusted_faucet_text: faucetText } : {}),
        };
      }
      return { ok: false, reason: status === 429 ? 'rate_limited' : 'refused', message: `The faucet refused the request (HTTP ${status}).`, ...manual, ...(faucetText ? { untrusted_faucet_text: faucetText } : {}) };
    }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'demos_onboard_check_proof',
    {
      title: 'Check a published identity proof',
      description:
        'Before attesting: check that the human published the exact proof text for THIS wallet, under the claimed username — a public GitHub gist (verified via the GitHub API) or an X post (best effort via the Demos node). You never post anything yourself. On success, call demos_identity_attest_prepare with the same kind and URL.',
      inputSchema: {
        kind: z.string().refine((v) => v === 'github' || v === 'twitter', { message: 'must be one of: github, twitter' }).describe('one of: github, twitter'),
        username: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'plain username'),
        proof_url: z.string().max(500),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    d.guarded(async (a: { kind: 'github' | 'twitter'; username: string; proof_url: string }) => {
      const w = await d.getWallet();
      const expected = await w.proofPayload(a.kind, a.username);
      const result = (verified: boolean | 'indeterminate', detail: string) => ({
        kind: a.kind,
        username: a.username,
        wallet: w.address,
        verified,
        detail,
        ...(verified === true ? { next: `Call demos_identity_attest_prepare with kind "${a.kind}" and proof "${a.proof_url}".` } : {}),
      });
      if (a.kind === 'github') {
        const m = /^https:\/\/gist\.github(?:usercontent)?\.com\/([A-Za-z0-9-]{1,39})\/([0-9a-f]{20,40})(?:[/#?].*)?$/i.exec(a.proof_url);
        if (!m) return result(false, 'not a public gist URL (https://gist.github.com/<user>/<id>)');
        if (m[1]!.toLowerCase() !== a.username.toLowerCase()) return result(false, 'the gist URL belongs to a different user than the claimed username');
        let gist: { owner: string; contents: string[] } | null;
        try {
          gist = await d.proofFetcher.gist(m[2]!);
        } catch (e) {
          return result('indeterminate', `could not fetch the gist: ${printable((e as Error).message).slice(0, 100)}`);
        }
        if (!gist) return result(false, 'gist not found (is it public?)');
        if (gist.owner.toLowerCase() !== a.username.toLowerCase()) return result(false, `the gist is owned by a different account`);
        if (!gist.contents.some((c) => c.includes(expected))) return result(false, 'the gist does not contain the exact proof text for this wallet; re-copy it from demos_identity_proof_payload');
        return result(true, 'gist found, owned by the claimed user, and it contains this wallet\'s exact proof text');
      }
      const m = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{5,25})/.exec(a.proof_url);
      if (!m) return result(false, 'not an X post URL (https://x.com/<user>/status/<id>)');
      if (m[1]!.toLowerCase() !== a.username.toLowerCase()) return result(false, 'the post URL belongs to a different user than the claimed username');
      let tw: { author: string; text: string } | null;
      try {
        tw = await d.proofFetcher.tweet(a.proof_url);
      } catch {
        tw = null;
      }
      if (!tw) return result('indeterminate', 'the post could not be read here; the Demos node verifies it again when you attest');
      if (tw.author.toLowerCase() !== a.username.toLowerCase()) return result(false, 'the post was written by a different account');
      if (!tw.text.includes(expected)) return result(false, 'the post does not contain the exact proof text for this wallet');
      return result(true, 'post found, by the claimed user, containing this wallet\'s exact proof text');
    }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'demos_onboard_set_limit',
    {
      title: 'Set a starter spending limit',
      description:
        'Propose a small daily spending limit (default 5 DEM; it can only lower the operator cap). The human can edit the number and approves it on the local page. It applies to every write, including fees.',
      inputSchema: { daily_limit_dem: z.number().int().min(0).max(100_000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    d.guarded(async (a: { daily_limit_dem?: number }) => {
      const maxDem = Number(osToDem(ledger.configuredCapOs));
      const proposed = Math.min(a.daily_limit_dem ?? 5, Math.floor(maxDem));
      const id = randomBytes(12).toString('hex');
      const step = { kind: 'set-limit', done: false, denied: false };
      pendingSteps.set(id, step);
      let applied: string | null = null;
      const card = {
        headline: `SET YOUR DAILY SPENDING LIMIT · ${config.network}`,
        rows: [
          ['applies to', 'every payment and fee this assistant can make, per UTC day'],
          ['proposed', `${proposed} DEM`],
          ['maximum allowed here', `${osToDem(ledger.configuredCapOs)} DEM (operator cap)`],
        ] as Array<[string, string]>,
        digest: id,
      };
      const { deliveredVia, expiresAt } = await gate.issueInteractive(id, card.headline, card.rows.map(([k, v]) => `${k}: ${v}`), card, {
        approveLabel: 'Set this limit',
        fields: [{ name: 'limit', label: 'Daily limit in DEM (whole number)', type: 'number', value: String(proposed), min: '0', max: String(Math.floor(maxDem)), step: '1' }],
        onApprove: async (form) => {
          const v = (form.limit ?? '').trim();
          if (!/^(0|[1-9][0-9]{0,6})$/.test(v)) return { error: 'Enter a whole number of DEM.' };
          const os = demToOs(v);
          if (os > ledger.configuredCapOs) return { error: `The limit cannot exceed the operator cap of ${osToDem(ledger.configuredCapOs)} DEM.` };
          ledger.setUserLimit(os);
          applied = v;
          step.done = true;
          return { html: `<p>Your daily limit is now <b>${escapeHtml(v)} DEM</b>. You can go back to the assistant.</p>` };
        },
        onDeny: () => {
          step.denied = true;
        },
      });
      return {
        status: 'awaiting_human_on_local_page',
        proposed_daily_limit_dem: proposed,
        delivered_via: deliveredVia,
        expires_at: new Date(expiresAt).toISOString(),
        instruction: 'A link to a local page was sent to the human out-of-band; they can change the number there. Call demos_onboard_status with wait_seconds to see the limit they set.',
        applied: applied,
      };
    }),
  );

  // -------------------------------------------------------------------------
  server.registerTool(
    'demos_onboard_test_payment',
    {
      title: 'Optional: send yourself 1 DEM',
      description:
        'Optional last onboarding step: prepare a 1 DEM payment from this wallet to itself, so the human sees the whole flow (card → approve on the page → signed → receipt). Uses the normal approval flow; submit with demos_tx_submit. Costs only the network fee.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    d.guarded(async () => {
      const w = await d.getWallet();
      return await d.prepareSelfPayment(w.address);
    }),
  );
}
