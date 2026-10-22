// GET /api/backup/file   header  X-Backup-Key: <key>      — added 22 Oct 2026
// For the scheduled backup on the office computer (Windows Task Scheduler, every 2 weeks): returns the same
// file as Admin Uploads > "Download backup" (all saved work + the accounts list, no passwords), without a
// sign-in. The key is made in Admin Uploads and only allows this one download. It is sent in a header,
// never in the URL, so it doesn't end up in logs or browser history.
import { getJSON, putJSON } from '../../_lib/kv.js';
import { errorJson } from '../../_lib/http.js';
import { loadAllRaw } from '../../_lib/store.js';

export async function onRequestGet({ request }) {
  const key = (request.headers.get('X-Backup-Key') || request.headers.get('x-backup-key') || '').trim();
  const cfg = await getJSON(AUTH, 'cfg_backup_key');
  if (!cfg || !cfg.key || !key || key.length !== cfg.key.length) return errorJson('Backup key missing or wrong', 401);
  let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ cfg.key.charCodeAt(i);
  if (diff) return errorJson('Backup key missing or wrong', 401);
  const raw = await loadAllRaw(APP_DATA, '__backup__');
  const users = [];
  let cursor;
  for (let g = 0; g < 50; g++) {
    const page = await AUTH.list(cursor ? { prefix: 'user:', limit: 256, cursor } : { prefix: 'user:', limit: 256 });
    for (const e of page.keys || []) { const u = await getJSON(AUTH, e.key || e.name); if (u) users.push({ uid: u.uid, email: u.email, name: u.name, role: u.role, title: u.title || null, active: u.active, createdAt: u.createdAt }); }
    if (page.complete || !page.cursor) break; cursor = page.cursor;
  }
  const meta = await getJSON(ERP_MIRROR, 'obdata_meta').catch(() => null);
  const now = new Date().toISOString();
  cfg.lastUsedAt = now; await putJSON(AUTH, 'cfg_backup_key', cfg);
  const head = JSON.stringify({ kind: 'order-bridge-backup', version: 1, createdAt: now, createdBy: 'scheduled backup', site: new URL(request.url).host, dataFile: meta, users });
  const body = head.slice(0, -1) + ',"store":' + raw + '}';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="order-bridge-backup-${now.slice(0, 16).replace(/[:T]/g, '-')}.json"` } });
}
