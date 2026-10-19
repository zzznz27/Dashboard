// Small DOM helpers. All text goes in as text nodes - catalogue content is never parsed as HTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (id) => document.getElementById(id);

// replaceChildren() would print null/false as text, so drop them first.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

// The build only accepts https links; check again here so nothing else ever becomes a link.
const safeHref = (url) => (/^https:\/\//i.test(url ?? '') ? url : null);

export function extLink(url, text) {
  const href = safeHref(url);
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : h('span', {}, text);
}

export const swatch = (colour, square = false) => h('span', { class: square ? 'swatch square' : 'swatch', style: { '--c': colour }, 'aria-hidden': 'true' });
export const lineKey = (colour) => h('span', { class: 'linekey', style: { '--c': colour }, 'aria-hidden': 'true' });
export const warnBadge = (label = 'Some details are not confirmed yet') => h('span', { class: 'warn-badge', role: 'img', title: label, 'aria-label': label }, '!');
// Text for screen readers only.
export const srOnly = (text) => h('span', { class: 'sr-only' }, text);

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One sort order for names and IDs everywhere, whatever the browser's language (numbers in order: I8 before I10).
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const compareText = (a, b) => collator.compare(a ?? '', b ?? '');
