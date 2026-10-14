// GET  /api/furnishings-tag                 -> { tags: [...] }   (Logbook; any signed-in user)
// GET  /api/furnishings-tag?id={tagId}       -> { tag }           (Dispatch/Receiving tag lookup)
// GET  /api/furnishings-tag?dupCheck=1&poKind=furnishings|furniture&po={po}&sku={sku}
//                                             -> { duplicates: [...] }  (Intake's duplicate-SKU banner)
// POST /api/furnishings-tag  { ...intake fields }  -> { tag }     (supply, production, admin)
import { requireRole } from '../../_lib/session.js';
import { createIntake, getTag, listTags, findDuplicateSkuOnPo } from '../../_lib/furnishings-tag.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const WRITE_ROLES = ['supply', 'production', 'admin'];

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  if (url.searchParams.get('dupCheck')) {
    const poKind = url.searchParams.get('poKind');
    const po = url.searchParams.get('po');
    const sku = url.searchParams.get('sku');
    if (!['furnishings', 'furniture'].includes(poKind) || !po || !sku) {
      return errorJson('poKind (furnishings|furniture), po, and sku are required for a duplicate check', 400);
    }
    const duplicates = await findDuplicateSkuOnPo(env.APP_DATA, poKind, po, sku);
    return json({ duplicates });
  }

  const id = url.searchParams.get('id');
  if (id) {
    const tag = await getTag(env.APP_DATA, id);
    if (!tag) return errorJson(`Tag ${id} not found`, 404);
    return json({ tag });
  }

  const tags = await listTags(env.APP_DATA);
  return json({ tags });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), WRITE_ROLES);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  try {
    const tag = await createIntake(env.APP_DATA, body, auth.user);
    return json({ tag }, 201);
  } catch (e) {
    return errorJson(e.message, 400);
  }
}
