// GET  /api/admin/users              (admin only) -> { users: [...] }  (no password hashes returned)
// POST /api/admin/users  { email, name, role, password } (admin only) -> { user }
//
// There is no public signup. The very first admin account can't be created
// through this endpoint (nothing exists yet to authenticate as), so it must
// be seeded directly - see scripts/seed-users.mjs, which computes the same
// PBKDF2 hash this endpoint would and writes the user:{uid}/email_idx:{...}
// KV records directly. Every admin account after the first goes through
// this endpoint like any other role.
import { requireRole, createUser } from '../../_lib/session.js';
import { getJSON } from '../../_lib/kv.js';
import { userRecordNames, noteUserRecord } from '../../_lib/store.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

// 'approver' added 14 Oct for SO Revision Request's COO/Director sign-off
// (mfpl-so-revision-director-approval.md) - same account mechanism as every
// other role, just gated to the /api/so-revisions/decide endpoint.
const VALID_ROLES = ['sales', 'supply', 'production', 'admin', 'accounts', 'approver'];

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  // No secondary index of "all users" exists yet (see schema doc - this is
  // exactly the kind of fan-out-on-write index other modules need). For the
  // small, admin-provisioned user count expected here, listing by the
  // namespace's own prefix-scoped list() is sufficient and avoids building
  // an index for a handful of records; revisit if the account list grows
  // large enough that list()'s 256-key page size becomes a real limit.
  // EdgeOne list() returns { keys:[{ key }], complete, cursor } (max 256 per page).
  // 23 Oct: list() can stall on EdgeOne; userRecordNames falls back to an index kept in AUTH.
  const names = await userRecordNames(AUTH, ['user:' + auth.user.uid]);
  // 23 Oct: read in parallel (one at a time ran past the 15 s limit when KV was slow).
  const recs = await Promise.all(names.map(n => getJSON(AUTH, n).catch(() => null)));
  const users = recs.filter(Boolean).map(u => ({ uid: u.uid, email: u.email, name: u.name, role: u.role, title: u.title || null, active: u.active, createdAt: u.createdAt }));
  return json({ users });
}

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { email, name, role, password, title } = body || {};
  if (!email || !name || !role || !password) {
    return errorJson('email, name, role, and password are required', 400);
  }
  if (!VALID_ROLES.includes(role)) {
    return errorJson(`role must be one of: ${VALID_ROLES.join(', ')}`, 400);
  }
  if (password.length < 8) {
    return errorJson('password must be at least 8 characters', 400);
  }

  try {
    // title is only meaningful for role='approver' (shown on the approval
    // card, e.g. "COO" / "Director") but there's no reason to reject it for
    // other roles - createUser just stores whatever is passed.
    const user = await createUser(AUTH, { email, name, role, password, title: title || null });
    try { await noteUserRecord(AUTH, `user:${user.uid}`); } catch (e) {}
    return json({ user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title } }, 201);
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
