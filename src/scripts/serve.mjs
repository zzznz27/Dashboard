#!/usr/bin/env node
// Local preview server for web/. No dependencies.
//   node scripts/serve.mjs [--port 8080]
// data/site.json is built live from config/ on every request, so editing a preset only needs a browser refresh.
// data/integrations.json comes from the last `npm run build:data` (or the page's "Rebuild data" button).
// Same handler and security headers as production (server/server.mjs), minus caching.
//
// Preview only:
// - POST /api/rebuild rebuilds the data from catalogue/ (scripts/build-data.mjs), for example after editing records
//   or switching branches.
// - GET / POST /api/records/<ID> read and save one integration record for the Table view's editor
//   (scripts/lib/record-edit.mjs). A save is checked against the whole catalogue first, then rebuilds the data.
// The server listens on this computer only, answers only requests addressed to it by a local name, and these
// requests must come from the page itself (a local origin plus a custom header), so other sites can't use them.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadSite } from './lib/site.mjs';
import { recordEditor } from './lib/record-edit.mjs';
import { readJson } from './lib/files.mjs';
import { staticHandler } from '../server/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const override = async (path) => {
  if (path !== '/data/site.json') return null;
  const { site, issues } = await loadSite(join(ROOT, 'config'));
  for (const i of issues) console.warn(`${i.level}: ${i.message}`);
  // The local preview also gets the design lab (off on the live site) and the record editor.
  return { body: JSON.stringify({ ...site, lab: true, devTools: { rebuild: true, edit: true } }), type: 'application/json; charset=utf-8' };
};
const editor = recordEditor(ROOT, { catalogue: readJson(join(ROOT, 'config', 'source.json')).store.dir, vocab: 'config/vocab.json', shownFrom: resolve(ROOT, '..') });
const serveStatic = staticHandler(join(ROOT, 'web'), { override, cache: 'no-store' });

const runNode = (script) => new Promise((done) => {
  execFile(process.execPath, [join(ROOT, 'scripts', script)], { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    done({ ok: !err, log: `${stdout}${stderr}`.trim() });
  });
});

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

let rebuilding = false;
async function rebuild(req, res, origins) {
  const json = (status, body) => sendJson(res, status, body);
  // Browsers always send Origin on a POST, so a missing one isn't the page.
  if (req.headers['x-worldmap-rebuild'] !== '1' || !origins.has(req.headers.origin)) {
    return json(403, { ok: false, error: 'Rebuild requests must come from the World Map page.' });
  }
  if (rebuilding) return json(409, { ok: false, error: 'A rebuild is already running.' });
  rebuilding = true;
  try {
    const built = await runNode('build-data.mjs');
    console.log(built.log);
    if (!built.ok) return json(500, { ok: false, error: 'The data build failed (a record has an error); see the log.', log: built.log });
    return json(200, { ok: true, log: built.log });
  } finally {
    rebuilding = false;
  }
}

const readBody = (req, limit = 64 * 1024) => new Promise((done, fail) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  req.on('error', fail);
});

// The Table view's editor: read a record (GET) or save changes to it (POST), then rebuild the data.
async function records(req, res, origins, id) {
  if (req.headers['x-worldmap-edit'] !== '1' || (req.method === 'POST' && !origins.has(req.headers.origin))) {
    return sendJson(res, 403, { ok: false, error: 'Editing requests must come from the World Map page.' });
  }
  if (req.method === 'GET') {
    const r = editor.read(id);
    return sendJson(res, r.status, r.body);
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use GET or POST.' });
  if (rebuilding) return sendJson(res, 409, { ok: false, error: 'A rebuild is running; try again in a moment.' });
  let changes;
  try {
    changes = JSON.parse(await readBody(req)).changes;
  } catch {
    return sendJson(res, 400, { ok: false, error: 'The changes couldn’t be read.' });
  }
  const saved = editor.save(id, changes);
  if (!saved.body.ok) return sendJson(res, saved.status, saved.body);
  console.log(`Saved ${saved.body.file}`);
  rebuilding = true;
  try {
    const built = await runNode('build-data.mjs');
    if (!built.ok) console.log(built.log);
    return sendJson(res, 200, { ...saved.body, rebuilt: built.ok });
  } finally {
    rebuilding = false;
  }
}

/**
 * The preview's request handler, for a server on `port`. It only answers requests addressed to this computer
 * (Host localhost, 127.0.0.1 or [::1] with this port). Listening on 127.0.0.1 alone isn't enough: with DNS rebinding a
 * site points its own name at 127.0.0.1, and the browser then sends its requests here as same-origin ones, with the
 * site's name in Host and Origin.
 */
export function previewHandler(port) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]'].map((name) => `${name}:${port}`));
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  return (req, res) => {
    if (!hosts.has(req.headers.host?.toLowerCase())) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`Open the preview at http://localhost:${port}/`);
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && path === '/api/rebuild') return rebuild(req, res, origins);
    const record = /^\/api\/records\/([^/]+)$/.exec(path);
    if (record) {
      let id;
      try { id = decodeURIComponent(record[1]); } catch { return sendJson(res, 400, { ok: false, error: 'Bad record name.' }); }
      return records(req, res, origins, id);
    }
    return serveStatic(req, res);
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values: args } = parseArgs({ options: { port: { type: 'string', default: process.env.PORT || '8080' } } });
  const port = Number(args.port);
  createServer(previewHandler(port)).listen(port, '127.0.0.1', () => {
    console.log(`World Map preview: http://localhost:${port}/`);
    console.log(`Lab panel:         http://localhost:${port}/?lab=1`);
    console.log(`Compare presets:   http://localhost:${port}/compare.html`);
  });
}
