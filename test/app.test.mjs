import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../lib/app.mjs';

const movie = { id: 'entity-movie-001', name: 'A fictional public film', type: 'urn:entity:movie', description: 'Contract fixture, not a live Qloo result.' };
function fixtures() {
  return { qloo: { configured: true, status: () => ({ configured: true, mode: 'test_fixture' }), search: async () => [movie], recommend: async () => ({ recommendations: [{ ...movie, id: 'entity-movie-002', name: 'Another public film' }], providerStatus: 'ok', endpoint: '/v2/insights' }) }, nebius: { configured: true, status: () => ({ configured: true, mode: 'test_fixture', model: 'nvidia/test-fixture' }), coach: async () => ({ draft: 'Would you like to talk about a shared interest?', inference: { provider: 'nebius', model: 'nvidia/test-fixture', at: '2026-10-30T00:00:00Z' } }) } };
}
async function start(t, options = {}) {
  const app = createApplication({ providers: fixtures(), env: {}, ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { base, request: (path, data, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }) };
}

test('status without event credentials is explicit and contains no secret', async t => {
  const { base } = await start(t, { providers: undefined, env: {} });
  const res = await fetch(base + '/api/status'); const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.providers.qloo.configured, false); assert.equal(data.providers.nebius.configured, false);
  assert.equal(data.experimental, true); assert.match(data.privacy, /No database/);
});
test('missing keys return 503, without fabricated AI or Qloo output', async t => {
  const { request } = await start(t, { providers: undefined, env: {} });
  const response = await request('/api/coach', { message: 'A fictional person wants to introduce themselves politely.', goal: 'introduction' });
  assert.equal(response.status, 503); const data = await response.json(); assert.equal(data.draft, undefined); assert.equal(data.error.code, 'NEBIUS_NOT_CONFIGURED');
  assert.equal((await request('/api/qloo/resolve', { concepts: ['A public film'] })).status, 503);
});
test('Qloo resolution requires explicit selection confirmation and server-issued entities', async t => {
  const { request } = await start(t);
  const resolution = await (await request('/api/qloo/resolve', { concepts: ['A public film'] })).json();
  assert.equal(resolution.needsConfirmation, true); assert.equal(resolution.groups[0].candidates[0].id, movie.id);
  const input = { resolutionId: resolution.resolutionId, entities: [{ id: movie.id, name: 'CLIENT MAY NOT RENAME THE ENTITY' }], goal: 'conversation' };
  assert.equal((await request('/api/qloo/plan', input)).status, 400);
  const response = await request('/api/qloo/plan', { ...input, confirmed: true }); const plan = await response.json();
  assert.equal(response.status, 200); assert.equal(plan.selectedEntities[0].name, movie.name); assert.equal(plan.humanApprovalRequired, true);
  assert.equal(plan.recommendations.length, 1); assert.match(plan.limits[0], /aggregate/); assert.equal(plan.provenance.operation, 'recommend');
  assert.equal((await request('/api/qloo/plan', { ...input, confirmed: true, entities: [{ id: 'unissued-entity' }] })).status, 400);
});
test('expired cultural selections cannot be reused', async t => {
  let clock = Date.now(); const { request } = await start(t, { now: () => clock });
  const data = await (await request('/api/qloo/resolve', { concepts: ['A public film'] })).json(); clock += 901_000;
  assert.equal((await request('/api/qloo/plan', { resolutionId: data.resolutionId, confirmed: true, entities: [movie], goal: 'activity' })).status, 409);
});
test('contact details, credentials and large requests are rejected before providers run', async t => {
  const providers = fixtures(); providers.qloo.search = () => { assert.fail('provider must not run'); };
  providers.nebius.coach = () => { assert.fail('provider must not run'); };
  const { request } = await start(t, { providers });
  assert.equal((await request('/api/qloo/resolve', { concepts: ['person@example.com'] })).status, 400);
  assert.equal((await request('/api/coach', { message: 'Phone +380730000000', goal: 'introduction' })).status, 400);
  assert.equal((await request('/api/coach', { message: 'api_key=should-not-share', goal: 'introduction' })).status, 400);
  assert.equal((await request('/api/coach', { message: 'x'.repeat(1201), goal: 'introduction' })).status, 400);
  assert.equal((await request('/api/coach', { message: 'x'.repeat(14000), goal: 'introduction' })).status, 413);
});
test('cross-origin requests and incorrect content types are rejected', async t => {
  const { base, request } = await start(t);
  assert.equal((await request('/api/qloo/resolve', { concepts: ['A public film'] }, { Origin: 'https://unrelated.example' })).status, 403);
  const response = await fetch(base + '/api/coach', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(response.status, 415); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
test('only public static assets can be read', async t => {
  const { base } = await start(t);
  assert.equal((await fetch(base + '/')).status, 200);
  for (const path of ['/.env', '/package.json', '/server.mjs', '/node_modules/@qloo/qloo-harness/package.json', '/%2e%2e/%2e%2e/.env']) assert.equal((await fetch(base + path)).status, 404);
});
test('rate and daily operation allowances stop additional provider operations', async t => {
  const { request } = await start(t, { env: { RATE_LIMIT_PER_HOUR: '2' } });
  assert.equal((await request('/api/qloo/resolve', { concepts: ['A public film'] })).status, 200);
  assert.equal((await request('/api/qloo/resolve', { concepts: ['Another public film'] })).status, 200);
  assert.equal((await request('/api/qloo/resolve', { concepts: ['A third film'] })).status, 429);
  const limited = await start(t, { env: { QLOO_DAILY_LIMIT: '1' } });
  assert.equal((await limited.request('/api/qloo/resolve', { concepts: ['A public film', 'Another public film'] })).status, 429);
});
test('unknown exceptions are hidden rather than reflecting sensitive strings', async t => {
  const providers = fixtures(); providers.qloo.search = async () => { throw new Error('private-provider-key-do-not-reflect'); };
  const { request } = await start(t, { providers }); const response = await request('/api/qloo/resolve', { concepts: ['A public film'] });
  const output = await response.text(); assert.equal(response.status, 500); assert.equal(output.includes('private-provider-key'), false);
});
test('coach returns provider attribution and requires human choice', async t => {
  const { request } = await start(t); const response = await request('/api/coach', { message: 'A fictional person would like to decline a date kindly.', goal: 'boundary' });
  const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.inference.provider, 'nebius'); assert.equal(data.humanApprovalRequired, true);
});
test('an empty provider recommendation does not invent a useful plan', async t => {
  const providers = fixtures(); providers.qloo.recommend = async () => ({ recommendations: [], providerStatus: 'ok', endpoint: '/v2/insights' });
  const { request } = await start(t, { providers }); const resolution = await (await request('/api/qloo/resolve', { concepts: ['A public film'] })).json();
  const response = await request('/api/qloo/plan', { resolutionId: resolution.resolutionId, entities: [movie], confirmed: true, goal: 'conversation' });
  const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.providerStatus, 'empty'); assert.deepEqual(data.conversationStarters, []); assert.match(data.message, /No plan.*invented/);
});
