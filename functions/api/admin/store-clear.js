// POST /api/admin/store-clear  (admin only)  { keys:[bucket keys, up to 40], dropActIndex:true|false }
// Deletes whole shared-store buckets — used once for the go-live clean-up of test-week entries (2 Nov 2026).
// The page names the buckets itself (no KV list(), which can stall on EdgeOne). Accounts and settings kept by the
// page are simply not named. dropActIndex also forgets activity pieces in idx_act that were deleted.
import { requireRole } from '../../_lib/session.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let b; try { b = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const keys = (Array.isArray(b && b.keys) ? b.keys : []).filter(k => typeof k === 'string');
  if (!keys.length || keys.length > 40) return errorJson('Send 1 to 40 bucket keys', 400);
  if (keys.some(k => !/^b_ob_[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(k))) return errorJson('Unexpected key', 400);
  await Promise.all(keys.map(k => APP_DATA.delete(k)));
  if (b.dropActIndex){
    const cur = (await getJSON(APP_DATA, 'idx_act')) || [];
    const gone = new Set(keys); const next = cur.filter(k => !gone.has(k));
    if (next.length !== cur.length) await putJSON(APP_DATA, 'idx_act', next);
  }
  return json({ ok:true, deleted:keys.length, by:auth.user.email });
}
