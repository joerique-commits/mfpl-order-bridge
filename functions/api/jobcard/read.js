// POST /api/jobcard/read  { image: <base64 JPEG/PNG>, mediaType }  (Production, Supply, Admin)
// -> { ok:true, result, provider, model, label } | { ok:false, reason, message }
// Reads one job card photo with the free-plan fallback chain in _lib/ai-reader.js.
// Nothing is saved here: the page fills its form and a person checks and saves it.
import { requireRole } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';
import { readCard } from '../../_lib/ai-reader.js';

const MAX_B64 = 3 * 1024 * 1024;

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['production', 'supply', 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let body;
  try { body = await request.json(); } catch (e) { return errorJson('Request body must be valid JSON', 400); }
  const data = String((body && body.image) || '').replace(/^data:[^,]*,/, '');
  const mediaType = /^image\/(jpeg|png|webp)$/.test(body && body.mediaType) ? body.mediaType : 'image/jpeg';
  if (!data) return errorJson('No photo received', 400);
  if (data.length > MAX_B64) return errorJson('Photo too large', 413);
  const by = auth.user.name || auth.user.email;
  const r = await readCard({ data, mediaType }, by);
  if (r.ok) return json({ ok: true, result: r.result, provider: r.provider, model: r.model, label: r.label });
  if (r.notConfigured) return json({ ok: false, reason: 'not_configured', message: "Automatic reading isn't set up yet — an admin needs to add a key in Admin Uploads. Please type the card in." });
  const daily = r.tried.length && r.tried.every(t => /Daily free limit|resting|Resting|Per-minute/.test(t.skipped || '') || t.http === 429);
  return json({ ok: false, reason: daily ? 'used_up' : 'failed', tried: r.tried.map(t => t.id + ': ' + (t.skipped || `${t.http} ${t.msg}`)).slice(0, 12),
    message: daily ? "Today's free automatic reading is used up (or busy for a minute). Please type the card in, or try again in a minute."
      : "The card couldn't be read automatically. Try a clearer photo (flat, whole card, good light), or type it in." });
}
