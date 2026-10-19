import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite } from '../lib/site.mjs';

const CONFIG = fileURLToPath(new URL('../../config', import.meta.url));

test('the real config loads with no warnings and a valid default preset', async () => {
  const { site, issues } = await loadSite(CONFIG);
  assert.deepEqual(issues, []);
  assert.ok(site.presets.some((p) => p.id === site.defaultPreset));
  assert.equal(new Set(site.presets.map((p) => p.id)).size, site.presets.length);
});

test('bad presets are reported, skipped or corrected - never fatal unless none are usable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldmap-site-'));
  mkdirSync(join(dir, 'presets'));
  writeFileSync(join(dir, 'site.json'), JSON.stringify({ title: 't', defaultPreset: 'missing' }));
  writeFileSync(join(dir, 'presets', 'a.json'), JSON.stringify({ id: 'a', theme: 'not-a-theme' }));
  writeFileSync(join(dir, 'presets', 'b.json'), '{ not json');
  writeFileSync(join(dir, 'presets', 'c.json'), JSON.stringify({ id: 'a' }));
  const { site, issues } = await loadSite(dir);
  const codes = issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['DEFAULT_PRESET', 'PRESET_DUPLICATE', 'PRESET_INVALID', 'PRESET_VALUE']);
  assert.equal(site.defaultPreset, 'a');
  assert.equal(site.presets[0].animation.ambient, 'none', 'defaults are filled in');
});

test('site.json and presets: a BOM is fine; broken site.json is a BAD_JSON error, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worldmap-site-'));
  mkdirSync(join(dir, 'presets'));
  writeFileSync(join(dir, 'site.json'), '﻿' + JSON.stringify({ title: 't', defaultPreset: 'a' }));
  writeFileSync(join(dir, 'presets', 'a.json'), '﻿' + JSON.stringify({ id: 'a' }));
  writeFileSync(join(dir, 'presets', 'b.json'), 'null');
  const { site, issues } = await loadSite(dir);
  assert.deepEqual(issues.map((i) => i.code), ['PRESET_INVALID']);
  assert.deepEqual(site.presets.map((p) => p.id), ['a']);

  writeFileSync(join(dir, 'site.json'), '{ "title": ');
  const broken = await loadSite(dir);
  assert.equal(broken.site, null);
  assert.deepEqual(broken.issues.map((i) => [i.level, i.code]), [['error', 'BAD_JSON']]);
  assert.match(broken.issues[0].message, /config\/site.json: isn't valid JSON/);
});
