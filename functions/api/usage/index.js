// Usage analytics (20 Nov 2026, JK): which menus get used, active time, and signs of people being stuck.
//
// POST /api/usage  { month:'202611', dev, kind, days:{ '20261120': {...} } }   (any signed-in user)
//   One record per person per device per month, always sent whole by that device, so a write is a plain
//   overwrite (no read-modify-write that a stale edge read could undo). usage_ix_<uid> lists the person's
//   devices and months; it only changes when a new device or month appears. Months older than 4 are deleted.
// GET  /api/usage?m=202611   (admin only) -> { users:[...], docs:[...] } for that month.
import { requireRole } from '../../_lib/session.js';
import { getJSON, putJSON, deleteKey, safeKeyPart } from '../../_lib/kv.js';
import { userRecordNames } from '../../_lib/store.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const KEEP_MONTHS = 4, MAX_BYTES = 400 * 1024;
const monthKey = (m, uid, dev) => `usage_m${m}_${safeKeyPart(uid)}_${safeKeyPart(dev)}`;
const ixKey = uid => `usage_ix_${safeKeyPart(uid)}`;
const monthsBack = (m, n) => { let y = +m.slice(0, 4), mo = +m.slice(4) - n; while (mo < 1){ mo += 12; y--; } return String(y) + String(mo).padStart(2, '0'); };

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const { month, dev, kind, days } = body || {};
  if (!/^\d{6}$/.test(String(month || '')) || !/^[A-Za-z0-9]{6,24}$/.test(String(dev || '')) || !days || typeof days !== 'object') return errorJson('month, dev and days are required', 400);
  const uid = auth.user.uid;
  const doc = { uid, name: auth.user.name || auth.user.email, role: auth.user.role, dev, kind: kind === 'phone' ? 'phone' : 'desktop', month, at: new Date().toISOString(), days };
  const text = JSON.stringify(doc);
  if (text.length > MAX_BYTES) return errorJson('usage record too large', 413);
  await APP_DATA.put(monthKey(month, uid, dev), text);
  // the index changes only for a new device or month
  const ix = (await getJSON(APP_DATA, ixKey(uid)).catch(() => null)) || { devs: {} };
  const ms = ix.devs[dev] = ix.devs[dev] || [];
  if (!ms.includes(month)) {
    ms.push(month); ms.sort();
    const oldest = monthsBack(month, KEEP_MONTHS - 1);
    for (const d of Object.keys(ix.devs)) {
      const gone = ix.devs[d].filter(x => x < oldest);
      for (const g of gone) { try { await deleteKey(APP_DATA, monthKey(g, uid, d)); } catch (e) {} }
      ix.devs[d] = ix.devs[d].filter(x => x >= oldest);
      if (!ix.devs[d].length) delete ix.devs[d];
    }
    await putJSON(APP_DATA, ixKey(uid), ix);
  }
  return json({ ok: true });
}

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const m = new URL(request.url).searchParams.get('m') || '';
  if (!/^\d{6}$/.test(m)) return errorJson('m=YYYYMM is required', 400);
  const names = await userRecordNames(AUTH, ['user:' + auth.user.uid]);
  const recs = (await Promise.all(names.map(n => getJSON(AUTH, n).catch(() => null)))).filter(Boolean);
  const users = recs.map(u => ({ uid: u.uid, name: u.name, email: u.email, role: u.role, active: u.active !== false }));
  const ixs = await Promise.all(users.map(u => getJSON(APP_DATA, ixKey(u.uid)).catch(() => null)));
  const want = [];
  users.forEach((u, i) => { const ix = ixs[i]; if (!ix || !ix.devs) return; Object.keys(ix.devs).forEach(d => { if (ix.devs[d].includes(m)) want.push(monthKey(m, u.uid, d)); }); });
  const docs = (await Promise.all(want.map(k => getJSON(APP_DATA, k).catch(() => null)))).filter(Boolean);
  return json({ users, docs });
}
