// GET  /api/store   (signed in) -> { b:{ <bucketKey>: {recs} }, u:{ <store>: {v} }, linkKey, user }
// POST /api/store   (signed in) { changes:[{s,bk,k,v,ver,c}], user:[{s,v}] } -> { ok:[...], conflicts:[...] }
// See functions/_lib/store.js. Bare KV globals (APP_DATA), never env.APP_DATA.
import { getSessionUser } from '../../_lib/session.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { loadAllRaw, applyChanges, userKey, getLinkKey, STORE_RE, maybeGzip, logDeleted, logHistory, histLabel } from '../../_lib/store.js';
import { putJSON } from '../../_lib/kv.js';

export async function onRequestGet({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  const [raw, linkKey] = await Promise.all([loadAllRaw(APP_DATA, s.user.uid), getLinkKey(APP_DATA)]);
  const body = raw.slice(0, -1) + ',"linkKey":' + JSON.stringify(linkKey) + ',"serverTime":' + JSON.stringify(new Date().toISOString()) + '}';
  return maybeGzip(request, body, { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' });
}

export async function onRequestPost({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  let body;
  try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const changes = Array.isArray(body && body.changes) ? body.changes : [];
  const user = Array.isArray(body && body.user) ? body.user : [];
  const held = Array.isArray(body && body.held) ? body.held.slice(0, 2000) : [];
  // 25 Nov 2026: pages opened before the 24 Nov fix still run the old loader, which can save an outdated copy over newer
  // work (it removed 40 PO requests on 24–25 Nov). Pages from 24 Nov on always send "held"; older ones are refused and
  // asked to reload. Nothing they hold is lost that the server doesn't already have.
  const refused = async why => { try { await logHistory(APP_DATA, { at: new Date().toISOString(), by: s.user.name || s.user.email, uid: String(s.user.uid),
    recs: changes.filter(ch => ch && STORE_RE.test(ch.s || '') && ch.s !== 'ob_activity' && ch.s !== 'ob_act_parts').slice(0, 300).map(ch => Object.assign({ s: ch.s, bk: String(ch.bk || ''), k: String(ch.k || ''), op: 'refused', why, d: ch.v == null ? { _: ['(record)', '(removed)'] } : { _: [null, ch.v] } }, histLabel(ch.s, String(ch.k || ''), ch.v))) }); } catch (e) {} };
  if (!Array.isArray(body && body.held)) { await refused('page out of date'); return json({ error: 'Order Bridge has been updated. Reload this page to keep working — this copy is out of date and can’t save.', outdated: true }, 409); }
  // Never more than 5 removals from one store in one save (the activity log excepted): a page working from an outdated
  // copy must not be able to wipe other people's records. The removals are logged for the admin and nothing is saved.
  const dels = {}; changes.forEach(ch => { if (ch && (ch.v === null || ch.v === undefined) && ch.s !== 'ob_activity') dels[ch.s] = (dels[ch.s] || 0) + 1; });
  const tooMany = Object.entries(dels).filter(([st, n]) => n > 5);
  if (tooMany.length) {
    try { await logDeleted(APP_DATA, { at: new Date().toISOString(), by: s.user.name || s.user.email, uid: String(s.user.uid), held: true, refused: true,
      recs: changes.filter(ch => ch && (ch.v === null || ch.v === undefined) && tooMany.some(([st]) => st === ch.s)).map(ch => ({ s: ch.s, bk: String(ch.bk || ''), k: String(ch.k || ''), v: null })) }); } catch (e) {}
    await refused('too many removals in one save');
    return json({ error: 'This save would remove ' + tooMany.map(([st, n]) => n + ' records from ' + st.replace(/^ob_/, '').replace(/_/g, ' ')).join(', ') + '. Nothing was saved. Reload the page; if this keeps happening, tell an admin.', refusedRemovals: true }, 409);
  }
  try {
    if (held.length) {   // removals the page refused to send (see the loader's safety stop): log them for the admin
      try { await logDeleted(APP_DATA, { at: new Date().toISOString(), by: s.user.name || s.user.email, uid: String(s.user.uid), held: true,
        recs: held.filter(h => h && STORE_RE.test(h.s || '')).map(h => ({ s: h.s, bk: String(h.bk || ''), k: String(h.k || ''), v: h.v === undefined ? null : h.v })) }); } catch (e) {}
    }
    const res = await applyChanges(APP_DATA, changes, s.user.name || s.user.email, String(s.user.uid).replace(/[^A-Za-z0-9_]/g, '_'));
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
