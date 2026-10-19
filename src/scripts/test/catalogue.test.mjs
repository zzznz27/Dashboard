import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, parseCell, splitRow, normKey } from '../lib/catalogue.mjs';
import { wikiToRecords } from '../lib/from-wiki.mjs';
import { buildFromStore } from '../lib/store.mjs';

const source = JSON.parse(readFileSync(new URL('../../config/source.json', import.meta.url), 'utf8'));
const vocab = JSON.parse(readFileSync(new URL('../../config/vocab.json', import.meta.url), 'utf8'));

const HEADER = '| Integration ID | Release | Workload | Source | Target | Data Flow | Integration Pattern | Source Protocol | Target Protocol | Schedule/Frequency | Epic | Notes |';
const DELIM = '|---|---|---|---|---|---|---|---|---|---|---|---|';
const catalogue = (...rows) => ['# Integration Catalogue', '', HEADER, DELIM, ...rows].join('\n');

const SETTINGS = `
## Domains
| Domain | Description |
|---|---|
| Finance | Money |
| Assets | Things |
| Risk & Incident | Bad days |
| Sales | Sales |

## Systems
| System | Aliases | Domain | Type | Wiki page |
|---|---|---|---|---|
| Core F&A | F&A | Finance | Internal | |
| Core Assets | | Assets | Internal | |
| Core Risk | RiskHub | Risk & Incident | Internal | |
| Partner Portal - EU/US | | Sales | External | |
| HelpDesk | | Risk & Incident | External | |
`;

const build = (md, settingsMd = SETTINGS) => buildModel({ catalogueMd: md, settingsMd, source, vocab, meta: { generatedAt: 'test' } });
const byId = (data, id) => data.integrations.find((i) => i.id === id);
const codes = (issues) => issues.map((i) => i.code);

