// Adjacency matrix (L3): sources as rows, targets as columns, grouped by domain.
// Cell shade = number of integrations (one hue, light -> dark). Every cell is a focusable button.

import { h, plural, compareText } from '../dom.js';
import { showTooltip, hideTooltip, edgeTip } from '../tooltip.js';
import { domainOf, cellsOf } from '../data.js';

const BINS = [
  { max: 1, label: '1' },
  { max: 2, label: '2' },
  { max: 4, label: '3–4' },
  { max: 8, label: '5–8' },
  { max: Infinity, label: '9+' },
];
const binOf = (n) => BINS.findIndex((b) => n <= b.max) + 1;

function groups(systems, idx) {
  const out = [];
  for (const s of systems) {
    const d = domainOf(idx, s.id);
    if (out.at(-1)?.domain !== d) out.push({ domain: d, systems: [] });
    out.at(-1).systems.push(s);
  }
  return out;
}

export function renderMatrix(el, model, ctx, sel) {
  const { idx, tokens } = ctx;
  // Cells by row → column. A two-way line counts in both directions' cells; a cell keeps the lines it came from.
  const cellMap = new Map();
  for (const e of model.edges.values()) {
    for (const [s, t] of e.twoWay ? [[e.source, e.target], [e.target, e.source]] : [[e.source, e.target]]) {
      const id = `${s}__${t}`;
      let c = cellMap.get(id);
      if (!c) cellMap.set(id, (c = { id, source: s, target: t, integrations: [], flagged: false, links: [] }));
      c.integrations.push(...e.integrations);
      c.flagged ||= e.flagged;
      c.links.push(e);
    }
  }
  const cellList = [...cellMap.values()];
  const order = (a, b) => idx.domainOrder.get(a.domain) - idx.domainOrder.get(b.domain) || compareText(a.name, b.name);
  const rows = [...new Set(cellList.map((c) => c.source))].map((id) => idx.systems.get(id)).sort(order);
  const cols = [...new Set(cellList.map((c) => c.target))].map((id) => idx.systems.get(id)).sort(order);
  const rowGroups = groups(rows, idx);
  const colGroups = groups(cols, idx);
  const selectedSystem = sel?.type === 'system' ? sel.id : null;
  const selectedEdge = sel?.type === 'edge' ? sel.id : null;
  const selectedCell = sel?.type === 'cell' ? sel.id : null;
  const selectedPairs = new Set();
  if (sel?.type === 'integration') {
    const i = idx.integrations.get(sel.key);
    if (i) for (const id of cellsOf(i)) selectedPairs.add(id);
  }

  const legend = h('div', { class: 'mx-legend' },
    h('span', {}, 'Integrations from row system to column system:'),
    h('span', { class: 'bins' }, BINS.map((b, i) => h('span', { class: `bin bin-${i + 1}` }, b.label))),
    h('span', {}, '⚠ = some details not confirmed'),
  );

  const corner = (rowspan) => h('th', { class: 'corner', colspan: 2, rowspan }, 'Source ↓  Target →');
  // Narrow column groups get vertical text so a long domain name doesn't stretch its single column.
  const headGroups = h('tr', {}, corner(2), colGroups.map((g) => h('th', {
    class: g.systems.length < 3 ? 'grp narrow' : 'grp',
    colspan: g.systems.length,
    style: { '--c': tokens.domain(g.domain.slot) },
    scope: 'colgroup',
    title: g.domain.name,
  }, h('span', {}, g.domain.name))));
  // Row and column names open that system's details.
  const sysButton = (s, axis) => h('button', { type: 'button', class: 'mx-sys', 'aria-pressed': String(s.id === selectedSystem), dataset: { system: s.id, focusKey: `mx-${axis}:${s.id}` } }, s.name);
  const headCols = h('tr', {}, cols.map((c) => h('th', { class: `col${c.id === selectedSystem ? ' sel' : ''}`, scope: 'col', dataset: { col: c.id } }, sysButton(c, 'col'))));

  const body = [];
  for (const g of rowGroups) {
    g.systems.forEach((r, n) => {
      const cells = cols.map((c) => {
        const id = `${r.id}__${c.id}`;
        const e = cellMap.get(id);
        if (!e) return h('td', { dataset: { col: c.id } });
        const count = e.integrations.length;
        const name = `${r.name} to ${c.name}: ${plural(count, 'integration')}${e.flagged ? ', some details not confirmed' : ''}`;
        const isSel = id === selectedCell || e.links.some((l) => l.id === selectedEdge) || selectedPairs.has(id);
        // A cell made of one line opens that line; a cell that also holds a two-way line opens the whole cell,
        // so the panel lists exactly what the cell counts.
        const target = e.links.length === 1 ? { type: 'edge', id: e.links[0].id } : { type: 'cell', id };
        return h('td', { dataset: { col: c.id } },
          h('button', {
            type: 'button',
            class: `cell bin-${binOf(count)}${e.flagged ? ' flag' : ''}${isSel ? ' sel' : ''}`,
            'aria-label': name,
            'aria-pressed': String(isSel),
            dataset: { selType: target.type, selId: target.id, cell: id, focusKey: `cell:${id}` },
          }, String(count)));
      });
      body.push(h('tr', { dataset: { row: r.id } },
        n === 0 ? h('th', { class: 'grp', rowspan: g.systems.length, style: { '--c': tokens.domain(g.domain.slot) }, scope: 'rowgroup' }, g.domain.name) : null,
        h('th', { class: `row${r.id === selectedSystem ? ' sel' : ''}`, scope: 'row' }, sysButton(r, 'row')),
        cells,
      ));
    });
  }

  const table = h('table', { class: 'mx' }, h('thead', {}, headGroups, headCols), h('tbody', {}, body));

  // Crosshair: highlight the row and column of the hovered/focused cell.
  const cross = (cell, on) => {
    const td = cell.closest('td');
    const tr = cell.closest('tr');
    const col = td?.dataset.col;
    tr?.querySelector('th.row')?.classList.toggle('xh', on);
    table.querySelector(`thead th.col[data-col="${CSS.escape(col)}"]`)?.classList.toggle('xh', on);
    table.querySelectorAll(`td[data-col="${CSS.escape(col)}"]`).forEach((x) => x.classList.toggle('xh', on));
    tr?.querySelectorAll('td').forEach((x) => x.classList.toggle('xh', on));
  };
  const tipFor = (btn) => edgeTip(cellMap.get(btn.dataset.cell), ctx);
  table.addEventListener('pointerover', (ev) => {
    const btn = ev.target.closest('button.cell');
    if (!btn) return;
    cross(btn, true);
    showTooltip(ev.clientX, ev.clientY, tipFor(btn));
  });
  table.addEventListener('pointerout', (ev) => {
    const btn = ev.target.closest('button.cell');
    if (!btn) return;
    cross(btn, false);
    hideTooltip();
  });
  table.addEventListener('focusin', (ev) => {
    const btn = ev.target.closest('button.cell');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    cross(btn, true);
    showTooltip(r.right, r.bottom, tipFor(btn));
  });
  table.addEventListener('focusout', (ev) => {
    const btn = ev.target.closest('button.cell');
    if (btn) { cross(btn, false); hideTooltip(); }
  });
  table.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.cell');
    if (btn) { hideTooltip(); ctx.select({ type: btn.dataset.selType, id: btn.dataset.selId }); }
    const sys = ev.target.closest('button.mx-sys');
    if (sys) ctx.select({ type: 'system', id: sys.dataset.system });
  });

  el.replaceChildren(legend, table);
}
