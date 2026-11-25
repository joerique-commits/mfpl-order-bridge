// Admin › History (25 Nov 2026): the server's own record of every change to the shared stores. Admin only.
// GET  /api/history?from=YYYYMMDD&to=YYYYMMDD     -> { lines:[…] } newest first (at most 31 days per call)
// GET  /api/history?e=hist_…                       -> one save in full
// GET  /api/history?s=<store>&k=<record key>&days=90  -> { cur, steps:[…] } the record's timeline, oldest first
// POST /api/history { s, k, e }                    -> put the record back to how it was right after save e
//                                                    (refused if it has changed since the timeline was read: send curVer)
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { getJSON } from '../../_lib/kv.js';
import { applyChanges, bucketKey, STORE_RE, BUCKET_RE, HIST_KEEP_DAYS } from '../../_lib/store.js';

const DAY_RE = /^\d{8}$/, E_RE = /^hist_\d{8}_[a-z0-9]+$/;
const dayStr = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const daysBack = n => Array.from({ length: n }, (_, i) => dayStr(new Date(Date.now() - i * 864e5)));
async function admin(request) { const a = await requireRole(AUTH, bearerToken(request), ['admin']); return a; }

async function timeline(s, k, days) {
  const ds = daysBack(Math.min(HIST_KEEP_DAYS, Math.max(1, days || HIST_KEEP_DAYS)));
  const idx = await Promise.all(ds.map(d => getJSON(APP_DATA, 'hidx_' + d).catch(() => null)));
  const lines = []; idx.forEach((L, i) => (L || []).forEach(l => { if (l.s === s && l.k === k) lines.push(Object.assign({ day: ds[i] }, l)); }));
  const keys = [...new Set(lines.map(l => l.e))];
  const entries = await Promise.all(keys.map(e => getJSON(APP_DATA, e).catch(() => null)));
  const steps = [];
  entries.forEach((en, i) => { if (!en) return; (en.recs || []).forEach(r => { if (r.s === s && r.k === k) steps.push({ e: keys[i], at: en.at, by: en.by, op: r.op, ver: r.ver, bk: r.bk, d: r.d, v: r.v, why: r.why, lb: r.lb, id: r.id, so: r.so }); }); });
  steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return steps;
}
// undo the steps after `after` (newest first) to get the record as it was right after that step
function rebuild(cur, later) {
  let v = cur === undefined ? undefined : JSON.parse(JSON.stringify(cur));
  for (const st of later.slice().reverse()) {
    if (st.op === 'refused') continue;
    if (st.op === 'remove') { v = JSON.parse(JSON.stringify(st.v)); continue; }
    if (!st.d) continue;
    if (st.d._) { v = st.d._[0] == null ? undefined : JSON.parse(JSON.stringify(st.d._[0])); continue; }
    if (st.op === 'add') { v = undefined; continue; }
    v = v && typeof v === 'object' ? v : {};
    for (const [f, x] of Object.entries(st.d)) {
      if (Array.isArray(x)) { if (x[0] === null) delete v[f]; else v[f] = JSON.parse(JSON.stringify(x[0])); }
      else if (x && x.app) v[f] = Array.isArray(v[f]) ? v[f].slice(0, x.n) : [];
    }
  }
  return v;
}

export async function onRequestGet({ request }) {
  const a = await admin(request); if (!a.ok) return errorJson(a.error, a.status);
  const u = new URL(request.url), q = k => u.searchParams.get(k);
  if (q('stats')) {   // for Admin › Usage › Data size: lines over the keep period and an estimate of the stored size
    const idx = await Promise.all(daysBack(HIST_KEEP_DAYS).map(d => getJSON(APP_DATA, 'hidx_' + d).catch(() => null)));
    let lines = 0, chars = 0, days = 0; idx.forEach(L => { if (!L) return; days++; lines += L.length; chars += JSON.stringify(L).length; });
    return json({ days, lines, bytes: Math.round(chars + lines * 900) });
  }
  if (q('e')) { if (!E_RE.test(q('e'))) return errorJson('Bad key', 400); const en = await getJSON(APP_DATA, q('e')); return en ? json(en) : errorJson('Not found', 404); }
  if (q('s') && q('k')) {
    const s = q('s'), k = q('k'); if (!STORE_RE.test(s) || k.length > 300) return errorJson('Bad record', 400);
    const steps = await timeline(s, k, +q('days') || HIST_KEEP_DAYS);
    const bk = (steps.find(x => x.bk) || {}).bk || q('bk'); let cur = null;
    if (bk && BUCKET_RE.test(bk)) { const doc = await getJSON(APP_DATA, bucketKey(s, bk)); const r = doc && doc.recs && doc.recs[k]; if (r) cur = { v: r.v, ver: r.ver, by: r.by, at: r.at }; }
    return json({ s, k, bk, cur, steps });
  }
  const to = DAY_RE.test(q('to') || '') ? q('to') : dayStr(new Date()), from = DAY_RE.test(q('from') || '') ? q('from') : to;
  const ds = daysBack(HIST_KEEP_DAYS).filter(d => d >= from && d <= to).slice(0, 31);
  const idx = await Promise.all(ds.map(d => getJSON(APP_DATA, 'hidx_' + d).catch(() => null)));
  const lines = []; idx.forEach((L, i) => (L || []).forEach(l => lines.push(Object.assign({ day: ds[i] }, l))));
  lines.sort((x, y) => (x.day + x.t < y.day + y.t ? 1 : -1));
  return json({ from, to, days: ds.length, lines });
}

export async function onRequestPost({ request }) {
  const a = await admin(request); if (!a.ok) return errorJson(a.error, a.status);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const { s, k, e, curVer } = body || {};
  if (!STORE_RE.test(s || '') || !k || !E_RE.test(e || '')) return errorJson('s, k and e are required', 400);
  const steps = await timeline(s, k, HIST_KEEP_DAYS);
  const i = steps.findIndex(x => x.e === e); if (i < 0) return errorJson('That version isn’t in the history any more', 404);
  const bk = steps[i].bk; if (!BUCKET_RE.test(bk || '')) return errorJson('Bad bucket', 400);
  const doc = (await getJSON(APP_DATA, bucketKey(s, bk))) || { recs: {} }, r = (doc.recs || {})[k];
  if ((r ? r.ver : 0) !== (+curVer || 0)) return errorJson('This record has changed since you opened its history. Open it again and check.', 409);
  if (steps[i].op === 'remove') return errorJson('Pick a version before it was removed', 400);
  const target = rebuild(r ? r.v : undefined, steps.slice(i + 1));
  if (target === undefined) return errorJson('The record didn’t exist at that point', 400);
  const res = await applyChanges(APP_DATA, [{ s, bk, k, v: target, ver: r ? r.ver : 0, c: r ? r.c : Date.now(), op: 'restore' }], (a.user.name || a.user.email), String(a.user.uid).replace(/[^A-Za-z0-9_]/g, '_'));
  if ((res.conflicts || []).length) return errorJson('Someone changed it a moment ago. Open it again and check.', 409);
  return json({ ok: true, ver: (res.ok[0] || {}).ver });
}
