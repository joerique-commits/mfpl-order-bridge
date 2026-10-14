// POST /api/auth/logout  (Authorization: Bearer <token>) -> { ok: true }
// Always returns ok (idempotent) - logging out a token that's already gone
// isn't an error from the client's point of view.
import { destroySession } from '../../_lib/session.js';
import { json, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const token = bearerToken(request);
  await destroySession(env.AUTH, token);
  return json({ ok: true });
}
