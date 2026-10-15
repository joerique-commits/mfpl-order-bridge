// GET  /api/warehouse-tag                        -> { tags: [...] }  (Logbook; any signed-in user)
// GET  /api/warehouse-tag?id={tagId}              -> { tag }
// GET  /api/warehouse-tag?toPick=1&so={so}&sku={sku} -> { tags: [...] }  (Last Mile's "tags to pick")
// POST /api/warehouse-tag  { po, sku, articleName, so, customer, qtyTotal, packets } -> { tag }
import { requireRole } from '../../_lib/session.js';
import { createIntake, getTag, listTags, tagsToPick } from '../../_lib/warehouse-tag.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const WRITE_ROLES = ['supply', 'production', 'admin'];

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  if (url.searchParams.get('toPick')) {
    const so = url.searchParams.get('so');
    const sku = url.searchParams.get('sku');
    if (!so || !sku) return errorJson('so and sku are required', 400);
    const tags = await tagsToPick(APP_DATA, so, sku);
    return json({ tags });
  }

  const id = url.searchParams.get('id');
  if (id) {
    const tag = await getTag(APP_DATA, id);
    if (!tag) return errorJson(`Tag ${id} not found`, 404);
    return json({ tag });
  }

  const tags = await listTags(APP_DATA);
  return json({ tags });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), WRITE_ROLES);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  try {
    const tag = await createIntake(APP_DATA, body, auth.user);
    return json({ tag }, 201);
  } catch (e) {
    return errorJson(e.message, 400);
  }
}
