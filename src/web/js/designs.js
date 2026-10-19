// The viewer's own designs: a mix of layout, theme, line animation, selection animation, logos and display options,
// made in the design lab and kept in this browser's storage. A design can be shared as a small .json file, which is
// read back field by field: only known options with allowed values are kept, everything else falls back to the default.

import { THEMES, store } from './theme.js';

const KEY = 'worldmap.designs';
const PREFIX = 'my-';
const MAX_DESIGNS = 50;
const MAX_FILE_BYTES = 20 * 1024;
export const FILE_MARK = 'worldmapDesign';

// Keep in step with scripts/lib/site.mjs.
const VIEWS = ['graph', 'matrix'];
const LAYOUTS = ['clusters', 'network'];
const AMBIENT = ['none', 'flow', 'ants', 'comets', 'packets', 'pulse', 'water', 'lightning'];
const ON_SELECT = ['none', 'focus-pulse'];
const EDGE_STYLE_BY = ['pattern', 'none'];
const NODE_LOGO = ['none', 'mark'];
const THEME_IDS = THEMES.map((t) => t.id);

export const isMine = (p) => typeof p?.id === 'string' && p.id.startsWith(PREFIX);
const newId = () => `${PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
export const cleanName = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, 60) : '');

// A design built only from known fields, on top of `base` (a full preset, for anything missing or not allowed).
function clean(raw, base, id) {
  const a = raw.animation ?? {};
  const b = base.animation;
  return {
    ...base,
    id,
    label: cleanName(raw.label) || 'My design',
    round: null,
    view: pick(raw.view, VIEWS, base.view),
    layout: pick(raw.layout, LAYOUTS, base.layout),
    theme: pick(raw.theme, THEME_IDS, base.theme),
    animation: {
      ...b,
      ambient: pick(a.ambient, AMBIENT, b.ambient),
      onSelect: pick(a.onSelect, ON_SELECT, b.onSelect),
      settle: bool(a.settle, b.settle),
      animateUnscheduled: bool(a.animateUnscheduled, b.animateUnscheduled !== false),
      filterFade: bool(a.filterFade, b.filterFade !== false),
      drawOn: bool(a.drawOn, b.drawOn !== false),
    },
    labels: { ...base.labels, showDomain: bool(raw.labels?.showDomain, base.labels.showDomain) },
    edges: { ...base.edges, styleBy: pick(raw.edges?.styleBy, EDGE_STYLE_BY, base.edges.styleBy), flagUncertain: bool(raw.edges?.flagUncertain, base.edges.flagUncertain) },
    nodes: { ...base.nodes, logo: pick(raw.nodes?.logo, NODE_LOGO, base.nodes?.logo ?? 'none') },
  };
}

// Only the choices, not the base preset's layout tuning: that's what gets stored and shared.
function choices(p) {
  return {
    label: p.label,
    view: p.view,
    layout: p.layout,
    theme: p.theme,
    animation: { ...p.animation },
    labels: { showDomain: p.labels.showDomain },
    edges: { styleBy: p.edges.styleBy, flagUncertain: p.edges.flagUncertain },
    nodes: { logo: p.nodes?.logo ?? 'none' },
  };
}

function readAll() {
  try {
    const list = JSON.parse(store.get(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((d) => d && typeof d === 'object' && isMine(d)) : [];
  } catch {
    return [];
  }
}
const writeAll = (list) => store.set(KEY, list.length ? JSON.stringify(list) : null);

/** This browser's saved designs, as full presets built on `base`, in the order they were saved. */
export const loadDesigns = (base) => readAll().map((d) => clean(d, base, d.id));

/** Saves `preset` with `name` and `theme`: over the design `replaceId` when given, else as a new one. Returns the saved design. */
export function saveDesign(preset, { name, theme, replaceId }, base) {
  const list = readAll();
  const id = replaceId && list.some((d) => d.id === replaceId) ? replaceId : newId();
  const design = clean({ ...choices(preset), label: name, theme }, base, id);
  const stored = { id, ...choices(design) };
  const at = list.findIndex((d) => d.id === id);
  if (at >= 0) list[at] = stored;
  else if (list.length >= MAX_DESIGNS) throw new Error(`You can keep up to ${MAX_DESIGNS} designs. Delete one first.`);
  else list.push(stored);
  writeAll(list);
  if (!readAll().some((d) => d.id === id)) throw new Error('This browser won’t let the map save anything (private window or blocked site data).');
  return design;
}

export function deleteDesign(id) {
  writeAll(readAll().filter((d) => d.id !== id));
}

/** The design as the text of a .json file to share. */
export const designFile = (preset, name, theme) => `${JSON.stringify({ [FILE_MARK]: 1, ...choices({ ...preset, label: cleanName(name) || 'My design', theme }) }, null, 2)}\n`;

/** Reads a shared design file and saves it as a new design. Throws an Error with a message for the viewer. */
export async function importDesign(file, base) {
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is too big to be a World Map design.');
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error('That file isn’t a World Map design (it couldn’t be read).');
  }
  if (!raw || typeof raw !== 'object' || raw[FILE_MARK] !== 1) throw new Error('That file isn’t a World Map design.');
  const design = clean(raw, base, 'import');
  return saveDesign(design, { name: design.label, theme: design.theme }, base);
}
