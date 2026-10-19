// Integration World Map - page controller: state, filters, view switching, selection, URL.

import { $, h, fill, extLink, plural } from './dom.js';
import { loadData, applyFilters, NONE, setSplitByKind } from './data.js';
import { readUrl, writeUrl, decodeSel } from './url.js';
import { THEMES, themeLabel, themed, applyTheme, readTokens, savedTheme, saveTheme, savedPreset, savePreset, prefersReducedMotion, setMotionChoice, satellitesOn, setSatellites, selectionOnlyOn, setSelectionOnly, hoverPreviewOn, setHoverPreview, mergeLinesOn, setMergeLines } from './theme.js';
import { hideTooltip } from './tooltip.js';
import { GraphView } from './views/graph.js';
import { renderMatrix } from './views/matrix.js';
import { renderTable } from './views/table.js';
import { renderPanel } from './panel.js';
import { renderLegend } from './legend.js';
import { renderLab } from './lab.js';
import { loadDesigns, isMine } from './designs.js';

const FILTER_LABELS = { release: 'Release', workload: 'Workload', patternGroup: 'Pattern', domain: 'Domain' };
const S = {}; // page state
let graph;

// What views, the panel, legend and lab are allowed to see and do.
const ctx = {
  get data() { return S.data; },
  get idx() { return S.idx; },
  get site() { return S.site; },
  get tokens() { return S.tokens; },
  get model() { return S.model; },
  get preset() { return S.preset; },
  get theme() { return S.theme; },
  get filters() { return S.filters; },
  get designs() { return S.designs; },
  get basePreset() { return basePreset(); },
  // The lab's theme choice: part of the mix being made, so the lab redraws it as unsaved changes.
  setTheme: (id) => { S.theme = id; if (!S.embed) saveTheme(id); },
  get canBack() { return S.history.length > 0; },
  select: (sel) => select(sel),
  preview: (sel) => graph?.highlight(sel ?? S.sel, { pulse: false }),
  setFilter: (key, value) => setFilter(key, value),
  back: () => select(S.history.pop() ?? null, { push: false }),
  close: () => select(null),
  applyPreset: (p) => applyPreset(p),
  choosePreset: (p) => choosePreset(p),
  chooseTheme: (id) => chooseTheme(id),
  designsChanged: () => designsChanged(),
  closeLab: () => { S.lab = false; $('lab').hidden = true; renderFooter(); writeUrl(S); },
  announce: (text) => announce(text),
  reloadData: () => reloadData(),
};

boot();

async function boot() {
  setSplitByKind(!mergeLinesOn());
  $('loading').hidden = false;
  $('load-error').hidden = true;
  try {
    Object.assign(S, await loadData());
  } catch (err) {
    return showLoadError('The map data couldn’t be loaded.', err);
  }
  try {
    start();
  } catch (err) {
    return showLoadError('The map couldn’t start.', err);
  } finally {
    $('loading').hidden = true;
  }
}

// Written for staff: what happened, what to try, and the technical detail tucked away for whoever helps.
function showLoadError(message, err) {
  console.error(err);
  $('loading').hidden = true;
  $('filters').hidden = true;
  fill($('load-error'),
    h('p', { class: 'strong' }, message),
    h('p', {}, 'Try again. If it keeps happening, let the integration team know.'),
    h('button', { type: 'button', class: 'ghost', onclick: () => location.reload() }, 'Try again'),
    h('details', { class: 'note' }, h('summary', {}, 'Technical details'), h('p', {}, String(err?.message ?? err))),
  );
  $('load-error').hidden = false;
}

