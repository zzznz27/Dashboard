// Reads the original wiki catalogue (and the optional WorldMap Settings page) into the map's data model.
// Since the move to catalogue/ in the repo (PLAN D11) this is used by the one-off migration
// (scripts/migrate-from-wiki.mjs); scripts/lib/store.mjs builds the map from the repo data.
// Both finish with assembleModel() below, so the map's data looks the same either way.
// Pure functions only - no file or network access - so everything here can be unit tested.

// The kind of line an integration is drawn as, and what the Pattern filter matches (vocab patternGroups): its
// pattern's group, except that a publish-subscribe or not-yet-known pattern that moves files (a File… or Recurring
// Import/Export protocol at either end) counts as a file integration. I004, for one, is Publisher-Subscriber from
// File (CSV in S3 bucket) to Recurring Import.
const FILE_PROTOCOL = /^(File\b|Recurring (Import|Export)\b)/i;
export function lineKindOf(group, sourceProtocol, targetProtocol) {
  if (group === 'file' || group === 'platform') return group;
  return [sourceProtocol, targetProtocol].some((p) => FILE_PROTOCOL.test(p ?? '')) ? 'file' : group;
}

export const MAX_DOMAIN_SLOTS = 8;
export const SCHEMA_VERSION = 1;

const SPEED_RANK = { none: 0, slow: 1, medium: 2, fast: 3 };
// The speeds a vocab.json frequency can have (the dot speed on the map).
export const SPEEDS = ['slow', 'medium', 'fast'];

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// Matching key: case, spacing and punctuation are ignored ("Help Desk" == "helpdesk").
export function normKey(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// One sort order everywhere (data, report, wiki page), the same on every machine whatever its locale:
// English rules, numbers in names compared as numbers (I9 before I10), case and accents ignored.
export const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const compareText = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

export function slugify(s) {
  return String(s ?? '').toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };

function cleanInline(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\*\*|__|`/g, '')
    .replace(/ /g, ' ');
}

// One table cell of wiki markdown -> plain text plus the links it contained.
// The text is meant to be rendered with textContent, never as HTML.
export function parseCell(raw) {
  const links = [];
  let s = String(raw ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => {
    links.push({ text: cleanInline(text).replace(/\s+/g, ' ').trim(), url: url.trim() });
    return text;
  });
  const text = cleanInline(s)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { text, links };
}

// Only http(s) links leave the build. Relative wiki links are resolved against a configured base or dropped.
export function resolveUrl(url, relativeBase) {
  if (!url) return { url: null };
  if (/^https?:\/\//i.test(url)) return { url };
  if (url.startsWith('/')) return relativeBase ? { url: relativeBase + encodeURI(url) } : { url: null, relative: true };
  return { url: null };
}

// ---------------------------------------------------------------------------
// Markdown tables (GFM rules: a header row, a delimiter row, then body rows)
// ---------------------------------------------------------------------------

export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isTableLine = (line) => line.trim().startsWith('|');
const isDelimiterRow = (line) => isTableLine(line) && splitRow(line).every((c) => /^:?-+:?$/.test(c));

export function parseTables(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const tables = [];
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/.exec(lines[i]);
    if (h) { heading = cleanInline(h[1]).trim(); continue; }
    if (isTableLine(lines[i]) && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitRow(lines[i]).map((c) => parseCell(c).text);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && isTableLine(lines[j]); j++) rows.push({ line: j + 1, cells: splitRow(lines[j]) });
      tables.push({ heading, line: i + 1, header, rows });
      i = j - 1;
    }
  }
  return tables;
}

const columnIndex = (header, name) => header.findIndex((h) => normKey(h) === normKey(name));

// ---------------------------------------------------------------------------
// Value clean-up driven by config/vocab.json
// ---------------------------------------------------------------------------

export function buildVocabIndex(table) {
  const index = new Map();
  for (const [canonical, attrs] of Object.entries(table ?? {})) {
    for (const name of [canonical, ...(attrs.aliases ?? [])]) index.set(normKey(name), { canonical, attrs });
  }
  return index;
}

// kind: known | na | unknown (TBC/blank) | partial (e.g. "File (TBC)") | unrecognised (not in vocab.json)
export function normaliseValue(raw, index, vocab) {
  const written = parseCell(raw).text.replace(/\n/g, ' ');
  if (!written) return { value: null, written, kind: 'unknown', uncertain: true, attrs: {} };
  const uncertain = /\?\s*$/.test(written);
  const base = written.replace(/\?+\s*$/, '').trim();
  const key = normKey(base);
  if (!key || (vocab.unknownValues ?? []).some((v) => normKey(v) === key)) {
    return { value: null, written, kind: 'unknown', uncertain: true, attrs: {} };
  }
  if ((vocab.notApplicableValues ?? []).some((v) => normKey(v) === key)) {
    return { value: 'N/A', written, kind: 'na', uncertain, attrs: {} };
  }
  const hit = index.get(key);
  if (hit) return { value: hit.canonical, written, kind: 'known', uncertain, attrs: hit.attrs };
  if (/\bTBC\b/i.test(base)) return { value: base, written, kind: 'partial', uncertain: true, attrs: {} };
  return { value: base, written, kind: 'unrecognised', uncertain, attrs: {} };
}

// ---------------------------------------------------------------------------
// Settings page: a Domains table and a Systems table, found by their headings.
// ---------------------------------------------------------------------------

export function parseSettings(md, cfg) {
  const result = { present: md != null, domains: [], systems: [] };
  if (md == null) return result;
  for (const t of parseTables(md)) {
    const sc = Object.fromEntries(Object.entries(cfg.systemColumns).map(([k, name]) => [k, columnIndex(t.header, name)]));
    if (sc.name >= 0) {
      for (const row of t.rows) {
        const cell = (k) => (sc[k] >= 0 ? row.cells[sc[k]] ?? '' : '');
        const name = parseCell(cell('name')).text;
        if (!name) continue;
        const typeKey = normKey(parseCell(cell('type')).text);
        const wikiLink = parseCell(cell('wikiPage')).links[0];
        result.systems.push({
          line: row.line,
          name,
          aliases: parseCell(cell('aliases')).text.split(/[;,\n]/).map((a) => a.trim()).filter(Boolean),
          domain: parseCell(cell('domain')).text,
          type: typeKey.startsWith('internal') ? 'internal' : typeKey.startsWith('external') ? 'external' : 'unknown',
          wikiUrl: wikiLink ? resolveUrl(wikiLink.url).url : null,
        });
      }
      continue;
    }
    const dc = columnIndex(t.header, cfg.domainColumns.domain);
    if (dc >= 0) {
      const desc = columnIndex(t.header, cfg.domainColumns.description);
      for (const row of t.rows) {
        const name = parseCell(row.cells[dc] ?? '').text;
        if (name) result.domains.push({ line: row.line, name, description: desc >= 0 ? parseCell(row.cells[desc] ?? '').text : '' });
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The main build
// ---------------------------------------------------------------------------

export function buildModel({ catalogueMd, settingsMd = null, source, vocab, logos = null, logoFiles = null, meta = {} }) {
  const issues = [];
  const issue = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra });
  const cat = source.catalogue;

  // 1. Find the catalogue table: the first one that has every required column.
  const tables = parseTables(catalogueMd);
  const requiredNames = cat.required.map((f) => cat.columns[f]);
  const candidates = tables.filter((t) => requiredNames.every((n) => columnIndex(t.header, n) >= 0));
  if (candidates.length === 0) {
    issue('error', 'NO_TABLE', `No table on the catalogue page has all the required columns (${requiredNames.join(', ')}).`);
    return { data: null, issues };
  }
  if (candidates.length > 1) issue('info', 'MULTIPLE_TABLES', `${candidates.length} tables have the required columns; using the first (line ${candidates[0].line}).`);
  const table = candidates[0];
  const col = {};
  for (const [field, name] of Object.entries(cat.columns)) {
    col[field] = columnIndex(table.header, name);
    if (col[field] < 0) issue('warning', 'MISSING_COLUMN', `Column "${name}" isn't in the catalogue table, so "${field}" will be empty.`);
  }

  // 2. Domains and systems from the settings page.
  const settings = parseSettings(settingsMd, source.settings);
  if (!settings.present) {
    issue('warning', 'SETTINGS_MISSING', `Settings page "${source.settings.path}" wasn't found, so every system is Unassigned and no aliases apply.`);
  }

  const domains = [];
  const domainByKey = new Map();
  const addDomain = (name, description = '') => {
    const d = { id: slugify(name), name, description, slot: null };
    domains.push(d);
    domainByKey.set(normKey(name), d);
    return d;
  };
  for (const d of settings.domains) {
    if (domainByKey.has(normKey(d.name))) issue('warning', 'DUPLICATE_DOMAIN', `Domain "${d.name}" is listed twice on the settings page.`, { file: 'settings', line: d.line });
    else addDomain(d.name, d.description);
  }

  const systems = [];
  const systemByKey = new Map();
  const usedIds = new Set();
  const uniqueId = (name) => {
    let id = slugify(name);
    for (let n = 2; usedIds.has(id); n++) id = `${slugify(name)}-${n}`;
    usedIds.add(id);
    return id;
  };
  const register = (sys, names, line) => {
    for (const name of names) {
      const key = normKey(name);
      if (!key) continue;
      const existing = systemByKey.get(key);
      if (existing && existing !== sys) {
        issue('warning', 'DUPLICATE_ALIAS', `"${name}" is used by both "${existing.name}" and "${sys.name}" on the settings page; "${existing.name}" wins.`, { file: 'settings', line });
      } else systemByKey.set(key, sys);
    }
  };

  for (const s of settings.systems) {
    const clash = systemByKey.get(normKey(s.name));
    if (clash) {
      issue('warning', 'DUPLICATE_SYSTEM', `"${s.name}" is already on the settings page (as "${clash.name}" or one of its aliases); the later row was ignored.`, { file: 'settings', line: s.line });
      continue;
    }
    let domain = null;
    if (s.domain) {
      domain = domainByKey.get(normKey(s.domain));
      if (!domain) {
        issue('warning', 'UNKNOWN_DOMAIN', `System "${s.name}" uses domain "${s.domain}", which isn't in the Domains table; it was added at the end.`, { file: 'settings', line: s.line });
        domain = addDomain(s.domain);
      }
    }
    const sys = { id: uniqueId(s.name), name: s.name, aliases: s.aliases, domain: domain ? domain.id : 'unassigned', type: s.type, wikiUrl: s.wikiUrl, inSettings: true };
    systems.push(sys);
    register(sys, [s.name, ...s.aliases], s.line);
  }

  domains.forEach((d, i) => { d.slot = i < MAX_DOMAIN_SLOTS ? i + 1 : null; });
  if (domains.length > MAX_DOMAIN_SLOTS) {
    issue('warning', 'TOO_MANY_DOMAINS', `There are ${domains.length} domains but only ${MAX_DOMAIN_SLOTS} colours; ${domains.slice(MAX_DOMAIN_SLOTS).map((d) => d.name).join(', ')} will show in grey.`);
  }
  domains.push({ id: 'unassigned', name: 'Unassigned', description: 'Systems not yet on the WorldMap Settings page', slot: null });

  // 3. Resolve a Source/Target cell to one or more systems.
  const unknownSystems = new Map(); // id -> { sys, seenIn: [] }
  const splitPattern = new RegExp(`[${(source.systemSplitSeparators ?? []).map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('')}]`);
  const resolveSystems = (raw, integrationId, line) => {
    const written = parseCell(raw).text.replace(/\n/g, ' ').trim();
    if (!written) return { ids: [], written };
    const direct = systemByKey.get(normKey(written));
    if (direct) return { ids: [direct.id], written };
    if (source.systemSplitSeparators?.length) {
      const parts = written.split(splitPattern).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => systemByKey.has(normKey(p)))) {
        const ids = [...new Set(parts.map((p) => systemByKey.get(normKey(p)).id))];
        issue('info', 'SPLIT_CELL', `"${written}" was read as ${ids.length} systems. Consider giving each its own row in the catalogue.`, { integration: integrationId, line });
        return { ids, written };
      }
    }
    const sys = { id: uniqueId(written), name: written, aliases: [], domain: 'unassigned', type: 'unknown', wikiUrl: null, inSettings: false };
    systems.push(sys);
    systemByKey.set(normKey(written), sys);
    unknownSystems.set(sys.id, { sys, seenIn: [integrationId] });
    return { ids: [sys.id], written };
  };
  const noteUnknown = (ids, integrationId) => {
    for (const id of ids) {
      const u = unknownSystems.get(id);
      if (u && !u.seenIn.includes(integrationId)) u.seenIn.push(integrationId);
    }
  };

  // 4. Rows -> integrations.
  const vocabIdx = { pattern: buildVocabIndex(vocab.pattern), protocol: buildVocabIndex(vocab.protocol), frequency: buildVocabIndex(vocab.frequency) };
  const unrecognised = new Map(); // "field|value" -> { field, value, integrations: [] }
  const width = table.header.length;
  const integrations = [];
  const seenIds = new Map();

  for (const row of table.rows) {
    let cells = row.cells;
    if (cells.every((c) => c === '')) continue;
    const idCell = parseCell(col.id >= 0 ? cells[col.id] ?? '' : '');
    const id = idCell.text.split('\n')[0] || `row-${row.line}`;
    if (cells.length > width) {
      const extra = cells.slice(width - 1).filter((c) => c !== '');
      issue('warning', 'EXTRA_CELLS', `Row has ${cells.length} cells but the table has ${width} columns; the extras were merged into "${table.header[width - 1]}".`, { integration: id, line: row.line });
      cells = [...cells.slice(0, width - 1), extra.join(' | ')];
    }
    const get = (field) => (col[field] >= 0 ? cells[col[field]] ?? '' : '');
    const flags = [];
    const gap = (field, written) => issue('info', 'DATA_GAP', `${field}: ${written ? `"${written}"` : 'blank'}`, { integration: id, line: row.line, field });

    if (!idCell.text) issue('warning', 'MISSING_FIELD', `Row has no Integration ID; it is listed as "${id}".`, { line: row.line });
    let key = id;
    if (seenIds.has(id)) {
      const n = seenIds.get(id) + 1;
      seenIds.set(id, n);
      key = `${id}#${n}`;
      issue('warning', 'DUPLICATE_ID', `Integration ID "${id}" appears more than once.`, { integration: id, line: row.line });
    } else seenIds.set(id, 1);

    const idLink = idCell.links[0];
    const idUrl = resolveUrl(idLink?.url, cat.relativeLinkBase);
    if (idUrl.relative) issue('warning', 'RELATIVE_LINK', `The link on "${id}" is a relative wiki path (${idLink.url}) that won't resolve from the map; use the full URL.`, { integration: id, line: row.line });

    const src = resolveSystems(get('source'), id, row.line);
    const tgt = resolveSystems(get('target'), id, row.line);
    noteUnknown(src.ids, id);
    noteUnknown(tgt.ids, id);
    for (const [field, r] of [['Source', src], ['Target', tgt]]) {
      if (r.ids.length === 0) {
        flags.push(`missing-${field.toLowerCase()}`);
        issue('warning', 'MISSING_FIELD', `${field} is blank, so this integration won't appear as a line on the map.`, { integration: id, line: row.line });
      }
    }

    const norm = (field, label, idxName) => {
      const v = normaliseValue(get(field), vocabIdx[idxName], vocab);
      if (v.kind === 'unrecognised') {
        const k = `${label}|${v.value}`;
        if (!unrecognised.has(k)) unrecognised.set(k, { label, value: v.value, integrations: [] });
        unrecognised.get(k).integrations.push(id);
      }
      if (v.kind === 'unknown' || v.uncertain) gap(label, v.written);
      return v;
    };
    const pattern = norm('pattern', 'Integration Pattern', 'pattern');
    const sourceProtocol = norm('sourceProtocol', 'Source Protocol', 'protocol');
    const targetProtocol = norm('targetProtocol', 'Target Protocol', 'protocol');
    const frequency = norm('frequency', 'Schedule/Frequency', 'frequency');
    if (pattern.kind === 'unknown' || pattern.uncertain) flags.push('uncertain-pattern');
    if (frequency.kind === 'unknown' || frequency.uncertain) flags.push('uncertain-frequency');
    if (sourceProtocol.kind === 'unknown' || sourceProtocol.uncertain || targetProtocol.kind === 'unknown' || targetProtocol.uncertain) flags.push('uncertain-protocol');

    const epicCell = parseCell(get('epic'));
    const epicLink = epicCell.links[0];
    const notes = parseCell(get('notes'));

    const group = pattern.kind === 'known' ? pattern.attrs.group : 'unknown';
    integrations.push({
      key,
      id,
      url: idUrl.url,
      line: row.line,
      release: parseCell(get('release')).text,
      workload: parseCell(get('workload')).text,
      sources: src.ids,
      targets: tgt.ids,
      sourceText: src.written,
      targetText: tgt.written,
      dataFlow: parseCell(get('dataFlow')).text,
      pattern: { value: pattern.value, written: pattern.written, group, twoWay: pattern.kind === 'known' && pattern.attrs.twoWay === true, uncertain: pattern.uncertain },
      kind: lineKindOf(group, sourceProtocol.value, targetProtocol.value),
      sourceProtocol: { value: sourceProtocol.value, written: sourceProtocol.written, uncertain: sourceProtocol.uncertain },
      targetProtocol: { value: targetProtocol.value, written: targetProtocol.written, uncertain: targetProtocol.uncertain },
      frequency: { value: frequency.value, written: frequency.written, speed: frequency.kind === 'known' ? frequency.attrs.speed : 'none', kind: frequency.kind, uncertain: frequency.uncertain },
      epic: epicCell.text ? { id: epicLink ? epicLink.text : epicCell.text, url: epicLink ? resolveUrl(epicLink.url).url : null } : null,
      notes: notes.text,
      links: notes.links.map((l) => ({ text: l.text, url: resolveUrl(l.url).url })).filter((l) => l.url),
      flags: [...new Set(flags)],
    });
  }

  if (integrations.length === 0) {
    issue('error', 'NO_ROWS', 'The catalogue table has no rows.');
    return { data: null, issues };
  }

  for (const { sys, seenIn } of unknownSystems.values()) {
    if (settings.present) {
      issue('warning', 'UNKNOWN_SYSTEM', `"${sys.name}" isn't on the settings page, so it shows as Unassigned. Add it there, or add it as an alias of an existing system. Used by: ${seenIn.join(', ')}.`, { integration: seenIn[0] });
    }
    for (const i of integrations) if (seenIn.includes(i.id) && !i.flags.includes('unknown-system')) i.flags.push('unknown-system');
  }
  for (const u of unrecognised.values()) {
    issue('warning', 'UNKNOWN_VALUE', `${u.label} "${u.value}" isn't in config/vocab.json, so it's shown as written. Used by: ${u.integrations.join(', ')}.`, { integration: u.integrations[0] });
  }

  const data = assembleModel({
    domains, systems, systemByKey, integrations, vocab, logos, logoFiles, issues, issue,
    source: { repo: source.wiki.repo, branch: source.wiki.branch, path: cat.path, pageUrl: cat.pageUrl, commit: meta.commit ?? null, settingsFound: settings.present },
    meta,
  });
  return { data, issues };
}

