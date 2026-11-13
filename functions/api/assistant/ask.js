// POST /api/assistant/ask  { sys, prompt, json?:bool, q?, did? }  -> { ok, text, provider, model } | { ok:false, code, error }
// GET  /api/assistant/ask  -> { ready, perUser, perDay, usedToday }   (is any AI key set)
// Signed-in users whose team has the Assistant switched on (User Permissions › Menu visibility); admins always.
// The page masks names, amounts and phone numbers before it calls this; see assistant.js.
import { requireRole } from '../../_lib/session.js';
import { getJSON } from '../../_lib/kv.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { ask, status } from '../../_lib/asst-ai.js';

const TEAMS = ['admin', 'sales', 'supply', 'production', 'accounts'];
async function allowed(user) {
  if (user.role === 'admin') return true;
  const b = await getJSON(APP_DATA, 'b_ob_permissions__v');
  const v = b && b.recs && b.recs._ && b.recs._.v;
  return !!(v && v.visibility && v.visibility.assistant && v.visibility.assistant[user.role] === true);
}
export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), TEAMS);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  return json(await status(false));
}
export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), TEAMS);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  if (!(await allowed(auth.user))) return errorJson('The Assistant is not switched on for your team', 403);
  let b; try { b = await request.json(); } catch (e) { return errorJson('Request body must be valid JSON', 400); }
  const sys = String((b && b.sys) || ''), prompt = String((b && b.prompt) || '');
  if (!prompt.trim() || prompt.length > 24000 || sys.length > 8000) return errorJson('Question missing or too long', 400);
  const r = await ask({ sys, user: prompt, wantJson: !!b.json, who: auth.user, log: b.q ? { q: b.q, did: b.did } : null });
  return json(r, 200);
}
