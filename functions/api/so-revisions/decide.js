// POST /api/so-revisions/decide  { id, token, decision, comments }  (approver only)
// decision: 'approved' | 'sent_back' | 'rejected'
import { requireRole } from '../../_lib/session.js';
import { decideSoRevision } from '../../_lib/so-revisions.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['approver']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { id, token, decision, comments } = body || {};
  if (!id || !token || !decision) return errorJson('id, token, and decision are required', 400);
  if (!['approved', 'sent_back', 'rejected'].includes(decision)) {
    return errorJson("decision must be 'approved', 'sent_back', or 'rejected'", 400);
  }

  try {
    const result = await decideSoRevision(APP_DATA, { id, token, decision, comments }, auth.user);
    return json({ request: result });
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
