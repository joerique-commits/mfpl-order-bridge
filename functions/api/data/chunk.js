// GET /api/data/chunk?id=<uploadId>&n=<index>  (signed in) -> raw JSON text chunk
// Chunks never change for a given upload id, so the browser may cache them.
import { getSessionUser } from '../../_lib/session.js';
import { errorJson, bearerToken } from '../../_lib/http.js';
import { gunzipSync } from '../../_lib/fflate.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '', n = url.searchParams.get('n') || '';
  if (!/^[A-Za-z0-9]{1,40}$/.test(id) || !/^\d{1,4}$/.test(n)) return errorJson('Bad id or n', 400);
  // Uploads since 21 Oct are stored gzipped by the admin's browser (obdata_z_*): served as-is, no server CPU.
  const z = await ERP_MIRROR.get(`obdata_z_${id}_${n}`, { type: 'arrayBuffer' });
  if (z) {
    const headers = { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': 'private, max-age=31536000, immutable' };
    if (url.searchParams.get('gz') === '1') return new Response(z, { status: 200, headers: Object.assign(headers, { 'content-encoding': 'gzip', 'x-ob-gz': 'stored' }) });
    return new Response(new TextDecoder().decode(gunzipSync(new Uint8Array(z))), { status: 200, headers });
  }
  // Older uploads are plain text; gzipping 500 KB on the fly costs about a second here, so they go out plain.
  const text = await ERP_MIRROR.get(`obdata_c_${id}_${n}`, { type: 'text' });
  if (text === null || text === undefined) return errorJson('Chunk not found', 404);
  return new Response(text, { status: 200, headers: { 'content-type': 'text/plain; charset=UTF-8', 'cache-control': 'private, max-age=31536000, immutable' } });
}