test('splitRow handles outer pipes and escaped pipes', () => {
  assert.deepEqual(splitRow('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
  assert.deepEqual(splitRow('a|b'), ['a', 'b']);
});

test('parseCell extracts links and strips formatting', () => {
  const c = parseCell('**Note** see [Design](https://x.test/a) &amp; more<br/>line two&nbsp;end');
  assert.equal(c.text, 'Note see Design & more\nline two end');
  assert.deepEqual(c.links, [{ text: 'Design', url: 'https://x.test/a' }]);
});

test('normKey ignores case, spaces and punctuation', () => {
  assert.equal(normKey('Help Desk'), normKey('helpdesk'));
  assert.equal(normKey('Partner Portal - EU/US'), 'partnerportaleuus');
});

test('aliases merge spellings; slash names stay whole; combined cells split', () => {
  const { data, issues } = build(catalogue(
    '| [I1.SVC01](https://x.test/1) | Release 2 | FIN01 | F&A | Core Assets | Assets | Publisher-Subscriber | API | API | Monthly | | |',
    '| I2.SVC01 | Release 2 | FIN01 | Partner Portal - EU/US | Core F&A | Invoices | Publisher-Subscriber | API | API | Daily | | |',
    '| I3.SVC01 | Release 3 | CST01 | Core F&A | Core Assets/RiskHub | Customer | Publisher-Subscriber | Event | API | Event-based | | |',
    '| I4.SVC01 | Release 3 | RSK01 | Help Desk | Core Risk | IT Incident | Publisher-Subscriber | API | API | 5 Mins | | |',
  ));
  assert.deepEqual(byId(data, 'I1.SVC01').sources, ['core-fa']);
  assert.deepEqual(byId(data, 'I2.SVC01').sources, ['partner-portal-eu-us']);
  assert.deepEqual(byId(data, 'I3.SVC01').targets, ['core-assets', 'core-risk']);
  assert.deepEqual(byId(data, 'I4.SVC01').sources, ['helpdesk']);
  assert.equal(byId(data, 'I1.SVC01').url, 'https://x.test/1');
  assert.ok(codes(issues).includes('SPLIT_CELL'));
  assert.ok(!codes(issues).includes('UNKNOWN_SYSTEM'));
  assert.equal(data.edges.find((e) => e.id === 'core-fa__core-assets').count, 2);
});

test('unknown systems are kept as Unassigned with one warning each', () => {
  const { data, issues } = build(catalogue(
    '| I1.SVC01 | Release 2 | | Mystery App | Core F&A | Stuff | OOTB | N/A | N/A | N/A | | |',
    '| I2.SVC01 | Release 2 | | Mystery App | Core Assets | Stuff | OOTB | N/A | N/A | N/A | | |',
  ));
  const sys = data.systems.find((s) => s.name === 'Mystery App');
  assert.equal(sys.domain, 'unassigned');
  assert.equal(sys.inSettings, false);
  assert.equal(issues.filter((i) => i.code === 'UNKNOWN_SYSTEM').length, 1);
  assert.ok(byId(data, 'I1.SVC01').flags.includes('unknown-system'));
});

test('value clean-up: variants, "?" suffix, TBC, N/A and unrecognised values', () => {
  const { data, issues } = build(catalogue(
    '| I1.SVC01 | Release 2 | | Core F&A | Core Assets | A | Dual-write | APIs | API(OData) | Monthly? | | |',
    '| I2.SVC01 | Release 2 | | Core F&A | Core Assets | B | TBC | File (TBC) | N/A | N/A | | |',
    '| I3.SVC01 | Release 2 | | Core F&A | Core Assets | C | Carrier Pigeon | API | API | Can be > 30 mins | | |',
  ));
  const i1 = byId(data, 'I1.SVC01');
  assert.equal(i1.pattern.value, 'Dual-Write');
  assert.equal(i1.pattern.group, 'platform');
  assert.equal(i1.sourceProtocol.value, 'API');
  assert.equal(i1.targetProtocol.value, 'API (OData)');
  assert.deepEqual([i1.frequency.value, i1.frequency.speed, i1.frequency.uncertain], ['Monthly', 'slow', true]);
  assert.ok(i1.flags.includes('uncertain-frequency'));

  const i2 = byId(data, 'I2.SVC01');
  assert.equal(i2.pattern.group, 'unknown');
  assert.equal(i2.frequency.kind, 'na');
  assert.ok(!i2.flags.includes('uncertain-frequency'), 'N/A is not a gap');
  assert.ok(i2.flags.includes('uncertain-protocol'), 'File (TBC) is a gap');

  const i3 = byId(data, 'I3.SVC01');
  assert.equal(i3.frequency.speed, 'medium');
  const unknownValues = issues.filter((i) => i.code === 'UNKNOWN_VALUE');
  assert.equal(unknownValues.length, 1, 'only "Carrier Pigeon" is unrecognised; "File (TBC)" is a known gap');
  assert.match(unknownValues[0].message, /Carrier Pigeon/);
});

test('rows with extra cells merge into Notes; short rows are padded and flagged', () => {
  const { data, issues } = build(catalogue(
    '| I1.SVC01 | Release 2 | | Core F&A | Core Assets | A | OOTB | N/A | N/A | N/A | | | | [Spec](https://x.test/spec) |',
    '| HR.PAY.SVC05 | HR | PAY01 |',
  ));
  const i1 = byId(data, 'I1.SVC01');
  assert.equal(i1.notes, 'Spec');
  assert.deepEqual(i1.links, [{ text: 'Spec', url: 'https://x.test/spec' }]);
  assert.ok(codes(issues).includes('EXTRA_CELLS'));
  const short = byId(data, 'HR.PAY.SVC05');
  assert.deepEqual([short.sources, short.targets], [[], []]);
  assert.ok(short.flags.includes('missing-source') && short.flags.includes('missing-target'));
  assert.equal(data.edges.length, 1);
});

test('only http(s) links survive; relative ID links are reported', () => {
  const { data, issues } = build(catalogue(
    '| [I1.SVC01](/some/wiki/page) | Release 2 | | Core F&A | Core Assets | A | OOTB | N/A | N/A | N/A | [123](javascript:alert(1)) | [x](mailto:a@b.c) |',
  ));
  const i1 = byId(data, 'I1.SVC01');
  assert.equal(i1.url, null);
  assert.equal(i1.epic.url, null);
  assert.deepEqual(i1.links, []);
  assert.ok(codes(issues).includes('RELATIVE_LINK'));
});

test('wiki drafts only carry https links (http:// upgraded, with a note), and links without text show their URL', () => {
  const { records, systems, domains, notes } = wikiToRecords({
    catalogueMd: catalogue('| [I1.SVC01](http://x.test/1) | Release 2 | FIN01 | F&A | Core Assets | Assets | Publisher-Subscriber | API | API | Monthly | [55](http://x.test/e/55) | see [](http://x.test/a) and [Spec](https://x.test/b) |'),
    settingsMd: SETTINGS, source, vocab,
  });
  const [r] = records;
  assert.equal(r.link, 'https://x.test/1');
  assert.equal(r.epic.url, 'https://x.test/e/55');
  assert.deepEqual(r.links, [{ text: 'https://x.test/a', url: 'https://x.test/a' }, { text: 'Spec', url: 'https://x.test/b' }]);
  assert.equal(notes.filter((n) => /^I1.SVC01: .*was http:\/\/, so it was changed to https:\/\//.test(n)).length, 3);
  // The draft passes the build as it is.
  const built = buildFromStore({ store: { domains, systems, integrations: [{ file: 'catalogue/integrations/I1.SVC01.json', record: r }] }, vocab });
  assert.deepEqual(built.issues.filter((i) => i.level === 'error'), []);
});

test('missing settings page still builds, with a single warning', () => {
  const { data, issues } = build(catalogue('| I1.SVC01 | Release 2 | | F&A | Core Assets | A | OOTB | N/A | N/A | N/A | | |'), null);
  assert.ok(data);
  assert.deepEqual(codes(issues).filter((c) => c === 'SETTINGS_MISSING' || c === 'UNKNOWN_SYSTEM'), ['SETTINGS_MISSING']);
  assert.ok(data.systems.every((s) => s.domain === 'unassigned'));
});

test('domain colours follow Domains table order; unknown domains are appended', () => {
  const settings = SETTINGS.replace('| HelpDesk | | Risk & Incident |', '| HelpDesk | | Technology |');
  const { data, issues } = build(catalogue('| I1.SVC01 | Release 2 | | HelpDesk | Core Risk | A | OOTB | N/A | N/A | N/A | | |'), settings);
  assert.deepEqual(data.domains.map((d) => [d.name, d.slot]), [['Finance', 1], ['Assets', 2], ['Risk & Incident', 3], ['Sales', 4], ['Technology', 5], ['Unassigned', null]]);
  assert.ok(codes(issues).includes('UNKNOWN_DOMAIN'));
});

test('a catalogue without the required columns is an error', () => {
  const { data, issues } = build('| Name | Thing |\n|---|---|\n| a | b |');
  assert.equal(data, null);
  assert.deepEqual(codes(issues), ['NO_TABLE']);
});

test('a two-way pattern (request/response) gets its own line, separate from the one-way lines', () => {
  const { data } = build(catalogue(
    '| I001.SVC01 | R2 | | Core F&A | Partner Portal - EU/US | Balances | Synchronous POST Request | API | API | Real-time | | |',
    '| I002.SVC01 | R2 | | Core F&A | Core Assets | Assets | Publisher-Subscriber | API | API | Daily | | |',
  ));
  assert.equal(byId(data, 'I001.SVC01').pattern.twoWay, true);
  assert.equal(byId(data, 'I002.SVC01').pattern.twoWay, false);
  assert.deepEqual(data.edges.map((e) => [e.id, e.twoWay]).sort(), [['core-fa__core-assets', false], ['core-fa__partner-portal-eu-us__2way', true]]);
  const alaya = data.systems.find((s) => s.id === 'partner-portal-eu-us');
  assert.deepEqual([alaya.outbound, alaya.inbound, alaya.degree], [1, 1, 1]);
});
