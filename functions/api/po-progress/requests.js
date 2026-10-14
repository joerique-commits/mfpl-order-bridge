// GET  /api/po-progress/requests?status=&so=         -> { requests: [...] }  (any signed-in user)
// POST /api/po-progress/requests  { action, ...fields } -> { request }       (role per action)
//
// action values:
//   create       sales, admin   - { so, article, sku, qty, committedDateOption, customDate?, detail?, knownPos? }
//   mark_raised  supply, admin  - { id }
import { requireRole } from '../../_lib/session.js';
import { createRequest, markRaised, listRequests } from '../../_lib/po-progress.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  const so = url.searchParams.get('so') || undefined;
  const requests = await listRequests(env.APP_DATA, { status, so });
  return json({ requests });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { action } = body || {};
  if (!action) return errorJson('action is required', 400);

  try {
    if (action === 'create') {
      const auth = await requireRole(env.AUTH, bearerToken(request), ['sales', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      const req = await createRequest(env.APP_DATA, body, auth.user);
      return json({ request: req }, 201);
    }
    if (action === 'mark_raised') {
      const auth = await requireRole(env.AUTH, bearerToken(request), ['supply', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      if (!body.id) return errorJson('id is required', 400);
      const req = await markRaised(env.APP_DATA, body.id, auth.user);
      return json({ request: req });
    }
    return errorJson(`Unknown action '${action}'`, 400);
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
