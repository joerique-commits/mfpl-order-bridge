// GET /api/data/meta  (signed in) -> { meta } | { meta:null }
// The page's business data (window.__MFPL_REAL_DATA__, ~9 MB JSON from
// build/build_from_folder.py) lives in ERP_MIRROR as text chunks:
//   obdata_meta            -> { id, chunks, bytes, builtAt, uploadedAt, uploadedBy, prevId }
//   obdata_c_<id>_<n>      -> chunk n of the JSON text
//   obdata_pub_<id>        -> { <so>: { so, customer, date } }  (for the public site-details form)
import { getSessionUser } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { getJSON } from '../../_lib/kv.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const meta = await getJSON(ERP_MIRROR, 'obdata_meta');
  return new Response(JSON.stringify({ meta }), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
}
