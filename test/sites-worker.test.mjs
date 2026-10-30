import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, '../connection-lab-site');
const source = await readFile(resolve(site, 'worker/index.js'), 'utf8');
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('Provider network forbidden in this test'); };
let worker;
try { worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default; }
finally { globalThis.fetch = originalFetch; }
const origin = 'https://example.test';
const call = (path, init) => worker.fetch(new Request(origin + path, init), {});

test('all whitelisted static assets are byte-identical and secured', async () => {
  for (const [path, file, mime] of [
    ['/', 'public/index.html', 'text/html'],
    ['/index.html', 'public/index.html', 'text/html'],
    ['/styles.css', 'public/styles.css', 'text/css'],
    ['/app.js', 'public/app.js', 'text/javascript'],
    ['/assets/realove-logo-approved.jpg', 'public/assets/realove-logo-approved.jpg', 'image/jpeg'],
  ]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    assert.ok(response.headers.get('content-security-policy').includes("default-src 'none'"));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(resolve(root, file)));
  }
});
test('HEAD retains static headers but has no body', async () => {
  const response = await call('/assets/realove-logo-approved.jpg', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(response.headers.get('content-length')) > 0);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});
test('unknown and sensitive paths are denied, never served as an SPA', async () => {
  for (const path of ['/missing', '/.env', '/.private/key', '/package.json', '/worker/index.js', '/%2e%2e/.env']) {
    assert.equal((await call(path)).status, 404);
  }
  const denied = await call('/app.js', { method: 'POST' });
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get('allow'), 'GET, HEAD');
});
test('API status and health retain backend shapes without provider access', async () => {
  const status = await call('/api/status');
  assert.equal(status.status, 200);
  const data = await status.json();
  assert.equal(data.app, 'Realove Connection Lab');
  assert.equal(data.providers.qloo.configured, false);
  assert.equal(data.providers.nebius.configured, false);
  assert.equal((await call('/api/status', { method: 'HEAD' })).status, 200);
  assert.deepEqual(await (await call('/healthz')).json(), { ok: true });
});
test('missing providers fail honestly and make no network calls', async () => {
  for (const [path, body] of [
    ['/api/qloo/resolve', { concepts: ['Nina Simone'] }],
    ['/api/coach', { message: 'This is a fictional practice message.', goal: 'introduction' }],
  ]) {
    const response = await call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 503);
    assert.equal(typeof (await response.json()).error.message, 'string');
  }
  assert.equal(networkCalls, 0);
});
test('no Node runtime dependencies remain in the generated module', () => {
  assert.equal(/^\s*import\b/m.test(source), false);
  assert.equal(/\brequire\s*\(|\bprocess\.|\bBuffer\b|['"]node:/m.test(source), false);
});
test('hosting manifest is copied byte-for-byte', async () => {
  assert.deepEqual(await readFile(resolve(site, '.openai/hosting.json')), await readFile(resolve(site, 'dist/.openai/hosting.json')));
});