function start() {
  const url = readUrl();
  S.embed = url.embed === '1';
  // A shared link wins; otherwise this browser's last choice (not inside the compare page's frames); otherwise the default.
  S.designs = S.embed ? [] : loadDesigns(basePreset());
  const byId = (id) => S.site.presets.find((p) => p.id === id) ?? S.designs.find((p) => p.id === id);
  S.preset = byId(url.preset) ?? (S.embed ? null : byId(savedPreset())) ?? byId(S.site.defaultPreset) ?? S.site.presets[0];
  S.readyMade = isMine(S.preset) ? basePreset() : S.preset;
  S.theme = THEMES.some((t) => t.id === url.theme) ? url.theme : (S.embed ? null : savedTheme()) ?? S.preset.theme;
  S.view = url.view === 'table' ? 'table' : 'map';
  S.filters = { q: url.q, release: url.release, workload: url.workload, patternGroup: url.patternGroup, domain: url.domain };
  // A filter value from an old or edited link that no longer exists would silently match nothing; drop it.
  for (const key of S.site.filters ?? []) {
    const known = new Set((S.data.facets[key] ?? []).map((f) => (f.value === '' ? NONE : f.value)));
    if (S.filters[key] && !known.has(S.filters[key])) S.filters[key] = '';
  }
  S.sel = decodeSel(url.sel);
  S.history = [];
  S.lab = !S.embed && url.lab === '1';

  document.body.classList.toggle('embed', S.embed);
  document.title = S.site.title;
  $('title').textContent = S.site.title;
  $('subtitle').textContent = S.site.subtitle ?? '';

  graph = new GraphView({ container: $('map'), canvas: $('flow'), sky: $('sky'), ctx });
  buildThemePicker();
  buildFilters();
  bindUi();
  applyPreset(themed(S.preset, S.theme));
}

// ---- Presets & rendering -------------------------------------------------------

function applyPreset(preset) {
  S.preset = preset;
  applyTheme(S.theme);
  showThemeChoice();
  S.tokens = readTokens();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--page').trim());
  S.model = applyFilters(S.data, S.idx, S.filters);
  keepFocus(() => {
    renderStage();
    renderSide();
  });
  renderSummary();
  renderFooter();
  $('lab').hidden = !S.lab;
  if (S.lab) renderLab($('lab'), ctx);
  writeUrl(S);
  redrawWhenFontLoads();
}

// A theme with a web font downloads it on first use. The page's text swaps over by
// itself, but the map draws its labels on a canvas, so draw it again once the font has arrived.
function redrawWhenFontLoads() {
  const spec = `500 12px ${S.tokens.font}`;
  if (!document.fonts || !S.tokens.font || document.fonts.check(spec)) return;
  const theme = S.theme;
  document.fonts.load(spec).then(() => {
    if (S.theme === theme && document.fonts.check(spec)) applyPreset(S.preset);
  }, () => {});
}

// A design picked in the lab brings its own theme; a theme picked in the header keeps the design. Both are
// remembered in this browser, so the map opens the same way next time.
function choosePreset(preset) {
  S.theme = preset.theme;
  if (preset.id !== 'custom' && !isMine(preset)) S.readyMade = preset;
  if (!S.embed && preset.id !== 'custom') { savePreset(preset.id); saveTheme(preset.theme); }
  applyPreset(preset);
}

// The theme brings its line animation and logos (themed), worked out from the design as saved, so going back to
// the design's own theme gives back its own animation.
function chooseTheme(id) {
  S.theme = id;
  if (!S.embed) saveTheme(id);
  applyPreset(themed(S.site.presets.find((p) => p.id === S.preset.id) ?? S.preset, id));
}

// The ready-made design new designs are built on, for anything they don't set.
const basePreset = () => S.site.presets.find((p) => p.id === S.site.defaultPreset) ?? S.site.presets[0];

// The header's Theme list: the themes, then this browser's saved designs (each brings its layout and animation too),
// then Customise…, which opens the design lab.
const DESIGN = 'design:';
const CUSTOMISE = 'customise';

