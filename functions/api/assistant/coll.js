// Collections snapshots (13 Nov 2026). The ERP exports give a collected total per sales order but no collection
// dates, so "collected this week" is worked out as the difference between two days' totals.
// GET  /api/assistant/coll            -> { days:[{ day, builtAt, n }] }                     newest first
// GET  /api/assistant/coll?a=<day>&b=<day> -> { a:{ day, builtAt, m }, b:{...} }             m = { so:[beforeGst, withGst] }
// POST /api/assistant/coll  (admin)  { builtAt, m }  one snapshot per data file, kept per IST day (a later file the same day replaces it)
// Stored in APP_DATA: asst_coll_idx, asst_coll_<yyyymmdd>. Kept for 800 days.
import { requireRole } from '../../_lib/session.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

const TEAMS = ['admin', 'sales', 'supply', 'production', 'accounts'];
const KEEP = 800;
const dayOf = iso => new Date(Date.parse(iso) + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), TEAMS);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const u = new URL(request.url); const a = u.searchParams.get('a'), b = u.searchParams.get('b');
  if (!a && !b) return json({ days: (await getJSON(APP_DATA, 'asst_coll_idx')) || [] });
  const one = async d => (/^\d{8}$/.test(d || '') ? await getJSON(APP_DATA, 'asst_coll_' + d) : null);
  return json({ a: await one(a), b: await one(b) });
}
export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let b; try { b = await request.json(); } catch (e) { return errorJson('Request body must be valid JSON', 400); }
  const t = Date.parse(b && b.builtAt);
  if (!t || t > Date.now() + 36 * 3600e3 || !b.m || typeof b.m !== 'object') return errorJson('builtAt and m are needed', 400);
  const m = {}; let n = 0;
  for (const so of Object.keys(b.m)) { const v = b.m[so]; if (!/^[A-Za-z0-9_\/-]{4,40}$/.test(so) || !Array.isArray(v)) continue; const x = Number(v[0]) || 0, y = Number(v[1]) || 0; if (!x && !y) continue; m[so] = [Math.round(x * 100) / 100, Math.round(y * 100) / 100]; if (++n > 20000) return errorJson('Too many sales orders', 400); }
  const day = dayOf(b.builtAt); const idx = (await getJSON(APP_DATA, 'asst_coll_idx')) || [];
  const have = idx.find(x => x.day === day);
  if (have && have.builtAt >= b.builtAt) return json({ ok: true, kept: have, days: idx });
  await putJSON(APP_DATA, 'asst_coll_' + day, { day, builtAt: b.builtAt, at: new Date().toISOString(), by: auth.user.name || auth.user.email, m });
  const next = idx.filter(x => x.day !== day).concat([{ day, builtAt: b.builtAt, n }]).sort((x, y) => y.day.localeCompare(x.day));
  for (const old of next.slice(KEEP)) { try { await APP_DATA.delete('asst_coll_' + old.day); } catch (e) {} }
  await putJSON(APP_DATA, 'asst_coll_idx', next.slice(0, KEEP));
  return json({ ok: true, kept: { day, builtAt: b.builtAt, n }, days: next.slice(0, KEEP) });
}
