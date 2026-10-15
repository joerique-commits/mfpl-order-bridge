// GET /api/payables?from=&to=&cutoff=   -> { view }   (any signed-in user)
//
// Pure computed view - no writes exist for this module (see payables.js
// header note). Recomputes everything fresh from the ERP mirror datasets on
// every call; nothing is cached or stored.
import { requireRole } from '../../_lib/session.js';
import { buildPayablesView, DEFAULT_CUTOFF_DATE } from '../../_lib/payables.js';
import { buildLineId } from '../../_lib/po-progress.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const cutoffDate = url.searchParams.get('cutoff') || DEFAULT_CUTOFF_DATE;

  const view = await buildPayablesView(APP_DATA, ERP_MIRROR, { buildLineId, cutoffDate, from, to });
  return json({ view });
}
