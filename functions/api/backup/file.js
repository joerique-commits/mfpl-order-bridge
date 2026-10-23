// Scheduled backup from the office computer (Windows Task Scheduler, every 2 weeks) — added 22 Oct 2026.
// Header X-Backup-Key: <key> on every call (made in Admin Uploads; it only allows the backup download;
// sent in a header, never in the URL).
//   GET  /api/backup/file?list=1  -> { kind, version, createdAt, createdBy, site, dataFile, users, keys:[bucket keys] }
//   POST /api/backup/file  { keys:[up to 25] } -> { b:{ ... } }
// The script joins these into the same file as Admin Uploads > "Download backup". (23 Oct: split into
// pieces, because reading everything in one call can pass EdgeOne's 15 s limit when storage is slow.)
// A plain GET (no ?list) still returns the whole file in one call, for small stores.
import { getJSON, putJSON } from '../../_lib/kv.js';
import { errorJson, readJsonBody } from '../../_lib/http.js';
import { loadAllRaw, listKeys, loadPartRaw } from '../../_lib/store.js';

async function checkKey(request) {
  const key = (request.headers.get('X-Backup-Key') || request.headers.get('x-backup-key') || '').trim();
  const cfg = await getJSON(AUTH, 'cfg_backup_key');
  if (!cfg || !cfg.key || !key || key.length !== cfg.key.length) return null;
  let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ cfg.key.charCodeAt(i);
  return diff ? null : cfg;
}
async function usersList() {
  const names = await listKeys(AUTH, 'user:');
  const recs = await Promise.all(names.map(n => getJSON(AUTH, n).catch(() => null)));
  return recs.filter(Boolean).map(u => ({ uid: u.uid, email: u.email, name: u.name, role: u.role, title: u.title || null, active: u.active, createdAt: u.createdAt }));
}
const JH = { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' };

export async function onRequestGet({ request }) {
  const cfg = await checkKey(request);
  if (!cfg) return errorJson('Backup key missing or wrong', 401);
  const now = new Date().toISOString();
  const [users, meta] = await Promise.all([usersList(), getJSON(ERP_MIRROR, 'obdata_meta').catch(() => null)]);
  const head = { kind: 'order-bridge-backup', version: 1, createdAt: now, createdBy: 'scheduled backup', site: new URL(request.url).host, dataFile: meta, users };
  cfg.lastUsedAt = now; await putJSON(AUTH, 'cfg_backup_key', cfg);
  if (new URL(request.url).searchParams.get('list') === '1') {
    const keys = (await listKeys(APP_DATA, 'b_'));
    return new Response(JSON.stringify(Object.assign(head, { keys })), { status: 200, headers: JH });
  }
  const raw = await loadAllRaw(APP_DATA, '__backup__');
  const s = JSON.stringify(head);
  return new Response(s.slice(0, -1) + ',"store":' + raw + '}', { status: 200, headers: Object.assign({}, JH, { 'content-disposition': `attachment; filename="order-bridge-backup-${now.slice(0, 16).replace(/[:T]/g, '-')}.json"` }) });
}

export async function onRequestPost({ request }) {
  if (!(await checkKey(request))) return errorJson('Backup key missing or wrong', 401);
  let b; try { b = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  return new Response(await loadPartRaw(APP_DATA, b && b.keys), { status: 200, headers: JH });
}
