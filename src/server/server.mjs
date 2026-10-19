#!/usr/bin/env node
// Production static server for the built web/ folder. No dependencies.
//   node server/server.mjs            (App Service sets PORT; sign-in is handled in front of it by Easy Auth)
// Also exports staticHandler() for the local preview server (scripts/serve.mjs).

import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as Z, gzip } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// App Service passes a Node app's responses through as they are, so compressing is up to us. Text shrinks to about a
// third (the vendor scripts are most of the first load); the images are compressed already.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md']);

// In order of preference. Each file is compressed once and kept (see staticHandler), so these lean towards size;
// brotli stops at 9 because 11 takes most of a second on the Cytoscape bundle for a few percent less.
const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);
const ENCODERS = {
  br: (raw) => brotli(raw, {
    params: { [Z.BROTLI_PARAM_QUALITY]: 9, [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length },
  }),
  gzip: (raw) => gzipped(raw, { level: Z.Z_BEST_COMPRESSION }),
};

// Everything is same-origin. The one hash is the rule Cytoscape injects into <head>
// (".__________cytoscape_container { position: relative; }"); update it if Cytoscape changes that string.
// blob: is for the map's logo images, which the page draws itself (web/js/views/graph.js, rasterLogo).
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'sha256-pgvDUBa4IjFA2yuSJ2cqcyxmNYJMborsd0ORcRv9vw8='",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// For every response that isn't one of our pages. Opened directly, a browser shows an SVG (or text) as a document in
// this signed-in origin, so a logo with a script in it could run here; sandbox gives it no scripts and no origin.
const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Staff only: if a crawler ever gets past sign-in, keep the pages out of search results.
  'X-Robots-Tag': 'noindex, nofollow',
};

// Small site, no fingerprinted file names: always revalidate (cheap 304s), so a wiki edit shows on the next refresh.
// private: the responses are for a signed-in person, so shared caches (proxies) mustn't keep them.
const CACHE = 'private, no-cache';
const TEXT = 'text/plain; charset=utf-8';

// The request's path, decoded. null when it can't be: bad percent-encoding or a NUL byte, both the client's mistake.
function requestPath(url) {
  try {
    const path = decodeURIComponent(new URL(url, 'http://localhost').pathname);
    return path.includes('\0') ? null : path;
  } catch {
    return null;
  }
}

// Whether `path` is the folder `dir` or inside it (both absolute and normalised).
const within = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// The encoding to send: the first of ENCODERS that Accept-Encoding allows (q above 0, by name or *), else none.
function pickEncoding(header = '') {
  const q = new Map();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    const weight = params.find((p) => p.startsWith('q='));
    q.set(name, weight ? Number(weight.slice(2)) : 1);
  }
  return Object.keys(ENCODERS).find((name) => (q.get(name) ?? q.get('*') ?? 0) > 0) ?? null;
}

