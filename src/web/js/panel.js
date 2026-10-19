// Details panel: a system, a system pair (edge), a matrix cell, or a single integration.

import { h, fill, swatch, extLink, warnBadge, compareText } from './dom.js';
import { domainOf, flagText, cellLinks, kindOf, lineKind } from './data.js';

const FIELD_LABELS = {
  dataFlow: 'Data flow',
  pattern: 'Pattern',
  sourceProtocol: 'Source protocol',
  targetProtocol: 'Target protocol',
  frequency: 'Schedule',
  release: 'Release',
  workload: 'Workload',
  epic: 'Epic',
  notes: 'Notes',
};

// keepScroll: the selection didn't change (a filter did), so leave the reader where they were.
export function renderPanel(el, sel, ctx, { keepScroll = false } = {}) {
  if (!sel) { el.replaceChildren(); return; }
  const scroll = el.scrollTop;
  const body =
    sel.type === 'system' ? systemPanel(sel.id, ctx)
    : sel.type === 'edge' ? edgePanel(sel.id, ctx)
    : sel.type === 'cell' ? cellPanel(sel.id, ctx)
    : sel.type === 'integration' ? integrationPanel(sel.key, ctx)
    : null;
  fill(el, nav(ctx), body ?? h('p', {}, 'Nothing selected.'));
  el.scrollTop = keepScroll ? scroll : 0;
}

function nav(ctx) {
  return h('div', { class: 'panel-nav' },
    ctx.canBack ? h('button', { type: 'button', onclick: () => ctx.back() }, '← Back') : h('span'),
    h('button', { type: 'button', onclick: () => ctx.close(), 'aria-label': 'Close details' }, '✕'),
  );
}

// The panel heading takes focus when details open (tabindex -1: focusable by script, not in the Tab order).
const heading = (...children) => h('h2', { tabindex: '-1' }, ...children);
const sysName = (ctx, id) => ctx.idx.systems.get(id)?.name ?? id;
// A system name that opens that system's details; the domain is said in words as well as by colour.
const sysChip = (ctx, id) => h('button', {
  type: 'button', class: 'sys-chip', title: `Show ${sysName(ctx, id)}`,
  onclick: () => ctx.select({ type: 'system', id }),
}, swatch(ctx.tokens.domain(domainOf(ctx.idx, id).slot)), sysName(ctx, id), h('span', { class: 'sr-only' }, ` (${domainOf(ctx.idx, id).name})`));
const filteredNote = (ctx) => (ctx.model.filtered ? h('p', { class: 'note' }, 'Counts reflect the current filters.') : null);
const unique = (list) => [...new Set(list)];

function intList(ctx, items, otherSide) {
  return h('ul', { class: 'int-list' }, items.map((i) =>
    h('li', {}, h('button', { type: 'button', dataset: { focusKey: `int:${i.key}` }, onclick: () => ctx.select({ type: 'integration', key: i.key }) },
      h('span', { class: 'id' }, i.id),
      h('span', { class: 'flow' }, i.dataFlow || '—'),
      h('span', { class: 'other' }, otherSide ? otherSide(i) : '', i.flags.length ? ' ⚠' : ''),
    )),
  ));
}

function systemPanel(id, ctx) {
  const s = ctx.idx.systems.get(id);
  if (!s) return [h('p', {}, 'This system is not in the catalogue.')];
  const d = domainOf(ctx.idx, id);
  const edges = [...ctx.model.edges.values()];
  // A two-way line counts as both sending and receiving, at both ends. An integration with two targets sits on
  // two lines, so each list is de-duplicated.
  const sends = unique(edges.filter((e) => e.source === id || (e.twoWay && e.target === id)).flatMap((e) => e.integrations));
  const receives = unique(edges.filter((e) => e.target === id || (e.twoWay && e.source === id)).flatMap((e) => e.integrations));
  // The other end, seen from this system (a two-way integration can sit on the line in either direction).
  const other = (i) => (i.sources.includes(id) ? i.targets : i.sources);
  const byOther = (list) => [...list].sort((a, b) => compareText(sysName(ctx, other(a)[0]), sysName(ctx, other(b)[0])) || compareText(a.id, b.id));
  const label = (arrow) => (i) => `${i.pattern.twoWay ? '↔' : arrow} ${other(i).map((t) => sysName(ctx, t)).join(', ')}`;
  const total = new Set([...sends, ...receives]).size;
  return [
    h('div', { class: 'sys-head' }, s.logo ? h('img', { class: 'sys-logo', src: s.logo, alt: '' }) : null, heading(s.name)),
    h('div', { class: 'meta' },
      h('span', {}, swatch(ctx.tokens.domain(d.slot)), d.name),
      h('span', {}, s.type === 'internal' ? 'Internal' : s.type === 'external' ? 'External' : 'Type not set'),
      s.wikiUrl ? extLink(s.wikiUrl, 'Wiki page') : null,
    ),
    !s.inSettings ? h('p', { class: 'note' }, 'Not in the systems list yet, so it has no domain.') : null,
    h('p', { class: 'stat' }, h('strong', {}, String(total)), `${total === 1 ? 'integration' : 'integrations'} · sends ${sends.length} · receives ${receives.length}`),
    filteredNote(ctx),
    sends.length ? h('h3', {}, 'Sends to') : null,
    sends.length ? intList(ctx, byOther(sends), label('→')) : null,
    receives.length ? h('h3', {}, 'Receives from') : null,
    receives.length ? intList(ctx, byOther(receives), label('←')) : null,
  ];
}

