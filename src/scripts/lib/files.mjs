// Reads the catalogue and config files from disk, for build-data.mjs, site.mjs and the wiki scripts.
// scripts/excel.ps1 has its own copy of readStore below; keep the two in step (test/excel.test.mjs compares them).
// Problems come back as issues (the same shape as the build's) rather than exceptions, so a broken file gives
// one clear message naming it instead of a stack trace.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listFromFile } from './store.mjs';

// Notepad and some other Windows editors save UTF-8 with a byte-order mark, which JSON.parse rejects with an
// unreadable message. It carries no information, so it's dropped.
export const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// Throws on a missing file or broken JSON; readJsonFile below turns that into a friendly issue.
export const readJson = (path) => JSON.parse(stripBom(readFileSync(path, 'utf8')));

// { value } or { issue } (BAD_JSON, an error). label is how the file is named in the message.
export function readJsonFile(path, label = path) {
  try {
    return { value: readJson(path) };
  } catch (err) {
    const why = !existsSync(path) ? 'file not found' : err instanceof SyntaxError ? `isn't valid JSON (${err.message})` : err.message;
    return { issue: { level: 'error', code: 'BAD_JSON', message: `${label}: ${why}.`, file: label } };
  }
}

// The catalogue folder: domains.json, systems.json and integrations/<ID>.json. rel(path) names a file in messages
// (always with forward slashes: the build checks a record's file name against its id).
// fatal = domains.json or systems.json couldn't be used, so the integrations aren't read at all.
export function readStore(dir, rel = (p) => p.replace(/\\/g, '/')) {
  const issues = [];
  const list = (name, key) => {
    const label = rel(join(dir, name));
    const { value, issue } = readJsonFile(join(dir, name), label);
    if (issue) { issues.push(issue); return null; }
    const r = listFromFile(value, key, label);
    issues.push(...r.issues);
    return r.list;
  };
  const domains = list('domains.json', 'domains');
  const systems = list('systems.json', 'systems');
  if (!domains || !systems) return { domains: domains ?? [], systems: systems ?? [], integrations: [], issues, fatal: true };

  const intDir = join(dir, 'integrations');
  const integrations = [];
  for (const f of existsSync(intDir) ? readdirSync(intDir).sort() : []) {
    const path = join(intDir, f);
    const label = rel(path);
    // Anything else here would otherwise be skipped without a word: "I093.SVC01.JSON", "I093.SVC01.json.txt", a folder.
    const isDir = statSync(path).isDirectory();
    if (isDir || !f.endsWith('.json')) {
      issues.push({ level: 'error', code: 'BAD_FILE', message: `${label}: only integration records belong in ${rel(intDir)}/, one per file, named after the ID with ".json" in lower case (e.g. I004.SVC01.json). Rename or move this ${isDir ? 'folder' : 'file'}.`, file: label });
      continue;
    }
    const { value, issue } = readJsonFile(path, label);
    if (issue) issues.push(issue);
    else integrations.push({ file: label, record: value });
  }
  return { domains, systems, integrations, issues, fatal: false };
}
