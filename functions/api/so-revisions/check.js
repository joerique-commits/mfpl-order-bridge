// POST /api/so-revisions/check  { id, area, note }  (supply for area='supply', accounts for area='accounts')
// Only valid when the request's status is 'pending' (i.e. already approved).
import { requireRole } from '../../_lib/session.js';
import { checkSoRevision } from '../../_lib/so-revisions.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { id, area, note } = body || {};
  if (!id || !area) return errorJson('id and area are required', 400);

  // The role allowed to check an area matches the area itself (supply checks
  // 'supply', accounts checks 'accounts') - admin can do either as a fallback.
  const allowedRole = area === 'supply' ? 'supply' : area === 'accounts' ? 'accounts' : null;
  if (!allowedRole) return errorJson("area must be 'supply' or 'accounts'", 400);

  const auth = await requireRole(AUTH, bearerToken(request), [allowedRole, 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  try {
    const result = await checkSoRevision(APP_DATA, { id, area, note }, auth.user);
    return json({ request: result });
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
