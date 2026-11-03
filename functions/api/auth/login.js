// POST /api/auth/login  { email, password } -> { token, expiresAt, user }
//
// AUTH is the ob_auth KV namespace binding (see mfpl-edgeone-kv-schema.md).
import { authenticate, createSession } from '../../_lib/session.js';
import { json, errorJson, readJsonBody } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { email, password } = body || {};
  if (!email || !password) {
    return errorJson('email and password are required', 400);
  }

  const user = await authenticate(AUTH, email, password);
  if (!user) {
    // Deliberately generic - don't reveal whether the email exists.
    return errorJson('Invalid email or password', 401);
  }

  const { token, expiresAt } = await createSession(AUTH, user);
  return json({
    token,
    expiresAt,
    user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null, prevNames: user.prevNames || [] },
  });
}
