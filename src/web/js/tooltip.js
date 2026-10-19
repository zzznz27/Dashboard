// One shared tooltip. Value first, label second; series identity via a short line key.
// Tooltips only repeat what the details panel and table view already show.

import { h, $, lineKey, plural } from './dom.js';
import { domainOf } from './data.js';

export function showTooltip(x, y, content) {
  const t = $('tooltip');
  t.replaceChildren(content);
  t.hidden = false;
  moveTooltip(x, y);
}

export function moveTooltip(x, y) {
  const t = $('tooltip');
  if (t.hidden) return;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}

export function hideTooltip() {
  $('tooltip').hidden = true;
}

export function systemTip(system, model, ctx) {
  const d = domainOf(ctx.idx, system.id);
  // A two-way line counts as both sending and receiving, at both ends.
  const edges = [...model.edges.values()];
  // An integration with two targets sits on two lines; count it once.
  const unique = (list) => [...new Set(list)];
  const sends = unique(edges.filter((e) => e.source === system.id || (e.twoWay && e.target === system.id)).flatMap((e) => e.integrations));
  const receives = unique(edges.filter((e) => e.target === system.id || (e.twoWay && e.source === system.id)).flatMap((e) => e.integrations));
  const [out, inn, total] = [sends.length, receives.length, new Set([...sends, ...receives]).size];
  return h('div', {},
    system.logo ? h('img', { class: 'tip-logo', src: system.logo, alt: '' }) : null,
    h('div', { class: 'value' }, plural(total, 'integration')),
    h('div', { class: 'row' }, lineKey(ctx.tokens.domain(d.slot)), system.name),
    h('div', { class: 'row' }, `${d.name} · ${system.type === 'internal' ? 'Internal' : system.type === 'external' ? 'External' : 'Type not set'}`),
    h('div', { class: 'row' }, `Sends ${out} · receives ${inn}`),
  );
}

export function edgeTip(edge, ctx) {
  const name = (id) => ctx.idx.systems.get(id)?.name ?? id;
  const list = edge.integrations.slice(0, 5);
  return h('div', {},
    h('div', { class: 'value' }, plural(edge.integrations.length, 'integration')),
    h('div', { class: 'row' }, lineKey(ctx.tokens.domain(domainOf(ctx.idx, edge.source).slot)), `${name(edge.source)} ${edge.twoWay ? '↔' : '→'} ${name(edge.target)}`),
    h('div', { class: 'row' }, Object.keys(edge.kinds).map((k) => ctx.data.patternGroups?.[k]?.label ?? k).join(' + ')),
    h('ul', {}, list.map((i) => h('li', {}, h('span', { class: 'id' }, i.id), ` ${i.dataFlow}${!edge.twoWay && i.pattern.twoWay ? ' ↔' : ''}`))),
    edge.integrations.length > list.length ? h('div', { class: 'row' }, `+ ${edge.integrations.length - list.length} more`) : null,
  );
}
