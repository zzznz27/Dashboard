#!/usr/bin/env node
// Turns a row of the original wiki catalogue into a draft record for catalogue/integrations/, using the same
// rules as the migration. Used by the worldmap-data skill; prints JSON and writes nothing.
//   node scripts/wiki-to-record.mjs <saved page> [--id I093.SVC01]
// <saved page> is either the page's markdown or the Azure DevOps wiki tool's saved output (JSON); the tool's
// "untrusted content" marker lines are removed. Without --id it lists the IDs on the page that aren't in catalogue/ yet.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { wikiToRecords } from './lib/from-wiki.mjs';
import { normKey } from './lib/catalogue.mjs';
import { readJson, stripBom } from './lib/files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: 'string' } } });
if (!positionals[0]) { console.error('Usage: node scripts/wiki-to-record.mjs <saved page> [--id <Integration ID>]'); process.exit(2); }
const source = readJson(join(ROOT, 'config', 'source.json'));
const vocab = readJson(join(ROOT, 'config', 'vocab.json'));

let text = stripBom(readFileSync(resolve(positionals[0]), 'utf8'));
try {
  const parsed = JSON.parse(text);
  text = Array.isArray(parsed) ? parsed.map((p) => p.text ?? '').join('\n') : parsed.content ?? text;
} catch { /* plain markdown */ }
const catalogueMd = text.replace(/^<<[0-9a-f]+>> \[UNTRUSTED[^\n]*\n/m, '').replace(/\n?<<\/[0-9a-f]+>>\s*$/, '');

// Systems and domains come from the repo catalogue, so names resolve the same way the build will.
const store = join(ROOT, source.store.dir);
const sys = readJson(join(store, 'systems.json')).systems;
const dom = readJson(join(store, 'domains.json')).domains;
const settingsMd = [
  '| Domain | Description |', '|---|---|', ...dom.map((d) => `| ${d.name} | ${d.description ?? ''} |`), '',
  '| System | Aliases | Domain | Type |', '|---|---|---|---|', ...sys.map((s) => `| ${s.name} | ${(s.aliases ?? []).join('; ')} | ${s.domain} | ${s.type} |`),
].join('\n');

const { records, notes } = wikiToRecords({ catalogueMd, settingsMd, source, vocab });
const existing = new Set(existsSync(join(store, 'integrations')) ? readdirSync(join(store, 'integrations')).map((f) => normKey(f.replace(/\.json$/, ''))) : []);

if (!args.id) {
  const missing = records.filter((r) => !existing.has(normKey(r.id))).map((r) => r.id);
  console.log(JSON.stringify({ onPage: records.length, notInCatalogue: missing }, null, 2));
  process.exit(0);
}
const record = records.find((r) => normKey(r.id) === normKey(args.id));
if (!record) { console.error(`No row with Integration ID "${args.id}" on that page.`); process.exit(1); }
console.log(JSON.stringify({
  record,
  alreadyInCatalogue: existing.has(normKey(record.id)),
  notes: notes.filter((n) => n.startsWith(`${record.id}:`) || n.startsWith('System ')),
}, null, 2));
