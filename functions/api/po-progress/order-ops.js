// GET  /api/po-progress/order-ops?lineId={lineId}              -> { orderOps }  (any signed-in user)
// POST /api/po-progress/order-ops  { lineId, so, po, article, committedDate?, detail? } -> { orderOps }
//      sales, supply, admin - for PO lines that already exist in PO Summary
//      from day one (no request flow needed) and for editing detail/committed
//      date after a request-driven link has already happened.
import { requireRole } from '../../_lib/session.js';
import { getOrderOps, setOrderOps } from '../../_lib/po-progress.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const lineId = url.searchParams.get('lineId');
  if (!lineId) return errorJson('lineId is required', 400);
  const orderOps = await getOrderOps(env.APP_DATA, lineId);
  return json({ orderOps });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), ['sales', 'supply', 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { lineId } = body || {};
  if (!lineId) return errorJson('lineId is required', 400);

  const orderOps = await setOrderOps(env.APP_DATA, lineId, body, auth.user);
  return json({ orderOps });
}
