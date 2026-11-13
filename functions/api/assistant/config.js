// GET  /api/assistant/config  (admin) -> providers (key last 4 only), models, order, today's use, resting models, last 100 questions
// POST /api/assistant/config  (admin)
//   { action:'save', provider, key?, url?, models?:[..], on? }   key '' leaves the saved key unchanged
//   { action:'remove', provider } | { action:'test', provider } | { action:'order', order:[...] }
//   { action:'limits', perUser, perDay } | { action:'clearRest' } | { action:'clearLog' }
import { requireRole } from '../../_lib/session.js';
import { putJSON } from '../../_lib/kv.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { PROVIDERS, loadCfg, saveCfg, status, testProvider } from '../../_lib/asst-ai.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  return json(await status(true));
}
export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let b; try { b = await request.json(); } catch (e) { return errorJson('Request body must be valid JSON', 400); }
  const p = b && b.provider;
  if (['save', 'remove', 'test'].includes(b && b.action) && !PROVIDERS[p]) return errorJson('Unknown provider', 400);
  const cfg = await loadCfg();
  if (b.action === 'save') {
    const P = cfg.providers[p]; const key = String(b.key || '').trim();
    if (key) { if (key.length < 16 || /\s/.test(key)) return errorJson("That doesn't look like an API key", 400); P.key = key; P.setBy = auth.user.email; P.setAt = new Date().toISOString(); }
    if (typeof b.url === 'string' && PROVIDERS[p].needsUrl) { const u = b.url.trim(); if (u && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/.test(u)) return errorJson('The service address must start with https://', 400); P.url = u; }
    if (Array.isArray(b.models)) { const m = b.models.map(x => String(x).trim()).filter(x => /^[@A-Za-z0-9._\/:-]{2,80}$/.test(x)); P.models = m.length ? m : PROVIDERS[p].models.slice(); }
    if (typeof b.on === 'boolean') P.on = b.on;
    await saveCfg(cfg);
    if (key) await putJSON(AUTH, 'asst_cool', {});
  } else if (b.action === 'remove') { delete cfg.providers[p].key; await saveCfg(cfg);
  } else if (b.action === 'test') { return json(await testProvider(p));
  } else if (b.action === 'order') { const o = (Array.isArray(b.order) ? b.order : []).filter(x => PROVIDERS[x]); if (o.length) { cfg.order = o; await saveCfg(cfg); }
  } else if (b.action === 'limits') { const u = Math.round(Number(b.perUser)), d = Math.round(Number(b.perDay)); if (!(u > 0 && u <= 1000 && d > 0 && d <= 20000)) return errorJson('Limits must be whole numbers above zero', 400); cfg.perUser = u; cfg.perDay = d; await saveCfg(cfg);
  } else if (b.action === 'clearRest') { await putJSON(AUTH, 'asst_cool', {});
  } else if (b.action === 'clearLog') { await putJSON(AUTH, 'asst_log', []);
  } else return errorJson('Unknown action', 400);
  return json(await status(true));
}