function buildThemePicker() {
  const sel = $('theme-select');
  fillThemePicker();
  sel.addEventListener('change', () => {
    if (sel.value === CUSTOMISE) { showThemeChoice(); openLab(); return; }
    if (sel.value.startsWith(DESIGN)) {
      const design = S.designs.find((d) => d.id === sel.value.slice(DESIGN.length));
      if (design) choosePreset(design);
      return;
    }
    // A theme picked here while a saved design is on leaves the design for the ready-made one it replaced, so
    // picking "Space" gives the Space theme, not a saved design that happens to use it.
    if (isMine(S.preset)) {
      if (!S.embed) savePreset(S.readyMade.id);
      S.preset = S.readyMade;
    }
    chooseTheme(sel.value);
  });
}

function fillThemePicker() {
  fill($('theme-select'),
    h('optgroup', { label: 'Themes' }, THEMES.map((t) => h('option', { value: t.id }, t.label))),
    S.designs.length ? h('optgroup', { label: 'My designs' }, S.designs.map((d) => h('option', { value: DESIGN + d.id }, d.label))) : null,
    S.embed ? null : h('option', { value: CUSTOMISE }, 'Customise…'),
  );
  showThemeChoice();
}

// A saved design shows as itself while its own theme is on; pick another theme and the list shows that theme.
function showThemeChoice() {
  $('theme-select').value = isMine(S.preset) && S.theme === S.preset.theme ? DESIGN + S.preset.id : S.theme;
}

function designsChanged() {
  S.designs = loadDesigns(basePreset());
  fillThemePicker();
}

function openLab() {
  openSettings(false);
  S.lab = true;
  $('lab').hidden = false;
  renderLab($('lab'), ctx);
  renderFooter();
  writeUrl(S);
  $('lab').querySelector('select')?.focus();
}

const showing = () => ({
  graph: S.view === 'map' && S.preset.view === 'graph',
  matrix: S.view === 'map' && S.preset.view === 'matrix',
  table: S.view === 'table',
});

function renderStage() {
  hideTooltip();
  const show = showing();
  $('map').hidden = !show.graph;
  $('flow').hidden = !show.graph;
  $('sky').hidden = !show.graph;
  $('stage-tools').hidden = !show.graph;
  $('legend').hidden = !show.graph;
  $('matrix').hidden = !show.matrix;
  $('table').hidden = !show.table;
  $('skip-table').hidden = show.table;
  for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
  if (show.graph) {
    graph.render(S.preset, S.model);
    graph.highlight(S.sel, { pulse: false });
    renderLegend($('legend'), S.model, S.preset, ctx);
  } else {
    graph.destroy();
  }
  if (show.matrix) keepScroll($('matrix'), () => renderMatrix($('matrix'), S.model, ctx, S.sel));
  if (show.table) keepScroll($('table'), () => renderTable($('table'), S.model, ctx, S.sel));
  renderEmpty();
}

// Nothing matches, or what matches has no systems to draw (integrations with no source or target yet).
function renderEmpty() {
  const show = showing();
  const n = S.model.integrations.length;
  const nothingToDraw = n > 0 && !show.table && S.model.edges.size === 0;
  const empty = n === 0 || nothingToDraw;
  $('empty').hidden = !empty;
  $('empty-text').textContent = n === 0
    ? 'No integrations match these filters.'
    : `${plural(n, 'matching integration')} ${n === 1 ? 'has' : 'have'} no source or target system yet, so there’s nothing to draw on the map.`;
  $('empty-table').hidden = !nothingToDraw;
  if (show.graph) {
    $('legend').hidden = empty;
    $('stage-tools').hidden = empty;
  }
}

function keepScroll(el, fn) {
  const { scrollTop, scrollLeft } = el;
  fn();
  el.scrollTop = scrollTop;
  el.scrollLeft = scrollLeft;
}

// Re-rendering replaces elements, which drops keyboard focus to the page. Put it back on the element with the
// same data-focus-key (a legend key, a matrix cell, a table row) if there is one.
function keepFocus(fn) {
  const key = document.activeElement?.dataset?.focusKey;
  fn();
  if (key && (document.activeElement === document.body || !document.activeElement)) {
    document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
  }
}

