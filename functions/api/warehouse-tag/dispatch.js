// POST /api/warehouse-tag/dispatch  { tagIds: [...], batchNo, vehicleNo, driverName }  -> { challan }
import { requireRole } from '../../_lib/session.js';
import { createChallan } from '../../_lib/warehouse-tag.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), ['supply', 'production', 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  try {
    const challan = await createChallan(env.APP_DATA, body, auth.user);
    return json({ challan }, 201);
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
