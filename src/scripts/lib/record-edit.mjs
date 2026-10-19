// The local preview's record editor (scripts/serve.mjs, Table view): read one integration record for the form, and
// save changes to it only after checking the whole catalogue the way the build does. Nothing here runs on the
// live site; changes reach it the usual way, through a commit and a pull request.

import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readStore, readJsonFile } from './files.mjs';
import { buildFromStore, canonicalRecord, ID_PATTERN } from './store.mjs';
import { compareText } from './catalogue.mjs';

// The details people fill in. IDs, epics and extra links stay with the skill or Excel.
export const EDITABLE = ['source', 'target', 'dataFlow', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency', 'release', 'workload', 'link', 'notes'];
const LISTS = new Set(['source', 'target']);
const MULTILINE = new Set(['notes']);

// root: the folder holding the catalogue (src/); paths: { catalogue: 'catalogue', vocab: 'config/vocab.json' } relative
// to it. File paths in replies are relative to paths.shownFrom (the repo, so they read src/catalogue/…), else root.
export function recordEditor(root, paths) {
  const dir = join(root, paths.catalogue);
  const rel = (p) => relative(paths.shownFrom ?? root, p).replace(/\\/g, '/');
  const fileOf = (id) => (typeof id === 'string' && ID_PATTERN.test(id) ? join(dir, 'integrations', `${id}.json`) : null);
  const vocab = () => readJsonFile(join(root, paths.vocab)).value ?? {};

  // The record exactly as written, and the values the form offers.
  function read(id) {
    const file = fileOf(id);
    if (!file || !existsSync(file)) return { status: 404, body: { ok: false, error: `There's no record called ${id}.` } };
    const { value: record, issue } = readJsonFile(file, rel(file));
    if (issue) return { status: 400, body: { ok: false, error: issue.message } };
    const store = readStore(dir, rel);
    const v = vocab();
    const inUse = (key) => [...new Set(store.integrations.map((x) => x.record?.[key]).filter((s) => typeof s === 'string' && s))].sort(compareText);
    return {
      status: 200,
      body: {
        ok: true,
        file: rel(file),
        record,
        options: {
          systems: store.systems.map((s) => s.name).sort(compareText),
          pattern: Object.keys(v.pattern ?? {}),
          protocol: Object.keys(v.protocol ?? {}),
          frequency: Object.keys(v.frequency ?? {}),
          unknown: v.unknownValues?.[0] ?? 'TBC',
          notApplicable: v.notApplicableValues?.[0] ?? 'N/A',
          release: inUse('release'),
          workload: inUse('workload'),
        },
      },
    };
  }

  // Applies `changes` to the record, checks the catalogue as it would be, and writes the file only if it passes.
  function save(id, changes) {
    const file = fileOf(id);
    if (!file || !existsSync(file)) return { status: 404, body: { ok: false, error: `There's no record called ${id}.` } };
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return bad('Send the changes as an object of field: value.');
    const { value: current, issue } = readJsonFile(file, rel(file));
    if (issue) return bad(issue.message);
    const next = { ...current };
    for (const [field, value] of Object.entries(changes)) {
      if (!EDITABLE.includes(field)) return bad(`${field} can't be changed here.`);
      if (LISTS.has(field)) {
        if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) return bad(`${field} must be a list of system names.`);
        next[field] = value.map((s) => s.trim()).filter(Boolean);
      } else if (typeof value !== 'string') {
        return bad(`${field} must be text.`);
      } else if (field === 'link') {
        if (value.trim()) next.link = value.trim(); else delete next.link;
      } else {
        next[field] = MULTILINE.has(field) ? value.replace(/\r\n/g, '\n') : value.trim();
      }
    }
    const record = canonicalRecord(next);

    // The same check the build runs, on the whole catalogue with this record swapped in.
    const store = readStore(dir, rel);
    const label = rel(file);
    store.integrations = store.integrations.map((x) => (x.file === label ? { ...x, record } : x));
    const { issues } = buildFromStore({ store, vocab: vocab() });
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      return { status: 422, body: { ok: false, error: 'Not saved: the catalogue wouldn’t pass its checks with this change.', problems: errors.map((i) => i.message) } };
    }
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const mine = (i) => i.message.includes(id);
    return {
      status: 200,
      body: { ok: true, file: label, record, warnings: issues.filter((i) => i.level === 'warning' && mine(i)).map((i) => i.message) },
    };
  }

  return { read, save };
}

const bad = (error) => ({ status: 400, body: { ok: false, error } });
