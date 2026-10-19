// Renders the generated "World Map Catalogue" wiki page from the repo catalogue. The pipeline writes it to the
// wiki after every data change, once its publishWikiPage switch is on. No timestamp, so the page (and the wiki's history) only changes when the data does.

import { compareText } from './catalogue.mjs';

// Cell text shows as written: every character Markdown or HTML would act on (emphasis, code, links, images, tags,
// headings, table pipes) is backslash-escaped, then line breaks become <br>.
const cell = (v) => String(v ?? '').trim().replace(/[\\`*_[\]()!<>#|]/g, '\\$&').replace(/\r?\n/g, '<br>');
// The build only accepts plain https URLs, but encode what would end a Markdown link or a table cell anyway.
const href = (url) => String(url).replace(/[ ()|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// A link with no text shows its URL, so it can still be seen and clicked.
const link = (text, url) => (url ? `[${cell(text) || cell(url)}](${href(url)})` : cell(text));
const row = (cells) => `|${cells.map((c) => (c ? ` ${c} ` : ' ')).join('|')}|`;
const table = (header, rows) => [row(header), `|${header.map(() => '---').join('|')}|`, ...rows.map(row)];

export function renderCataloguePage({ store, data, source }) {
  const original = source.catalogue?.pageUrl;
  const repoUrl = source.store?.repoUrl;
  const integrations = [...store.integrations].map((x) => x.record).sort((a, b) => compareText(a.id, b.id));
  const names = (list) => (list ?? []).join(' / ');
  const out = [
    '[[_TOC_]]',
    '',
    '# World Map Catalogue',
    '',
    `> **Generated: don't edit this page.** It is rewritten from the Integration World Map data (\`src/catalogue/\` in the ${repoUrl ? `[World Map repo](${repoUrl}?path=/src/catalogue)` : 'World Map repo'}) every time that data changes, so edits made here are lost. To add or change an integration, ask the integration team.${original ? ` The original [Integrated System Catalogue](${original}) is kept as it was.` : ''}`,
    '',
    `${data.counts.integrations} integrations between ${data.counts.systems} systems.`,
    '',
    '## Integrations',
    '',
    ...table(
      ['Integration ID', 'Release', 'Workload', 'Source', 'Target', 'Data Flow', 'Integration Pattern', 'Source Protocol', 'Target Protocol', 'Schedule/Frequency', 'Epic', 'Notes'],
      integrations.map((r) => [
        link(r.id, r.link), cell(r.release), cell(r.workload), cell(names(r.source)), cell(names(r.target)), cell(r.dataFlow),
        cell(r.pattern), cell(r.sourceProtocol), cell(r.targetProtocol), cell(r.frequency),
        r.epic ? link(r.epic.id, r.epic.url) : '-',
        [cell(r.notes), ...(r.links ?? []).map((l) => link(l.text, l.url))].filter(Boolean).join('<br>'),
      ]),
    ),
    '',
    '## Systems',
    '',
    ...table(['System', 'Aliases', 'Domain', 'Type'], store.systems.map((s) => [cell(s.name), cell((s.aliases ?? []).join('; ')), cell(s.domain), cell(s.type)])),
    '',
    '## Domains',
    '',
    'The order sets each domain\'s colour on the map.',
    '',
    ...table(['Domain', 'Description'], store.domains.map((d) => [cell(d.name), cell(d.description)])),
    '',
  ];
  return out.join('\n');
}
