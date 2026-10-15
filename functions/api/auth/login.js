// POST /api/auth/login  { email, password } -> { token, expiresAt, user }
//
// AUTH is the ob_auth KV namespace binding (see mfpl-edgeone-kv-schema.md).
// IMPORTANT: on EdgeOne Pages/Makers Functions, a bound KV namespace is
// injected as a bare global matching its configured "Variable name" (here
// literally the identifier `AUTH`) - it is NOT exposed via the handler's
// `env` argument the way Cloudflare Pages Functions do it. `env` here is
// EdgeOne's own build/runtime environment object (NPM_CONFIG_YES,
// EDGEONE_PROJECT_ID, etc.) and has nothing to do with KV bindings. This was
// confirmed by dumping Object.keys(env) in production and cross-checking
// against EdgeOne's own docs (edgeone.ai/document/162227803822321664) - see
// mfpl-edgeone-kv-schema.md for the full writeup. Every route file that
// touches KV was fixed the same way: reference the bound variable name
// directly (`AUTH`, `APP_DATA`, `ERP_MIRROR`), never `env.<name>`.
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

export async function onRequestPost({ request }) {
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

  // TEMPORARY DIAGNOSTIC WRAP #2 (2026-10-15): the env.AUTH -> bare AUTH fix
  // deployed (commit 561b2e5) but a real login attempt still crashes with the
  // same platform-level 545 "Error return from script" - no message reaches
  // the client. This surfaces the real exception so we're not guessing again.
  // Remove once identified (restore the plain two-line call below).
  let user;
  try {
    user = await authenticate(AUTH, email, password);
  } catch (e) {
    return errorJson(`DIAGNOSTIC2: authenticate() threw: ${e && e.name}: ${e && e.message} | typeof AUTH=${typeof AUTH} | stack: ${e && e.stack}`, 500);
  }
  if (!user) {
    // Deliberately generic - don't reveal whether the email exists.
    return errorJson('Invalid email or password', 401);
  }

  let sessionResult;
  try {
    sessionResult = await createSession(AUTH, user);
  } catch (e) {
    return errorJson(`DIAGNOSTIC2: createSession() threw: ${e && e.name}: ${e && e.message} | stack: ${e && e.stack}`, 500);
  }
  const { token, expiresAt } = sessionResult;
  return json({
    token,
    expiresAt,
    user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null },
  });
}
