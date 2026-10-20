// GET /api/data/chunk?id=<uploadId>&n=<index>  (signed in) -> raw JSON text chunk
// Chunks never change for a given upload id, so the browser may cache them.
import { getSessionUser } from '../../_lib/session.js';
import { errorJson, bearerToken } from '../../_lib/http.js';
import { maybeGzip } from '../../_lib/store.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '', n = url.searchParams.get('n') || '';
  if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !/^\d{1,4}$/.test(n)) return errorJson('Bad id or n', 400);
  const text = await ERP_MIRROR.get(`obdata_c_${id}_${n}`, { type: 'text' });
  if (text === null || text === undefined) return errorJson('Chunk not found', 404);
  return maybeGzip(request, text, { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': 'private, max-age=31536000, immutable' });
}
