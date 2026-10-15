// POST /api/auth/login  { email, password } -> { token, expiresAt, user }
//
// env.AUTH is the ob_auth KV namespace binding (see mfpl-edgeone-kv-schema.md).
//
// onRequestOptions below handles the browser's CORS preflight. A
// functions/_middleware.js attempt at this (wrapping every route) landed
// as a 404 on EdgeOne - this platform's Pages Functions routing appears to
// only dispatch requests to a per-method export inside the literal route
// file, not through a directory-level middleware hook the way Cloudflare
// Pages does. Per-file onRequestOptions is the fallback that's guaranteed
// to work, matching the same routing model onRequestGet/onRequestPost
// already rely on here.
import { authenticate, createSession } from '../../_lib/session.js';
import { json, errorJson, readJsonBody } from '../../_lib/http.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

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

  // TEMPORARY DIAGNOSTIC WRAP (2026-10-15): a real login attempt against this
  // endpoint has been crashing with EdgeOne's platform-level HTTP 545
  // ("Error return from script"), i.e. an uncaught exception somewhere in
  // authenticate() -> verifyPassword() -> the Web Crypto PBKDF2 calls. The
  // uncaught exception means nothing - no message, no stack - reaches the
  // client or any log panel we have access to. This try/catch exists only to
  // surface that error's real message/stack in the JSON response so we can
  // see it directly, instead of groping in the dark. Remove this try/catch
  // (restore the plain `const user = await authenticate(...)` call below)
  // once the underlying bug is identified and fixed.
  let user;
  try {
    const envKeys = env && typeof env === 'object' ? Object.keys(env).join(',') : String(env);
    if (!env || !env.AUTH) {
      return errorJson(`DIAGNOSTIC: env.AUTH missing. typeof env=${typeof env} envKeys=[${envKeys}] typeof env.AUTH=${env && typeof env.AUTH}`, 500);
    }
    user = await authenticate(env.AUTH, email, password);
  } catch (e) {
    return errorJson(`DIAGNOSTIC: authenticate() threw: ${e && e.message} | stack: ${e && e.stack}`, 500);
  }
  if (!user) {
    // Deliberately generic - don't reveal whether the email exists.
    return errorJson('Invalid email or password', 401);
  }

  const { token, expiresAt } = await createSession(env.AUTH, user);
  return json({
    token,
    expiresAt,
    user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null },
  });
}
