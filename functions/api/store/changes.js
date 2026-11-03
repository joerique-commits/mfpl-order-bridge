// GET /api/store/changes?since=<ISO>  (signed in) -> { now, b:{ <bucket key>: { t, u } changed after since }, dataId }
// Polled by open pages every 2 minutes (and when a hidden tab comes back) so they fetch only the buckets that changed.
// dataId = the ERP data upload now published, so a page can say "new data — refresh".
import { getSessionUser } from '../../_lib/session.js';
import { errorJson, bearerToken } from '../../_lib/http.js';
import { readStamps } from '../../_lib/store.js';
import { getJSON } from '../../_lib/kv.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const since = new URL(request.url).searchParams.get('since') || '';
  const [st, meta] = await Promise.all([readStamps(APP_DATA), getJSON(ERP_MIRROR, 'obdata_meta').catch(() => null)]);
  const b = {};
  Object.keys(st).forEach(k => { const x = st[k]; if (x && x.t && (!since || x.t > since)) b[k] = x; });
  const body = JSON.stringify({ now: new Date().toISOString(), b, dataId: (meta && meta.id) || null });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
}