function refresh() {
  S.model = applyFilters(S.data, S.idx, S.filters);
  const show = showing();
  keepFocus(() => {
    if (show.graph) {
      graph.applyFilter(S.model);
      renderLegend($('legend'), S.model, S.preset, ctx);
    }
    if (show.matrix) keepScroll($('matrix'), () => renderMatrix($('matrix'), S.model, ctx, S.sel));
    if (show.table) keepScroll($('table'), () => renderTable($('table'), S.model, ctx, S.sel));
    renderSide({ keepScroll: true });
  });
  renderEmpty();
  syncFilterControls();
  renderSummary();
  writeUrl(S);
}

// ---- Selection -------------------------------------------------------------------

const sameSel = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function select(sel, { push = true } = {}) {
  if (sameSel(sel, S.sel)) return;
  hideTooltip();
  // Remember where focus was when the details opened, to return there when they close.
  if (sel && !S.sel) {
    const active = document.activeElement;
    S.opener = active && active !== document.body ? active : null;
    S.openerKey = active?.dataset?.focusKey ?? null;
  }
  if (!sel) S.history = [];
  else if (push && S.sel) S.history.push(S.sel);
  S.sel = sel;
  const show = showing();
  if (show.graph) graph.highlight(sel);
  if (show.matrix) keepScroll($('matrix'), () => renderMatrix($('matrix'), S.model, ctx, S.sel));
  if (show.table) {
    for (const tr of $('table').querySelectorAll('tbody tr')) tr.classList.toggle('sel', sel?.type === 'integration' && tr.dataset.key === sel.key);
  }
  renderSide();
  writeUrl(S);
  if (sel) {
    const heading = $('panel').querySelector('h2');
    heading?.focus({ preventScroll: true });
    announce(heading ? `Details: ${heading.textContent}` : '');
  } else {
    returnFocus();
    announce('Details closed');
  }
}

function returnFocus() {
  const back = S.opener?.isConnected ? S.opener
    : S.openerKey ? document.querySelector(`[data-focus-key="${CSS.escape(S.openerKey)}"]`)
      : null;
  (back ?? $('search')).focus({ preventScroll: true });
  S.opener = null;
  S.openerKey = null;
}

function renderSide({ keepScroll: keep = false } = {}) {
  const open = Boolean(S.sel);
  $('panel').hidden = !open;
  $('layout').classList.toggle('has-panel', open);
  renderPanel($('panel'), S.sel, ctx, { keepScroll: keep });
}

// One short, polite status for screen readers (the panel itself isn't a live region, so it isn't re-read on
// every filter change).
function announce(text) {
  const el = $('sr-status');
  el.textContent = '';
  if (text) requestAnimationFrame(() => { el.textContent = text; });
}

// ---- Filters -----------------------------------------------------------------------

function facetLabel(key, value) {
  if (value === '') return '(none)';
  if (key === 'patternGroup') return S.data.patternGroups?.[value]?.label ?? value;
  if (key === 'domain') return S.idx.domains.get(value)?.name ?? value;
  return value;
}

function buildFilters() {
  const wrap = $('filter-selects');
  for (const key of S.site.filters ?? []) {
    const facet = S.data.facets[key] ?? [];
    const unit = key === 'domain' ? 'system' : 'integration';
    const sel = h('select', { id: `f-${key}`, 'aria-label': FILTER_LABELS[key] ?? key },
      h('option', { value: '' }, `${FILTER_LABELS[key] ?? key}: all`),
      facet.map((f) => h('option', { value: f.value === '' ? NONE : f.value }, `${facetLabel(key, f.value)} (${plural(f.count, unit)})`)),
    );
    sel.addEventListener('change', () => setFilter(key, sel.value));
    wrap.append(sel);
  }
  $('search-suggestions').replaceChildren(
    ...S.data.systems.filter((s) => s.degree > 0).map((s) => h('option', { value: s.name })),
    ...S.data.integrations.map((i) => h('option', { value: i.id })),
  );
  syncFilterControls();
}

