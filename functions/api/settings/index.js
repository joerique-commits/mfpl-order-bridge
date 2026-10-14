// GET  /api/settings?key={key}         -> { setting }   (any signed-in user)
// POST /api/settings  { key, value }   -> { setting }   (admin only)
import { requireRole } from '../../_lib/session.js';
import { getSetting, setSetting } from '../../_lib/settings.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return errorJson('key is required', 400);

  const setting = await getSetting(env.APP_DATA, key);
  if (!setting) return errorJson(`Unknown setting '${key}'`, 404);
  return json({ setting });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { key, value } = body || {};
  if (!key || value === undefined) return errorJson('key and value are required', 400);

  const setting = await setSetting(env.APP_DATA, key, value, auth.user);
  return json({ setting });
}
