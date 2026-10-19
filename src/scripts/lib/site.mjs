// Loads config/site.json plus every config/presets/*.json into the single object the page reads.
// Used by build-data.mjs (written to web/data/site.json) and serve.mjs (served live for fast iteration).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, readJsonFile } from './files.mjs';
import { compareText } from './catalogue.mjs';

export const VIEWS = ['graph', 'matrix'];
export const LAYOUTS = ['clusters', 'network'];
// Keep in step with THEMES in web/js/theme.js and the blocks in web/styles/themes.css.
export const THEMES = ['clean-light', 'ops-dark', 'neon', 'synthwave', 'eucalypt', 'nature', 'forest-night', 'space'];
export const AMBIENT = ['none', 'flow', 'ants', 'comets', 'packets', 'pulse', 'water', 'lightning'];
export const ON_SELECT = ['none', 'focus-pulse'];
export const EDGE_STYLE_BY = ['pattern', 'none'];
export const NODE_LOGO = ['none', 'mark'];

const PRESET_DEFAULTS = {
  round: null,
  view: 'graph',
  layout: 'clusters',
  theme: 'clean-light',
  // filterFade: filter changes fade items out and in. drawOn: lines trace from source to target once on load, then
  // stay still. (Selection-only animation and hover preview are the viewer's choice, in the map settings.)
  animation: { ambient: 'none', onSelect: 'focus-pulse', settle: true, animateUnscheduled: true, filterFade: true, drawOn: true },
  labels: { showDomain: false },
  edges: { styleBy: 'pattern', flagUncertain: true },
  // Logos on the map's systems: none, or mark (the brand's symbol in white on the domain colour; initials when a
  // brand has no symbol). Panels and tooltips always show the full-colour logo.
  nodes: { logo: 'none' },
  layoutOptions: {},
};

export function withPresetDefaults(p) {
  return {
    ...PRESET_DEFAULTS,
    ...p,
    animation: { ...PRESET_DEFAULTS.animation, ...(p.animation ?? {}) },
    labels: { ...PRESET_DEFAULTS.labels, ...(p.labels ?? {}) },
    edges: { ...PRESET_DEFAULTS.edges, ...(p.edges ?? {}) },
    nodes: { ...PRESET_DEFAULTS.nodes, ...(p.nodes ?? {}) },
    layoutOptions: { ...(p.layoutOptions ?? {}) },
  };
}

function checkPreset(p, file, issues) {
  const bad = (what, value, allowed) => issues.push({ level: 'warning', code: 'PRESET_VALUE', message: `${file}: ${what} "${value}" isn't one of ${allowed.join(', ')}.` });
  if (!VIEWS.includes(p.view)) bad('view', p.view, VIEWS);
  if (p.view === 'graph' && !LAYOUTS.includes(p.layout)) bad('layout', p.layout, LAYOUTS);
  if (!THEMES.includes(p.theme)) bad('theme', p.theme, THEMES);
  if (!AMBIENT.includes(p.animation.ambient)) bad('animation.ambient', p.animation.ambient, AMBIENT);
  if (!ON_SELECT.includes(p.animation.onSelect)) bad('animation.onSelect', p.animation.onSelect, ON_SELECT);
  if (!EDGE_STYLE_BY.includes(p.edges.styleBy)) bad('edges.styleBy', p.edges.styleBy, EDGE_STYLE_BY);
  if (!NODE_LOGO.includes(p.nodes.logo)) bad('nodes.logo', p.nodes.logo, NODE_LOGO);
}

// site is null when config/site.json can't be read (a BAD_JSON error); a broken preset is only skipped.
export async function loadSite(configDir) {
  const issues = [];
  const { value: site, issue } = readJsonFile(join(configDir, 'site.json'), 'config/site.json');
  if (issue) return { site: null, issues: [issue] };
  if (!site || typeof site !== 'object' || Array.isArray(site)) {
    return { site: null, issues: [{ level: 'error', code: 'BAD_JSON', message: 'config/site.json must be one object ({ … }).', file: 'config/site.json' }] };
  }
  delete site.$comment;
  const dir = join(configDir, 'presets');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const presets = [];
  for (const file of files) {
    let raw;
    try {
      raw = readJson(join(dir, file));
    } catch (err) {
      issues.push({ level: 'warning', code: 'PRESET_INVALID', message: `${file} isn't valid JSON and was skipped (${err.message}).` });
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.id) {
      issues.push({ level: 'warning', code: 'PRESET_INVALID', message: `${file} has no "id" and was skipped.` });
      continue;
    }
    if (presets.some((p) => p.id === raw.id)) {
      issues.push({ level: 'warning', code: 'PRESET_DUPLICATE', message: `${file}: preset id "${raw.id}" is already used; skipped.` });
      continue;
    }
    const p = withPresetDefaults({ label: raw.id, ...raw });
    checkPreset(p, file, issues);
    presets.push(p);
  }
  presets.sort((a, b) => (a.round ?? 99) - (b.round ?? 99) || compareText(a.label, b.label));
  if (presets.length === 0) issues.push({ level: 'error', code: 'NO_PRESETS', message: 'config/presets has no usable presets.' });
  if (!presets.some((p) => p.id === site.defaultPreset)) {
    issues.push({ level: 'warning', code: 'DEFAULT_PRESET', message: `defaultPreset "${site.defaultPreset}" doesn't exist; using "${presets[0]?.id}".` });
    site.defaultPreset = presets[0]?.id ?? null;
  }
  return { site: { ...site, presets }, issues };
}
