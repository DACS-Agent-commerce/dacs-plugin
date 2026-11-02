// Shared DOM/text renderer. MCP supplies an escaped markup builder.
export function renderShowcaseProgress(ledger, el) {
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.stages) || ledger.stages.length !== 5) return null;
  const missing = (value) => value === null || value === undefined || value === '' ? 'Missing proof' : String(value);
  return el('section', { id: 'dacs-showcase-ledger', 'aria-label': 'DACS five-stage ledger' },
    el('h3', {}, 'DACS purchase ledger'),
    el('p', {}, `Profile: ${missing(ledger.profile)} · Substrate: ${missing(ledger.substrate)} · Recorded status: ${missing(ledger.status)}`),
    ...ledger.stages.map((stage) => el('article', { class: 'card' },
      el('h4', {}, `${missing(stage.name)} — ${missing(stage.state)}`), el('p', {}, missing(stage.reason)),
      ...stage.evidence.map((row) => el('details', {},
        el('summary', {}, `${missing(row.label)} — ${missing(row.state)}`),
        el('dl', {}, ...[
          ['Check', row.check], ['Reason', row.reason], ['Transaction hash', row.txHash],
          ['Block', row.block === null || row.block === undefined ? null : `Included in block ${row.block}`],
          ['Artifact key', row.artifactKey], ['Artifact hash', row.artifactHash], ['Observation scope', row.scope],
        ].flatMap(([name, value]) => [el('dt', {}, name), el('dd', {}, missing(value))])))))),
  );
}

export function showcaseProgressHtml(ledger) {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, props, ...children) => `<${tag}${Object.entries(props).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>${children.map((child) => child?.markup ?? escape(child)).join('')}</${tag}>`;
  const node = (tag, props, ...children) => ({ markup: el(tag, props, ...children) });
  return renderShowcaseProgress(ledger, node)?.markup ?? '';
}