// What kind of line this is: one kind, or (lines merged) the kinds it carries and which one it's drawn as.
function kindNote(e, ctx) {
  const label = (k) => ctx.data.patternGroups?.[k]?.label ?? k;
  const kinds = Object.keys(e.kinds);
  if (kinds.length === 1) return `Line: ${label(kinds[0])}`;
  return `Line: drawn as ${label(lineKind(e))}; carries ${kinds.map((k) => `${label(k)} (${e.kinds[k]})`).join(', ')}`;
}

function edgePanel(id, ctx) {
  const e = ctx.model.edges.get(id);
  if (!e) return [h('p', {}, 'This connection is hidden by the current filters.')];
  return [
    heading(`${sysName(ctx, e.source)} ${e.twoWay ? '↔' : '→'} ${sysName(ctx, e.target)}`),
    h('div', { class: 'meta' }, sysChip(ctx, e.source), e.twoWay ? '↔' : '→', sysChip(ctx, e.target)),
    e.twoWay ? h('p', { class: 'note' }, 'Two-way: a request one way and a response back.') : null,
    h('p', { class: 'note' }, kindNote(e, ctx)),
    h('p', { class: 'stat' }, h('strong', {}, String(e.integrations.length)), e.integrations.length === 1 ? 'integration' : 'integrations'),
    filteredNote(ctx),
    h('h3', {}, 'Integrations'),
    intList(ctx, [...e.integrations].sort((a, b) => compareText(a.id, b.id))),
  ];
}

// A matrix cell: everything sent from the row system to the column system (data.js cellLinks).
function cellPanel(id, ctx) {
  const [s, t] = id.split('__');
  const links = cellLinks(ctx.model, id);
  if (!links.length) return [h('p', {}, 'This connection is hidden by the current filters.')];
  const items = unique(links.flatMap((e) => e.integrations)).sort((a, b) => compareText(a.id, b.id));
  const twoWay = links.find((e) => e.twoWay)?.integrations.length ?? 0;
  return [
    heading(`${sysName(ctx, s)} → ${sysName(ctx, t)}`),
    h('div', { class: 'meta' }, sysChip(ctx, s), '→', sysChip(ctx, t)),
    twoWay ? h('p', { class: 'note' }, `Includes ${twoWay} two-way ${twoWay === 1 ? 'integration' : 'integrations'} (a request and a response), which also count from ${sysName(ctx, t)} to ${sysName(ctx, s)}.`) : null,
    h('p', { class: 'stat' }, h('strong', {}, String(items.length)), items.length === 1 ? 'integration' : 'integrations'),
    filteredNote(ctx),
    h('h3', {}, 'Integrations'),
    intList(ctx, items, (i) => (i.pattern.twoWay ? '↔' : '')),
  ];
}

function integrationPanel(key, ctx) {
  const i = ctx.idx.integrations.get(key);
  if (!i) return [h('p', {}, 'This integration is not in the catalogue.')];
  const groups = ctx.data.patternGroups ?? {};
  const val = (v, extra) => {
    if (!v.value && !v.written) return h('span', { class: 'note' }, 'Not recorded');
    return [v.value ?? v.written, extra ?? ''];
  };
  const fields = {
    dataFlow: () => i.dataFlow || null,
    pattern: () => val(i.pattern, `${groups[kindOf(i)] ? ` · ${groups[kindOf(i)].label}` : ''}${i.pattern.twoWay ? ' · two-way (request and response)' : ''}`),
    sourceProtocol: () => val(i.sourceProtocol),
    targetProtocol: () => val(i.targetProtocol),
    frequency: () => val(i.frequency, i.frequency.uncertain ? ' · not confirmed' : ''),
    release: () => i.release || null,
    workload: () => i.workload || null,
    epic: () => (i.epic ? extLink(i.epic.url, `Epic ${i.epic.id}`) : null),
    notes: () => (i.notes || i.links.length
      ? [i.notes, i.links.length ? h('ul', { class: 'links' }, i.links.map((l) => h('li', {}, extLink(l.url, l.text || l.url)))) : null]
      : null),
  };
  const rows = ctx.site.detailFields
    .filter((f) => fields[f])
    .map((f) => [f, fields[f]()])
    .filter(([, v]) => v != null && v !== '')
    .flatMap(([f, v]) => [h('dt', {}, FIELD_LABELS[f] ?? f), h('dd', {}, v)]);
  const route = h('div', { class: 'meta route' },
    i.sources.length ? i.sources.map((s) => sysChip(ctx, s)) : h('span', { class: 'note' }, i.sourceText || 'No source'),
    i.pattern.twoWay ? '↔' : '→',
    i.targets.length ? i.targets.map((t) => sysChip(ctx, t)) : h('span', { class: 'note' }, i.targetText || 'No target'),
  );
  return [
    heading(i.id),
    route,
    i.url ? h('p', { class: 'note' }, extLink(i.url, 'Open the design page in the wiki')) : null,
    i.flags.length ? h('div', { class: 'flags' }, i.flags.map((f) => h('div', {}, warnBadge(flagText(f)), flagText(f)))) : null,
    h('dl', {}, rows),
    i.record && ctx.data.source.repoUrl
      ? h('p', { class: 'note' }, 'Record: ', extLink(`${ctx.data.source.repoUrl}?path=/${i.record}`, i.record))
      : null,
  ];
}
