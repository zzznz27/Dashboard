// The Excel bulk-edit script (scripts/excel.ps1, PowerShell 7) and its copy of the build's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFromStore, canonicalRecord } from '../lib/store.mjs';
import { readStore } from '../lib/files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // src/
const SCRIPT = join(ROOT, 'scripts', 'excel.ps1');
const vocab = JSON.parse(readFileSync(join(ROOT, 'config', 'vocab.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(ROOT, 'config', 'source.json'), 'utf8'));

// The pipeline's agents have PowerShell 7, so there a missing pwsh fails rather than skipping.
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
const skip = !hasPwsh && !process.env.TF_BUILD && 'PowerShell 7 (pwsh) not installed';

// A scratch copy of the real catalogue and config, with source.json pointing at the copy.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'worldmap-excel-'));
  cpSync(join(ROOT, 'catalogue'), join(dir, 'catalogue'), { recursive: true });
  cpSync(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'source.json'), JSON.stringify({ ...source, store: { ...source.store, dir: join(dir, 'catalogue') } }));
  const cat = join(dir, 'catalogue');
  const intDir = join(cat, 'integrations');
  const csv = join(dir, 'csv');
  const run = (...args) => {
    const r = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, ...args, '-Config', join(dir, 'config')], { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const snapshot = () => [
    ...readdirSync(intDir).sort().map((f) => `${f}\n${readFileSync(join(intDir, f), 'utf8')}`),
    readFileSync(join(cat, 'systems.json'), 'utf8'),
    readFileSync(join(cat, 'domains.json'), 'utf8'),
  ].join('\n');
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cat, intDir, csv, run, snapshot, done };
}
const systemsOf = (cat) => JSON.parse(readFileSync(join(cat, 'systems.json'), 'utf8')).systems;
const firstRecord = (intDir) => JSON.parse(readFileSync(join(intDir, readdirSync(intDir).sort()[0]), 'utf8'));
const errorLines = (stderr) => stderr.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.replace(/^ {2}/, ''));

test('excel.ps1: export then import without changes leaves every file byte-identical (on a copy)', { skip }, () => {
  const { cat, intDir, csv, run, snapshot, done } = scratch();
  // Values an import could change: spaces at the ends, quotes, commas and semicolons, a backslash and a tab, a line
  // break, accents and an emoji, brackets in link text, several links, an epic id with spaces round it.
  const [a, b] = systemsOf(cat);
  const edge = canonicalRecord({
    ...firstRecord(intDir), id: 'ZZ.EDGE01', source: [a.name], target: [b.name], dataFlow: 'Line one\nline two é — 😀',
    epic: { id: ' 0042 ', url: 'https://x.test/e/42' }, notes: '  Starts and ends with spaces, "quoted"; semis \\ back\ttab ',
    links: [{ text: 'Spec (v2) [final] & notes, 50%', url: 'https://x.test/Design%20%28v2%29.pdf?a=1&b=2' }, { text: ' padded ', url: 'https://x.test/b' }],
  });
  writeFileSync(join(intDir, 'ZZ.EDGE01.json'), JSON.stringify(edge, null, 2) + '\n');
  const before = snapshot();
  const ex = run('export', csv);
  assert.equal(ex.status, 0, ex.stderr);
  assert.deepEqual(readdirSync(csv).sort(), ['Domains.csv', 'Integrations.csv', 'Systems.csv']);
  const im = run('import', csv);
  assert.equal(im.status, 0, im.stderr);
  assert.match(im.stdout, /0 added, 0 changed, 0 removed/);
  assert.equal(snapshot(), before);
  done();
});

test('excel.ps1: what the CSV files can\'t carry is refused before export', { skip }, () => {
  const { intDir, csv, run, done } = scratch();
  const rec = firstRecord(intDir);
  writeFileSync(join(intDir, 'ZZ.BAD01.json'), JSON.stringify({ ...rec, id: 'ZZ.BAD01', $comment: 'x', links: [{ url: 'https://x.test/a' }, { text: 'a | b', url: 'https://x.test/b' }] }));
  const r = run('export', csv);
  assert.equal(r.status, 1);
  for (const words of ['has errors', '"$comment"', 'needs "text"', 'not contain " | "']) assert.ok(r.stderr.includes(words), `${words}: ${r.stderr}`);
  assert.equal(existsSync(csv), false);
  done();
});

test('excel.ps1: import adds, changes and removes records; an error anywhere changes nothing', { skip }, () => {
  const { intDir, csv, run, snapshot, done } = scratch();
  assert.equal(run('export', csv).status, 0);
  const file = join(csv, 'Integrations.csv');
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split('\r\n');
  const ids = readdirSync(intDir).sort().map((f) => f.replace(/\.json$/, ''));
  const [header, first, second] = lines;
  // Cells stay as written in the file (quotes doubled), so they go back in as they are.
  const cells = (line) => line.slice(1, -1).split('","');
  const row = (values) => values.map((v) => `"${v}"`).join(',');
  const changed = cells(first); changed[6] = 'A changed data flow';
  const added = cells(first); added[0] = 'ZZ.NEW01'; added[1] = '';
  // Saved by Excel in a region that uses ";": the heading row says which, and the import follows it.
  const semi = (line) => cells(line).map((v) => `"${v}"`).join(';');
  const edited = [header, row(changed), ...lines.slice(3).filter(Boolean), row(added)].map((l) => semi(l)).join('\r\n') + '\r\n';

  // An unknown system: nothing is written.
  const before = snapshot();
  const bad = [...cells(first)]; bad[4] = 'Not A Real System';
  writeFileSync(file, [header, row(bad), ...lines.slice(1)].join('\r\n'));
  const refused = run('import', csv);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.match(refused.stderr, /Integrations\.csv row 2: source "Not A Real System" isn't in Systems\.csv/);
  assert.equal(snapshot(), before);

  // Not UTF-8 (Excel's plain "CSV" in Windows-1252, with an é): refused, with how to save it.
  writeFileSync(file, Buffer.from([...Buffer.from(header + '\r\n'), 0x22, 0xe9, 0x22, 0x0d, 0x0a]));
  assert.match(run('import', csv).stderr, /isn't UTF-8 text/);
  assert.equal(snapshot(), before);

  writeFileSync(file, '﻿' + edited);
  const ok = run('import', csv);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`1 added, 1 changed, 1 removed \\(added: ZZ\\.NEW01\\) \\(removed: ${ids[1].replace(/\./g, '\\.')}\\)`));
  assert.equal(JSON.parse(readFileSync(join(intDir, `${ids[0]}.json`), 'utf8')).dataFlow, 'A changed data flow');
  assert.equal(existsSync(join(intDir, `${ids[1]}.json`)), false);
  assert.equal(JSON.parse(readFileSync(join(intDir, 'ZZ.NEW01.json'), 'utf8')).id, 'ZZ.NEW01');
  done();
});

