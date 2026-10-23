// POST /api/store/part  (signed in)  { keys:[up to 25 bucket keys] }  -> { b:{ <key>: {recs} } }   (?gz=1 gzips)
import { getSessionUser } from '../../_lib/session.js';
import { errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { loadPartRaw, maybeGzip } from '../../_lib/store.js';

export async function onRequestPost({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  let b; try { b = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const raw = await loadPartRaw(APP_DATA, b && b.keys);
  return maybeGzip(request, raw, { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' });
}
