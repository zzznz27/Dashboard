import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEditor } from '../lib/record-edit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// A scratch copy of the real catalogue and vocab, so saves never touch the repo.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'worldmap-edit-'));
  cpSync(join(ROOT, 'catalogue'), join(dir, 'catalogue'), { recursive: true });
  mkdirSync(join(dir, 'config'));
  cpSync(join(ROOT, 'config', 'vocab.json'), join(dir, 'config', 'vocab.json'));
  return { dir, editor: recordEditor(dir, { catalogue: 'catalogue', vocab: 'config/vocab.json' }), file: (id) => join(dir, 'catalogue', 'integrations', `${id}.json`) };
}

test('reads a record with the values the form offers', () => {
  const { dir, editor } = scratch();
  const r = editor.read('I002.SVC01');
  assert.equal(r.status, 200);
  assert.equal(r.body.record.id, 'I002.SVC01');
  assert.equal(r.body.file, 'catalogue/integrations/I002.SVC01.json');
  assert.ok(r.body.options.systems.includes('ERP'));
  assert.ok(r.body.options.pattern.includes('OOTB'));
  assert.equal(r.body.options.unknown, 'TBC');
  rmSync(dir, { recursive: true, force: true });
});

test('unknown or odd record names are refused', () => {
  const { dir, editor } = scratch();
  for (const id of ['NOPE-01', '../catalogue/systems', 'a/b', '', 'I004.SVC01.json']) {
    assert.equal(editor.read(id).status, 404, id);
    assert.equal(editor.save(id, { notes: 'x' }).status, 404, id);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a good change is saved in the standard format', () => {
  const { dir, editor, file } = scratch();
  const r = editor.save('I002.SVC01', { frequency: 'Daily?', dataFlow: '  Approved expense claims  ', link: 'https://example.test/design' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const text = readFileSync(file('I002.SVC01'), 'utf8');
  const saved = JSON.parse(text);
  assert.equal(saved.frequency, 'Daily?');
  assert.equal(saved.dataFlow, 'Approved expense claims', 'single-line fields are trimmed');
  assert.equal(saved.link, 'https://example.test/design');
  assert.deepEqual(Object.keys(saved).slice(0, 3), ['id', 'link', 'release'], 'fields stay in the standard order');
  assert.ok(text.endsWith('}\n'));
  // Clearing the link removes it.
  assert.equal(editor.save('I002.SVC01', { link: '' }).status, 200);
  assert.equal(JSON.parse(readFileSync(file('I002.SVC01'), 'utf8')).link, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('a change the catalogue checks would reject is not written', () => {
  const { dir, editor, file } = scratch();
  const before = readFileSync(file('I002.SVC01'), 'utf8');
  const r = editor.save('I002.SVC01', { target: ['Not A Real System'] });
  assert.equal(r.status, 422);
  assert.ok(r.body.problems.some((p) => /Not A Real System/.test(p)), r.body.problems.join('\n'));
  assert.equal(readFileSync(file('I002.SVC01'), 'utf8'), before, 'file unchanged');
  assert.equal(editor.save('I002.SVC01', { link: 'http://insecure.test' }).status, 422, 'non-https link');
  rmSync(dir, { recursive: true, force: true });
});

test('only the editable fields can be changed, with the right types', () => {
  const { dir, editor } = scratch();
  assert.equal(editor.save('I002.SVC01', { id: 'OTHER' }).status, 400);
  assert.equal(editor.save('I002.SVC01', { epic: { id: '1' } }).status, 400);
  assert.equal(editor.save('I002.SVC01', { source: 'Bank' }).status, 400, 'source must be a list');
  assert.equal(editor.save('I002.SVC01', { notes: 5 }).status, 400);
  assert.equal(editor.save('I002.SVC01', null).status, 400);
  rmSync(dir, { recursive: true, force: true });
});
