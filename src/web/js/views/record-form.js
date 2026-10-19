// Local preview only: the Table view's form for filling in an integration's missing details. It reads the record
// file through the preview server, offers the catalogue's own values, and saves through the server, which checks
// the whole catalogue before writing (scripts/lib/record-edit.mjs).

import { h, fill } from '../dom.js';

// What's missing or unconfirmed on an integration, as the table and the form name it.
export function gapsOf(i) {
  const gaps = [];
  const unsure = (v) => !v || v.uncertain || /\bTBC\b/i.test(v.value ?? '');
  if (!i.sources.length) gaps.push('Source');
  if (!i.targets.length) gaps.push('Target');
  if (!i.dataFlow) gaps.push('Data flow');
  if (unsure(i.pattern)) gaps.push('Pattern');
  if (unsure(i.sourceProtocol)) gaps.push('Source protocol');
  if (unsure(i.targetProtocol)) gaps.push('Target protocol');
  if (unsure(i.frequency)) gaps.push('Schedule');
  return gaps;
}

const api = (id, init = {}) => fetch(`api/records/${encodeURIComponent(id)}`, { ...init, headers: { 'X-WorldMap-Edit': '1', 'Content-Type': 'application/json', ...init.headers } })
  .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) }));

const isMissing = (v) => (Array.isArray(v) ? v.length === 0 : !v || /\bTBC\b/i.test(v) || /\?\s*$/.test(v));

// Renders the form into `el` for integration `id`. onSaved(message) runs after a successful save and rebuild.
export async function renderRecordForm(el, id, { onSaved, onCancel }) {
  fill(el, h('p', { class: 'note' }, `Loading ${id}…`));
  const { body } = await api(id);
  if (!body.ok) { fill(el, h('p', { class: 'form-error' }, body.error ?? 'Couldn’t load the record.')); return; }
  const { record, options: o, file } = body;
  const uid = (name) => `rf-${id.replace(/[^\w-]/g, '_')}-${name}`;

  // A label that says when the value is missing, so the gaps stand out.
  const field = (name, label, control, hint) => h('div', { class: `rf-field${isMissing(record[name]) ? ' missing' : ''}` },
    h('label', { for: uid(name) }, label, isMissing(record[name]) ? h('span', { class: 'rf-missing' }, ' missing') : null),
    control,
    hint ? h('span', { class: 'rf-hint' }, hint) : null);

  const datalist = (name, values) => h('datalist', { id: uid(`${name}-list`) }, values.map((v) => h('option', { value: v })));
  const text = (name, { list, placeholder } = {}) => h('input', {
    id: uid(name), name, type: 'text', value: Array.isArray(record[name]) ? record[name].join('; ') : record[name] ?? '',
    list: list ? uid(`${name}-list`) : null, placeholder, autocomplete: 'off',
  });

  // A vocab choice: the listed values plus "not known yet" and "doesn't apply", with "not confirmed" adding a "?".
  // A value written some other way (an alias, "File (TBC)") stays selectable as it is.
  const choice = (name, values) => {
    const written = String(record[name] ?? '');
    const unsure = /\?\s*$/.test(written);
    const base = written.replace(/\?\s*$/, '').trim();
    const all = [...values, o.unknown, o.notApplicable];
    const select = h('select', { id: uid(name), name },
      h('option', { value: '' }, '(blank)'),
      all.map((v) => h('option', { value: v, selected: v === base }, v)),
      base && !all.includes(base) ? h('option', { value: base, selected: true }, `${base} (as written)`) : null,
    );
    const confirm = h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `${name}-unsure`, checked: unsure }), ' not confirmed');
    return h('span', { class: 'rf-choice' }, select, confirm);
  };

  const status = h('div', { class: 'rf-status', role: 'status' });
  const form = h('form', { class: 'record-form', 'aria-label': `Edit ${id}` },
    h('p', { class: 'rf-head' }, h('strong', {}, `Edit ${id}`), h('span', { class: 'rf-hint' }, ` · saves to ${file}`)),
    datalist('systems', o.systems), datalist('release', o.release), datalist('workload', o.workload),
    h('div', { class: 'rf-grid' },
      field('source', 'Source system', text('source', { list: true, placeholder: 'e.g. ERP' }), 'Separate several with ;'),
      field('target', 'Target system', text('target', { list: true, placeholder: 'e.g. Bank' }), 'Separate several with ;'),
      field('dataFlow', 'Data flow', text('dataFlow', { placeholder: 'What data, in a few words' })),
      field('pattern', 'Pattern', choice('pattern', o.pattern)),
      field('sourceProtocol', 'Source protocol', choice('sourceProtocol', o.protocol)),
      field('targetProtocol', 'Target protocol', choice('targetProtocol', o.protocol)),
      field('frequency', 'Schedule', choice('frequency', o.frequency)),
      field('release', 'Release', text('release', { list: true })),
      field('workload', 'Workload', text('workload', { list: true })),
      field('link', 'Design page link', h('input', { id: uid('link'), name: 'link', type: 'url', value: record.link ?? '', placeholder: 'https://…' })),
      h('div', { class: 'rf-field wide' },
        h('label', { for: uid('notes') }, 'Notes'),
        h('textarea', { id: uid('notes'), name: 'notes', rows: 2 }, record.notes ?? '')),
    ),
    status,
    h('div', { class: 'rf-actions' },
      h('button', { type: 'submit', class: 'ghost primary' }, 'Save'),
      h('button', { type: 'button', class: 'ghost', onclick: () => onCancel() }, 'Cancel'),
    ),
  );

  // The form's values as record fields; only what changed is sent.
  const valueOf = (name) => {
    const get = (n) => form.elements.namedItem(n);
    if (name === 'source' || name === 'target') return get(name).value.split(';').map((s) => s.trim()).filter(Boolean);
    if (['pattern', 'sourceProtocol', 'targetProtocol', 'frequency'].includes(name)) {
      const v = get(name).value;
      return v && get(`${name}-unsure`).checked ? `${v}?` : v;
    }
    return get(name).value;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const changes = {};
    for (const name of ['source', 'target', 'dataFlow', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency', 'release', 'workload', 'link', 'notes']) {
      const now = valueOf(name);
      const was = record[name] ?? (name === 'source' || name === 'target' ? [] : '');
      if (JSON.stringify(now) !== JSON.stringify(was)) changes[name] = now;
    }
    if (!Object.keys(changes).length) { fill(status, h('p', {}, 'Nothing changed.')); return; }
    fill(status, h('p', {}, 'Checking and saving…'));
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const res = await api(id, { method: 'POST', body: JSON.stringify({ changes }) });
    form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    if (!res.body.ok) {
      fill(status, h('div', { class: 'form-error' },
        h('p', {}, res.body.error ?? 'Not saved.'),
        res.body.problems?.length ? h('ul', {}, res.body.problems.slice(0, 8).map((p) => h('li', {}, p))) : null));
      return;
    }
    const warn = res.body.warnings?.length ? ` Still to sort out: ${res.body.warnings.join(' ')}` : '';
    onSaved(`Saved ${id} to ${res.body.file}${res.body.rebuilt ? ' and rebuilt the map' : ' (the rebuild failed: use Rebuild data)'}. To publish it, commit it on a branch and raise a pull request.${warn}`);
  });

  fill(el, form);
  form.querySelector('.rf-field.missing input, .rf-field.missing select, input')?.focus();
}
