import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, QlooAdapter, NebiusAdapter } from './providers.mjs';

const LIMITS = ['Qloo reports aggregate cultural affinities, not individual compatibility or predicted behaviour.', 'Suggestions are conversation prompts, not evidence that two people will form a relationship.', 'No message is sent and no introduction is made. Each person decides what to do.'];
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const BAD_PERSONAL = /@|https?:|www\.|(?:\+?\d[\s().-]*){9,}|\b(?:password|api[_ -]?key|bearer)\s*[:=]/i;
function safeText(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new AppError(400, 'INVALID_INPUT', `${name} must contain ${min} to ${max} characters.`);
  if (BAD_PERSONAL.test(value)) throw new AppError(400, 'PERSONAL_DATA', 'Use a fictional example or public cultural title, without contact details, URLs or credentials.');
  return value.trim();
}
async function readJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new AppError(415, 'CONTENT_TYPE', 'Send application/json.');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 12_000) throw new AppError(413, 'BODY_TOO_LARGE', 'This demo accepts short fictional examples only.'); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; } catch { throw new AppError(400, 'INVALID_JSON', 'Send one valid JSON object.'); }
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function requireProvider(provider, name) { if (!provider.configured) throw new AppError(503, `${name.toUpperCase()}_NOT_CONFIGURED`, `${name} live access is not configured. No live output has been generated.`); }

