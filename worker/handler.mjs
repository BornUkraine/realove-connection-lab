import { ServiceError, QlooRestAdapter, ENTITY_ID, boundedJson, nebiusDraft } from '../lib/qloo-rest.mjs';

const LIMITS = ['Qloo reports aggregate cultural affinities, not individual compatibility or predicted behaviour.', 'Suggestions are conversation prompts, not evidence that two people will form a relationship.', 'No message is sent and no introduction is made. Each person decides what to do.'];
const BAD_PERSONAL = /@|https?:|www\.|(?:\+?\d[\s().-]*){9,}|\b(?:password|api[_ -]?key|bearer)\s*[:=]/i;
const encoder = new TextEncoder();
function inputText(value, field, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ServiceError(400, 'INVALID_INPUT', `${field} must contain ${min} to ${max} characters.`);
  if (BAD_PERSONAL.test(value)) throw new ServiceError(400, 'PERSONAL_DATA', 'Use a fictional example or public cultural title, without contact details, URLs or credentials.');
  return value.trim();
}
function encode64(bytes) { let data = ''; for (const byte of bytes) data += String.fromCharCode(byte); return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function decode64(value) { if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid token encoding'); const data = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); return Uint8Array.from(data, x => x.charCodeAt(0)); }
function signingSecret(env) { if (typeof env.SELECTION_SIGNING_KEY !== 'string' || encoder.encode(env.SELECTION_SIGNING_KEY).length < 32) throw new ServiceError(503, 'SELECTION_NOT_CONFIGURED', 'The demo confirmation key is not configured. No provider request was made.'); return env.SELECTION_SIGNING_KEY; }
async function signingKey(secret, cryptoImpl) { return cryptoImpl.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function signSelection(ids, env, { now = Date.now, cryptoImpl = crypto } = {}) {
  const secret = signingSecret(env);
  const payload = { v: 1, aud: 'realove-connection-lab', exp: Math.floor(now() / 1000) + 900, ids: [...new Set(ids)] };
  const data = encode64(encoder.encode(JSON.stringify(payload)));
  const signature = await cryptoImpl.subtle.sign('HMAC', await signingKey(secret, cryptoImpl), encoder.encode(data));
  return `${data}.${encode64(new Uint8Array(signature))}`;
}
export async function verifySelection(token, env, { now = Date.now, cryptoImpl = crypto } = {}) {
  const secret = signingSecret(env);
  try {
    if (typeof token !== 'string' || token.length > 6000) throw new Error();
    const parts = token.split('.'); if (parts.length !== 2) throw new Error();
    if (!(await cryptoImpl.subtle.verify('HMAC', await signingKey(secret, cryptoImpl), decode64(parts[1]), encoder.encode(parts[0])))) throw new Error();
    const payload = JSON.parse(new TextDecoder().decode(decode64(parts[0]))); const seconds = Math.floor(now() / 1000);
    if (payload.v !== 1 || payload.aud !== 'realove-connection-lab' || !Number.isInteger(payload.exp) || payload.exp <= seconds || payload.exp > seconds + 900 || !Array.isArray(payload.ids) || payload.ids.length > 9 || payload.ids.some(id => typeof id !== 'string' || !ENTITY_ID.test(id))) throw new Error();
    return payload.ids;
  } catch { throw new ServiceError(409, 'SELECTION_EXPIRED', 'Resolve your cultural choices again before making a plan.'); }
}
async function readInput(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new ServiceError(415, 'CONTENT_TYPE', 'Send application/json.');
  try {
    const data = await boundedJson(request, 12_000);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data;
  } catch (error) {
    if (error.code === 'PROVIDER_RESPONSE_SIZE') throw new ServiceError(413, 'BODY_TOO_LARGE', 'This demo accepts short fictional examples only.');
    throw new ServiceError(400, 'INVALID_JSON', 'Send one valid JSON object.');
  }
}
function response(status, value) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } }); }

