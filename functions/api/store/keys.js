// GET /api/store/keys  (signed in) -> { keys:[bucket keys] | null, act:[activity keys], u:{ <store>: {v} }, linkKey, serverTime }
// keys is null when KV list() stalls or ?nolist=1 (23 Oct: list() hung for hours while get() worked); the page then asks for every bucket name it knows, plus act.
// First half of the split store load; the page then fetches the buckets with POST /api/store/part.
import { getSessionUser } from '../../_lib/session.js';
import { errorJson, bearerToken } from '../../_lib/http.js';
import { loadIndexRaw, getLinkKey } from '../../_lib/store.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const [idx, linkKey] = await Promise.all([loadIndexRaw(APP_DATA, s.user.uid, new URL(request.url).searchParams.get('nolist') === '1'), getLinkKey(APP_DATA)]);
  const body = '{"keys":' + JSON.stringify(idx.keys) + ',"act":' + JSON.stringify(idx.act) + ',"u":' + idx.uRaw + ',"uid":' + JSON.stringify(String(s.user.uid).replace(/[^A-Za-z0-9_]/g, '_')) + ',"linkKey":' + JSON.stringify(linkKey) + ',"serverTime":' + JSON.stringify(new Date().toISOString()) + '}';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
}
