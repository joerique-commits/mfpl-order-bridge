// POST /api/exports/upload?id=<fileId>&n=<index>  (admin) body: raw bytes of piece n of one .xlsx export
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '', n = url.searchParams.get('n') || '';
  if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !/^\d{1,4}$/.test(n)) return errorJson('Bad id or n', 400);
  const buf = await request.arrayBuffer();
  if (!buf || !buf.byteLength) return errorJson('Empty piece', 400);
  await ERP_MIRROR.put(`exp_c_${id}_${n}`, buf);
  return json({ ok: true, n: Number(n), bytes: buf.byteLength });
}
