// Builds the map's data model from the catalogue in the repo (catalogue/: domains.json, systems.json and one
// integrations/<ID>.json per integration). Unlike the wiki it replaced, this data is validated strictly:
// anything that would make the map wrong is an error and stops the build, so the live map is never replaced
// by a broken one. Gaps (TBC, unconfirmed "?" values, no source yet) are allowed and reported.
// Pure functions only - scripts/lib/files.mjs does the file reading.

import { MAX_DOMAIN_SLOTS, SPEEDS, normKey, slugify, compareText, buildVocabIndex, normaliseValue, assembleModel, lineKindOf } from './catalogue.mjs';

export const INTEGRATION_FIELDS = ['id', 'link', 'release', 'workload', 'source', 'target', 'dataFlow', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency', 'epic', 'notes', 'links'];
const SYSTEM_FIELDS = ['name', 'aliases', 'domain', 'type'];
const DOMAIN_FIELDS = ['name', 'description'];
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Names Windows keeps for devices: a file called CON.json (or CON.SVC01.json) can't be created or checked out there.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Keep in step with PATTERN_LINE in web/js/views/graph.js: the pattern groups the map has a line style for.
export const PATTERN_GROUPS = ['pubsub', 'file', 'platform', 'unknown'];
// The Excel CSV export (scripts/excel.ps1) keeps a record's links in one cell, one per line as "text | url", so link text can't
// contain a line break or this separator.
export const LINK_SEP = ' | ';

// A record with its fields in the standard order, so files diff cleanly. Optional link/links are left out when empty.
export function canonicalRecord(r) {
  const out = {};
  for (const f of INTEGRATION_FIELDS) {
    const v = r[f];
    if (f === 'link' || f === 'links') { if (v && (!Array.isArray(v) || v.length)) out[f] = v; }
    else if (f === 'epic') out.epic = v && (v.id || v.url) ? { id: v.id ?? '', ...(v.url ? { url: v.url } : {}) } : null;
    else if (f === 'source' || f === 'target') out[f] = v ?? [];
    else out[f] = v ?? '';
  }
  return out;
}

// A full https:// URL. Spaces and ( ) | [ ] ` are refused even though browsers often cope: they break the
// generated wiki page's Markdown links and the Excel "text | url" cells.
const HTTPS_RULE = 'must be a full https:// URL, with any spaces or ( ) | [ ] ` written as %20, %28, %29, %7C, %5B, %5D, %60';
export function isHttps(u) {
  if (typeof u !== 'string' || !/^https:\/\//i.test(u) || /[\s<>"`()|[\]]/.test(u)) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// How a JSON value reads in a message: "must be text in quotes, not a number".
export const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : isStr(v) ? 'text' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'true/false' : 'an object');

// The list inside domains.json or systems.json: { "$comment": "…", "<key>": [ … ] }. Anything else at the top is
// an error, so a misspelt key is caught instead of quietly giving an empty list (and an error on every record).
export function listFromFile(json, key, file) {
  const issues = [];
  const err = (code, message) => { issues.push({ level: 'error', code, message, file }); return { list: null, issues }; };
  if (!isObj(json)) return err('BAD_VALUE', `${file} must be { "${key}": [ … ] }, not ${kindOf(json)}.`);
  const others = Object.keys(json).filter((k) => k !== '$comment' && k !== key);
  if (!(key in json)) return err('MISSING_FIELD', `${file} has no "${key}" list${others.length ? ` (it has ${others.map((k) => `"${k}"`).join(', ')}: is "${key}" misspelt?)` : ''}.`);
  if (!Array.isArray(json[key])) return err('BAD_VALUE', `${file}: "${key}" must be a list ([ … ]), not ${kindOf(json[key])}.`);
  for (const k of others) issues.push({ level: 'error', code: 'UNKNOWN_FIELD', message: `${file}: "${k}" isn't a known field (only "$comment" and "${key}").`, file });
  return { list: json[key], issues };
}

// config/vocab.json drives every pattern, protocol and frequency check, so a slip there is reported on its own
// instead of as an error on every record that uses the value.
export function checkVocab(vocab) {
  const issues = [];
  const bad = (message) => issues.push({ level: 'error', code: 'BAD_VOCAB', message: `config/vocab.json: ${message}`, file: 'config/vocab.json' });
  if (!isObj(vocab)) { bad(`must be an object ({ … }), not ${kindOf(vocab)}.`); return issues; }
  const textList = (v) => Array.isArray(v) && v.every(isStr);
  for (const k of ['unknownValues', 'notApplicableValues']) if (vocab[k] != null && !textList(vocab[k])) bad(`"${k}" must be a list of values in quotes.`);
  const special = new Set([vocab.unknownValues, vocab.notApplicableValues].filter(textList).flat().map(normKey));
  const groups = isObj(vocab.patternGroups) ? Object.keys(vocab.patternGroups) : [];
  if (!isObj(vocab.patternGroups)) bad('"patternGroups" must be { "pubsub": { "label": "…" }, … }.');
  for (const g of groups) if (!PATTERN_GROUPS.includes(g)) bad(`pattern group "${g}" isn't one the map has a line style for (${PATTERN_GROUPS.join(', ')}).`);
  const usable = groups.filter((g) => PATTERN_GROUPS.includes(g));
  for (const table of ['pattern', 'protocol', 'frequency']) {
    if (!isObj(vocab[table])) { bad(`"${table}" must be a table of values ({ "Value": { "aliases": [] }, … }).`); continue; }
    const seen = new Map(); // match key -> the value it belongs to
    for (const [value, attrs] of Object.entries(vocab[table])) {
      const where = `${table} "${value}"`;
      if (!isObj(attrs)) { bad(`${where} must be { … }, not ${kindOf(attrs)}.`); continue; }
      if (attrs.aliases != null && !textList(attrs.aliases)) bad(`${where}: aliases must be a list of values in quotes.`);
      if (table === 'pattern' && !usable.includes(attrs.group)) bad(`${where}: group "${attrs.group ?? ''}" must be one of ${usable.join(', ')}.`);
      if (table === 'pattern' && attrs.twoWay != null && typeof attrs.twoWay !== 'boolean') bad(`${where}: twoWay must be true or false.`);
      if (table === 'frequency' && !SPEEDS.includes(attrs.speed)) bad(`${where}: speed "${attrs.speed ?? ''}" must be one of ${SPEEDS.join(', ')}.`);
      for (const name of [value, ...(textList(attrs.aliases) ? attrs.aliases : [])]) {
        const key = normKey(name);
        const other = seen.get(key);
        if (!key) bad(`${where}: "${name}" has no letters or digits, so nothing can match it.`);
        else if (special.has(key)) bad(`${where}: "${name}" is also in unknownValues or notApplicableValues, which win, so it would never match.`);
        else if (other && other !== value) bad(`${table}: "${name}" maps to both "${other}" and "${value}".`);
        else seen.set(key, value);
      }
    }
  }
  return issues;
}

/**
 * store: { domains: [{ name, description }], systems: [{ name, aliases, domain, type }],
 *          integrations: [{ file, record }] } where file is the record's path, e.g. catalogue/integrations/I004.SVC01.json
 * store.issues (problems found reading the files) are passed through; store.fatal means domains.json or
 * systems.json couldn't be read, so nothing else is checked.
 */
export function buildFromStore({ store, vocab, logos = null, logoFiles = null, source = {}, meta = {} }) {
  const issues = [...(store.issues ?? [])];
  // Without domains and systems every integration would fail too; one clear message is more useful than a hundred.
  if (store.fatal) return { data: null, issues };
  const vocabIssues = checkVocab(vocab);
  if (vocabIssues.length) return { data: null, issues: [...issues, ...vocabIssues] };
  const issue = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra });
  // "$comment" is fine at the top of systems.json and domains.json, but not inside an entry: the Excel round trip
  // has nowhere to keep it, so it would be lost without a word.
  const unknownKeys = (obj, allowed, where, commentHint, extra = { file: where }) => {
    for (const k of Object.keys(obj)) {
      if (k === '$comment') issue('error', 'UNKNOWN_FIELD', `${where}: "$comment" isn't allowed here; ${commentHint}.`, extra);
      else if (!allowed.includes(k)) issue('error', 'UNKNOWN_FIELD', `${where}: "${k}" isn't a known field (${allowed.join(', ')}).`, extra);
    }
  };

  // 1. Domains, in order: the order sets each domain's colour slot.
  const domains = [];
  const domainByKey = new Map();
  for (const [n, d] of (store.domains ?? []).entries()) {
    const where = `domains.json #${n + 1}`;
    if (!isObj(d)) { issue('error', 'BAD_VALUE', `${where}: each domain must be { "name": "…", "description": "…" }, not ${kindOf(d)}.`); continue; }
    unknownKeys(d, DOMAIN_FIELDS, where, 'use "description" instead');
    if (d.name != null && !isStr(d.name)) { issue('error', 'BAD_VALUE', `${where}: name must be text in quotes, not ${kindOf(d.name)}.`); continue; }
    if (!isStr(d.name) || !d.name.trim()) { issue('error', 'MISSING_FIELD', `${where}: a domain needs a name.`); continue; }
    if (!normKey(d.name)) { issue('error', 'BAD_VALUE', `${where}: domain name "${d.name}" needs at least one letter or digit.`); continue; }
    // The map files systems without a domain under a built-in "Unassigned" domain.
    if (normKey(d.name) === 'unassigned') { issue('error', 'BAD_VALUE', `${where}: "${d.name}" is reserved for systems without a domain; pick another name.`); continue; }
    if (domainByKey.has(normKey(d.name))) { issue('error', 'DUPLICATE_DOMAIN', `Domain "${d.name}" is listed twice in domains.json.`); continue; }
    if (d.description != null && !isStr(d.description)) issue('error', 'BAD_VALUE', `${where}: description must be text in quotes, not ${kindOf(d.description)}.`);
    const dom = { id: slugify(d.name), name: d.name.trim(), description: isStr(d.description) ? d.description : '', slot: null };
    domains.push(dom);
    domainByKey.set(normKey(d.name), dom);
  }
  domains.forEach((d, i) => { d.slot = i < MAX_DOMAIN_SLOTS ? i + 1 : null; });
  if (domains.length > MAX_DOMAIN_SLOTS) {
    issue('warning', 'TOO_MANY_DOMAINS', `There are ${domains.length} domains but only ${MAX_DOMAIN_SLOTS} colours; ${domains.slice(MAX_DOMAIN_SLOTS).map((d) => d.name).join(', ')} will show in grey.`);
  }
  domains.push({ id: 'unassigned', name: 'Unassigned', description: 'Systems without a domain', slot: null });

  // 2. Systems: names and aliases are matched ignoring case, spaces and punctuation, and must be unique.
  const systems = [];
  const systemByKey = new Map();
  const usedIds = new Set();
  for (const [n, s] of (store.systems ?? []).entries()) {
    if (!isObj(s)) { issue('error', 'BAD_VALUE', `systems.json #${n + 1}: each system must be { "name": "…", "aliases": [], "domain": "…", "type": "…" }, not ${kindOf(s)}.`); continue; }
    const where = `systems.json "${isStr(s.name) ? s.name : `#${n + 1}`}"`;
    unknownKeys(s, SYSTEM_FIELDS, where, 'put the comment in the "$comment" at the top of systems.json');
    if (s.name != null && !isStr(s.name)) { issue('error', 'BAD_VALUE', `systems.json #${n + 1}: name must be text in quotes, not ${kindOf(s.name)}.`); continue; }
    if (!isStr(s.name) || !s.name.trim()) { issue('error', 'MISSING_FIELD', `systems.json #${n + 1}: a system needs a name.`); continue; }
    // Names are matched on their letters and digits alone, so a name without any would match blank values.
    if (!normKey(s.name)) { issue('error', 'BAD_VALUE', `${where}: a system name needs at least one letter or digit.`); continue; }
    const aliases = [];
    if (s.aliases != null && !Array.isArray(s.aliases)) issue('error', 'BAD_VALUE', `${where}: aliases must be a list ([ "…" ]), not ${kindOf(s.aliases)}.`);
    for (const a of Array.isArray(s.aliases) ? s.aliases : []) {
      if (!isStr(a)) issue('error', 'BAD_VALUE', `${where}: each alias must be text in quotes, not ${kindOf(a)}.`);
      else if (a.trim() && !normKey(a)) issue('error', 'BAD_VALUE', `${where}: alias "${a}" needs at least one letter or digit.`);
      else if (a.trim()) aliases.push(a.trim());
    }
    const domain = isStr(s.domain) ? domainByKey.get(normKey(s.domain)) : null;
    if (s.domain != null && !isStr(s.domain)) issue('error', 'BAD_VALUE', `${where}: domain must be a domain's name in quotes, not ${kindOf(s.domain)}.`);
    else if (!domain) issue('error', 'UNKNOWN_DOMAIN', `${where}: domain "${s.domain ?? ''}" isn't in domains.json.`);
    const type = isStr(s.type) ? normKey(s.type) : '';
    if (type !== 'internal' && type !== 'external') issue('error', 'BAD_VALUE', `${where}: type must be Internal or External.`);
    let id = slugify(s.name);
    for (let k = 2; usedIds.has(id); k++) id = `${slugify(s.name)}-${k}`;
    usedIds.add(id);
    const sys = { id, name: s.name.trim(), aliases, domain: domain?.id ?? 'unassigned', type: type || 'unknown', wikiUrl: null, inSettings: true };
    for (const name of [sys.name, ...aliases]) {
      const clash = systemByKey.get(normKey(name));
      if (clash) issue('error', 'DUPLICATE_ALIAS', `"${name}" is used by both "${clash.name}" and "${sys.name}" in systems.json.`);
      else systemByKey.set(normKey(name), sys);
    }
    systems.push(sys);
  }
  const systemName = (sid) => systems.find((s) => s.id === sid).name;

  // 3. Integrations.
  const vocabIdx = { pattern: buildVocabIndex(vocab.pattern), protocol: buildVocabIndex(vocab.protocol), frequency: buildVocabIndex(vocab.frequency) };
  const integrations = [];
  const seenIds = new Map();
  for (const { file, record: r } of store.integrations ?? []) {
    if (!isObj(r)) { issue('error', 'BAD_RECORD', `${file} must hold one record ({ … }), not ${kindOf(r)}.`, { file }); continue; }
    const id = isStr(r.id) ? r.id.trim() : '';
    const at = { integration: id || file, file };
    unknownKeys(r, INTEGRATION_FIELDS, file, 'use "notes" instead');
    if (r.id != null && !isStr(r.id)) { issue('error', 'BAD_ID', `${file}: id must be text in quotes (e.g. "I004.SVC01"), not ${kindOf(r.id)}.`, at); continue; }
    if (!ID_PATTERN.test(id)) { issue('error', 'BAD_ID', `${file}: id "${r.id ?? ''}" must be letters, digits, ".", "_" or "-".`, at); continue; }
    const head = id.split('.')[0];
    if (WINDOWS_RESERVED.test(head)) { issue('error', 'BAD_ID', `${file}: id "${id}" starts with "${head}", a name Windows keeps for devices (CON, PRN, AUX, NUL, COM1-9, LPT1-9), so its file can't be created there. Pick another id.`, at); continue; }
    if (!file.endsWith(`/${id}.json`)) issue('error', 'FILE_NAME', `${file}: the file must be named after its id (${id}.json).`, at);
    if (seenIds.has(normKey(id))) { issue('error', 'DUPLICATE_ID', `Integration ID "${id}" is used by both ${seenIds.get(normKey(id))} and ${file}.`, at); continue; }
    seenIds.set(normKey(id), file);
    for (const f of ['release', 'workload', 'dataFlow', 'notes', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency']) {
      if (r[f] != null && !isStr(r[f])) issue('error', 'BAD_VALUE', `${file}: ${f} must be text in quotes, not ${kindOf(r[f])}.`, at);
    }
    const text = (f) => (isStr(r[f]) ? r[f].trim() : '');
    const flags = [];
    const gap = (label, written) => issue('info', 'DATA_GAP', `${label}: ${written ? `"${written}"` : 'blank'}`, { ...at, field: label });

    if (r.link != null && r.link !== '' && !isHttps(r.link)) issue('error', 'BAD_LINK', `${file}: link ${HTTPS_RULE}.`, at);
    const ends = {};
    for (const [field, label] of [['source', 'Source'], ['target', 'Target']]) {
      const v = r[field];
      if (v != null && !Array.isArray(v)) {
        issue('error', 'BAD_VALUE', `${file}: ${field} must be a list of system names, e.g. ["ERP"]${isStr(v) ? ` (put "${v}" inside [ ])` : `, not ${kindOf(v)}`}.`, at);
        ends[field] = [];
        continue;
      }
      const names = v ?? [];
      const notText = names.find((x) => !isStr(x));
      if (notText !== undefined) { issue('error', 'BAD_VALUE', `${file}: each ${field} name must be text in quotes, not ${kindOf(notText)}.`, at); ends[field] = []; continue; }
      ends[field] = names.map((n) => n.trim()).filter(Boolean).flatMap((n) => {
        const sys = systemByKey.get(normKey(n));
        if (!sys) { issue('error', 'UNKNOWN_SYSTEM', `${file}: ${field} "${n}" isn't in systems.json (add it, or add it as an alias).`, at); return []; }
        return [sys.id];
      });
      ends[field] = [...new Set(ends[field])];
      if (ends[field].length === 0 && names.every((n) => !n.trim())) {
        flags.push(`missing-${field}`);
        issue('warning', 'MISSING_FIELD', `${label} is empty, so this integration won't appear as a line on the map.`, at);
      }
    }
    // Usually two names for the same system (e.g. "General Ledger" and "ERP"). A line from a system to itself means nothing.
    for (const sid of ends.source.filter((s) => ends.target.includes(s))) {
      issue('warning', 'SAME_SYSTEM', `"${systemName(sid)}" is both a source and a target (perhaps under another name or alias), so no line is drawn from it to itself.`, at);
    }

    const norm = (field, label, idxName) => {
      const v = normaliseValue(text(field), vocabIdx[idxName], vocab);
      if (v.kind === 'unrecognised') issue('error', 'UNKNOWN_VALUE', `${file}: ${label} "${v.value}" isn't in config/vocab.json (use a listed value, or add it there).`, at);
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

    let epic = null;
    if (r.epic != null) {
      if (!isObj(r.epic) || !isStr(r.epic.id) || (r.epic.url != null && !isHttps(r.epic.url))) {
        issue('error', 'BAD_VALUE', `${file}: epic must be { "id": "12345", "url": "https://…" } (url optional) or null; the url ${HTTPS_RULE}.`, at);
      } else {
        unknownKeys(r.epic, ['id', 'url'], `${file}: epic`, 'use "notes" instead', at);
        epic = { id: r.epic.id, url: r.epic.url ?? null };
      }
    }
    const links = [];
    if (r.links != null) {
      if (!Array.isArray(r.links)) issue('error', 'BAD_VALUE', `${file}: links must be a list of { "text": "…", "url": "https://…" }, not ${kindOf(r.links)}.`, at);
      else for (const [n, l] of r.links.entries()) {
        const where = `${file}: link ${n + 1}`;
        if (!isObj(l)) { issue('error', 'BAD_LINK', `${where} must be { "text": "…", "url": "https://…" }, not ${kindOf(l)}.`, at); continue; }
        unknownKeys(l, ['text', 'url'], where, 'use "notes" instead', at);
        if (!isHttps(l.url)) issue('error', 'BAD_LINK', `${where}: url ${HTTPS_RULE}.`, at);
        else if (!isStr(l.text) || !l.text.trim()) issue('error', 'BAD_LINK', `${where} needs "text": the words shown for the link.`, at);
        else if (/[\r\n]/.test(l.text) || l.text.includes(LINK_SEP)) issue('error', 'BAD_LINK', `${where}: text must be on one line and not contain "${LINK_SEP}" (the Excel export uses it between text and url).`, at);
        else links.push({ text: l.text, url: l.url });
      }
    }

    const names = (ids) => ids.map(systemName).join(' / ');
    integrations.push({
      key: id,
      id,
      url: isHttps(r.link) ? r.link : null,
      record: file,
      release: text('release'),
      workload: text('workload'),
      sources: ends.source,
      targets: ends.target,
      sourceText: names(ends.source),
      targetText: names(ends.target),
      dataFlow: text('dataFlow'),
      pattern: { value: pattern.value, written: pattern.written, group: pattern.kind === 'known' ? pattern.attrs.group : 'unknown', twoWay: pattern.kind === 'known' && pattern.attrs.twoWay === true, uncertain: pattern.uncertain },
      kind: lineKindOf(pattern.kind === 'known' ? pattern.attrs.group : 'unknown', sourceProtocol.value, targetProtocol.value),
      sourceProtocol: { value: sourceProtocol.value, written: sourceProtocol.written, uncertain: sourceProtocol.uncertain },
      targetProtocol: { value: targetProtocol.value, written: targetProtocol.written, uncertain: targetProtocol.uncertain },
      frequency: { value: frequency.value, written: frequency.written, speed: frequency.kind === 'known' ? frequency.attrs.speed : 'none', kind: frequency.kind, uncertain: frequency.uncertain },
      epic,
      notes: text('notes'),
      links,
      flags: [...new Set(flags)],
    });
  }
  integrations.sort((a, b) => compareText(a.id, b.id));
  if (integrations.length === 0) issue('error', 'NO_ROWS', 'catalogue/integrations has no integrations.');
  if (issues.some((i) => i.level === 'error')) return { data: null, issues };

  const data = assembleModel({ domains, systems, systemByKey, integrations, vocab, logos, logoFiles, issues, issue, source, meta });
  return { data, issues };
}
