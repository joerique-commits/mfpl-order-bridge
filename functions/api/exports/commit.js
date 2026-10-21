// POST /api/exports/commit  (admin) { files:[{ slot, id, chunks, bytes, file, type, label, rows, oldest, newest }], remove:[slot] }
// Points each slot at its newly uploaded copy (after checking every piece is there) and deletes the copy it replaces.
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { getJSON, putJSON } from '../../_lib/kv.js';

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const files = Array.isArray(body && body.files) ? body.files : [], remove = Array.isArray(body && body.remove) ? body.remove : [];
  const meta = (await getJSON(ERP_MIRROR, 'exp_meta')) || { slots: {} };
  const old = [];
  for (const f of files) {
    if (!f || typeof f.slot !== 'string' || !f.slot || f.slot.length > 200 || !/^[A-Za-z0-9]{1,40}$/.test(f.id || '')) return errorJson('Bad file entry', 400);
    const chunks = Number(f.chunks);
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > 500) return errorJson('Bad chunk count', 400);
    for (let i = 0; i < chunks; i++) {
      const c = await ERP_MIRROR.get(`exp_c_${f.id}_${i}`, { type: 'arrayBuffer' });
      if (!c) return errorJson(`${f.file}: piece ${i} is missing - upload again`, 409);
    }
  }
  const now = new Date().toISOString(), by = auth.user.name || auth.user.email;
  for (const f of files) {
    if (meta.slots[f.slot]) old.push(meta.slots[f.slot]);
    meta.slots[f.slot] = { id: f.id, chunks: Number(f.chunks), bytes: Number(f.bytes) || 0, file: String(f.file || '').slice(0, 200), type: String(f.type || ''), label: String(f.label || '').slice(0, 120),
      rows: Number(f.rows) || 0, oldest: f.oldest || null, newest: f.newest || null, uploadedAt: now, uploadedBy: by };
  }
  for (const s of remove) { if (meta.slots[s]) { old.push(meta.slots[s]); delete meta.slots[s]; } }
  await putJSON(ERP_MIRROR, 'exp_meta', meta);
  for (const o of old) { try { for (let i = 0; i < o.chunks; i++) await ERP_MIRROR.delete(`exp_c_${o.id}_${i}`); } catch (e) {} }
  return json({ meta });
}
