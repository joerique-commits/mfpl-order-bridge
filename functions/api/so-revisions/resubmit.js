// POST /api/so-revisions/resubmit  { id, newSos, clientMismatch, reasonType, background }  (sales only)
// Only valid when the request's status is 'sent_back' - starts a fresh 48h
// approval round with a new token; the old approval link stops working.
import { requireRole } from '../../_lib/session.js';
import { resubmitSoRevision } from '../../_lib/so-revisions.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['sales']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { id, ...input } = body || {};
  if (!id) return errorJson('id is required', 400);

  try {
    const result = await resubmitSoRevision(APP_DATA, id, input, auth.user);
    return json({ request: result });
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
