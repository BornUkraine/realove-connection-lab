import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = resolve(sourceRoot, '../connection-lab-site');
const workerPath = resolve(siteRoot, 'worker/index.js');
const expectedLogoHash = '483039f11a2109b8e6f1560587775ebec0685c54b30e87a9d572cbd3564460d0';
const sourcePaths = {
  rest: resolve(sourceRoot, 'lib/qloo-rest.mjs'),
  handler: resolve(sourceRoot, 'worker/handler.mjs'),
};
const assetEntries = [
  ['/', 'public/index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'public/index.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'public/styles.css', 'text/css; charset=utf-8'],
  ['/app.js', 'public/app.js', 'text/javascript; charset=utf-8'],
  ['/assets/realove-logo-approved.jpg', 'public/assets/realove-logo-approved.jpg', 'image/jpeg'],
];
function replaceExactlyOnce(source, before, after, name) {
  if (source.split(before).length !== 2) throw new Error('Unexpected source shape: ' + name);
  return source.replace(before, after);
}
function assertPortable(source, name) {
  if (/^\s*(?:import|export)\b/m.test(source) || /\brequire\s*\(|\bprocess\.|\bBuffer\b|['"]node:/m.test(source)) {
    throw new Error('Unexpected nonportable module syntax: ' + name);
  }
}
let rest = await readFile(sourcePaths.rest, 'utf8');
for (const declaration of [
  'class ServiceError', 'function providerDiagnostic', 'const ENTITY_ID', 'function normalizeCulturalEntity',
  'function entityRows', 'function qlooBase', 'async function boundedJson',
  'class QlooRestAdapter', 'async function nebiusDraft',
]) rest = replaceExactlyOnce(rest, 'export ' + declaration, declaration, declaration);
assertPortable(rest, 'REST adapter');

let handler = await readFile(sourcePaths.handler, 'utf8');
handler = replaceExactlyOnce(handler, "import { ServiceError, QlooRestAdapter, ENTITY_ID, boundedJson, nebiusDraft } from '../lib/qloo-rest.mjs';", '', 'REST import');
for (const declaration of ['async function signSelection', 'async function verifySelection', 'function createWorkerHandler']) {
  handler = replaceExactlyOnce(handler, 'export ' + declaration, declaration, declaration);
}
handler = replaceExactlyOnce(handler, 'export default handler;', '', 'default handler');
assertPortable(handler, 'worker handler');

const assets = {};
for (const [url, relativePath, type] of assetEntries) {
  // Read only this explicit asset allowlist. Never traverse the source directory.
  const bytes = await readFile(resolve(sourceRoot, relativePath));
  if (type === 'image/jpeg' && createHash('sha256').update(bytes).digest('hex') !== expectedLogoHash) {
    throw new Error('Approved logo checksum mismatch');
  }
  assets[url] = { type, length: bytes.length, base64: bytes.toString('base64') };
}
const output = [
  '// Generated from explicit first-party source and asset allowlists.',
  '// Runtime uses Web APIs only. Secrets remain runtime environment bindings.',
  'const __realoveRest = (() => {',
  rest,
  'return { ServiceError, QlooRestAdapter, ENTITY_ID, boundedJson, nebiusDraft };',
  '})();',
  'const __realoveApi = (() => {',
  'const { ServiceError, QlooRestAdapter, ENTITY_ID, boundedJson, nebiusDraft } = __realoveRest;',
  handler,
  'return handler;',
  '})();',
  'const __realoveAssets = ' + JSON.stringify(assets) + ';',
  'const __realoveDecoded = new Map();',
  "const __realoveCsp = \"default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'\";",
  'function __realoveSecure(response, head = false) {',
  '  const headers = new Headers(response.headers);',
  "  headers.set('Content-Security-Policy', __realoveCsp);",
  "  headers.set('X-Content-Type-Options', 'nosniff');",
  "  headers.set('Referrer-Policy', 'no-referrer');",
  "  headers.set('X-Frame-Options', 'DENY');",
  "  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');",
  '  return new Response(head ? null : response.body, { status: response.status, statusText: response.statusText, headers });',
  '}',
  'function __realoveStaticError(status, message, head = false) {',
  "  return __realoveSecure(new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) } }), head);",
  '}',
  'export default {',
  '  async fetch(request, env = {}, ctx) {',
  '    let url;',
  "    try { url = new URL(request.url); } catch { return __realoveStaticError(400, 'Invalid request URL.'); }",
  "    const head = request.method === 'HEAD';",
  "    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {",
  "      const apiRequest = head && ['/api/status', '/healthz'].includes(url.pathname) ? new Request(request, { method: 'GET' }) : request;",
  '      return __realoveSecure(await __realoveApi.fetch(apiRequest, env, ctx), head);',
  '    }',
  "    if (!['GET', 'HEAD'].includes(request.method)) return __realoveStaticError(405, 'Use GET or HEAD for a static asset.', head);",
  '    const asset = Object.prototype.hasOwnProperty.call(__realoveAssets, url.pathname) ? __realoveAssets[url.pathname] : null;',
  "    if (!asset) return __realoveStaticError(404, 'This path is not part of the demo.', head);",
  '    if (!__realoveDecoded.has(url.pathname)) __realoveDecoded.set(url.pathname, Uint8Array.from(atob(asset.base64), character => character.charCodeAt(0)));',
  "    return __realoveSecure(new Response(head ? null : __realoveDecoded.get(url.pathname), { headers: { 'Content-Type': asset.type, 'Content-Length': String(asset.length), 'Cache-Control': 'no-cache' } }), head);",
  '  }',
  '};',
  '',
].join('\n');
await mkdir(dirname(workerPath), { recursive: true });
await writeFile(workerPath, output, 'utf8');
console.log(JSON.stringify({ worker: workerPath, bytes: new TextEncoder().encode(output).length, assetRoutes: Object.keys(assets), logoSha256: expectedLogoHash }));