function syncFilterControls() {
  for (const key of S.site.filters ?? []) {
    const el = $(`f-${key}`);
    if (!el) continue;
    el.value = S.filters[key] ?? '';
    el.classList.toggle('active', Boolean(S.filters[key]));
  }
  if ($('search').value !== S.filters.q) $('search').value = S.filters.q ?? '';
  $('clear-filters').hidden = !Object.values(S.filters).some(Boolean);
}

function setFilter(key, value) {
  S.filters[key] = value ?? '';
  refresh();
}

function clearFilters() {
  S.filters = { q: '', release: '', workload: '', patternGroup: '', domain: '' };
  refresh();
  $('search').focus();
}

function renderSummary() {
  const m = S.model;
  const total = S.data.integrations.length;
  $('summary').textContent = m.filtered
    ? `Showing ${m.integrations.length} of ${plural(total, 'integration')} · ${plural(m.systemIds.size, 'system')}`
    : `${plural(total, 'integration')} · ${plural(m.systemIds.size, 'system')} · ${plural(m.edges.size, 'connection')}`;
}

// ---- Chrome ----------------------------------------------------------------------------

function renderFooter() {
  const d = S.data;
  const built = new Date(d.generatedAt);
  // Built when clicked, so it carries the page's current view and filters.
  const openLab = (e) => {
    e.preventDefault();
    const u = new URL(location.href);
    u.searchParams.set('lab', '1');
    location.href = u.pathname + u.search;
  };
  fill($('footer'),
    h('span', {}, 'Source: ', extLink(d.source.repoUrl ? `${d.source.repoUrl}?path=/${d.source.dir}` : d.source.pageUrl, 'World Map catalogue'), d.source.commit ? ` @ ${d.source.commit.slice(0, 8)}` : ''),
    d.source.pageUrl ? h('span', {}, extLink(d.source.pageUrl, 'Catalogue page in the wiki')) : null,
    h('span', {}, `Data built ${built.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`),
    S.site.lab ? h('span', {}, `Design: ${S.preset.label}${S.theme !== S.preset.theme ? ` · ${themeLabel(S.theme)} theme` : ''}`) : null,
    S.site.lab && !S.lab ? h('a', { href: '?lab=1', onclick: openLab }, 'Design lab') : null,
    S.site.lab ? h('a', { href: 'compare.html' }, 'Compare designs') : null,
    S.site.devTools?.rebuild ? rebuildButton() : null,
  );
}

// Local preview only (scripts/serve.mjs sets site.devTools): rebuild the data from catalogue/, then reload.
function rebuildButton() {
  const btn = h('button', { type: 'button', class: 'ghost small', title: 'Rebuild the map data from the catalogue records in this repo' }, 'Rebuild data');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Rebuilding…';
    try {
      const res = await fetch('api/rebuild', { method: 'POST', headers: { 'X-WorldMap-Rebuild': '1' } });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Rebuild failed: retry';
      btn.title = String(err.message || err);
      console.error('Rebuild failed:', err);
    }
  });
  return btn;
}

// Local preview: after the Table view's editor saves a record and the server rebuilds the data, load it again and
// redraw everything, keeping the view, filters and selection.
async function reloadData() {
  try {
    Object.assign(S, await loadData());
  } catch (err) {
    console.error('Reloading the data failed:', err);
    return;
  }
  $('filter-selects').replaceChildren();
  buildFilters();
  applyPreset(S.preset);
}

// ---- Map settings (⚙): animation, satellites and hover behaviour, out of the way of the map -------

