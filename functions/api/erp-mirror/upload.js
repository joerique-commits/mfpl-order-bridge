// POST /api/erp-mirror/upload  { datasetKey, originalName, rows }  (admin only)
// rows must already be parsed JSON (the admin's browser parses the uploaded
// .xlsx client-side - see erp-mirror.js header note). Overwrites the whole
// dataset; there is no partial/merge upload.
import { requireRole } from '../../_lib/session.js';
import { uploadDataset } from '../../_lib/erp-mirror.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }

  const { datasetKey, originalName, rows } = body || {};
  if (!datasetKey || !rows) return errorJson('datasetKey and rows are required', 400);

  try {
    const meta = await uploadDataset(env.ERP_MIRROR, { datasetKey, originalName, rows }, auth.user);
    return json({ meta });
  } catch (e) {
    return errorJson(e.message, 400);
  }
}
