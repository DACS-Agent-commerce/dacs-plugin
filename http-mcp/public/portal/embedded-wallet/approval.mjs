// Explicit user approval for the experimental embedded wallet. The SDK session
// calls approve(request) before signing (and before any explicitly configured
// transaction/identity write); it resolves true ONLY when the person clicks
// Approve with a real, trusted pointer or keyboard event. A model-supplied
// flag, a scripted click, Escape, a timeout, a second concurrent request or
// locking the wallet all resolve false.
import { el, uniqueId } from './dom.mjs';

const PURPOSES = {
  connect: 'Share this wallet’s public address.',
  sign: 'Sign this exact message with your embedded wallet key.',
  sendTransaction: 'Send this exact transaction from your embedded wallet.',
  addGithubIdentity: 'Add a GitHub identity link to this wallet.',
  addTwitterIdentity: 'Add an X/Twitter identity link to this wallet.',
  removeWeb2Identity: 'Remove an identity link from this wallet.',
};

const NOTES = {
  sign: 'Signing proves you control this wallet. It does not move funds.',
};
const WRITE_NOTE = 'Approving allows exactly this one action. This experimental wallet has no live network connection unless this page was explicitly configured with one.';

// The request shape comes from the SDK seam; accept a bare message string or
// {method, params, purpose?, message?, content?} and show the exact content.
export function describeRequest(request) {
  if (typeof request === 'string') return { method: 'sign', purpose: PURPOSES.sign, content: request };
  const method = typeof request?.method === 'string' ? request.method : 'unknown';
  const purpose = typeof request?.purpose === 'string' && request.purpose.trim() ? request.purpose : PURPOSES[method] ?? `Wallet action “${method}”.`;
  let content;
  if (typeof request?.message === 'string') content = request.message;
  else if (method === 'sign' && typeof request?.params?.[0] === 'string') content = request.params[0];
  else content = JSON.stringify(request?.content ?? request?.params ?? null, null, 2) ?? 'null';
  return { method, purpose, content };
}

export function createApprovalController(host, { timeoutMs = 300_000 } = {}) {
  let pending = null;

  const finish = (approved) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (current.dialog.open) current.dialog.close();
    current.dialog.remove();
    if (current.returnFocus?.isConnected) current.returnFocus.focus();
    current.resolve(approved === true);
  };

  function approve(request) {
    if (pending) return Promise.resolve(false); // one prompt at a time, never queued
    const { method, purpose, content } = describeRequest(request);
    return new Promise((resolve) => {
      const titleId = uniqueId('ew-approval-title');
      const purposeId = uniqueId('ew-approval-purpose');
      const reject = el('button', { type: 'button', class: 'ew-secondary', 'data-approval': 'reject' }, 'Reject');
      const accept = el('button', { type: 'button', class: 'ew-primary', 'data-approval': 'approve' }, 'Approve');
      reject.addEventListener('click', () => finish(false));
      accept.addEventListener('click', (event) => {
        if (event.isTrusted) finish(true);
      });
      const dialog = el('dialog', { class: 'ew-approval', 'aria-labelledby': titleId, 'aria-describedby': purposeId },
        el('h2', { id: titleId }, 'Approval needed'),
        el('p', { id: purposeId, class: 'ew-approval-purpose' }, purpose),
        el('dl', {}, el('dt', {}, 'Wallet action'), el('dd', {}, method)),
        el('p', {}, 'Exact content:'),
        el('pre', { class: 'ew-approval-content', tabindex: '0', 'aria-label': 'Exact content to approve' }, content),
        el('p', { class: 'ew-muted' }, NOTES[method] ?? WRITE_NOTE),
        el('p', { class: 'ew-muted' }, 'Approve only if you started this yourself and the content above is exactly what you expect. An AI assistant or a website cannot approve on your behalf.'),
        el('div', { class: 'ew-actions' }, reject, accept),
      );
      // Escape closes the dialog as a rejection.
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(false);
      });
      host.append(dialog);
      pending = { resolve, dialog, timer: setTimeout(() => finish(false), timeoutMs), returnFocus: document.activeElement };
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      reject.focus();
    });
  }

  return {
    approve,
    cancel: () => finish(false),
    get pending() {
      return pending !== null;
    },
  };
}
