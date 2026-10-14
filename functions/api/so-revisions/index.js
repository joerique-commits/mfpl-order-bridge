// GET  /api/so-revisions          -> { requests: [...] }  (any signed-in user)
// POST /api/so-revisions          -> { request }           (sales only)
import { requireRole } from '../../_lib/session.js';
import { createSoRevision, listSoRevisions } from '../../_lib/so-revisions.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null); // any signed-in user
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const requests = await listSoRevisions(env.APP_DATA);
  return json({ requests });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), ['sales']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  try {
    const result = await createSoRevision(env.APP_DATA, body, auth.user);
    return json({ request: result }, 201);
  } catch (e) {
    return errorJson(e.message, 400);
  }
}
