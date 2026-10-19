// Design lab ("Customise…" in the Theme picker, or ?lab=1): mix layout, theme and animation live, save the mix as
// one of this browser's designs (designs.js), and share it as a file. On the local preview it can also copy the
// mix as a preset file for config/presets/ and open the compare page.

import { h, fill } from './dom.js';
import { THEMES, themeLabel, prefersReducedMotion } from './theme.js';
import { isMine, cleanName, saveDesign, deleteDesign, designFile, importDesign } from './designs.js';

const VIEWS = [
  { id: 'clusters', label: 'Grouped by domain', view: 'graph', layout: 'clusters' },
  { id: 'network', label: 'Free-form network', view: 'graph', layout: 'network' },
  { id: 'matrix', label: 'Grid (who talks to whom)', view: 'matrix', layout: null },
];
const AMBIENT = [['none', 'None (still lines)'], ['flow', 'Flowing dots'], ['ants', 'Marching ants'], ['comets', 'Comets'], ['packets', 'Data packets'], ['pulse', 'Pulse'], ['water', 'Water'], ['lightning', 'Lightning']];
const ON_SELECT = [['focus-pulse', 'Pulse the system and its partners'], ['none', 'Nothing']];
const LOGOS = [['none', 'No, names only'], ['mark', 'Yes, the brand’s symbol']];

// What a design is made of, in the lab's words: Grouped by domain · Space · Comets.
const describe = (x, theme = x.theme) => [
  VIEWS.find((v) => v.id === (x.view === 'matrix' ? 'matrix' : x.layout))?.label,
  themeLabel(theme),
  x.view === 'graph' && x.animation?.ambient !== 'none' ? AMBIENT.find(([v]) => v === x.animation?.ambient)?.[1] : null,
].filter(Boolean).join(' · ');

const options = (pairs, value) => pairs.map(([v, label]) => h('option', { value: v, selected: v === value }, label));
// The panel is drawn again after every change, so what's typed in the name box and whether More options is open
// are kept here.
let draftName = null;
let moreOpen = false;

