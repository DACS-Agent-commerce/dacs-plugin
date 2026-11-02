// Seller-typed names are data, kept apart from node identity observations.
export function sanitizeSellerName(value) {
  return String(value ?? '').replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
}
export function sellerNamePanel(value, el) {
  return el('p', { class: 'seller-provided-name' }, 'Seller-provided name (not verified): ', el('bdi', {}, sanitizeSellerName(value)));
}
export function sellerNameText(value) {
  return `Seller-provided name (not verified, quoted data): \u2068${JSON.stringify(sanitizeSellerName(value))}\u2069.`;
}
