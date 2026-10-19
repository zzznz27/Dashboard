// Loads the generated data, builds lookups, and applies filters.

export const NONE = '__none__';
export const SPEED = { none: 0, slow: 1, medium: 2, fast: 3 };

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function loadData() {
  const [site, data] = await Promise.all([fetchJson('data/site.json'), fetchJson('data/integrations.json')]);
  return { site, data, idx: buildIndex(data) };
}

export function buildIndex(data) {
  const systems = new Map(data.systems.map((s) => [s.id, s]));
  const domains = new Map(data.domains.map((d) => [d.id, d]));
  const integrations = new Map(data.integrations.map((i) => [i.key, i]));
  const domainOrder = new Map(data.domains.map((d, n) => [d.id, n]));
  const haystack = new Map(
    data.integrations.map((i) => [
      i.key,
      [i.id, i.dataFlow, i.sourceText, i.targetText, ...[...i.sources, ...i.targets].map((id) => systems.get(id)?.name ?? ''), i.pattern.value ?? '', i.release, i.workload]
        .join(' ')
        .toLowerCase(),
    ]),
  );
  return {
    systems,
    domains,
    integrations,
    domainOrder,
    haystack,
    maxDegree: Math.max(1, ...data.systems.map((s) => s.degree)),
    maxPair: Math.max(1, ...data.edges.map((e) => e.count)),
  };
}

export const domainOf = (idx, systemId) => idx.domains.get(idx.systems.get(systemId)?.domain) ?? idx.domains.get('unassigned');

// Integrations that pass the filters, plus the system pairs (edges) and systems they involve.
export function applyFilters(data, idx, f) {
  const q = (f.q ?? '').trim().toLowerCase();
  const integrations = data.integrations.filter((i) => {
    // NONE picks out the integrations where the value is blank (the "(none)" option).
    const matches = (value, wanted) => (wanted === NONE ? value === '' : value === wanted);
    if (f.release && !matches(i.release, f.release)) return false;
    if (f.workload && !matches(i.workload, f.workload)) return false;
    if (f.patternGroup && kindOf(i) !== f.patternGroup) return false;
    if (f.domain && ![...i.sources, ...i.targets].some((id) => idx.systems.get(id)?.domain === f.domain)) return false;
    if (q && !idx.haystack.get(i.key).includes(q)) return false;
    return true;
  });
  const edges = aggregate(integrations);
  const systemIds = new Set();
  for (const e of edges.values()) systemIds.add(e.source).add(e.target);
  return { integrations, edges, systemIds, filtered: integrations.length !== data.integrations.length };
}

// An integration's kind of line (patternGroups: pubsub, file, platform, unknown), set by the data build from its
// pattern and protocols (scripts/lib/catalogue.mjs lineKindOf). Older data without it falls back to the pattern.
export const kindOf = (i) => i.kind ?? i.pattern.group;

// Whether each kind gets its own line between a pair of systems (the default), or they share one line styled by the
// kind most of them are (the viewer's "One line per pair" map setting). Set by app.js before building the model.
let splitByKind = true;
export function setSplitByKind(on) { splitByKind = on; }

// Lines an integration is drawn on: one per source/target pair, in the direction of the data, and per kind unless
// lines are merged. A two-way pattern (config/vocab.json "twoWay", e.g. a request/response call) gets its own line
// per pair, with arrows at both ends, so it isn't mixed into the one-way lines.
export function linksOf(i) {
  const kind = splitByKind ? `~${kindOf(i)}` : '';
  return i.sources.flatMap((s) => i.targets.filter((t) => t !== s).map((t) => (i.pattern.twoWay
    ? { id: `${[s, t].sort().join('__')}__2way${kind}`, source: s, target: t, twoWay: true }
    : { id: `${s}__${t}${kind}`, source: s, target: t, twoWay: false })));
}

// The lines a matrix cell (row system → column system) counts: its one-way lines (one per kind, or one) plus any
// two-way lines between the pair (which count in both directions' cells).
export function cellLinks(model, cellId) {
  const [s, t] = cellId.split('__');
  return [...model.edges.values()].filter((e) => (e.twoWay
    ? (e.source === s && e.target === t) || (e.source === t && e.target === s)
    : e.source === s && e.target === t));
}

// The kind a line is drawn as: its only kind, or (lines merged) the kind most of its integrations are, ties going to
// the first in patternGroups order.
const KIND_ORDER = ['pubsub', 'file', 'platform', 'unknown'];
export function lineKind(edge) {
  let best = null;
  for (const k of KIND_ORDER) if ((edge.kinds[k] ?? 0) > (edge.kinds[best] ?? 0)) best = k;
  return best ?? 'unknown';
}

// Matrix cells (row system → column system) an integration counts in: both ways when it's two-way.
export function cellsOf(i) {
  return i.sources.flatMap((s) => i.targets.filter((t) => t !== s).flatMap((t) => (i.pattern.twoWay ? [`${s}__${t}`, `${t}__${s}`] : [`${s}__${t}`])));
}

export function aggregate(integrations) {
  const edges = new Map();
  for (const i of integrations) {
    for (const link of linksOf(i)) {
      let e = edges.get(link.id);
      if (!e) edges.set(link.id, (e = { ...link, integrations: [], kinds: {}, speed: 'none', speeds: {}, flagged: false }));
      e.integrations.push(i);
      e.kinds[kindOf(i)] = (e.kinds[kindOf(i)] ?? 0) + 1;
      // speed is the line's fastest schedule; speeds counts its integrations per schedule speed, so a line with a
      // monthly and an event-based integration animates one slow and one fast traveller.
      if (SPEED[i.frequency.speed] > SPEED[e.speed]) e.speed = i.frequency.speed;
      const sp = SPEED[i.frequency.speed] ? i.frequency.speed : 'none';
      e.speeds[sp] = (e.speeds[sp] ?? 0) + 1;
      if (i.flags.length) e.flagged = true;
    }
  }
  return edges;
}

const FLAG_TEXT = {
  'uncertain-pattern': 'Integration pattern not confirmed',
  'uncertain-frequency': 'Schedule not confirmed',
  'uncertain-protocol': 'Protocol not confirmed',
  'unknown-system': 'Uses a system that isn’t in the systems list yet',
  'missing-source': 'Source system is blank in the catalogue',
  'missing-target': 'Target system is blank in the catalogue',
};
export const flagText = (flag) => FLAG_TEXT[flag] ?? flag;
