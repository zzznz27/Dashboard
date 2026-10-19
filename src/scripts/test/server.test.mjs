import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { CSP, staticHandler } from '../../server/server.mjs';
import { previewHandler } from '../serve.mjs';

// A small web root, with a secret next to it that no request may reach.
const dir = mkdtempSync(join(tmpdir(), 'worldmap-server-'));
const site = join(dir, 'site');
mkdirSync(join(site, 'sub'), { recursive: true });
mkdirSync(join(dir, 'outside'));
writeFileSync(join(dir, 'outside', 'secret.txt'), 'SECRET');
writeFileSync(join(dir, 'secret.txt'), 'SECRET');
writeFileSync(join(site, 'index.html'), `<!doctype html><title>t</title>${'<p>map</p>'.repeat(200)}`);
writeFileSync(join(site, 'sub', 'index.html'), '<!doctype html><title>sub</title>');
writeFileSync(join(site, 'app.js'), 'export const nodes = [];\n'.repeat(500));
writeFileSync(join(site, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
writeFileSync(join(site, 'mark.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
let linked = true;
try {
  symlinkSync(join(dir, 'outside'), join(site, 'escape'), 'junction'); // a junction needs no admin rights on Windows
} catch {
  linked = false;
}

const servers = [];
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return server.address().port;
}

let port;
before(async () => {
  // The handler logs 4xx/5xx lines; keep them out of the test output (and let the tests read them).
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  port = await listen(staticHandler(site));
});
after(() => {
  mock.restoreAll();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

// fetch() normalises paths ("%2e%2e", "\") and decompresses; this sends the path and headers exactly as given.
function raw(path, { method = 'GET', headers = {}, to = port } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port: to, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
}
const url = (path) => `http://127.0.0.1:${port}${path}`;

test('path traversal never escapes the root and never errors', async () => {
  const attempts = [
    '/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%2f..%2foutside%2fsecret.txt',
    '/sub/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/..%5c..%5coutside%5csecret.txt', '/%2e%2e%5csecret.txt',
    '/index.html%00.txt', '/%00', '/..%00/secret.txt', '//..%2f..%2fsecret.txt',
  ];
  for (const path of attempts) {
    const res = await raw(path);
    assert.ok([400, 403, 404].includes(res.status), `${path} gave ${res.status}`);
    assert.ok(!res.body.toString().includes('SECRET'), `${path} leaked the secret`);
  }
  assert.equal((await raw('/index.html%00.txt')).status, 400);
});

test('a symlink out of the root is refused', { skip: !linked && 'could not create a symlink here' }, async () => {
  const res = await raw('/escape/secret.txt');
  assert.equal(res.status, 404);
  assert.ok(!res.body.toString().includes('SECRET'));
});

test('malformed percent-encoding is a 400, logged as one line without a stack', async () => {
  console.log.mock.resetCalls();
  console.error.mock.resetCalls();
  const res = await raw('/%E0%A4%A');
  assert.equal(res.status, 400);
  assert.equal(console.error.mock.callCount(), 0);
  assert.deepEqual(console.log.mock.calls.map((c) => c.arguments), [['GET /%E0%A4%A 400']]);
});

test('only 4xx/5xx are logged, and not the favicon.ico browsers guess at', async () => {
  console.log.mock.resetCalls();
  await raw('/index.html');
  await raw('/favicon.ico');
  await raw('/missing.js');
  await raw('/index.html', { method: 'DELETE' });
  assert.deepEqual(console.log.mock.calls.map((c) => c.arguments[0]), ['GET /missing.js 404', 'DELETE /index.html 405']);
});

test('text is compressed when the client accepts it, and decodes to the same bytes', async () => {
  const original = readFileSync(join(site, 'app.js'));
  const gz = await raw('/app.js', { headers: { 'accept-encoding': 'gzip, deflate' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.vary, 'Accept-Encoding');
  assert.equal(Number(gz.headers['content-length']), gz.body.length);
  assert.ok(gz.body.length < original.length / 5);
  assert.deepEqual(gunzipSync(gz.body), original);

  const br = await raw('/app.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(brotliDecompressSync(br.body), original);

  for (const accept of [undefined, 'identity', 'gzip;q=0, br;q=0', 'deflate']) {
    const plain = await raw('/app.js', { headers: accept ? { 'accept-encoding': accept } : {} });
    assert.equal(plain.headers['content-encoding'], undefined, `${accept}`);
    assert.equal(Number(plain.headers['content-length']), original.length);
    assert.deepEqual(plain.body, original);
  }
  assert.equal((await raw('/mark.png', { headers: { 'accept-encoding': 'gzip' } })).headers['content-encoding'], undefined);
  const viaFetch = await fetch(url('/app.js'));
  assert.equal(await viaFetch.text(), original.toString());
});

test('a changed file is compressed again', async () => {
  const file = join(site, 'data.json');
  writeFileSync(file, JSON.stringify({ v: 1, pad: 'x'.repeat(2000) }));
  utimesSync(file, new Date('2026-01-01'), new Date('2026-01-01'));
  const first = await raw('/data.json', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(JSON.parse(gunzipSync(first.body)).v, 1);
  writeFileSync(file, JSON.stringify({ v: 22, pad: 'x'.repeat(2000) }));
  utimesSync(file, new Date('2026-02-01'), new Date('2026-02-01'));
  const second = await raw('/data.json', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(JSON.parse(gunzipSync(second.body)).v, 22);
  assert.notEqual(first.headers.etag, second.headers.etag);
});

test('ETag revalidation: 304 on a match, per encoding, and If-None-Match wins over If-Modified-Since', async () => {
  const first = await raw('/app.js', { headers: { 'accept-encoding': 'gzip' } });
  const { etag, 'last-modified': modified } = first.headers;
  assert.match(etag, /^W\/"\d+-\d+-gzip"$/);
  assert.ok(modified);

  const again = await raw('/app.js', { headers: { 'accept-encoding': 'gzip', 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, etag);
  assert.equal(again.headers.vary, 'Accept-Encoding');

  // The same tag doesn't stand for the uncompressed bytes.
  assert.equal((await raw('/app.js', { headers: { 'if-none-match': etag } })).status, 200);
  // A stale tag gets the file, even when the date matches.
  const stale = await raw('/app.js', { headers: { 'accept-encoding': 'gzip', 'if-none-match': 'W/"1-1-gzip"', 'if-modified-since': modified } });
  assert.equal(stale.status, 200);

  // fetch() round trip.
  const viaFetch = await fetch(url('/index.html'));
  const tag = viaFetch.headers.get('etag');
  await viaFetch.arrayBuffer();
  assert.equal((await fetch(url('/index.html'), { headers: { 'if-none-match': tag } })).status, 304);
});

test('If-Modified-Since only gives a 304 for exactly the file\'s time, so a rollback to an older file is served', async () => {
  const file = join(site, 'rollback.txt');
  writeFileSync(file, 'old version');
  utimesSync(file, new Date('2026-03-01T10:00:00.700Z'), new Date('2026-03-01T10:00:00.700Z'));
  const res = await raw('/rollback.txt');
  assert.equal(res.headers['last-modified'], 'Sun, 01 Mar 2026 10:00:00 GMT');
  assert.equal((await raw('/rollback.txt', { headers: { 'if-modified-since': res.headers['last-modified'] } })).status, 304);
  // The client's copy is newer than the file now deployed: changed, not "not modified".
  assert.equal((await raw('/rollback.txt', { headers: { 'if-modified-since': 'Mon, 02 Mar 2026 10:00:00 GMT' } })).status, 200);
  assert.equal((await raw('/rollback.txt', { headers: { 'if-modified-since': 'not a date' } })).status, 200);
});

test('HEAD sends the headers GET would, Content-Length included, and no body', async () => {
  for (const headers of [{}, { 'accept-encoding': 'gzip' }, { 'accept-encoding': 'br' }]) {
    const get = await raw('/app.js', { headers });
    const head = await raw('/app.js', { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(get.body.length));
    assert.equal(head.headers['content-encoding'], get.headers['content-encoding']);
    assert.equal(head.headers.etag, get.headers.etag);
  }
  const missing = await raw('/missing.txt', { method: 'HEAD' });
  assert.equal(missing.status, 404);
  assert.ok(missing.headers['content-length']);
});

test('/healthz answers ok without touching the disk', async () => {
  const nowhere = await listen(staticHandler(join(dir, 'does-not-exist')));
  for (const method of ['GET', 'HEAD']) {
    const res = await raw('/healthz', { method, to: nowhere });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.toString(), method === 'GET' ? 'ok' : '');
    assert.equal(res.headers['content-length'], '2');
  }
  assert.equal((await raw('/index.html', { to: nowhere })).status, 404);
});

test('pages get the page CSP; SVG and every other response get the sandbox CSP', async () => {
  const page = await fetch(url('/'));
  assert.equal(page.headers.get('content-security-policy'), CSP);
  assert.match(CSP, /img-src 'self' data: blob:/);
  assert.equal((await fetch(url('/sub/'))).headers.get('content-security-policy'), CSP);
  const sandbox = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  for (const path of ['/logo.svg', '/app.js', '/mark.png', '/missing', '/healthz']) {
    assert.equal((await fetch(url(path))).headers.get('content-security-policy'), sandbox, path);
  }
});

test('security and caching headers', async () => {
  const res = await fetch(url('/'));
  const expected = {
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000',
    'cache-control': 'private, no-cache',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(res.headers.get(name), value, name);
  assert.equal((await fetch(url('/index.html'), { method: 'POST' })).status, 405);
});

test('preview server: answers only local host names, and rebuilds only for a local origin', async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const p = server.address().port;
  server.on('request', previewHandler(p));
  const get = (host) => raw('/healthz', { to: p, headers: { host } });

  for (const host of [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`, `LOCALHOST:${p}`]) assert.equal((await get(host)).status, 200, host);
  // DNS rebinding: an attacker's name that resolves to 127.0.0.1.
  for (const host of [`evil.example:${p}`, 'localhost', `localhost:${p + 1}`, `127.0.0.1.evil.example:${p}`]) {
    assert.equal((await get(host)).status, 403, host);
  }

  // Never a valid rebuild request here: that would run the real data build.
  const post = (headers) => raw('/api/rebuild', { to: p, method: 'POST', headers: { host: `localhost:${p}`, ...headers } });
  const ok = { 'x-worldmap-rebuild': '1' };
  assert.equal((await post({ ...ok })).status, 403, 'no Origin');
  assert.equal((await post({ ...ok, origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ ...ok, origin: `http://localhost:${p + 1}` })).status, 403);
  assert.equal((await post({ ...ok, origin: 'null' })).status, 403);
  assert.equal((await post({ origin: `http://localhost:${p}` })).status, 403, 'no custom header');
  const rebound = await raw('/api/rebuild', { to: p, method: 'POST', headers: { ...ok, host: `evil.example:${p}`, origin: `http://evil.example:${p}` } });
  assert.equal(rebound.status, 403);
});
