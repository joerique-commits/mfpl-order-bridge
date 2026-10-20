// POST /api/data/upload?id=<uploadId>&n=<index>   (admin) body: raw text of chunk n
// POST /api/data/upload?id=<uploadId>&finish=1    (admin) body: { chunks, bytes, builtAt, pub }
// Chunks first, meta last: a reader who sees the new meta finds every chunk it points to.
// The upload before the previous one is deleted on finish (current + previous are kept).
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { getJSON, putJSON } from '../../_lib/kv.js';

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) return errorJson('Bad id', 400);

  if (url.searchParams.get('finish')) {
    let body; try { body = await request.json(); } catch (e) { return errorJson('Body must be JSON', 400); }
    const chunks = Number(body && body.chunks);
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > 2000) return errorJson('Bad chunk count', 400);
    const prefix = body.gz ? 'obdata_z_' : 'obdata_c_';
    for (let i = 0; i < chunks; i++) {
      const c = await ERP_MIRROR.get(`${prefix}${id}_${i}`, { type: 'arrayBuffer' });
      if (c === null || c === undefined) return errorJson(`Chunk ${i} missing - upload again`, 409);
    }
    await putJSON(ERP_MIRROR, `obdata_pub_${id}`, (body && body.pub) || {});
    const prev = await getJSON(ERP_MIRROR, 'obdata_meta');
    const meta = { id, chunks, gz: !!body.gz, bytes: Number(body.bytes) || 0, builtAt: body.builtAt || null, uploadedAt: new Date().toISOString(), uploadedBy: auth.user.name || auth.user.email, prevId: prev ? prev.id : null };
    await putJSON(ERP_MIRROR, 'obdata_meta', meta);
    if (prev && prev.prevId && prev.prevId !== id) {
      try {
        const old = await getJSON(ERP_MIRROR, 'obdata_meta_' + prev.prevId);
        const n = old ? old.chunks : 0;
        for (let i = 0; i < n; i++) { await ERP_MIRROR.delete(`obdata_c_${prev.prevId}_${i}`); await ERP_MIRROR.delete(`obdata_z_${prev.prevId}_${i}`); }
        await ERP_MIRROR.delete('obdata_pub_' + prev.prevId);
        await ERP_MIRROR.delete('obdata_meta_' + prev.prevId);
      } catch (e) {}
    }
    await putJSON(ERP_MIRROR, 'obdata_meta_' + id, meta);
    return json({ meta });
  }

  const n = url.searchParams.get('n') || '';
  if (!/^\d{1,4}$/.test(n)) return errorJson('Bad n', 400);
  if (url.searchParams.get('gz') === '1') {   // gzipped by the browser: stored as bytes
    const buf = await request.arrayBuffer();
    if (!buf || !buf.byteLength) return errorJson('Empty chunk', 400);
    await ERP_MIRROR.put(`obdata_z_${id}_${n}`, buf);
    return json({ ok: true, n: Number(n), bytes: buf.byteLength });
  }
  const text = await request.text();
  if (!text) return errorJson('Empty chunk', 400);
  await ERP_MIRROR.put(`obdata_c_${id}_${n}`, text);
  return json({ ok: true, n: Number(n), bytes: text.length });
}
