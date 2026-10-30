import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkerHandler, signSelection, verifySelection } from '../worker/handler.mjs';
import { QlooRestAdapter, nebiusDraft, providerDiagnostic } from '../lib/qloo-rest.mjs';

const env = { QLOO_API_KEY: 'fixture-qloo-key-not-real', QLOO_BASE_URL: 'https://hackathon.api.qloo.com', SELECTION_SIGNING_KEY: 'fixture-signing-key-not-real-32-bytes-minimum', NEBIUS_API_KEY: 'fixture-nebius-key-not-real', NEBIUS_MODEL: 'nvidia/test-fixture' };
const entity = { entity_id: 'CULTURE-ENTITY-001', name: 'A public band', type: 'urn:entity', subtype: 'urn:entity:artist' };
function req(path, data, headers = {}) { return new Request('https://lab.example' + path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }); }
function fakeApi(calls = []) {
  return async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    if (url.pathname === '/search') return Response.json({ results: [entity] });
    if (url.pathname === '/v2/insights') return Response.json({ results: { entities: [{ entity_id: 'CULTURE-MOVIE-002', name: 'Across the Universe', type: 'urn:entity', subtype: 'urn:entity:movie', properties: { description: 'Public cultural fixture.' } }] } });
    if (url.pathname === '/v1/chat/completions') return Response.json({ choices: [{ message: { content: 'Would you like to share a favourite song?' } }] });
    throw new Error('Unexpected fixture path');
  };
}
test('Worker dependency graph contains no Node, filesystem or subprocess imports', async () => {
  for (const path of ['../worker/handler.mjs', '../lib/qloo-rest.mjs']) {
    const code = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.equal(/(?:from\s*|import\s*\()\s*['"](?:node:|fs|child_process|path)/.test(code), false);
    assert.equal(/\b(?:process|Buffer|require)\s*[.(]/.test(code), false);
  }
});
test('signed resolution survives another isolate and contains IDs without names or queries', async () => {
  let clock = 1_800_000_000_000;
  const token = await signSelection(['CULTURE-ENTITY-001'], env, { now: () => clock });
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'ids', 'v']);
  assert.deepEqual(await verifySelection(token, env, { now: () => clock }), ['CULTURE-ENTITY-001']);
  await assert.rejects(() => verifySelection(token + 'x', env, { now: () => clock }), error => error.code === 'SELECTION_EXPIRED');
  await assert.rejects(() => verifySelection(token, { ...env, SELECTION_SIGNING_KEY: 'a-different-fixture-signing-key-minimum-32bytes' }, { now: () => clock }), error => error.code === 'SELECTION_EXPIRED');
  clock += 901_000; await assert.rejects(() => verifySelection(token, env, { now: () => clock }), error => error.code === 'SELECTION_EXPIRED');
});
test('Worker status is explicit about configuration and per-isolate limits', async () => {
  const worker = createWorkerHandler({ fetchImpl: () => assert.fail('status must not call provider') });
  const missing = await (await worker.fetch(req('/api/status'), {})).json();
  assert.equal(missing.providers.qloo.configured, false); assert.equal(missing.providers.nebius.configured, false);
  const configured = await (await worker.fetch(req('/api/status'), env)).json();
  assert.equal(configured.providers.qloo.configured, true); assert.equal(configured.providers.qloo.mode, 'configured_not_verified');
  assert.equal(configured.requestLimits.scope, 'per_isolate_limits_only'); assert.equal(configured.requestLimits.billingCap, false);
  assert.equal(JSON.stringify(configured).includes(env.QLOO_API_KEY), false); assert.equal(JSON.stringify(configured).includes(env.SELECTION_SIGNING_KEY), false);
});
test('Worker cultural flow preserves confirmation across isolates and uses verified REST contracts', async () => {
  const calls = []; const first = createWorkerHandler({ fetchImpl: fakeApi(calls) });
  const resolve = await first.fetch(req('/api/qloo/resolve', { concepts: ['The Beatles'] }), env); assert.equal(resolve.status, 200);
  const data = await resolve.json(); assert.equal(data.needsConfirmation, true); assert.equal(data.groups[0].candidates[0].type, 'urn:entity:artist');
  assert.equal(calls[0].url.origin, 'https://hackathon.api.qloo.com'); assert.equal(calls[0].url.pathname, '/search');
  assert.equal(calls[0].url.searchParams.get('query'), 'The Beatles'); assert.equal(calls[0].url.searchParams.get('take'), '6');
  assert.equal(calls[0].options.headers['X-Api-Key'], env.QLOO_API_KEY); assert.equal(calls[0].url.href.includes(env.QLOO_API_KEY), false); assert.equal(calls[0].options.redirect, 'error');
  const second = createWorkerHandler({ fetchImpl: fakeApi(calls) });
  const planInput = { resolutionId: data.resolutionId, entities: [{ id: 'CULTURE-ENTITY-001', name: 'UNTRUSTED CLIENT NAME' }], confirmed: true, goal: 'conversation' };
  const result = await second.fetch(req('/api/qloo/plan', planInput), env); const plan = await result.json();
  assert.equal(result.status, 200); assert.equal(plan.recommendations[0].name, 'Across the Universe'); assert.equal(plan.providerStatus, 'ok'); assert.equal(plan.humanApprovalRequired, true);
  assert.deepEqual(plan.selectedEntities, [{ id: 'CULTURE-ENTITY-001' }]); assert.equal(JSON.stringify(plan).includes('UNTRUSTED CLIENT NAME'), false);
  const query = calls[1].url.searchParams;
  assert.equal(calls[1].url.pathname, '/v2/insights'); assert.equal(query.get('filter.type'), 'urn:entity:movie'); assert.equal(query.get('signal.interests.entities'), 'CULTURE-ENTITY-001'); assert.equal(query.get('take'), '5'); assert.equal(query.get('feature.explainability'), 'true'); assert.equal(query.has('signal.demographics.gender'), false);
});
test('Worker rejects missing confirmation, unissued IDs and tampered tokens before recommendation', async () => {
  const calls = []; const worker = createWorkerHandler({ fetchImpl: fakeApi(calls) }); const data = await (await worker.fetch(req('/api/qloo/resolve', { concepts: ['Public film'] }), env)).json();
  const input = { resolutionId: data.resolutionId, entities: [{ id: 'CULTURE-ENTITY-001' }], goal: 'conversation' };
  assert.equal((await worker.fetch(req('/api/qloo/plan', input), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/qloo/plan', { ...input, confirmed: true, entities: [{ id: 'unissued-id' }] }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/qloo/plan', { ...input, confirmed: true, resolutionId: data.resolutionId + 'x' }), env)).status, 409);
  assert.equal(calls.length, 1);
});
test('Worker privacy, origin, body-size and signing-key guards run before provider calls', async () => {
  const worker = createWorkerHandler({ fetchImpl: () => assert.fail('must not call provider') });
  assert.equal((await worker.fetch(req('/api/qloo/resolve', { concepts: ['private@example.com'] }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/qloo/resolve', { concepts: ['Public film'] }), { ...env, SELECTION_SIGNING_KEY: '' })).status, 503);
  assert.equal((await worker.fetch(req('/api/qloo/resolve', { concepts: ['Public film'] }, { Origin: 'https://attacker.example' }), env)).status, 403);
  assert.equal((await worker.fetch(req('/api/coach', { message: 'x'.repeat(14000), goal: 'introduction' }), env)).status, 413);
  assert.equal((await worker.fetch(req('/api/coach', { message: 'A fictional introduction.', goal: 'introduction' }), {})).status, 503);
});
test('Worker empty Qloo response cannot become a fabricated plan', async () => {
  const worker = createWorkerHandler({ fetchImpl: async input => new URL(input).pathname === '/search' ? Response.json({ results: [entity] }) : Response.json({ results: { entities: [] } }) });
  const data = await (await worker.fetch(req('/api/qloo/resolve', { concepts: ['Public film'] }), env)).json();
  const output = await (await worker.fetch(req('/api/qloo/plan', { resolutionId: data.resolutionId, entities: [{ id: entity.entity_id }], confirmed: true, goal: 'conversation' }), env)).json();
  assert.equal(output.providerStatus, 'empty'); assert.deepEqual(output.conversationStarters, []); assert.match(output.message, /invented/);
});
test('Worker provider failures and redirects cannot leak credentials', async () => {
  const adapter = new QlooRestAdapter({ env, fetchImpl: async () => new Response(env.QLOO_API_KEY, { status: 401 }) });
  await assert.rejects(() => adapter.search('Public film'), error => error.code === 'QLOO_AUTH' && !error.message.includes(env.QLOO_API_KEY));
  const invalid = new QlooRestAdapter({ env: { ...env, QLOO_BASE_URL: 'https://attacker.example' }, fetchImpl: () => assert.fail('must not send key') });
  await assert.rejects(() => invalid.search('Public film'), error => error.code === 'QLOO_NOT_CONFIGURED');
});
test('Worker request limits and external limiter fail closed', async () => {
  const worker = createWorkerHandler({ fetchImpl: fakeApi() });
  assert.equal((await worker.fetch(req('/api/qloo/resolve', { concepts: ['Public film'] }), { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal((await worker.fetch(req('/api/qloo/resolve', { concepts: ['Public film', 'Another public film'] }), { ...env, QLOO_DAILY_LIMIT: '1' })).status, 429);
});
test('Worker Nebius adapter keeps key server-side and labels the actual configured model', async () => {
  const calls = []; const worker = createWorkerHandler({ fetchImpl: fakeApi(calls), now: () => 1_800_000_000_000 });
  const output = await worker.fetch(req('/api/coach', { message: 'A fictional person wants to decline an invitation kindly.', goal: 'boundary' }), env); const data = await output.json();
  assert.equal(output.status, 200); assert.equal(data.inference.model, env.NEBIUS_MODEL); assert.equal(data.humanApprovalRequired, true);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${env.NEBIUS_API_KEY}`); assert.equal(JSON.stringify(data).includes(env.NEBIUS_API_KEY), false);
  assert.equal(JSON.parse(calls[0].options.body).max_tokens, 350);
});
test('portable providers preserve the global receiver and work without AbortSignal.timeout', async () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
  try {
    let requests = 0;
    async function receiverSensitiveFetch(url, options) {
      assert.equal(this, globalThis, 'Workers native fetch must receive the global receiver');
      assert.ok(options.signal instanceof AbortSignal); requests += 1;
      return new URL(url).pathname === '/search' ? Response.json({ results: [entity] }) : Response.json({ choices: [{ message: { content: 'A respectful fictional draft.' } }] });
    }
    const qloo = new QlooRestAdapter({ env, fetchImpl: receiverSensitiveFetch });
    assert.equal((await qloo.search('Public film')).length, 1);
    assert.equal((await nebiusDraft(env, 'A fictional introduction.', 'introduction', receiverSensitiveFetch)).draft, 'A respectful fictional draft.');
    assert.equal(requests, 2);
  } finally { Object.defineProperty(AbortSignal, 'timeout', original); }
});
test('opt-in diagnostics retain only sanitized names and messages', () => {
  const logs = []; const logger = { warn: (...args) => logs.push(args) };
  const error = { name: 'TypeError', message: `Illegal invocation ${env.QLOO_API_KEY} ${env.NEBIUS_API_KEY} ${env.SELECTION_SIGNING_KEY} https://provider.example/path?key=hidden Bearer hidden-token` };
  providerDiagnostic(error, env, logger); assert.equal(logs.length, 0);
  providerDiagnostic(error, { ...env, PROVIDER_DIAGNOSTICS: '1' }, logger);
  assert.equal(logs.length, 1); assert.deepEqual(Object.keys(logs[0][1]).sort(), ['message', 'name']);
  const output = JSON.stringify(logs);
  for (const value of [env.QLOO_API_KEY, env.NEBIUS_API_KEY, env.SELECTION_SIGNING_KEY, 'key=hidden', 'hidden-token']) assert.equal(output.includes(value), false);
  assert.match(output, /Illegal invocation/);
});
test('portable connection failures do not masquerade as timeouts or expose provider errors', async () => {
  const qloo = new QlooRestAdapter({ env, fetchImpl: async () => { throw new TypeError(`Illegal invocation ${env.QLOO_API_KEY}`); } });
  await assert.rejects(() => qloo.search('Public film'), error => error.status === 502 && error.code === 'QLOO_CONNECT' && !error.message.includes('Illegal invocation') && !error.message.includes(env.QLOO_API_KEY));
});
