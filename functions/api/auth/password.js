// POST /api/auth/password  (signed in) { current, next } -> { ok:true }
// Lets a signed-in user change their own password (Profile > Change password).
import { getSessionUser } from '../../_lib/session.js';
import { verifyPassword, hashPassword } from '../../_lib/crypto.js';
import { json, errorJson, bearerToken, readJsonBody } from '../../_lib/http.js';
import { putJSON } from '../../_lib/kv.js';

export async function onRequestPost({ request }) {
  const s = await getSessionUser(AUTH, bearerToken(request));
  if (!s) return errorJson('Not signed in or session expired', 401);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const { current, next } = body || {};
  if (!current || !next) return errorJson('current and next are required', 400);
  if (String(next).length < 8) return errorJson('The new password must be at least 8 characters.', 400);
  const u = s.user;
  const ok = await verifyPassword(current, { hash: u.hash, salt: u.salt, iterations: u.iterations });
  if (!ok) return errorJson('Your current password is incorrect.', 403);
  const h = await hashPassword(next);
  await putJSON(AUTH, `user:${u.uid}`, Object.assign({}, u, h, { passwordChangedAt: new Date().toISOString() }));
  return json({ ok: true });
}
