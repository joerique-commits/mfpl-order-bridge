// GET /api/erp-mirror?key={datasetKey}   -> { meta, rows }   (any signed-in user)
// GET /api/erp-mirror                    -> { datasets: [meta, ...] }  (any signed-in user;
//                                             meta-only list for the Admin Uploads screen)
import { requireRole } from '../../_lib/session.js';
import { getDataset, listDatasetMeta } from '../../_lib/erp-mirror.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) {
    const datasets = await listDatasetMeta(env.ERP_MIRROR);
    return json({ datasets });
  }

  const dataset = await getDataset(env.ERP_MIRROR, key);
  if (!dataset) return errorJson(`Dataset '${key}' has not been uploaded yet`, 404);
  return json(dataset);
}
