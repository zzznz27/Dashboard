// Table view: every filtered integration as a row. The accessible twin of the map.
// On the local preview (site.devTools.edit) rows can also be edited, to fill in missing details (record-form.js).

import { h, fill, swatch, warnBadge, plural, srOnly } from '../dom.js';
import { domainOf } from '../data.js';
import { gapsOf, renderRecordForm } from './record-form.js';

// Editor state for this page: the "missing details only" switch, the row being edited, and the last save message.
const edit = { missingOnly: false, open: null, notice: '' };

export function renderTable(el, model, ctx, sel) {
  const { idx, tokens, data } = ctx;
  const editing = Boolean(ctx.site.devTools?.edit);
  // System names open that system's details; the domain is said in words as well as shown by colour.
  const sys = (ids, written) => {
    if (!ids.length) return h('span', { class: 'dim' }, written || '—');
    return ids.map((id, n) => {
      const d = domainOf(idx, id);
      const name = idx.systems.get(id)?.name ?? id;
      return h('span', { class: 'sys' }, n ? ', ' : null,
        h('button', { type: 'button', class: 'sys-link', dataset: { system: id, focusKey: `tsys:${id}` }, title: `Show ${name}` },
          swatch(tokens.domain(d.slot)), name, srOnly(` (${d.name})`)));
    });
  };
  const value = (v) => (v.value ? v.value : h('span', { class: 'dim' }, v.written || '—'));
  const selKey = sel?.type === 'integration' ? sel.key : null;
  const columns = ['ID', 'From', 'To', 'Data flow', 'Pattern', 'Schedule', 'Release', 'Workload', 'Flags', ...(editing ? ['Edit'] : [])];

  const withGaps = model.integrations.map((i) => ({ i, gaps: editing ? gapsOf(i) : [] }));
  const shown = editing && edit.missingOnly ? withGaps.filter((x) => x.gaps.length) : withGaps;

  const rows = shown.flatMap(({ i, gaps }) => {
    const row = h('tr', { class: i.key === selKey ? 'sel' : null, dataset: { key: i.key } },
      h('td', { class: 'id' }, h('button', { type: 'button', 'aria-label': `Show details for ${i.id}`, dataset: { focusKey: `trow:${i.key}` } }, i.id)),
      h('td', {}, sys(i.sources, i.sourceText)),
      h('td', {}, sys(i.targets, i.targetText)),
      h('td', {}, i.dataFlow),
      h('td', {}, value(i.pattern)),
      h('td', {}, value(i.frequency)),
      h('td', {}, i.release),
      h('td', {}, i.workload || h('span', { class: 'dim' }, '—')),
      h('td', {}, i.flags.length ? warnBadge('Some details not confirmed - open for details') : null),
      editing ? h('td', { class: 'edit' }, h('button', {
        type: 'button', class: `ghost small${gaps.length ? ' fill' : ''}`, dataset: { edit: i.id, focusKey: `tedit:${i.key}` },
        title: gaps.length ? `Missing or not confirmed: ${gaps.join(', ')}` : 'Edit this integration',
        'aria-expanded': String(edit.open === i.id),
      }, gaps.length ? `Fill in (${gaps.length})` : 'Edit')) : null,
    );
    if (edit.open !== i.id) return [row];
    const cell = h('td', { colspan: columns.length });
    const formRow = h('tr', { class: 'editor-row' }, cell);
    renderRecordForm(cell, i.id, {
      onSaved: (message) => { edit.open = null; edit.notice = message; ctx.reloadData(); },
      onCancel: () => { edit.open = null; renderTable(el, model, ctx, sel); el.querySelector(`[data-edit="${CSS.escape(i.id)}"]`)?.focus(); },
    });
    return [row, formRow];
  });

  const table = h('table', { class: 'tv' },
    h('caption', { class: 'sr-only' }, 'Integrations matching the current filters'),
    h('thead', {}, h('tr', {}, columns.map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows),
  );
  table.addEventListener('click', (ev) => {
    const editBtn = ev.target.closest('button[data-edit]');
    if (editBtn) {
      edit.open = edit.open === editBtn.dataset.edit ? null : editBtn.dataset.edit;
      edit.notice = '';
      renderTable(el, model, ctx, sel);
      return;
    }
    if (ev.target.closest('.editor-row')) return;
    const sysBtn = ev.target.closest('button.sys-link');
    if (sysBtn) { ctx.select({ type: 'system', id: sysBtn.dataset.system }); return; }
    const tr = ev.target.closest('tbody tr');
    if (tr) ctx.select({ type: 'integration', key: tr.dataset.key });
  });

  const missing = withGaps.filter((x) => x.gaps.length).length;
  fill(el,
    h('p', { class: 'tv-meta' }, `${plural(shown.length, 'integration')}${model.filtered || shown.length !== data.integrations.length ? ` of ${data.integrations.length}` : ''}. Select an ID for full details, or a system for everything it connects to.`),
    editing ? h('div', { class: 'tv-edit-bar' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', id: 'tv-missing-only', checked: edit.missingOnly, onchange: (e) => { edit.missingOnly = e.target.checked; renderTable(el, model, ctx, sel); } }),
        ` Missing details only (${missing})`),
      h('span', { class: 'rf-hint' }, 'Local preview: edits save to the catalogue files in this repo.'),
    ) : null,
    edit.notice ? h('p', { class: 'tv-notice', role: 'status' }, edit.notice) : null,
    table,
  );
}
