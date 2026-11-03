// POST /api/admin/user-update  (admin only)   — added 22 Oct 2026
//   { uid, action:'deactivate' }            account can't sign in; its open sessions stop working at once
//   { uid, action:'activate' }              undo the above
//   { uid, action:'reset', password }       admin sets a new password (8+ characters) for someone who forgot theirs
//   { uid, action:'edit', name, email, role, title }   (3 Nov) change name / sign-in email / user type / title.
//       A changed name is kept in prevNames so the page still knows older records typed with the old name are this
//       person's. A changed email moves the sign-in lookup. Every edit is kept in user.edits (who, when, old → new).
//       Guards: email not used by another account; an admin can't change their own user type; the last active
//       admin can't be made a non-admin; COO / Director (approver) needs a title.
// Deactivating keeps the account and everything it entered (names on past work stay correct);
// it is the reversible alternative to deleting. An admin can't deactivate themselves or the last active admin.
import { requireRole, getUserById, findUserByEmail } from '../../_lib/session.js';
import { hashPassword } from '../../_lib/crypto.js';
import { getJSON, putJSON, deleteKey, safeKeyPart } from '../../_lib/kv.js';
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
  } else if (b.action === 'edit') {
    const ROLES = ['sales', 'supply', 'production', 'admin', 'accounts', 'approver'];
    const name = String(b.name == null ? user.name : b.name).trim().replace(/\s+/g, ' ');
    const email = String(b.email == null ? user.email : b.email).trim().toLowerCase();
    const role = String(b.role == null ? user.role : b.role);
    const title = role === 'approver' ? String(b.title == null ? (user.title || '') : b.title).trim() : null;
    if (!name || name.length > 80) return errorJson('Enter a name (up to 80 characters)', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return errorJson('Enter a valid email address', 400);
    if (!ROLES.includes(role)) return errorJson('Unknown user type', 400);
    if (role === 'approver' && !title) return errorJson('A COO / Director account needs a title (e.g. COO or Director)', 400);
    if (role !== user.role) {
      if (user.uid === auth.user.uid) return errorJson("You can't change your own user type", 400);
      if (user.role === 'admin' && user.active !== false) { const a = await activeAdmins(); if (a.filter(x => x !== user.uid).length < 1) return errorJson("Can't change the last active admin to another user type", 400); }
    }
    const oldEmail = user.email;
    if (email !== oldEmail) { const other = await findUserByEmail(AUTH, email); if (other && other.uid !== user.uid) return errorJson(`${email} is already used by ${other.name}`, 409); }
    const ch = {};
    if (name !== user.name) { ch.name = [user.name, name]; user.prevNames = [...new Set((user.prevNames || []).concat([user.name]))].filter(n => n !== name); user.name = name; }
    if (email !== oldEmail) { ch.email = [oldEmail, email]; user.email = email; }
    if (role !== user.role) { ch.role = [user.role, role]; user.role = role; }
    if ((title || null) !== (user.title || null)) { ch.title = [user.title || null, title || null]; user.title = title || null; }
    if (!Object.keys(ch).length) return errorJson('Nothing changed', 400);
    user.edits = (user.edits || []).concat([{ at: now, by, ch }]).slice(-50);
    await putJSON(AUTH, `user:${user.uid}`, user);
    if (ch.email) {   // sign-in lookup: add the new email, then drop the old one
      await AUTH.put(`email_idx:${safeKeyPart(email)}`, user.uid);
      if (safeKeyPart(oldEmail) !== safeKeyPart(email)) { try { await deleteKey(AUTH, `email_idx:${safeKeyPart(oldEmail)}`); } catch (e) {} }
    }
    return json({ user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null, active: user.active !== false, prevNames: user.prevNames || [] } });
  } else return errorJson('Unknown action', 400);
  await putJSON(AUTH, `user:${user.uid}`, user);
  return json({ user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null, active: user.active !== false } });
}
