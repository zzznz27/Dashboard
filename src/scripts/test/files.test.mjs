import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStore, readJsonFile } from '../lib/files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BOM = '﻿';

// A copy of the real catalogue and config to break in different ways.
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'worldmap-files-'));
  cpSync(join(ROOT, 'catalogue'), join(dir, 'catalogue'), { recursive: true });
  cpSync(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
  return dir;
}
// --check on that copy, with plain (non-pipeline) output.
const check = (dir) => spawnSync(process.execPath, ['scripts/build-data.mjs', '--check', '--catalogue', join(dir, 'catalogue'), '--config', join(dir, 'config')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TF_BUILD: '' } });
const codes = (issues) => issues.map((i) => i.code);

test('a UTF-8 byte-order mark (Notepad) is ignored; broken JSON is a BAD_JSON error naming the file', () => {
  const dir = copy();
  const p = join(dir, 'catalogue', 'systems.json');
  writeFileSync(p, BOM + readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(readJsonFile(p).value.systems));
  const store = readStore(join(dir, 'catalogue'));
  assert.deepEqual(store.issues, []);

  writeFileSync(join(dir, 'catalogue', 'integrations', 'I004.SVC01.json'), '{ "id": "I004.SVC01", }');
  const broken = readStore(join(dir, 'catalogue'));
  assert.deepEqual(codes(broken.issues), ['BAD_JSON']);
  assert.match(broken.issues[0].message, /integrations\/I004.SVC01.json: isn't valid JSON/);
});

test('files in catalogue/integrations that are not lower-case .json records are errors, not silently skipped', () => {
  const dir = copy();
  const intDir = join(dir, 'catalogue', 'integrations');
  const rec = readFileSync(join(intDir, 'I004.SVC01.json'), 'utf8');
  writeFileSync(join(intDir, 'I999.SVC01.JSON'), rec);
  writeFileSync(join(intDir, 'notes.txt'), 'x');
  mkdirSync(join(intDir, 'drafts'));
  const store = readStore(join(dir, 'catalogue'));
  assert.deepEqual(codes(store.issues), ['BAD_FILE', 'BAD_FILE', 'BAD_FILE']);
  assert.match(store.issues.map((i) => i.message).join('\n'), /I999.SVC01.JSON: only integration records belong/);
  assert.match(store.issues.map((i) => i.message).join('\n'), /Rename or move this folder/);
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /BAD_FILE/);
});

test('a broken or misspelt domains.json / systems.json is one error, and the integrations are not checked', () => {
  const dir = copy();
  writeFileSync(join(dir, 'catalogue', 'systems.json'), JSON.stringify({ sytems: [] }));
  const store = readStore(join(dir, 'catalogue'));
  assert.equal(store.fatal, true);
  assert.deepEqual(codes(store.issues), ['MISSING_FIELD']);
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Check failed: 1 error\(s\)/);
  assert.match(out.stdout, /has no "systems" list \(it has "sytems"/);

  writeFileSync(join(dir, 'catalogue', 'domains.json'), '{ "domains": [ }');
  const both = readStore(join(dir, 'catalogue'));
  assert.deepEqual(codes(both.issues), ['BAD_JSON', 'MISSING_FIELD']);
});

test('config files: a BOM is fine; broken JSON is a friendly BAD_JSON error, not a stack trace', () => {
  const dir = copy();
  for (const f of ['vocab.json', 'site.json', 'source.json', join('presets', 'matrix-light.json')]) {
    const p = join(dir, 'config', f);
    writeFileSync(p, BOM + readFileSync(p, 'utf8'));
  }
  const ok = check(dir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Check passed: \d+ warnings/);

  writeFileSync(join(dir, 'config', 'vocab.json'), '{ "pattern": ');
  const bad = check(dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /BAD_JSON .*config\/vocab.json: isn't valid JSON/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /\n\s+at /, 'no stack trace');
});

test('--check also checks config/site.json and the presets', () => {
  const dir = copy();
  writeFileSync(join(dir, 'config', 'site.json'), '{ "title": "x", }');
  const out = check(dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /BAD_JSON +config\/site.json/);
  assert.doesNotMatch(out.stdout + out.stderr, /\n\s+at /);
});
