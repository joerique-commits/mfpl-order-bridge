// GET  /api/admin/backup-key  (admin) -> { exists, createdAt, createdBy, lastUsedAt }   (never the key itself)
// POST /api/admin/backup-key  (admin) { action:'new' }    -> { key, ... }  shown once; replaces any old key
//                                      { action:'remove' } -> stops the scheduled backup from working
import { requireRole } from '../../_lib/session.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const info = c => ({ exists: !!(c && c.key), createdAt: c && c.createdAt || null, createdBy: c && c.createdBy || null, lastUsedAt: c && c.lastUsedAt || null });

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  return json(info(await getJSON(AUTH, 'cfg_backup_key')));
}

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let b; try { b = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  if (b && b.action === 'remove') { await AUTH.delete('cfg_backup_key'); return json(info(null)); }
  if (!b || b.action !== 'new') return errorJson('Unknown action', 400);
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  const key = 'obk_' + Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
  const c = { key, createdAt: new Date().toISOString(), createdBy: auth.user.email, lastUsedAt: null };
  await putJSON(AUTH, 'cfg_backup_key', c);
  return json(Object.assign(info(c), { key }));
}
