// GET /api/store/keys  (signed in) -> { keys:[bucket keys], u:{ <store>: {v} }, linkKey, serverTime }
// First half of the split store load; the page then fetches the buckets with POST /api/store/part.
import { getSessionUser } from '../../_lib/session.js';
import { errorJson, bearerToken } from '../../_lib/http.js';
import { loadIndexRaw, getLinkKey } from '../../_lib/store.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const [idx, linkKey] = await Promise.all([loadIndexRaw(APP_DATA, s.user.uid), getLinkKey(APP_DATA)]);
  const body = '{"keys":' + JSON.stringify(idx.keys) + ',"u":' + idx.uRaw + ',"linkKey":' + JSON.stringify(linkKey) + ',"serverTime":' + JSON.stringify(new Date().toISOString()) + '}';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
}
