// GET /api/auth/me  (Authorization: Bearer <token>) -> { user } or 401
// Used by the client on page load to restore a session instead of asking
// the user to log in again every visit, and by any page that needs to
// confirm the current role before rendering role-specific UI.
import { getSessionUser } from '../../_lib/session.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const token = bearerToken(request);
  const result = await getSessionUser(env.AUTH, token);
  if (!result) return errorJson('Not signed in or session expired', 401);
  const { user } = result;
  return json({ user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null } });
}
