// GET  /api/store   (signed in) -> { b:{ <bucketKey>: {recs} }, u:{ <store>: {v} }, linkKey, user }
// POST /api/store   (signed in) { changes:[{s,bk,k,v,ver,c}], user:[{s,v}] } -> { ok:[...], conflicts:[...] }
// See functions/_lib/store.js. Bare KV globals (APP_DATA), never env.APP_DATA.
import { getSessionUser } from '../../_lib/session.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { loadAllRaw, applyChanges, userKey, getLinkKey, STORE_RE } from '../../_lib/store.js';
import { putJSON } from '../../_lib/kv.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const raw = await loadAllRaw(APP_DATA, s.user.uid);
  const linkKey = await getLinkKey(APP_DATA);
  const body = raw.slice(0, -1) + ',"linkKey":' + JSON.stringify(linkKey) + ',"serverTime":' + JSON.stringify(new Date().toISOString()) + '}';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
}

export async function onRequestPost({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  let body;
  try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const changes = Array.isArray(body && body.changes) ? body.changes : [];
  const user = Array.isArray(body && body.user) ? body.user : [];
  try {
    const res = await applyChanges(APP_DATA, changes, s.user.name || s.user.email);
    for (const u of user) {
      if (!u || !STORE_RE.test(u.s || '')) continue;
      if (u.v === null || u.v === undefined) await APP_DATA.delete(userKey(s.user.uid, u.s));
      else await putJSON(APP_DATA, userKey(s.user.uid, u.s), { v: u.v, at: new Date().toISOString() });
    }
    return json(res);
  } catch (e) {
    return errorJson(e.message, 400);
  }
}
