// GET /api/admin/kv-check  (admin) — 23 Oct: times one read (and one small write) on each KV namespace and
// returns the exact error EdgeOne gives, to tell a storage problem from a code problem.
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

async function timed(fn, ms) {
  const t0 = Date.now(); let t;
  try {
    const v = await Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('no answer within ' + ms + ' ms')), ms); })]);
    return { ok: true, ms: Date.now() - t0, value: v == null ? null : String(v).slice(0, 40) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e && (e.message || e)) || e).slice(0, 300), name: e && e.name }; }
  finally { clearTimeout(t); }
}
export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const which = new URL(request.url).searchParams.get('ns') || 'all';
  const out = {};
  const ns = { AUTH: typeof AUTH !== 'undefined' ? AUTH : null, APP_DATA: typeof APP_DATA !== 'undefined' ? APP_DATA : null, ERP_MIRROR: typeof ERP_MIRROR !== 'undefined' ? ERP_MIRROR : null };
  for (const [name, kv] of Object.entries(ns)) {
    if (which !== 'all' && which !== name) continue;
    if (!kv) { out[name] = 'not bound'; continue; }
    out[name] = {
      get: await timed(() => kv.get('cfg_linkkey', { type: 'text' }), 5000),
      put: await timed(() => kv.put('diag_ping', new Date().toISOString()), 5000),
      list: await timed(async () => { const p = await kv.list({ prefix: 'diag_', limit: 5 }); return (p.keys || []).length + ' keys'; }, 5000),
    };
  }
  return json(out);
}
