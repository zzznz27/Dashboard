#!/usr/bin/env node
// One-off: converts the original wiki catalogue (and WorldMap Settings page) into the repo catalogue
// (catalogue/domains.json, systems.json, integrations/<ID>.json).
//   node scripts/migrate-from-wiki.mjs [--wiki .cache/wiki] [--force]
// Reads saved copies of the two pages. Refuses to overwrite existing records unless --force (the repo is the
// source of truth once migrated). Prints what it couldn't carry over, such as relative links.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wikiToRecords } from './lib/from-wiki.mjs';
import { readJson } from './lib/files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // src/
const REPO = resolve(ROOT, '..'); // the repo: .cache/
const { values: args } = parseArgs({ options: { wiki: { type: 'string', default: join(REPO, '.cache', 'wiki') }, force: { type: 'boolean', default: false } } });
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const source = readJson(join(ROOT, 'config', 'source.json'));
const vocab = readJson(join(ROOT, 'config', 'vocab.json'));
const dir = join(ROOT, source.store.dir);
const intDir = join(dir, 'integrations');

if (existsSync(intDir) && readdirSync(intDir).length && !args.force) {
  console.error(`${intDir} already has records. The repo is the source of truth now; use --force only to start again from the wiki.`);
  process.exit(1);
}
const catalogueMd = read(join(args.wiki, source.catalogue.path));
if (!catalogueMd) throw new Error(`No saved catalogue page at ${join(args.wiki, source.catalogue.path)}`);
const settingsMd = read(join(args.wiki, source.settings.path));

const { records, systems, domains, notes } = wikiToRecords({ catalogueMd, settingsMd, source, vocab });
mkdirSync(intDir, { recursive: true });
if (args.force) for (const f of readdirSync(intDir)) rmSync(join(intDir, f));
for (const r of records) writeFileSync(join(intDir, `${r.id}.json`), JSON.stringify(r, null, 2) + '\n', 'utf8');
writeFileSync(join(dir, 'domains.json'), JSON.stringify({ $comment: 'Business domains, in order: the order sets each domain\'s colour on the map (8 colours). Add new domains at the end.', domains }, null, 2) + '\n', 'utf8');
writeFileSync(join(dir, 'systems.json'), JSON.stringify({ $comment: 'Systems on the map. Names and aliases are matched ignoring case, spaces and punctuation. type is Internal (a platform your organisation runs) or External (a vendor or partner system).', systems }, null, 2) + '\n', 'utf8');

console.log(`Wrote ${records.length} integrations, ${systems.length} systems and ${domains.length} domains to ${source.store.dir}/.`);
for (const n of notes) console.log(`  note: ${n}`);
