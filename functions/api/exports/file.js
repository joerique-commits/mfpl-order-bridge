// GET /api/exports/file?id=<fileId>&n=<index>  (admin) -> raw bytes of one stored piece
import { requireRole } from '../../_lib/session.js';
import { errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '', n = url.searchParams.get('n') || '';
  if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !/^\d{1,4}$/.test(n)) return errorJson('Bad id or n', 400);
  const buf = await ERP_MIRROR.get(`exp_c_${id}_${n}`, { type: 'arrayBuffer' });
  if (!buf) return errorJson('Piece not found', 404);
  return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } });
}
