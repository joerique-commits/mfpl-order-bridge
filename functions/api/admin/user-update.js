// POST /api/admin/user-update  (admin only)   — added 22 Oct 2026
//   { uid, action:'deactivate' }            account can't sign in; its open sessions stop working at once
//   { uid, action:'activate' }              undo the above
//   { uid, action:'reset', password }       admin sets a new password (8+ characters) for someone who forgot theirs
// Deactivating keeps the account and everything it entered (names on past work stay correct);
// it is the reversible alternative to deleting. An admin can't deactivate themselves or the last active admin.
import { requireRole, getUserById } from '../../_lib/session.js';
import { hashPassword } from '../../_lib/crypto.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { userRecordNames } from '../../_lib/store.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

async function activeAdmins() {
  const names = await userRecordNames(AUTH, []);
  const recs = await Promise.all(names.map(n => getJSON(AUTH, n).catch(() => null)));
  return recs.filter(u => u && u.role === 'admin' && u.active !== false).map(u => u.uid);
}

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let b; try { b = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const user = b && b.uid ? await getUserById(AUTH, String(b.uid)) : null;
  if (!user) return errorJson('No such user', 404);
  const now = new Date().toISOString(), by = auth.user.email;
  if (b.action === 'deactivate') {
    if (user.uid === auth.user.uid) return errorJson("You can't deactivate your own account", 400);
    if (user.role === 'admin') { const a = await activeAdmins(); if (a.filter(x => x !== user.uid).length < 1) return errorJson("Can't deactivate the last active admin", 400); }
    user.active = false; user.deactivatedAt = now; user.deactivatedBy = by;
  } else if (b.action === 'activate') {
    user.active = true; user.reactivatedAt = now; user.reactivatedBy = by;
  } else if (b.action === 'reset') {
    const pw = String(b.password || '');
    if (pw.length < 8) return errorJson('The new password must be at least 8 characters', 400);
    const h = await hashPassword(pw);
    user.hash = h.hash; user.salt = h.salt; user.iterations = h.iterations; user.passwordResetAt = now; user.passwordResetBy = by;
  } else return errorJson('Unknown action', 400);
  await putJSON(AUTH, `user:${user.uid}`, user);
  return json({ user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null, active: user.active !== false } });
}
