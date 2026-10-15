// POST /api/warehouse-tag/receive  { tagIds: [...] }  -> { tags: [...] }
import { requireRole } from '../../_lib/session.js';
import { confirmReceipt } from '../../_lib/warehouse-tag.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['supply', 'production', 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  try {
    const tags = await confirmReceipt(APP_DATA, body, auth.user);
    return json({ tags });
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