// The checks in excel.ps1 are a copy of the build's. Each broken catalogue below must get exactly the build's errors.
test('excel.ps1 refuses exactly what the build refuses, with the same messages', { skip }, () => {
  const write = (p, v) => writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const cases = {
    records({ intDir, cat }) {
      const rec = firstRecord(intDir);
      const [sys] = systemsOf(cat);
      write(join(intDir, 'ZZ.A01.json'), { ...rec, id: 'ZZ.A01', source: ['Nobody'], pattern: 'Carrier Pigeon', link: 'http://x.test', epic: { id: 5 }, Notes: 'x', $comment: 'y' });
      write(join(intDir, 'ZZ.A02.json'), { ...rec, id: 'ZZ.A02', source: sys.name, target: [5], frequency: ['Daily'], links: { text: 'a' } });
      write(join(intDir, 'ZZ.A03.json'), { ...rec, id: 'ZZ.A03', links: [{ text: 'two\nlines', url: 'https://x.test/a' }, 'x', { text: 'ok', url: 'https://x .test' }, { text: ' ', url: 'https://x.test/c', extra: 1 }], epic: { id: '1', url: 'https://x.test/(1)' } });
      write(join(intDir, 'ZZ.A04.json'), { ...rec, id: 'ZZ.A04', sourceProtocol: 'File (TBC)?', targetProtocol: 'n/a', frequency: 'TBC', pattern: '**OOTB**' });
      write(join(intDir, 'ZZ.A05.json'), { ...rec, id: 'ZZ.A05.wrong' });
      write(join(intDir, 'ZZ.A06.json'), { ...rec, id: 7 });
      write(join(intDir, 'CON.SVC01.json'), { ...rec, id: 'CON.SVC01' });
      write(join(intDir, 'bad id.json'), { ...rec, id: 'bad id' });
      write(join(intDir, 'ZZA01.json'), { ...rec, id: 'ZZA01' });
      write(join(intDir, 'ZZ.A07.json'), '[1, 2]');
      write(join(intDir, 'ZZ.A08.JSON'), {});
      mkdirSync(join(intDir, 'a-folder'));
    },
    systems({ cat }) {
      const s = systemsOf(cat);
      write(join(cat, 'systems.json'), { $comment: 'x', systems: [...s, { ...s[0] }, { name: 'New', aliases: [7, '--', ' ', 'NEW'], domain: 'Nowhere', type: 'Partner' }, { name: 5 }, { aliases: 'x' }, 'text', { name: '!!', domain: 3, $comment: 'c' }] });
    },
    domains({ cat }) {
      const d = JSON.parse(readFileSync(join(cat, 'domains.json'), 'utf8')).domains;
      write(join(cat, 'domains.json'), { domains: [...d, { ...d[0] }, { name: 'Unassigned' }, { name: '--' }, { name: 'Extra', description: 4, colour: 'red' }, null, { name: 3 }, {}] });
    },
    'misspelt list'({ cat }) { write(join(cat, 'systems.json'), { $comment: 'x', sytems: [] }); },
    'top-level key'({ cat }) {
      const d = JSON.parse(readFileSync(join(cat, 'domains.json'), 'utf8'));
      write(join(cat, 'domains.json'), { ...d, extra: 1 });
    },
    vocab({ dir }) {
      const v = structuredClone(vocab);
      v.patternGroups.zzz = { label: 'x' };
      v.pattern.OOTB.group = 'nope';
      v.pattern.MFT.twoWay = 'yes';
      v.frequency.Daily.speed = 'warp';
      v.protocol.API.aliases = ['File', 'N/A', '--'];
      write(join(dir, 'config', 'vocab.json'), v);
    },
    'no integrations'({ intDir }) { rmSync(intDir, { recursive: true }); mkdirSync(intDir); },
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const s = scratch();
    breakIt(s);
    const v = JSON.parse(readFileSync(join(s.dir, 'config', 'vocab.json'), 'utf8'));
    const expected = buildFromStore({ store: readStore(s.cat), vocab: v }).issues.filter((i) => i.level === 'error').map((i) => i.message).sort();
    const r = s.run('export', s.csv);
    assert.equal(r.status, 1, `${name}: ${r.stdout}`);
    assert.ok(expected.length > 0, name);
    assert.deepEqual(errorLines(r.stderr).sort(), expected, name);
    s.done();
  }
});
