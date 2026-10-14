// Session lifecycle over the ob_auth KV namespace (bound as env.AUTH).
//
// Key shapes in ob_auth:
//   user:{uid}            -> { uid, email, name, role, hash, salt, iterations, createdAt, active }
//   email_idx:{email}     -> uid   (lookup by email at login - KV has no query-by-field)
//   session:{token}       -> { uid, role, createdAt, expiresAt }
//
// Sessions last 7 days from creation (SESSION_TTL_MS). There's no server-side
// TTL/expiry feature assumed for EdgeOne KV (unverified either way), so
// expiry is enforced in application code: getSessionUser checks expiresAt
// itself and treats an expired session as absent, rather than relying on the
// store to garbage-collect it. Expired session keys are left in place rather
// than deleted on read (deleting on every expired read adds a write to a hot
// path for no real benefit at this account's scale) - a future cleanup sweep
// could prune them, noted as a non-blocking improvement.

import { randomToken, randomId, hashPassword, verifyPassword } from './crypto.js';
import { getJSON, putJSON, deleteKey, safeKeyPart } from './kv.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function findUserByEmail(authKv, email) {
  const normalized = email.trim().toLowerCase();
  const uid = await authKv.get(`email_idx:${safeKeyPart(normalized)}`, { type: 'text' });
  if (!uid) return null;
  return getJSON(authKv, `user:${uid}`);
}

export async function getUserById(authKv, uid) {
  return getJSON(authKv, `user:${uid}`);
}

// Creates a new user record + email index entry. Throws if the email is
// already taken (checked first, but see the KV-consistency note in kv.js -
// this is a best-effort check, not a hard uniqueness guarantee under
// concurrent signups; acceptable here because accounts are admin-provisioned
// one at a time, never a public signup race).
export async function createUser(authKv, { email, name, role, password, title = null }) {
  const normalized = email.trim().toLowerCase();
  const existing = await findUserByEmail(authKv, normalized);
  if (existing) throw new Error(`A user with email ${normalized} already exists`);

  const uid = randomId('u');
  const { hash, salt, iterations } = await hashPassword(password);
  const user = {
    uid,
    email: normalized,
    name,
    role,
    title, // only meaningful for role='approver' (e.g. "COO" / "Director")
    hash,
    salt,
    iterations,
    createdAt: new Date().toISOString(),
    active: true,
  };
  await putJSON(authKv, `user:${uid}`, user);
  // Written after the user record, same ordering reasoning as ERP mirror's
  // data/meta pattern: a reader who sees the index entry can always find a
  // complete user record behind it.
  await authKv.put(`email_idx:${safeKeyPart(normalized)}`, uid);
  return user;
}

// Verifies email+password, returns the user record or null. Does not
// distinguish "no such email" from "wrong password" in its return value -
// callers should give a generic "invalid email or password" response so the
// API doesn't leak which emails are registered.
export async function authenticate(authKv, email, password) {
  const user = await findUserByEmail(authKv, email);
  if (!user || user.active === false) return null;
  const ok = await verifyPassword(password, { hash: user.hash, salt: user.salt, iterations: user.iterations });
  return ok ? user : null;
}

export async function createSession(authKv, user) {
  const token = randomToken();
  const now = Date.now();
  const session = {
    uid: user.uid,
    role: user.role,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  await putJSON(authKv, `session:${token}`, session);
  return { token, expiresAt: session.expiresAt };
}

// Returns { session, user } for a valid, unexpired token, or null.
export async function getSessionUser(authKv, token) {
  if (!token) return null;
  const session = await getJSON(authKv, `session:${token}`);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const user = await getUserById(authKv, session.uid);
  if (!user || user.active === false) return null;
  return { session, user };
}

export async function destroySession(authKv, token) {
  if (!token) return;
  await deleteKey(authKv, `session:${token}`);
}

// Role-check helper for endpoints: pass the allowed roles for that route.
// Returns { ok: true, user } or { ok: false, status, error }.
export async function requireRole(authKv, token, allowedRoles) {
  const result = await getSessionUser(authKv, token);
  if (!result) return { ok: false, status: 401, error: 'Not signed in or session expired' };
  if (allowedRoles && allowedRoles.length && !allowedRoles.includes(result.user.role)) {
    return { ok: false, status: 403, error: `Role '${result.user.role}' is not permitted for this action` };
  }
  return { ok: true, user: result.user };
}
