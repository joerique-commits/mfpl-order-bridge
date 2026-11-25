// Records removed from the shared stores (24 Nov 2026), admin only.
// GET  /api/store/deleted?days=14            -> { entries:[ {key, day, at, by, n, held, stores} ] }   newest first
// GET  /api/store/deleted?key=del_…           -> the whole entry, with each removed record's last value
// POST /api/store/deleted { key, s, k }       -> puts one removed record back, if nothing has taken its place
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { DEL_IDX, bucketKey, noteStamps, STORE_RE, BUCKET_RE, logHistory, histLabel } from '../../_lib/store.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url), key = url.searchParams.get('key');
  if (key) {
    if (!/^del_\d{8}_[a-z0-9]+$/.test(key)) return errorJson('Bad key', 400);
    const e = await getJSON(APP_DATA, key);
    return e ? json({ key, ...e }) : errorJson('Not found', 404);
  }
  const days = Math.min(120, Math.max(1, +url.searchParams.get('days') || 14));
  const cut = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const idx = ((await getJSON(APP_DATA, DEL_IDX)) || []).filter(x => x && x.day >= cut).sort((a, b) => (a.at < b.at ? 1 : -1));
  return json({ entries: idx });
}

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const { key, s, k } = body || {};
  if (!/^del_\d{8}_[a-z0-9]+$/.test(key || '') || !STORE_RE.test(s || '') || !k) return errorJson('key, s and k are required', 400);
  const e = await getJSON(APP_DATA, key);
  if (!e) return errorJson('Not found', 404);
  const rec = (e.recs || []).find(r => r.s === s && r.k === k);
  if (!rec || rec.v == null) return errorJson('That record has no saved value to put back', 404);
  if (!BUCKET_RE.test(rec.bk || '')) return errorJson('Bad bucket', 400);
  const bkey = bucketKey(s, rec.bk), doc = (await getJSON(APP_DATA, bkey)) || { recs: {} };
  doc.recs = doc.recs || {};
  if (doc.recs[k]) return errorJson('A record with this key exists again — nothing was changed', 409);
  const now = new Date().toISOString(), who = auth.user.name || auth.user.email;
  doc.recs[k] = { v: rec.v, ver: (rec.ver || 0) + 1, c: rec.c || Date.now(), by: 'Restored by ' + who, at: now };
  await putJSON(APP_DATA, bkey, doc);
  try { await noteStamps(APP_DATA, [bkey], String(auth.user.uid)); } catch (err) {}
  try { await logHistory(APP_DATA, { at: now, by: who, uid: String(auth.user.uid), recs: [Object.assign({ s, bk: rec.bk, k, op: 'restore', ver: doc.recs[k].ver, d: { _: [null, rec.v] }, why: 'put back from the removal log' }, histLabel(s, k, rec.v))] }); } catch (er) {}
  (e.restored = e.restored || []).push({ s, k, by: who, at: now });
  await putJSON(APP_DATA, key, e);
  return json({ ok: true });
}