export function createApplication({ env = process.env, providers = { qloo: new QlooAdapter({ env }), nebius: new NebiusAdapter({ env }) }, publicDir = fileURLToPath(new URL('../public/', import.meta.url)), now = Date.now } = {}) {
  const resolutions = new Map(); const rates = new Map(); const daily = new Map();
  const hourlyMax = Math.max(1, Math.min(100, Number(env.RATE_LIMIT_PER_HOUR) || 30));
  const providerMax = { qloo: Math.max(1, Math.min(500, Number(env.QLOO_DAILY_LIMIT) || 120)), nebius: Math.max(1, Math.min(200, Number(env.COACH_DAILY_LIMIT) || 60)) };
  function consume(name, cost) {
    const day = new Date(now()).toISOString().slice(0, 10); const row = daily.get(name);
    const used = row?.day === day ? row.used : 0;
    if (used + cost > providerMax[name]) throw new AppError(429, 'DEMO_BUDGET', 'The daily demo request allowance has been reached. Try another day.');
    daily.set(name, { day, used: used + cost });
  }
  function rate(req) {
    const address = env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    const hour = Math.floor(now() / 3_600_000); const key = `${address}:${hour}`;
    for (const [k, row] of rates) if (row.hour < hour) rates.delete(k);
    if (rates.size > 5000) throw new AppError(503, 'DEMO_BUSY', 'The demo is busy. Try later.', true);
    const row = rates.get(key) || { hour, count: 0 }; row.count += 1; rates.set(key, row);
    if (row.count > hourlyMax) throw new AppError(429, 'RATE_LIMIT', 'Please wait before trying more demo requests.', true);
  }
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost'); const path = url.pathname;
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, { app: 'Realove Connection Lab', experimental: true, providers: { qloo: providers.qloo.status(), nebius: providers.nebius.status() }, limits: LIMITS, privacy: 'No database, account, chat history or production user data is connected. Request counters and temporary cultural selections are stored in process memory.' });
      if (path.startsWith('/api/')) {
        if (req.method !== 'POST') throw new AppError(405, 'METHOD', 'Use POST for this operation.');
        if (req.headers.origin) { let origin; try { origin = new URL(req.headers.origin); } catch { throw new AppError(403, 'ORIGIN', 'This request origin is not allowed.'); } if (origin.host !== req.headers.host) throw new AppError(403, 'ORIGIN', 'This request origin is not allowed.'); }
        rate(req); const data = await readJson(req);
        if (path === '/api/qloo/resolve') {
          if (!Array.isArray(data.concepts) || data.concepts.length < 1 || data.concepts.length > 3) throw new AppError(400, 'INVALID_INPUT', 'Choose one to three public cultural titles or artists.');
          const concepts = data.concepts.map(x => safeText(x, 'Cultural concept', 2, 80));
          requireProvider(providers.qloo, 'Qloo'); consume('qloo', concepts.length);
          const groups = [];
          for (const query of concepts) groups.push({ query, candidates: await providers.qloo.search(query) });
          for (const [key, row] of resolutions) if (row.expires <= now()) resolutions.delete(key);
          if (resolutions.size >= 500) resolutions.delete(resolutions.keys().next().value);
          const resolutionId = randomBytes(24).toString('hex');
          resolutions.set(resolutionId, { groups, expires: now() + 900_000 });
          return json(res, 200, { resolutionId, groups, needsConfirmation: true, source: 'Qloo API', limits: LIMITS });
        }
        if (path === '/api/qloo/plan') {
          if (data.confirmed !== true) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Confirm the resolved cultural entities first.');
          const resolution = typeof data.resolutionId === 'string' ? resolutions.get(data.resolutionId) : null;
          if (!resolution || resolution.expires <= now()) throw new AppError(409, 'SELECTION_EXPIRED', 'Resolve your cultural choices again before making a plan.');
          if (!['conversation', 'activity'].includes(data.goal) || !Array.isArray(data.entities) || data.entities.length < 1 || data.entities.length > 3) throw new AppError(400, 'INVALID_INPUT', 'Choose confirmed cultural entities and a conversation or activity goal.');
          const seen = new Set(); const entities = data.entities.map(x => { const candidate = resolution.groups.flatMap(g => g.candidates).find(c => c.id === x?.id); if (!candidate || seen.has(candidate.id)) throw new AppError(400, 'INVALID_SELECTION', 'Select distinct entities returned by the Qloo search.'); seen.add(candidate.id); return candidate; });
          requireProvider(providers.qloo, 'Qloo'); consume('qloo', 1);
          const result = await providers.qloo.recommend(entities, data.goal);
          const recommendations = result.recommendations;
          const conversationStarters = recommendations.slice(0, 3).map(x => `Would you be interested in exploring ${x.name} together? What about it appeals to you?`);
          return json(res, 200, { recommendations, conversationStarters, selectedEntities: entities, source: 'Qloo API', providerStatus: recommendations.length ? result.providerStatus : 'empty', message: recommendations.length ? 'Cultural suggestions received from Qloo. Review them before choosing a conversation prompt.' : 'Qloo returned no supported cultural suggestions for these choices. No plan or conversation prompts were invented. Try different public cultural entities.', provenance: { operation: 'recommend', endpoint: result.endpoint, retrievedAt: new Date(now()).toISOString(), interpretation: 'Conversation prompts are deterministic product suggestions based on the returned cultural entities, not Qloo claims about individuals.' }, limits: LIMITS, humanApprovalRequired: true });
        }
        if (path === '/api/coach') {
          const message = safeText(data.message, 'Fictional scenario', 5, 1200);
          if (!['introduction', 'boundary', 'deescalation'].includes(data.goal)) throw new AppError(400, 'INVALID_INPUT', 'Choose introduction, boundary or deescalation.');
          requireProvider(providers.nebius, 'Nebius'); consume('nebius', 1);
          const result = await providers.nebius.coach(message, data.goal);
          return json(res, 200, { ...result, humanApprovalRequired: true, limits: ['Experimental fictional rehearsal, not professional counselling.', 'Review every suggestion. Nothing is sent or performed automatically.'] });
        }
        throw new AppError(404, 'NOT_FOUND', 'This operation does not exist.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, 'METHOD', 'Use GET for this page.');
      let decoded; try { decoded = decodeURIComponent(path); } catch { throw new AppError(400, 'INVALID_PATH', 'Invalid page path.'); }
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new AppError(404, 'NOT_FOUND', 'Page not found.');
      const file = resolve(publicDir, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!file.startsWith(resolve(publicDir) + sep)) throw new AppError(404, 'NOT_FOUND', 'Page not found.');
      const type = CONTENT_TYPES[extname(file)]; if (!type) throw new AppError(404, 'NOT_FOUND', 'Page not found.');
      let content; try { content = await readFile(file); } catch { throw new AppError(404, 'NOT_FOUND', 'Page not found.'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); return res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof AppError) return json(res, error.status, { error: { code: error.code, message: error.message, retryable: error.retryable } });
      return json(res, 500, { error: { code: 'INTERNAL', message: 'The demo could not complete this operation.', retryable: false } });
    }
  };
  return http.createServer(handler);
}
