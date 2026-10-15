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
// A second, independent bug was layered under that one: EdgeOne's edge Web
// Crypto implementation rejects importKey's algorithm identifier when it's
// passed as an object ({ name: 'PBKDF2' }) - see the comment in
// functions/_lib/crypto.js for the fix and mfpl-edgeone-kv-schema.md for the
// full writeup.
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

  const user = await authenticate(AUTH, email, password);
  if (!user) {
    // Deliberately generic - don't reveal whether the email exists.
    return errorJson('Invalid email or password', 401);
  }

  const { token, expiresAt } = await createSession(AUTH, user);
  return json({
    token,
    expiresAt,
    user: { uid: user.uid, email: user.email, name: user.name, role: user.role, title: user.title || null },
  });
}
