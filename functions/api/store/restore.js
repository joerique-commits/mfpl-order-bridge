// POST /api/store/restore  (admin only) { buckets: { "b_<store>__<bucket>": { recs:{...} }, ... }, replace: false }
// Writes the shared-store buckets from an Admin Uploads backup file (file.store.b) back into APP_DATA.
// replace:true also deletes buckets that are not in the backup. No screen calls this; it is for recovery.
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { listKeys } from '../../_lib/store.js';

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const buckets = (body && body.buckets) || {};
  const keys = Object.keys(buckets);
  if (!keys.length) return errorJson('No buckets in the request', 400);
  if (keys.some(k => !/^b_ob_[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(k))) return errorJson('Unexpected key in backup', 400);
  for (const k of keys) await APP_DATA.put(k, JSON.stringify(buckets[k]));
  let removed = 0;
  if (body.replace) {
    const want = new Set(keys);
    for (const k of await listKeys(APP_DATA, 'b_')) if (!want.has(k)) { await APP_DATA.delete(k); removed++; }
  }
  return json({ ok: true, written: keys.length, removed });
}
