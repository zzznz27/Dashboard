import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildFromStore, canonicalRecord, checkVocab, isHttps, listFromFile } from '../lib/store.mjs';
import { compareText } from '../lib/catalogue.mjs';
import { renderCataloguePage } from '../lib/wiki-page.mjs';

const vocab = JSON.parse(readFileSync(new URL('../../config/vocab.json', import.meta.url), 'utf8'));
const source = JSON.parse(readFileSync(new URL('../../config/source.json', import.meta.url), 'utf8'));

const domains = [{ name: 'Finance', description: 'Money' }, { name: 'Sales', description: 'Sales' }];
const systems = [
  { name: 'Core F&A', aliases: ['F&A'], domain: 'Finance', type: 'Internal' },
  { name: 'Partner Portal - EU/US', aliases: [], domain: 'Sales', type: 'External' },
  { name: 'e-Shop', aliases: [], domain: 'Sales', type: 'External' },
];
const rec = (over = {}) => ({
  id: 'I001.SVC01', release: 'Release 2', workload: 'FIN01', source: ['F&A'], target: ['Partner Portal - EU/US'],
  dataFlow: 'Invoices', pattern: 'Publisher-Subscriber', sourceProtocol: 'API', targetProtocol: 'API', frequency: 'Daily', epic: null, notes: '', ...over,
});
const build = (records, extra = {}) => buildFromStore({
  store: { domains, systems, integrations: records.map((r) => ({ file: `catalogue/integrations/${r.id}.json`, record: r })), ...extra },
  vocab,
});
const errors = (issues) => issues.filter((i) => i.level === 'error').map((i) => i.code);
const messages = (issues) => issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n');
const withSystems = (extraSystems, extraDomains = []) => buildFromStore({
  store: { domains: [...domains, ...extraDomains], systems: [...systems, ...extraSystems], integrations: [{ file: 'catalogue/integrations/I001.SVC01.json', record: rec() }] },
  vocab,
});

test('a valid catalogue builds: aliases resolve, values normalise, gaps are reported', () => {
  const { data, issues } = build([rec(), rec({ id: 'I002.SVC01', frequency: 'Daily?', pattern: 'TBC' })]);
  assert.deepEqual(errors(issues), []);
  assert.equal(data.integrations[0].sources[0], 'core-fa');
  assert.equal(data.integrations[0].record, 'catalogue/integrations/I001.SVC01.json');
  assert.equal(data.edges.length, 1);
  assert.equal(issues.filter((i) => i.code === 'DATA_GAP').length, 2);
});

test('anything that would make the map wrong is an error and stops the build', () => {
  const cases = [
    [rec({ source: ['Nobody'] }), 'UNKNOWN_SYSTEM'],
    [rec({ pattern: 'Carrier pigeon' }), 'UNKNOWN_VALUE'],
    [rec({ link: 'http://insecure.example' }), 'BAD_LINK'],
    [rec({ link: 'javascript:alert(1)' }), 'BAD_LINK'],
    [rec({ colour: 'red' }), 'UNKNOWN_FIELD'],
    [rec({ id: 'has space' }), 'BAD_ID'],
    [rec({ epic: { id: '1', url: '/relative' } }), 'BAD_VALUE'],
  ];
  for (const [r, code] of cases) {
    const { data, issues } = build([r]);
    assert.equal(data, null, code);
    assert.ok(errors(issues).includes(code), `${code}: got ${errors(issues)}`);
  }
  const dup = build([rec(), rec()]);
  assert.ok(errors(dup.issues).includes('DUPLICATE_ID'));
  const wrongFile = buildFromStore({ store: { domains, systems, integrations: [{ file: 'catalogue/integrations/other.json', record: rec() }] }, vocab });
  assert.ok(errors(wrongFile.issues).includes('FILE_NAME'));
});

test('systems: unknown domain, bad type and clashing aliases are errors', () => {
  const bad = [
    { name: 'X', aliases: [], domain: 'Nowhere', type: 'External' },
    { name: 'Y', aliases: ['F&A'], domain: 'Finance', type: 'Sometimes' },
  ];
  const { issues } = buildFromStore({ store: { domains, systems: [...systems, ...bad], integrations: [{ file: 'catalogue/integrations/I001.SVC01.json', record: rec() }] }, vocab });
  assert.deepEqual(errors(issues).sort(), ['BAD_VALUE', 'DUPLICATE_ALIAS', 'UNKNOWN_DOMAIN']);
});