// Whether the client's copy is current. If-None-Match decides when it's sent. If-Modified-Since only counts without it,
// and only for exactly this file's time: a file older than the client's copy (a rollback) has still changed.
function unchanged(headers, etag, modified) {
  const tags = headers['if-none-match'];
  const bare = (tag) => tag.trim().replace(/^W\//, '');
  if (tags !== undefined) return tags.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
  return Date.parse(headers['if-modified-since'] ?? '') === Date.parse(modified);
}

/**
 * Returns an http request handler serving files under `root`.
 * `override(path)` may return { body, type } to answer a path itself (the preview server builds site.json live).
 * `cache` replaces the Cache-Control value (the preview server uses no-store).
 */
export function staticHandler(root, { override, cache = CACHE } = {}) {
  const base = resolve(root);
  let realBase; // `base` with symlinks resolved, found on first use
  // Compressed files, kept until the file's size or modified time changes: "<encoding> <file>" -> { stamp, bytes }.
  const packed = new Map();
  const compressed = (file, info, encoding) => {
    const key = `${encoding} ${file}`;
    const stamp = `${info.size} ${info.mtimeMs}`;
    let entry = packed.get(key);
    if (entry?.stamp !== stamp) {
      entry = { stamp, bytes: readFile(file).then(ENCODERS[encoding]) };
      packed.set(key, entry);
      entry.bytes.catch(() => packed.get(key) === entry && packed.delete(key)); // don't keep a failure
    }
    return entry.bytes;
  };

  return async (req, res) => {
    const path = requestPath(req.url);
    let failure; // what the handler threw, for the log
    // One line for App Service's log per request that ends badly; the favicon.ico that browsers guess at is noise.
    const log = (status) => {
      if (status < 400 || (status === 404 && path === '/favicon.ico')) return;
      const line = `${req.method} ${req.url.slice(0, 200).replace(/[^\x20-\x7e]/g, '?')} ${status}`;
      if (failure) console.error(line, failure);
      else if (status >= 500) console.error(line);
      else console.log(line);
    };
    const reply = (status, body, type, extra = {}) => {
      const headers = {
        'Content-Type': type,
        'Cache-Control': cache,
        ...SECURITY_HEADERS,
        'Content-Security-Policy': type.startsWith('text/html') ? CSP : ASSET_CSP,
        ...extra,
      };
      if (status !== 304) headers['Content-Length'] ??= Buffer.byteLength(body ?? '');
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      log(status);
    };

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Method not allowed', TEXT, { Allow: 'GET, HEAD' });
      if (path === null) return reply(400, 'Bad request', TEXT);
      // For App Service's health check: shows the process is answering, without depending on the disk.
      if (path === '/healthz') return reply(200, 'ok', TEXT, { 'Cache-Control': 'no-store' });
      const own = override ? await override(path) : null;
      if (own) return reply(200, own.body, own.type);

      let file = resolve(base, '.' + (path.endsWith('/') ? path + 'index.html' : path));
      if (!within(base, file)) return reply(403, 'Forbidden', TEXT);
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) return reply(404, 'Not found', TEXT);
      // stat() follows symlinks, so a link under web/ could lead anywhere: only serve what really lives under the root.
      realBase ??= await realpath(base);
      if (!within(realBase, await realpath(file).catch(() => ''))) return reply(404, 'Not found', TEXT);

      const ext = extname(file).toLowerCase();
      const type = TYPES[ext] ?? 'application/octet-stream';
      const encoding = COMPRESSIBLE.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;
      // Changes with the file (a rollback included) and differs per encoding, as each is a different set of bytes.
      const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}${encoding ? `-${encoding}` : ''}"`;
      const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
      const headers = { ETag: etag, 'Last-Modified': modified, ...(COMPRESSIBLE.has(ext) && { Vary: 'Accept-Encoding' }) };
      if (unchanged(req.headers, etag, modified)) return reply(304, null, type, headers);
      if (encoding) return reply(200, await compressed(file, info, encoding), type, { ...headers, 'Content-Encoding': encoding });
      if (req.method === 'HEAD') return reply(200, null, type, { ...headers, 'Content-Length': info.size });
      reply(200, await readFile(file), type, headers);
    } catch (err) {
      failure = err;
      if (!res.headersSent) return reply(500, 'Server error', TEXT);
      log(500);
      res.destroy();
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const port = Number(process.env.PORT) || 8080; // an empty PORT means the default, not port 0 (any free port)
  const server = createServer(staticHandler(web)).listen(port, () => console.log(`World Map serving ${web} on port ${port}`));

  // App Service sends SIGTERM on restart, deploy and scale-in: stop accepting connections, let the requests in flight
  // finish, and exit when they have (or after 10 s, before the platform kills the container anyway).
  const stop = (signal) => {
    console.log(`${signal}: closing`);
    server.close(() => process.exit(0));
    // close() drops the idle keep-alive connections once; drop the others as they go idle, rather than after 5 s.
    setInterval(() => server.closeIdleConnections(), 250).unref();
    setTimeout(() => {
      console.error('Requests still open after 10 s; exiting');
      process.exit(1);
    }, 10_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
