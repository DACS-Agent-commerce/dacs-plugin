export function sellerIdentityPanel(identity, el) {
  if (!identity) return null;
  const rows = [];
  if (identity.status === 'observed' && identity.identities) {
    for (const [kind, entries] of Object.entries(identity.identities)) {
      rows.push(el('p', {}, `${kind === 'x' ? 'X (Twitter)' : kind}: `, ...entries.map((entry) =>
        el('span', {}, el('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer' }, entry.value), entry.punycode ? ' (punycode / IDNA A-label)' : '', ...(entry.signals ? [el('span', {}, ` ${entry.signals.label} `, ...(entry.signals.stars?.top ?? []).map((r) => el('span', {}, el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.name), `: ${r.stars} stars${r.archived ? ' (archived)' : ''}; `)))] : []), ' ')), entries.length ? '' : 'None observed'));
    }
    rows.push(el('p', {}, `${identity.otherAssociations} other associations not displayed; ${identity.unrecognizedEntries} unrecognized entries omitted.`));
  }
  return el('section', { id: 'seller-identity', role: 'note' },
    el('h3', {}, 'Seller’s Demos-linked identities'), el('p', {}, identity.label), ...rows,
    el('p', { class: 'muted' }, `${identity.evidence.mode}; configured network ${identity.evidence.network ?? 'unknown'}; RPC ${identity.evidence.rpcOrigin ?? 'not configured'}; server-local observation ${identity.evidence.observedAt}.`),
    el('p', { class: 'warn' }, identity.evidence.note), el('p', { class: 'muted' }, identity.evidence.readLimits.authority));
}