test('an integration with no source yet is a warning, not an error', () => {
  const { data, issues } = build([rec(), rec({ id: 'I003.SVC01', source: [], target: [] })]);
  assert.ok(data);
  assert.equal(issues.filter((i) => i.code === 'MISSING_FIELD').length, 2);
});

test('two-way patterns get their own line', () => {
  const { data } = build([rec({ pattern: 'Synchronous POST Request', source: ['Partner Portal - EU/US'], target: ['e-Shop'] })]);
  assert.deepEqual(data.edges.map((e) => [e.id, e.twoWay]), [['e-shop__partner-portal-eu-us__2way', true]]);
});

test('canonicalRecord orders fields and drops empty optional ones', () => {
  const r = canonicalRecord({ notes: 'n', id: 'X', links: [], link: '', epic: { id: '5' } });
  assert.deepEqual(Object.keys(r), ['id', 'release', 'workload', 'source', 'target', 'dataFlow', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency', 'epic', 'notes']);
  assert.deepEqual(r.epic, { id: '5' });
});

test('the generated wiki page escapes cells and has no timestamp', () => {
  const store = { domains, systems, integrations: [{ file: 'f', record: rec({ notes: 'a | b' }) }] };
  const { data } = build([rec({ notes: 'a | b' })]);
  const page = renderCataloguePage({ store, data, source });
  assert.match(page, /a \\\| b/);
  assert.match(page, /Generated: don't edit this page/);
  assert.doesNotMatch(page, /\d{4}-\d{2}-\d{2}T/);
});

test('the wiki page shows cell text as written: Markdown and HTML characters are escaped, link URLs encoded', () => {
  const r = rec({
    notes: '*bold* _under_ `code` [x](https://evil.example) ![img](y) <b>tag</b> # not a heading \\ end',
    links: [{ text: '', url: 'https://x.test/a' }, { text: 'Spec [v2]', url: 'https://x.test/b(c)|d e' }],
  });
  const store = { domains, systems, integrations: [{ file: 'f', record: r }] };
  const { data } = build([rec()]);
  const page = renderCataloguePage({ store, data, source });
  const row = page.split('\n').find((l) => l.startsWith('| I001.SVC01'));
  assert.ok(row.includes('\\*bold\\* \\_under\\_ \\`code\\` \\[x\\]\\(https://evil.example\\) \\!\\[img\\]\\(y\\) \\<b\\>tag\\</b\\> \\# not a heading \\\\ end'), row);
  assert.ok(row.includes('[https://x.test/a](https://x.test/a)'), 'a link with no text shows its URL');
  assert.ok(row.includes('[Spec \\[v2\\]](https://x.test/b%28c%29%7Cd%20e)'), row);
});

test('links: every link needs one line of text without " | " and a plain https URL', () => {
  const bad = [
    [{ url: 'https://x.test/a' }, 'needs "text"'],
    [{ text: '  ', url: 'https://x.test/a' }, 'needs "text"'],
    [{ text: 'a | b', url: 'https://x.test/a' }, 'not contain " | "'],
    [{ text: 'two\nlines', url: 'https://x.test/a' }, 'on one line'],
    [{ text: 'Spec', url: 'https://x.test/Design (v2).pdf' }, '%28'],
    [{ text: 'Spec', url: 'https://x.test/a|b' }, '%7C'],
    [{ text: 'Spec', url: 'https://x.test/a`b' }, 'https://'],
    [{ text: 'Spec', url: 'http://x.test/a' }, 'https://'],
    [{ text: 'Spec', url: 'https://x.test/a', title: 'x' }, '"title" isn\'t a known field'],
    ['https://x.test/a', 'must be { "text"'],
    [null, 'not null'],
  ];
  for (const [link, words] of bad) {
    const { data, issues } = build([rec({ links: [link] })]);
    assert.equal(data, null, JSON.stringify(link));
    assert.ok(messages(issues).includes(words), `${JSON.stringify(link)}: ${messages(issues)}`);
  }
  const ok = build([rec({ links: [{ text: 'Spec (v2) - final', url: 'https://x.test/Design%20%28v2%29.pdf?a=1&b=2#top' }] })]);
  assert.deepEqual(errors(ok.issues), []);
  assert.equal(ok.data.integrations[0].links[0].text, 'Spec (v2) - final');
  assert.equal(isHttps('https://x.test'), true);
  for (const u of ['https://', 'https:x.test', 'https://x.test/[a]', 'https://x .test', 'ftp://x.test', 42]) assert.equal(isHttps(u), false, u);
});

test('"$comment" inside a record or an entry is an error, so the Excel round trip never drops it silently', () => {
  const r = build([rec({ $comment: 'remember this' })]);
  assert.ok(errors(r.issues).includes('UNKNOWN_FIELD'));
  assert.match(messages(r.issues), /"\$comment" isn't allowed here; use "notes" instead/);
  const s = withSystems([{ $comment: 'x', name: 'Z', aliases: [], domain: 'Sales', type: 'External' }]);
  assert.match(messages(s.issues), /systems.json "Z": "\$comment" isn't allowed here/);
});

test('a system that is both source and target is a warning, and no line is drawn to itself', () => {
  const { data, issues } = build([rec({ source: ['F&A'], target: ['Core F&A', 'e-Shop'] })]);
  assert.ok(data);
  const same = issues.filter((i) => i.code === 'SAME_SYSTEM');
  assert.equal(same.length, 1);
  assert.equal(same[0].level, 'warning');
  assert.match(same[0].message, /"Core F&A" is both a source and a target/);
  assert.deepEqual(data.edges.map((e) => e.id), ['core-fa__e-shop']);
});

test('names: "Unassigned" is reserved, names need a letter or digit, Windows device names are refused as IDs', () => {
  assert.match(messages(withSystems([], [{ name: 'Unassigned' }]).issues), /"Unassigned" is reserved/);
  assert.match(messages(withSystems([{ name: '---', aliases: [], domain: 'Sales', type: 'External' }]).issues), /needs at least one letter or digit/);
  assert.match(messages(withSystems([{ name: 'Z', aliases: ['-'], domain: 'Sales', type: 'External' }]).issues), /alias "-" needs at least one letter or digit/);
  for (const id of ['CON', 'con.SVC01', 'NUL', 'COM1.SVC01', 'lpt9', 'Aux.X']) {
    const { issues } = build([rec({ id })]);
    assert.ok(errors(issues).includes('BAD_ID'), id);
    assert.match(messages(issues), /Windows keeps for devices/, id);
  }
  for (const id of ['CONSOLE.SVC01', 'COM10', 'CON-01']) assert.ok(!errors(build([rec({ id })]).issues).includes('BAD_ID'), id);
});

test('entries of the wrong type get a plain message, never a crash', () => {
  const cases = [
    [() => buildFromStore({ store: { domains: [null, 'Finance', ...domains], systems, integrations: [] }, vocab }), [/domains.json #1: each domain must be .* not null/, /domains.json #2: .* not text/]],
    [() => withSystems([{ name: 'Z', aliases: 'Zed', domain: 'Sales', type: 'External' }]), [/aliases must be a list .* not text/]],
    [() => withSystems([{ name: 'Z', aliases: [7], domain: 'Sales', type: 'External' }]), [/each alias must be text in quotes, not a number/]],
    [() => withSystems([{ name: 5, aliases: [], domain: 'Sales', type: 'External' }]), [/name must be text in quotes, not a number/]],
    [() => withSystems([[1, 2]]), [/each system must be .* not a list/]],
    [() => build([rec({ id: 5 })]), [/id must be text in quotes .* not a number/]],
    [() => build([rec({ source: 'F&A' })]), [/source must be a list of system names, e.g. \["ERP"\] \(put "F&A" inside \[ \]\)/]],
    [() => build([rec({ target: [null] })]), [/each target name must be text in quotes, not null/]],
    [() => build([rec({ notes: ['a'] })]), [/notes must be text in quotes, not a list/]],
    [() => build([rec({ links: { text: 'a', url: 'https://x.test' } })]), [/links must be a list .* not an object/]],
    [() => buildFromStore({ store: { domains, systems, integrations: [{ file: 'catalogue/integrations/X.json', record: [] }] }, vocab }), [/must hold one record .* not a list/]],
  ];
  for (const [run, patterns] of cases) {
    const { data, issues } = run();
    assert.equal(data, null);
    for (const p of patterns) assert.match(messages(issues), p);
  }
});

test('domains.json / systems.json: a missing or misspelt list is one clear error; other top-level keys are refused', () => {
  const typo = listFromFile({ $comment: 'x', sytems: [] }, 'systems', 'catalogue/systems.json');
  assert.equal(typo.list, null);
  assert.equal(typo.issues.length, 1);
  assert.match(typo.issues[0].message, /has no "systems" list \(it has "sytems": is "systems" misspelt\?\)/);
  assert.match(listFromFile({ systems: {} }, 'systems', 's').issues[0].message, /must be a list/);
  assert.match(listFromFile([], 'systems', 's').issues[0].message, /must be \{ "systems": \[ … \] \}, not a list/);
  const extra = listFromFile({ systems: [], colours: {} }, 'systems', 's');
  assert.deepEqual(extra.list, []);
  assert.deepEqual(extra.issues.map((i) => i.code), ['UNKNOWN_FIELD']);
  // buildFromStore stops there: no error per integration.
  const fatal = buildFromStore({ store: { domains, systems: [], integrations: [{ file: 'f', record: rec() }], issues: typo.issues, fatal: true }, vocab });
  assert.equal(fatal.data, null);
  assert.equal(fatal.issues.length, 1);
});

test('vocab.json is checked: pattern groups, frequency speeds and spellings that map to two values', () => {
  assert.deepEqual(checkVocab(vocab), []);
  const copy = () => JSON.parse(JSON.stringify(vocab));
  const cases = [
    [(v) => { v.pattern.MFT.group = 'files'; }, /pattern "MFT": group "files" must be one of/],
    [(v) => { v.patternGroups.zigzag = { label: 'Z' }; }, /pattern group "zigzag" isn't one the map has a line style for/],
    [(v) => { v.frequency.Daily.speed = 'warp'; }, /frequency "Daily": speed "warp" must be one of slow, medium, fast/],
    [(v) => { v.frequency.Monthly.aliases = ['Daily']; }, /frequency: "Daily" maps to both "Daily" and "Monthly"/],
    [(v) => { v.protocol.File.aliases = ['SFTP']; }, /protocol: "SFTP" maps to both "File" and "File \(SFTP\)"/],
    [(v) => { v.protocol.API.aliases = 'APIs'; }, /protocol "API": aliases must be a list/],
    [(v) => { v.protocol.Event.aliases = ['N/A']; }, /"N\/A" is also in unknownValues or notApplicableValues/],
    [(v) => { delete v.frequency; }, /"frequency" must be a table of values/],
  ];
  for (const [change, pattern] of cases) {
    const v = copy();
    change(v);
    const issues = checkVocab(v);
    assert.ok(issues.length > 0 && issues.every((i) => i.code === 'BAD_VOCAB'), pattern.source);
    assert.match(issues.map((i) => i.message).join('\n'), pattern);
  }
  // A vocab problem is reported on its own, not as an error on every record.
  const v = copy();
  v.pattern.MFT.group = 'files';
  const r = buildFromStore({ store: { domains, systems, integrations: [{ file: 'catalogue/integrations/I001.SVC01.json', record: rec() }] }, vocab: v });
  assert.equal(r.data, null);
  assert.deepEqual(errors(r.issues), ['BAD_VOCAB']);
});

test('sorting uses one collator: numbers in names compare as numbers, whatever the machine locale', () => {
  assert.ok(compareText('I9.SVC01', 'I10.SVC01') < 0);
  assert.equal(compareText('e-shop', 'E-Shop'), 0);
  const { data } = build([rec({ id: 'I10.SVC01' }), rec({ id: 'I9.SVC01' }), rec({ id: 'i2.SVC01' })]);
  assert.deepEqual(data.integrations.map((i) => i.id), ['i2.SVC01', 'I9.SVC01', 'I10.SVC01']);
});

test('the real catalogue in the repo passes the check', () => {
  const out = execFileSync(process.execPath, ['scripts/build-data.mjs', '--check'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  assert.match(out, /Check passed/);
});
