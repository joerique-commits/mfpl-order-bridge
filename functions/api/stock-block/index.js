// GET  /api/stock-block?so={so}                         -> { requests }       (any signed-in user)
// GET  /api/stock-block?warehouse={ho|bng|cok}           -> { blocked }        (any signed-in user;
//                                                            "Blocked stock by warehouse", article -> SO -> qty)
// GET  /api/stock-block?article={article}&warehouse={w}  -> { position }       (any signed-in user;
//                                                            stock in hand / already-blocked / free)
// POST /api/stock-block  { action, ...fields }           -> { request }
//
// action values and the role each requires:
//   create    sales, production, admin   - { so, article, warehouse, qty, reason? }
//   decide    supply, admin               - { id, decision: 'approved'|'rejected', reason? }
//   release   supply, admin               - { id }
import { requireRole } from '../../_lib/session.js';
import {
  listRequestsForSo,
  listBlockedByWarehouse,
  getStockPosition,
  createRequest,
  decide,
  release,
} from '../../_lib/stock-block.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const ROLE_FOR_ACTION = {
  create: ['sales', 'production', 'admin'],
  decide: ['supply', 'admin'],
  release: ['supply', 'admin'],
};

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const so = url.searchParams.get('so');
  const warehouse = url.searchParams.get('warehouse');
  const article = url.searchParams.get('article');

  try {
    if (article && warehouse) {
      const position = await getStockPosition(env.ERP_MIRROR, env.APP_DATA, article, warehouse);
      return json({ position });
    }
    if (warehouse) {
      const blocked = await listBlockedByWarehouse(env.APP_DATA, warehouse);
      return json({ blocked });
    }
    if (so) {
      const requests = await listRequestsForSo(env.APP_DATA, so);
      return json({ requests });
    }
    return errorJson('so, warehouse, or article and warehouse, is required', 400);
  } catch (e) {
    return errorJson(e.message, 400);
  }
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
  const allowedRoles = ROLE_FOR_ACTION[action];
  if (!allowedRoles) return errorJson(`Unknown action '${action}'`, 400);

  const auth = await requireRole(env.AUTH, bearerToken(request), allowedRoles);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  try {
    switch (action) {
      case 'create':
        return json({ request: await createRequest(env.APP_DATA, body, auth.user) }, 201);
      case 'decide':
        return json({ request: await decide(env.APP_DATA, body.id, body.decision, body.reason, auth.user) });
      case 'release':
        return json({ request: await release(env.APP_DATA, body.id, auth.user) });
      default:
        return errorJson(`Unknown action '${action}'`, 400);
    }
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
