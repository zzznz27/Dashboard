// Page state <-> URL, so any view can be shared as a link.

const KEYS = { preset: 'preset', theme: 'theme', view: 'view', q: 'q', release: 'release', workload: 'workload', patternGroup: 'pattern', domain: 'domain', sel: 'sel', lab: 'lab', embed: 'embed' };

export function readUrl() {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(Object.entries(KEYS).map(([k, param]) => [k, p.get(param) ?? '']));
}

export function writeUrl(state) {
  const p = new URLSearchParams();
  const set = (k, v) => v && p.set(KEYS[k], v);
  // A design mixed in the lab ("custom") or saved in this browser ("my-…") can't be restored from someone else's
  // link, so the link opens the default design with this theme.
  const ownDesign = state.preset.id === 'custom' || state.preset.id.startsWith('my-');
  const linked = ownDesign ? state.site.presets.find((p) => p.id === state.site.defaultPreset) : state.preset;
  set('preset', ownDesign || state.preset.id === state.site.defaultPreset ? '' : state.preset.id);
  set('theme', state.theme === linked?.theme ? '' : state.theme);
  set('view', state.view === 'table' ? 'table' : '');
  for (const k of ['q', 'release', 'workload', 'patternGroup', 'domain']) set(k, state.filters[k]);
  set('sel', encodeSel(state.sel));
  set('lab', state.lab ? '1' : '');
  set('embed', state.embed ? '1' : '');
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
}

export function encodeSel(sel) {
  if (!sel) return '';
  if (sel.type === 'system') return `system:${sel.id}`;
  if (sel.type === 'edge') return `edge:${sel.id}`;
  if (sel.type === 'cell') return `cell:${sel.id}`;
  if (sel.type === 'integration') return `int:${sel.key}`;
  return '';
}

export function decodeSel(s) {
  const m = /^(system|edge|cell|int):(.+)$/.exec(s ?? '');
  if (!m) return null;
  return m[1] === 'int' ? { type: 'integration', key: m[2] } : { type: m[1], id: m[2] };
}
