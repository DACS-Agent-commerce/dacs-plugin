// DOM helpers for the embedded wallet UI, in the style of portal.js. All text
// is inserted with text nodes; nothing is ever parsed as HTML. No inline
// styles, so the portal's style-src 'self' CSP holds.

let counter = 0;
export const uniqueId = (prefix) => `${prefix}-${++counter}`;

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