function renderSettings() {
  const menu = $('settings-menu');
  const moves = S.preset.animation.ambient !== 'none' || S.tokens.sky !== 'none' || S.tokens.orbits;
  const toggle = (id, label, checked, onChange, note) => h('label', { class: 'check', for: id },
    h('input', { type: 'checkbox', id, checked, onchange: (e) => onChange(e.target.checked) }),
    h('span', {}, label, note ? h('span', { class: 'hint' }, note) : null));
  fill(menu,
    h('p', { class: 'menu-title' }, 'Map settings'),
    toggle('set-animate', 'Animations', !prefersReducedMotion(), (on) => { setMotionChoice(on ? 'on' : 'off'); applyPreset(S.preset); renderSettings(); },
      moves ? null : 'This design has none'),
    S.tokens.orbits
      ? toggle('set-satellites', 'Satellites', satellitesOn(), (on) => { setSatellites(on); applyPreset(S.preset); renderSettings(); }, 'Stars orbiting each system')
      : null,
    toggle('set-selection-only', 'Animate only what I select', selectionOnlyOn(), (on) => { setSelectionOnly(on); renderSettings(); },
      S.preset.animation.ambient === 'none' ? 'This design has no line animation' : 'Lines move only for the selected or hovered system'),
    toggle('set-hover-preview', 'Preview connections on hover', hoverPreviewOn(), (on) => { setHoverPreview(on); if (!on) graph?.previewSystem(null); renderSettings(); },
      'Pointing at a system fades what it isn’t connected to'),
    toggle('set-merge-lines', 'One line per pair', mergeLinesOn(), (on) => { setMergeLines(on); setSplitByKind(!on); applyPreset(S.preset); renderSettings(); },
      'Instead of a line per kind (file, API, out of the box); drawn as the kind most of them are'),
    S.embed ? null : h('button', { type: 'button', class: 'ghost small menu-link', onclick: () => openLab() }, 'Customise the map…'),
  );
}

function openSettings(open) {
  const menu = $('settings-menu');
  const button = $('settings-button');
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    renderSettings();
    menu.querySelector('input')?.focus();
  }
}

function showView(view) {
  if (S.view === view) return;
  S.view = view;
  keepFocus(() => renderStage());
  writeUrl(S);
}

function bindUi() {
  let t;
  $('search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => setFilter('q', e.target.value), 150);
  });
  $('search').addEventListener('change', (e) => {
    const v = e.target.value.trim().toLowerCase();
    if (!v) return;
    const sys = S.data.systems.find((s) => s.name.toLowerCase() === v);
    const int = S.data.integrations.find((i) => i.id.toLowerCase() === v);
    if (sys) select({ type: 'system', id: sys.id });
    else if (int) select({ type: 'integration', key: int.key });
  });
  $('clear-filters').addEventListener('click', clearFilters);
  $('empty-clear').addEventListener('click', clearFilters);
  $('empty-table').addEventListener('click', () => showView('table'));
  $('skip-table').addEventListener('click', () => {
    showView('table');
    $('table').querySelector('tbody button')?.focus();
  });
  $('fit').addEventListener('click', () => graph.fit());
  $('zoom-in').addEventListener('click', () => graph.zoomBy(1.25));
  $('zoom-out').addEventListener('click', () => graph.zoomBy(0.8));
  $('settings-button').addEventListener('click', () => openSettings($('settings-menu').hidden));
  document.addEventListener('pointerdown', (e) => {
    if (!$('settings-menu').hidden && !e.target.closest('#settings-menu, #settings-button')) openSettings(false);
  });
  for (const b of document.querySelectorAll('.segmented button')) b.addEventListener('click', () => showView(b.dataset.view));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideTooltip();
    if (!$('settings-menu').hidden) { openSettings(false); $('settings-button').focus(); return; }
    if (!e.target.closest?.('input, textarea, select')) select(null);
  });
  new ResizeObserver(() => graph.resize()).observe($('stage'));
}