// ---------------------------------------------------------------------------
// Shared by the wiki reader and the repo store: logos, lines, counts, filters and the output object.
// integrations need key, sources, targets, release, workload, pattern { group, twoWay } and frequency { speed }.
// ---------------------------------------------------------------------------

export function assembleModel({ domains, systems, systemByKey, integrations, vocab, logos, logoFiles, issues, issue, source, meta = {} }) {
  // Logos (config/logos.json), matched to systems like catalogue names, so aliases work too.
  // logoFiles is the set of files in web/logos/; a missing file is reported rather than linked.
  for (const sys of systems) Object.assign(sys, { logo: null, mark: null });
  for (const [name, entry] of Object.entries(logos?.systems ?? {})) {
    const sys = systemByKey.get(normKey(name));
    if (!sys) {
      issue('info', 'LOGO_UNUSED', `config/logos.json has a logo for "${name}", which isn't a system on the map.`);
      continue;
    }
    const file = (f) => {
      if (!f) return null;
      if (!/^[\w.-]+\.(svg|png)$/i.test(f) || (logoFiles && !logoFiles.has(f))) {
        issue('warning', 'LOGO_MISSING', `config/logos.json gives "${name}" the logo file "${f}", which isn't in web/logos/.`);
        return null;
      }
      return `logos/${f}`;
    };
    sys.logo = file(entry.logo);
    sys.mark = file(entry.mark);
  }

  // Edges: one per direction per system pair. A two-way pattern (vocab "twoWay", e.g. a request/response
  // call) gets its own line per pair, drawn with arrows at both ends. Same rule as linksOf() in web/js/data.js.
  // A system that is both source and target of one integration gets no line to itself (the build warns).
  const edgeMap = new Map();
  for (const i of integrations) {
    for (const [s, t] of i.sources.flatMap((src) => i.targets.filter((tgt) => tgt !== src).map((tgt) => [src, tgt]))) {
      const id = i.pattern.twoWay ? `${[s, t].sort().join('__')}__2way` : `${s}__${t}`;
      if (!edgeMap.has(id)) edgeMap.set(id, { id, source: s, target: t, twoWay: i.pattern.twoWay, count: 0, integrations: [], patternGroups: [], speed: 'none' });
      const e = edgeMap.get(id);
      e.count++;
      e.integrations.push(i.key);
      if (!e.patternGroups.includes(i.pattern.group)) e.patternGroups.push(i.pattern.group);
      if (SPEED_RANK[i.frequency.speed] > SPEED_RANK[e.speed]) e.speed = i.frequency.speed;
    }
  }
  const edges = [...edgeMap.values()].sort((a, b) => compareText(a.id, b.id));

  // Per-system counts.
  for (const sys of systems) Object.assign(sys, { degree: 0, outbound: 0, inbound: 0 });
  const byId = new Map(systems.map((s) => [s.id, s]));
  for (const i of integrations) {
    for (const id of new Set([...i.sources, ...i.targets])) byId.get(id).degree++;
    const [out, inn] = i.pattern.twoWay ? [[...i.sources, ...i.targets], [...i.sources, ...i.targets]] : [i.sources, i.targets];
    for (const id of new Set(out)) byId.get(id).outbound++;
    for (const id of new Set(inn)) byId.get(id).inbound++;
  }
  systems.sort((a, b) => compareText(a.name, b.name));

  // Filter values with counts.
  const facet = (values) => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => compareText(a.value, b.value));
  };
  const facets = {
    release: facet(integrations.map((i) => i.release)),
    workload: facet(integrations.map((i) => i.workload)),
    patternGroup: facet(integrations.map((i) => i.kind)),
    domain: facet(systems.filter((s) => s.degree > 0).map((s) => s.domain)),
  };

  const count = (level) => issues.filter((x) => x.level === level).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    source,
    counts: {
      integrations: integrations.length,
      systems: systems.filter((s) => s.degree > 0).length,
      edges: edges.length,
      warnings: count('warning'),
      dataGaps: issues.filter((x) => x.code === 'DATA_GAP').length,
    },
    patternGroups: vocab.patternGroups,
    domains,
    systems,
    integrations,
    edges,
    facets,
  };
}
