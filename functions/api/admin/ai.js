// GET  /api/admin/ai  (admin) -> status: providers (key last 4 only), models, today's use, resting models, recent calls
// POST /api/admin/ai  (admin)
//   { action:'save', provider, key?, models?:[..], on? }   key '' leaves the saved key unchanged
//   { action:'remove', provider }                           forget the key
//   { action:'test', provider }                             tiny text request to each model
//   { action:'order', order:[...] }                         which provider is tried first
//   { action:'clearRest' }                                  stop resting all models now
// Keys are kept in the AUTH namespace and never sent back to the page.
import { requireRole } from '../../_lib/session.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { PROVIDERS, loadCfg, saveCfg, status, testProvider } from '../../_lib/ai-reader.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  return json(await status());
}

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let b; try { b = await request.json(); } catch (e) { return errorJson('Request body must be valid JSON', 400); }
  const p = b && b.provider;
  if (['save', 'remove', 'test'].includes(b && b.action) && !PROVIDERS[p]) return errorJson('Unknown provider', 400);
  const cfg = await loadCfg();
  if (b.action === 'save') {
    const P = cfg.providers[p];
    const key = String(b.key || '').trim();
    if (key) { if (key.length < 16 || /\s/.test(key)) return errorJson("That doesn't look like an API key", 400); P.key = key; P.setBy = auth.user.email; P.setAt = new Date().toISOString(); }
    if (Array.isArray(b.models)) { const m = b.models.map(x => String(x).trim()).filter(x => /^[A-Za-z0-9._\/:-]{2,80}$/.test(x)); P.models = m.length ? m : PROVIDERS[p].models.slice(); }
    if (typeof b.on === 'boolean') P.on = b.on;
    await saveCfg(cfg);
    // a new key gets a fresh start
    if (key) { const cool = (await getJSON(AUTH, 'ai_cool')) || {}; Object.keys(cool).forEach(k => { if (k.startsWith(p + '|')) delete cool[k]; }); await putJSON(AUTH, 'ai_cool', cool); }
  } else if (b.action === 'remove') {
    delete cfg.providers[p].key; await saveCfg(cfg);
  } else if (b.action === 'test') {
    return json(await testProvider(p));
  } else if (b.action === 'order') {
    const o = (Array.isArray(b.order) ? b.order : []).filter(x => PROVIDERS[x]);
    if (o.length) { cfg.order = o; await saveCfg(cfg); }
  } else if (b.action === 'clearRest') {
    await putJSON(AUTH, 'ai_cool', {});
  } else return errorJson('Unknown action', 400);
  return json(await status());
}
