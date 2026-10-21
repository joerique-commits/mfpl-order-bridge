// GET /api/exports  (admin) -> { meta: { slots: { <slot>: { id, chunks, bytes, file, type, label, rows, oldest, newest, uploadedAt, uploadedBy } } } }
// The latest copy of each ERP export (raw .xlsx, chunked) that the "Daily exports" card in Admin Uploads
// rebuilds the data file from. KV (ERP_MIRROR): exp_meta, exp_c_<id>_<n>.
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { getJSON } from '../../_lib/kv.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  return json({ meta: (await getJSON(ERP_MIRROR, 'exp_meta')) || { slots: {} } });
}
