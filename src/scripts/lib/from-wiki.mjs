// Turns the original wiki catalogue (and the settings page) into repo catalogue records. Shared by the one-off
// migration and the worldmap-data skill's "turn this wiki entry into a record" step (scripts/wiki-to-record.mjs).

import { buildModel } from './catalogue.mjs';
import { canonicalRecord, isHttps, LINK_SEP } from './store.mjs';

// A vocab value back as text: the canonical value (plus "?" when it was unconfirmed), or what was written.
const valueText = (v) => (v.value == null ? v.written || '' : v.uncertain && v.written ? `${v.value}?` : v.value);
const isPlaceholder = (s) => /^(-|n\/?a|none)?$/i.test(String(s ?? '').trim());

export function wikiToRecords({ catalogueMd, settingsMd, source, vocab }) {
  const { data, issues } = buildModel({ catalogueMd, settingsMd, source, vocab });
  if (!data) return { records: [], systems: [], domains: [], notes: issues.map((i) => i.message) };
  const notes = [];
  const domainName = new Map(data.domains.map((d) => [d.id, d.name]));
  const systemName = new Map(data.systems.map((s) => [s.id, s.name]));
  const domains = data.domains.filter((d) => d.id !== 'unassigned').map((d) => ({ name: d.name, description: d.description }));
  const systems = data.systems.filter((s) => s.inSettings).map((s) => ({
    name: s.name, aliases: s.aliases, domain: domainName.get(s.domain), type: s.type === 'internal' ? 'Internal' : s.type === 'external' ? 'External' : s.type,
  }));
  for (const s of data.systems.filter((x) => !x.inSettings)) notes.push(`System "${s.name}" isn't a known system; add it to systems.json (or as an alias) before its integrations will validate.`);

  // The build only takes https links, so a draft shouldn't carry anything else: http:// is upgraded and characters a
  // link can't hold are percent-encoded (both noted, to check the link still opens); anything else is left out.
  const fixUrl = (url, what, id) => {
    if (!url || isHttps(url)) return url || null;
    const fixed = url.replace(/^http:\/\//i, 'https://').replace(/[ ()|[\]`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    if (isHttps(fixed)) {
      notes.push(`${id}: the ${what} ${/^http:/i.test(url) ? 'was http://, so it was changed to https://' : "had characters a link can't hold, so they were percent-encoded"}; check it still opens: ${fixed}`);
      return fixed;
    }
    notes.push(`${id}: the ${what} (${url}) isn't a full https URL, so it was left out.`);
    return null;
  };

  const records = data.integrations.map((i) => {
    if (issues.some((x) => x.code === 'RELATIVE_LINK' && x.integration === i.id)) notes.push(`${i.id}: the wiki link is a relative path, so it was left out (add the full https URL as "link").`);
    // Link text is required, on one line and without " | " (the Excel cell separator); an empty one shows the URL.
    const links = i.links.flatMap((l) => {
      const url = fixUrl(l.url, `note link "${l.text || l.url}"`, i.id);
      return url ? [{ text: (l.text || url).split(LINK_SEP).join(' - '), url }] : [];
    });
    const record = canonicalRecord({
      id: i.id,
      link: fixUrl(i.url, 'wiki link', i.id) ?? '',
      release: i.release,
      workload: i.workload,
      source: i.sources.map((id) => systemName.get(id)),
      target: i.targets.map((id) => systemName.get(id)),
      dataFlow: i.dataFlow,
      pattern: valueText(i.pattern),
      sourceProtocol: valueText(i.sourceProtocol),
      targetProtocol: valueText(i.targetProtocol),
      frequency: valueText(i.frequency),
      epic: i.epic && !isPlaceholder(i.epic.id) ? { id: i.epic.id, url: fixUrl(i.epic.url, 'epic link', i.id) ?? undefined } : null,
      notes: isPlaceholder(i.notes) ? '' : i.notes,
      links,
    });
    if (!record.source.length || !record.target.length) notes.push(`${i.id}: no ${!record.source.length ? 'source' : 'target'} in the wiki; it won't be drawn until one is added.`);
    return record;
  });
  return { records, systems, domains, notes };
}
