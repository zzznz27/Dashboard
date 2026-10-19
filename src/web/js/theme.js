// Applies a theme and reads its tokens for the canvas-based views (Cytoscape and the flow overlay can't use CSS variables directly).

// Every theme in web/styles/themes.css, in picker order. Keep in step with THEMES in scripts/lib/site.mjs.
// ambient: the theme's own line animation. Picking a theme brings it (with logos on), and the ready-made designs in
// config/presets/ follow it (Space also has a lightning design).
export const THEMES = [
  { id: 'clean-light', label: 'Clean Light', ambient: 'packets' },
  { id: 'ops-dark', label: 'Ops Dark', ambient: 'packets' },
  { id: 'neon', label: 'Neon', ambient: 'pulse' },
  { id: 'synthwave', label: 'Synthwave', ambient: 'pulse' },
  { id: 'eucalypt', label: 'Eucalypt', ambient: 'flow' },
  { id: 'nature', label: 'Nature', ambient: 'water' },
  { id: 'forest-night', label: 'Forest Night', ambient: 'flow' },
  { id: 'space', label: 'Space', ambient: 'comets' },
];
export const themeLabel = (id) => THEMES.find((t) => t.id === id)?.label ?? id;

// A design shown in another theme takes that theme's line animation and logos; its layout and other options stay.
export function themed(preset, theme) {
  const ambient = THEMES.find((t) => t.id === theme)?.ambient;
  if (preset.theme === theme || !ambient) return preset;
  return { ...preset, animation: { ...preset.animation, ambient }, nodes: { ...preset.nodes, logo: 'mark' } };
}

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
}

export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  const num = (name, fallback = 0) => { const n = parseFloat(v(name)); return Number.isFinite(n) ? n : fallback; };
  return {
    font: v('--font'),
    surface: v('--surface'),
    surface2: v('--surface-2'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    muted: v('--muted'),
    edge: v('--edge'),
    edgeUnknown: v('--edge-unknown'),
    focus: v('--focus'),
    nodeOutline: v('--node-outline') || v('--surface'),
    nodeOutlineWidth: num('--node-outline-width', 2),
    glow: v('--glow') === '1',
    glowStrength: num('--glow-strength'),
    nodeGlow: num('--node-glow'),
    edgeGlow: num('--edge-glow'),
    edgeTint: v('--edge-tint') || 'neutral',
    edgeOpacity: num('--edge-opacity', 0.9),
    labelBgOpacity: num('--label-bg-opacity', 0.88),
    sky: v('--sky') || 'none',
    orbits: v('--orbits') === '1',
    planets: v('--planets') === '1',
    clusterFill: num('--cluster-fill-opacity', 0.06),
    domain: (slot) => (slot ? v(`--domain-${slot}`) : v('--domain-none')),
  };
}

// Per-browser conveniences kept in localStorage: the viewer's theme and design, and whether to play animations
// despite the OS "reduce motion" setting. All of it works without storage (private windows, blocked site data).
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage blocked */ } },
};
const THEME_KEY = 'worldmap.theme';
const PRESET_KEY = 'worldmap.preset';
export const savedTheme = () => { const id = store.get(THEME_KEY); return THEMES.some((t) => t.id === id) ? id : null; };
export const saveTheme = (id) => store.set(THEME_KEY, id);
export const savedPreset = () => store.get(PRESET_KEY);
export const savePreset = (id) => store.set(PRESET_KEY, id);

// Animations follow the OS "reduce motion" setting unless the viewer chose otherwise with Pause / Play animations:
// 'off' pauses them, 'on' plays them even when the OS asks for less motion.
const MOTION_KEY = 'worldmap.motion';

export const systemReducesMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let sessionMotion; // the choice for this page, if storage is blocked
export const motionChoice = () => sessionMotion ?? (['on', 'off'].includes(store.get(MOTION_KEY)) ? store.get(MOTION_KEY) : null);

export function setMotionChoice(choice) {
  sessionMotion = choice;
  store.set(MOTION_KEY, choice);
}

export const prefersReducedMotion = () => (motionChoice() ? motionChoice() === 'off' : systemReducesMotion());

// The space theme's orbiting stars ("satellites") can be switched off in the map settings.
const SATELLITES_KEY = 'worldmap.satellites';
export const satellitesOn = () => store.get(SATELLITES_KEY) !== 'off';
export const setSatellites = (on) => store.set(SATELLITES_KEY, on ? null : 'off');

// Map settings, off unless chosen: animate only the selected or hovered system's lines, and preview a system's
// connections on hover.
const SELECTION_ONLY_KEY = 'worldmap.selectionOnly';
const HOVER_PREVIEW_KEY = 'worldmap.hoverPreview';
export const selectionOnlyOn = () => store.get(SELECTION_ONLY_KEY) === 'on';
export const setSelectionOnly = (on) => store.set(SELECTION_ONLY_KEY, on ? 'on' : null);
export const hoverPreviewOn = () => store.get(HOVER_PREVIEW_KEY) === 'on';
export const setHoverPreview = (on) => store.set(HOVER_PREVIEW_KEY, on ? 'on' : null);

// Map setting, off unless chosen: one line per pair of systems, styled by the kind most of its integrations are,
// instead of a line per kind (file, API, out of the box).
const MERGE_LINES_KEY = 'worldmap.mergeLines';
export const mergeLinesOn = () => store.get(MERGE_LINES_KEY) === 'on';
export const setMergeLines = (on) => store.set(MERGE_LINES_KEY, on ? 'on' : null);