export function createWorkerHandler({ fetchImpl = fetch, now = Date.now, cryptoImpl = crypto } = {}) {
  const rates = new Map(); const daily = new Map();
  async function rate(request, env) {
    const hour = Math.floor(now() / 3_600_000);
    const address = request.headers.get('cf-connecting-ip') || 'unknown-client';
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', encoder.encode(address)));
    const key = `${encode64(digest)}:${hour}`;
    if (env.RATE_LIMITER?.limit) {
      const result = await env.RATE_LIMITER.limit({ key }); if (!result.success) throw new ServiceError(429, 'RATE_LIMIT', 'Please wait before trying more demo requests.', true);
    }
    for (const [old, row] of rates) if (row.hour < hour) rates.delete(old);
    if (rates.size > 5000) throw new ServiceError(503, 'DEMO_BUSY', 'The demo is busy. Try later.', true);
    const row = rates.get(key) || { hour, count: 0 }; row.count += 1; rates.set(key, row);
    const maximum = Math.max(1, Math.min(100, Number(env.RATE_LIMIT_PER_HOUR) || 30));
    if (row.count > maximum) throw new ServiceError(429, 'RATE_LIMIT', 'Please wait before trying more demo requests.', true);
  }
  async function consume(provider, cost, env) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (env.DEMO_BUDGET?.consume) { const allowed = await env.DEMO_BUDGET.consume({ provider, cost, day }); if (!allowed) throw new ServiceError(429, 'DEMO_BUDGET', 'The daily demo request allowance has been reached.'); }
    const row = daily.get(provider); const used = row?.day === day ? row.used : 0;
    const maximum = Math.max(1, Math.min(provider === 'qloo' ? 500 : 200, Number(provider === 'qloo' ? env.QLOO_DAILY_LIMIT : env.COACH_DAILY_LIMIT) || (provider === 'qloo' ? 120 : 60)));
    if (used + cost > maximum) throw new ServiceError(429, 'DEMO_BUDGET', 'The daily demo request allowance has been reached.');
    daily.set(provider, { day, used: used + cost });
  }
  return {
    async fetch(request, env = {}, ctx) {
      try {
        const url = new URL(request.url); const path = url.pathname;
        if (path === '/healthz' && request.method === 'GET') return response(200, { ok: true });
        const qloo = new QlooRestAdapter({ env, fetchImpl, now });
        if (path === '/api/status' && request.method === 'GET') {
          const qlooState = qloo.status(); const confirmationReady = typeof env.SELECTION_SIGNING_KEY === 'string' && encoder.encode(env.SELECTION_SIGNING_KEY).length >= 32;
          return response(200, { app: 'Realove Connection Lab', experimental: true, providers: { qloo: { ...qlooState, configured: qlooState.configured && confirmationReady, mode: qlooState.configured && confirmationReady ? 'configured_not_verified' : 'unconfigured', selectionSigningConfigured: confirmationReady }, nebius: { configured: Boolean(env.NEBIUS_API_KEY?.trim() && env.NEBIUS_MODEL?.trim()), mode: env.NEBIUS_API_KEY?.trim() && env.NEBIUS_MODEL?.trim() ? 'configured_not_verified' : 'unconfigured', model: env.NEBIUS_MODEL || null, modelLicenseVerified: false } }, limits: LIMITS, privacy: 'No production database, profiles or messages are connected. Cultural confirmation tokens contain only entity IDs and expiry metadata.', requestLimits: { scope: env.RATE_LIMITER?.limit ? 'external_rate_binding_plus_isolate_limits' : 'per_isolate_limits_only', billingCap: false } });
        }
        if (!path.startsWith('/api/')) throw new ServiceError(404, 'NOT_FOUND', 'This adapter serves API routes only.');
        if (request.method !== 'POST') throw new ServiceError(405, 'METHOD', 'Use POST for this operation.');
        const givenOrigin = request.headers.get('origin');
        if (givenOrigin) { let origin; try { origin = new URL(givenOrigin).origin; } catch { throw new ServiceError(403, 'ORIGIN', 'This request origin is not allowed.'); } if (origin !== url.origin) throw new ServiceError(403, 'ORIGIN', 'This request origin is not allowed.'); }
        await rate(request, env); const data = await readInput(request);
        if (path === '/api/qloo/resolve') {
          if (!Array.isArray(data.concepts) || data.concepts.length < 1 || data.concepts.length > 3) throw new ServiceError(400, 'INVALID_INPUT', 'Choose one to three public cultural titles or artists.');
          const concepts = data.concepts.map(x => inputText(x, 'Cultural concept', 2, 80));
          signingSecret(env);
          if (!qloo.configured) throw new ServiceError(503, 'QLOO_NOT_CONFIGURED', 'Qloo live access is not configured. No live result has been generated.');
          await consume('qloo', concepts.length, env); const groups = [];
          for (const query of concepts) groups.push({ query, candidates: await qloo.search(query) });
          const resolutionId = await signSelection(groups.flatMap(x => x.candidates.map(c => c.id)), env, { now, cryptoImpl });
          return response(200, { resolutionId, groups, needsConfirmation: true, source: 'Qloo API', limits: LIMITS });
        }
        if (path === '/api/qloo/plan') {
          if (data.confirmed !== true) throw new ServiceError(400, 'CONFIRMATION_REQUIRED', 'Confirm the resolved cultural entities first.');
          if (!['conversation', 'activity'].includes(data.goal) || !Array.isArray(data.entities) || data.entities.length < 1 || data.entities.length > 3) throw new ServiceError(400, 'INVALID_INPUT', 'Choose confirmed cultural entities and a conversation or activity goal.');
          const issued = await verifySelection(data.resolutionId, env, { now, cryptoImpl });
          const ids = data.entities.map(x => x?.id);
          if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !issued.includes(id))) throw new ServiceError(400, 'INVALID_SELECTION', 'Select distinct entities returned by the Qloo search.');
          if (!qloo.configured) throw new ServiceError(503, 'QLOO_NOT_CONFIGURED', 'Qloo live access is not configured. No live result has been generated.');
          await consume('qloo', 1, env); const result = await qloo.recommend(ids, data.goal);
          const recommendations = result.recommendations; const conversationStarters = recommendations.slice(0, 3).map(x => `Would you be interested in exploring ${x.name} together? What about it appeals to you?`);
          return response(200, { recommendations, conversationStarters, selectedEntities: ids.map(id => ({ id })), source: 'Qloo API', providerStatus: result.providerStatus, message: recommendations.length ? 'Cultural suggestions received from Qloo. Review them before choosing a conversation prompt.' : 'Qloo returned no supported cultural suggestions. No plan or conversation prompts were invented.', provenance: { operation: 'recommend', endpoint: '/v2/insights', retrievedAt: new Date(now()).toISOString(), interpretation: 'Conversation prompts are product-written suggestions, not Qloo claims about individuals.' }, limits: LIMITS, humanApprovalRequired: true });
        }
        if (path === '/api/coach') {
          const message = inputText(data.message, 'Fictional scenario', 5, 1200);
          if (!['introduction', 'boundary', 'deescalation'].includes(data.goal)) throw new ServiceError(400, 'INVALID_INPUT', 'Choose introduction, boundary or deescalation.');
          if (!env.NEBIUS_API_KEY?.trim() || !env.NEBIUS_MODEL?.trim()) throw new ServiceError(503, 'NEBIUS_NOT_CONFIGURED', 'Nebius access and an eligible model are not configured. No AI inference has been generated.');
          await consume('nebius', 1, env); const result = await nebiusDraft(env, message, data.goal, fetchImpl, now);
          return response(200, { ...result, humanApprovalRequired: true, limits: ['Experimental fictional rehearsal, not professional counselling.', 'Review every suggestion. Nothing is sent or performed automatically.'] });
        }
        throw new ServiceError(404, 'NOT_FOUND', 'This operation does not exist.');
      } catch (error) {
        if (error instanceof ServiceError) return response(error.status, { error: { code: error.code, message: error.message, retryable: error.retryable } });
        return response(500, { error: { code: 'INTERNAL', message: 'The demo could not complete this operation.', retryable: false } });
      }
    }
  };
}

const handler = createWorkerHandler();
export default handler;
