import test from 'node:test';
import assert from 'node:assert/strict';
import { QlooAdapter, NebiusAdapter, compactEntity } from '../lib/providers.mjs';

test('entity normalisation limits outputs to cultural entities', () => {
  assert.equal(compactEntity({ entity_id: 'entity-001', name: 'Private person', type: 'urn:entity:person' }), null);
  assert.deepEqual(compactEntity({ entity_id: 'entity-001', name: 'Public film', types: ['urn:entity:movie'] }), { id: 'entity-001', name: 'Public film', type: 'urn:entity:movie', description: '' });
});
test('Qloo insights generic entity wire shape uses an explicitly cultural subtype', () => {
  const wire = { entity_id: 'MOVIE-WIRE-001', name: 'Across the Universe', type: 'urn:entity', subtype: 'urn:entity:movie', popularity: 0.5, affinity: 0.4, explainability: {}, properties: { description: 'A public musical film.' } };
  assert.deepEqual(compactEntity(wire), { id: 'MOVIE-WIRE-001', name: 'Across the Universe', type: 'urn:entity:movie', description: 'A public musical film.' });
  assert.equal(compactEntity({ ...wire, subtype: 'urn:entity:person' }), null);
  assert.equal(compactEntity({ ...wire, subtype: undefined }), null);
  assert.equal(compactEntity({ ...wire, type: 'urn:entity:person' }), null);
});
test('Qloo uses the official CLI with event key in environment, never arguments', async () => {
  const key = 'test-key-not-a-real-credential'; const calls = [];
  const adapter = new QlooAdapter({ env: { QLOO_API_KEY: key, QLOO_BASE_URL: 'https://hackathon.api.qloo.com' }, run: async (args, options) => { calls.push({ args, options }); return { code: 0, stdout: JSON.stringify({ results: { entities: [{ entity_id: 'entity-001', name: 'Public film', type: 'urn:entity:movie' }] } }) }; } });
  assert.equal((await adapter.search('Public film')).length, 1);
  assert.deepEqual(calls[0].args.slice(1), ['api', 'search', '--query', 'Public film', '--take', '6', '--json']);
  assert.equal(calls[0].args.some(x => x.includes(key)), false);
  assert.equal(calls[0].options.env.QLOO_API_KEY, key); assert.equal(calls[0].options.env.QLOO_BASE_URL, 'https://hackathon.api.qloo.com');
  assert.equal(calls[0].options.env.QLOO_TRUSTED_BASE_URL, 'https://hackathon.api.qloo.com');
  assert.match(calls[0].options.env.QLOO_HOME, /realove-connection-lab[\\/]\.qloo$/);
  assert.equal(JSON.stringify(adapter.status()).includes(key), false);
});
test('Qloo rejects unapproved endpoints without sending a credential', async () => {
  const adapter = new QlooAdapter({ env: { QLOO_API_KEY: 'fake-key', QLOO_BASE_URL: 'https://attacker.example' }, run: () => assert.fail('must not spawn') });
  await assert.rejects(() => adapter.search('Public film'), error => error.code === 'QLOO_CONFIG');
});
test('Qloo recommendation uses confirmed IDs and safe aggregate workflow', async () => {
  let request;
  const adapter = new QlooAdapter({ env: { QLOO_API_KEY: 'fake-key' }, run: async args => { request = JSON.parse(args.at(-1)); return { code: 0, stdout: JSON.stringify({ status: 'ok', results: [{ entity_id: 'entity-002', name: 'A book', type: 'urn:entity:book' }] }) }; } });
  const result = await adapter.recommend([{ id: 'entity-001' }], 'activity');
  assert.deepEqual(request, { target_type: 'book', signals: ['entity-001'], limit: 5, explain: true });
  assert.equal(result.recommendations.length, 1); assert.equal(request.demographic, undefined);
});
test('Qloo auth failures never reflect raw provider errors', async () => {
  const adapter = new QlooAdapter({ env: { QLOO_API_KEY: 'fake-secret' }, run: async () => ({ code: 4, stdout: JSON.stringify({ status: 'error', error: { code: 'QLOO_AUTH', recovery: 'fake-secret' } }) }) });
  await assert.rejects(() => adapter.search('Public film'), error => error.code === 'QLOO_AUTH' && !error.message.includes('fake-secret'));
});
test('Qloo distinguishes a genuinely empty response from an unsupported result schema', async () => {
  const empty = new QlooAdapter({ env: { QLOO_API_KEY: 'fake-key' }, run: async () => ({ code: 0, stdout: JSON.stringify({ status: 'ok', result_count: 0, results: [] }) }) });
  assert.equal((await empty.recommend([{ id: 'entity-001' }], 'conversation')).providerStatus, 'empty');
  const unsupported = new QlooAdapter({ env: { QLOO_API_KEY: 'fake-key' }, run: async () => ({ code: 0, stdout: JSON.stringify({ status: 'ok', result_count: 1, results: [{ name: 'Unsupported entity', type: 'unrecognised' }] }) }) });
  await assert.rejects(() => unsupported.recommend([{ id: 'entity-001' }], 'conversation'), error => error.code === 'QLOO_RESULT_CONTRACT');
});
test('Nebius uses configured NVIDIA model, bounded output and server-side bearer', async () => {
  let sent;
  const adapter = new NebiusAdapter({ env: { NEBIUS_API_KEY: 'fake-secret', NEBIUS_MODEL: 'nvidia/test-model' }, fetchImpl: async (url, options) => { sent = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'A respectful fictional draft.' } }] }) }; } });
  const result = await adapter.coach('A fictional person wants to set a boundary.', 'boundary');
  const body = JSON.parse(sent.options.body); assert.equal(sent.url.href, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.equal(sent.options.headers.Authorization, 'Bearer fake-secret'); assert.equal(body.model, 'nvidia/test-model'); assert.equal(body.max_tokens, 350);
  assert.equal(JSON.stringify(body).includes('fake-secret'), false); assert.equal(result.inference.provider, 'nebius');
});
test('Nebius rejects wrong model or endpoint before making a request', async () => {
  for (const env of [{ NEBIUS_API_KEY: 'fake-key', NEBIUS_MODEL: 'unverified/generic-model' }, { NEBIUS_API_KEY: 'fake-key', NEBIUS_MODEL: 'nvidia/test-model', NEBIUS_BASE_URL: 'https://attacker.example/v1' }]) {
    const adapter = new NebiusAdapter({ env, fetchImpl: () => assert.fail('must not call provider') });
    await assert.rejects(() => adapter.coach('A fictional introduction.', 'introduction'));
  }
});
test('Nebius provider failures and reflected credentials are suppressed', async () => {
  const env = { NEBIUS_API_KEY: 'fake-secret', NEBIUS_MODEL: 'nvidia/test-model' };
  const failed = new NebiusAdapter({ env, fetchImpl: async () => ({ ok: false, status: 401, text: () => assert.fail('must not read provider error body') }) });
  await assert.rejects(() => failed.coach('A fictional introduction.', 'introduction'), error => error.code === 'NEBIUS_AUTH' && !error.message.includes('fake-secret'));
  const reflected = new NebiusAdapter({ env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'fake-secret' } }] }) }) });
  await assert.rejects(() => reflected.coach('A fictional introduction.', 'introduction'), error => error.code === 'NEBIUS_RESPONSE');
});