const field = (label, hint, control) => h('label', {}, h('span', { class: 'lab-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

export function renderLab(el, ctx) {
  const p = ctx.preset;
  const dev = Boolean(ctx.site.lab);
  const viewId = p.view === 'matrix' ? 'matrix' : p.layout;
  const isGraph = p.view === 'graph';
  // The saved design being changed, if any: a change makes an unsaved copy that remembers where it came from.
  const editing = isMine(p) ? p : ctx.designs.find((d) => d.id === p.from) ?? null;
  const update = (patch) => ctx.applyPreset({ ...p, ...patch, id: 'custom', label: 'Unsaved changes', from: isMine(p) ? p.id : p.from });
  const deep = (key, patch) => update({ [key]: { ...p[key], ...patch } });
  const byId = (id) => ctx.designs.find((d) => d.id === id) ?? ctx.site.presets.find((x) => x.id === id);

  const startSelect = h('select', { onchange: (e) => { const next = byId(e.target.value); if (next) { draftName = null; ctx.choosePreset(next); } } },
    p.id === 'custom' ? h('option', { value: 'custom', selected: true }, editing ? `${editing.label} (unsaved changes)` : 'Unsaved changes') : null,
    ctx.designs.length ? h('optgroup', { label: 'My designs' }, ctx.designs.map((d) => h('option', { value: d.id, selected: d.id === p.id, title: describe(d) }, d.label))) : null,
    h('optgroup', { label: 'Ready-made' }, ctx.site.presets.map((x) => h('option', { value: x.id, selected: x.id === p.id, title: describe(x) }, x.label))),
  );
  const viewSelect = h('select', { onchange: (e) => { const v = VIEWS.find((x) => x.id === e.target.value); update({ view: v.view, layout: v.layout ?? p.layout }); } },
    VIEWS.map((v) => h('option', { value: v.id, selected: v.id === viewId }, v.label)));
  const themeSelect = h('select', { onchange: (e) => { ctx.setTheme(e.target.value); update({ theme: e.target.value }); } }, options(THEMES.map((t) => [t.id, t.label]), ctx.theme));
  const ambientSelect = h('select', { disabled: !isGraph, onchange: (e) => deep('animation', { ambient: e.target.value }) }, options(AMBIENT, p.animation.ambient));
  const selectSelect = h('select', { disabled: !isGraph, onchange: (e) => deep('animation', { onSelect: e.target.value }) }, options(ON_SELECT, p.animation.onSelect));
  const logoSelect = h('select', { disabled: !isGraph, onchange: (e) => deep('nodes', { logo: e.target.value }) }, options(LOGOS, p.nodes?.logo ?? 'none'));
  const check = (label, checked, onChange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, disabled: !isGraph, onchange: (e) => onChange(e.target.checked) }), label);

  // ---- Save, delete, share
  const status = h('p', { class: 'lab-status', role: 'status', 'aria-live': 'polite' });
  const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('bad', bad); };
  const nameInput = h('input', { type: 'text', maxlength: 60, placeholder: 'For example: My calm dark map', 'aria-label': 'Design name', value: draftName ?? editing?.label ?? '', oninput: (e) => { draftName = e.target.value; } });
  const name = () => cleanName(nameInput.value);
  const save = (replaceId) => {
    if (!name()) { say('Give the design a name first.', true); nameInput.focus(); return; }
    try {
      const saved = saveDesign(p, { name: name(), theme: ctx.theme, replaceId }, ctx.basePreset);
      draftName = null;
      ctx.designsChanged();
      ctx.choosePreset(saved);
      ctx.announce(`Saved “${saved.label}”. It’s in the Theme list under My designs.`);
    } catch (err) {
      say(err.message, true);
    }
  };
  const remove = () => {
    if (!editing || !confirm(`Delete the design “${editing.label}” from this browser?`)) return;
    deleteDesign(editing.id);
    draftName = null;
    ctx.designsChanged();
    ctx.choosePreset(byId(ctx.site.defaultPreset) ?? ctx.site.presets[0]);
    ctx.announce(`Deleted “${editing.label}”.`);
  };
  const download = () => {
    const label = name() || editing?.label || 'My design';
    const url = URL.createObjectURL(new Blob([designFile(p, label, ctx.theme)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `${label.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'design'}.worldmap.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('Downloaded. Send the file to a colleague; they open it with Import.');
  };
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const saved = await importDesign(file, ctx.basePreset);
      draftName = null;
      ctx.designsChanged();
      ctx.choosePreset(saved);
      ctx.announce(`Imported “${saved.label}”. It’s in the Theme list under My designs.`);
    } catch (err) {
      say(err.message, true);
    }
  } });

  const saveButtons = editing
    ? [h('button', { type: 'button', class: 'ghost small primary', onclick: () => save(editing.id) }, 'Save changes'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => save(null) }, 'Save as new')]
    : [h('button', { type: 'button', class: 'ghost small primary', onclick: () => save(null) }, 'Save design')];

  // ---- Local preview only: copy as a preset file for config/presets/
  const output = h('textarea', { readonly: true, hidden: true, 'aria-label': 'Preset JSON' });
  const copy = async () => {
    const { id, label, from, ...rest } = p;
    const named = id !== 'custom' && !isMine(p);
    const json = JSON.stringify({ id: named ? id : 'my-new-preset', label: named ? label : 'My new preset', ...rest, round: rest.round ?? null, theme: ctx.theme }, null, 2);
    output.value = json;
    output.hidden = false;
    output.select();
    try { await navigator.clipboard.writeText(json); copyBtn.textContent = 'Copied ✓'; } catch { copyBtn.textContent = 'Select and copy below'; }
    setTimeout(() => { copyBtn.textContent = 'Copy as preset'; }, 2000);
  };
  const copyBtn = h('button', { type: 'button', class: 'ghost small', onclick: copy }, 'Copy as preset');
  const compareFrom = p.id === 'custom' || isMine(p) ? ctx.site.defaultPreset : p.id;

  // Keep keyboard focus on the same control after the redraw.
  const focusable = () => [...el.querySelectorAll('select, input, button, summary, a')];
  const focusedAt = focusable().indexOf(document.activeElement);

  fill(el,
    h('button', { type: 'button', class: 'collapse', title: 'Close', 'aria-label': 'Close the design lab', onclick: () => ctx.closeLab() }, '✕'),
    h('h2', {}, 'Design lab'),
    h('p', {}, 'Choose how the map looks and moves. Changes show straight away. Save a mix to keep it: it appears in the Theme list under My designs, in this browser only.'),
    prefersReducedMotion() ? h('p', { class: 'note' }, 'This device asks for less motion, so animations are paused. Turn Animations on in ⚙ Map settings to see them.') : null,
    field('Start from', describe(p, ctx.theme), startSelect),
    field('Layout', null, viewSelect),
    field('Theme', 'Colours and fonts', themeSelect),
    field('Moving lines', isGraph ? 'How data is shown flowing along the lines' : 'Only on the map layouts', ambientSelect),
    field('When you select a system', null, selectSelect),
    field('Logos on systems', null, logoSelect),
    h('details', { class: 'lab-more', open: moreOpen, ontoggle: (e) => { moreOpen = e.target.open; } },
      h('summary', {}, 'More options'),
      check('Settle into place on load', p.animation.settle, (v) => deep('animation', { settle: v })),
      check('Draw lines on load', p.animation.drawOn !== false, (v) => deep('animation', { drawOn: v })),
      check('Fade when filters change', p.animation.filterFade !== false, (v) => deep('animation', { filterFade: v })),
      check('Animate lines with no known schedule', p.animation.animateUnscheduled !== false, (v) => deep('animation', { animateUnscheduled: v })),
      check('Line style shows the kind (file, API…)', p.edges.styleBy === 'pattern', (v) => deep('edges', { styleBy: v ? 'pattern' : 'none' })),
      check('Domain name under each system', p.labels.showDomain, (v) => deep('labels', { showDomain: v })),
      check('⚠ on lines with unconfirmed details', p.edges.flagUncertain, (v) => deep('edges', { flagUncertain: v })),
    ),
    h('section', { class: 'lab-save', 'aria-label': 'Save and share' },
      h('h3', {}, editing ? `Your design: ${editing.label}` : 'Save this design'),
      field('Name', null, nameInput),
      h('div', { class: 'actions' }, saveButtons, editing ? h('button', { type: 'button', class: 'ghost small', onclick: remove }, 'Delete') : null),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'ghost small', title: 'Download this design as a file to share', onclick: download }, 'Share as file'),
        h('button', { type: 'button', class: 'ghost small', title: 'Add a design someone shared with you', onclick: () => fileInput.click() }, 'Import…'),
        fileInput,
      ),
      status,
    ),
    dev ? h('section', { class: 'lab-dev', 'aria-label': 'Local preview tools' },
      h('h3', {}, 'Local preview'),
      h('p', {}, 'Make it a ready-made design for everyone by saving the JSON in src/config/presets/.'),
      h('div', { class: 'actions' }, copyBtn, h('a', { class: 'ghost small', href: `compare.html?left=${encodeURIComponent(compareFrom)}` }, 'Compare…')),
      output,
    ) : null,
  );
  if (focusedAt >= 0) focusable()[focusedAt]?.focus();
}
