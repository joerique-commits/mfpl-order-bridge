// POST /api/po-progress/links  { action, ...fields } -> { link } | { link, finalLink } | { link, request }
//      supply, admin for every action
//
// action values:
//   decide        { linkId, decision: 'confirmed'|'rejected'|'ignored', note? }
//   manual_link   { requestId, poRow: { PO, Qty, ... } }   - poRow is whatever
//                 row the caller looked up from GET /api/erp-mirror?key=po_summary
//                 client-side; passed through verbatim (field names are the
//                 FIELD_MAP-recognized ones, see po-progress.js header note)
//   undo_auto     { linkId }
import { requireRole } from '../../_lib/session.js';
import { decideLink, manualLink, undoAutoLink } from '../../_lib/po-progress.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['supply', 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { action } = body || {};
  if (!action) return errorJson('action is required', 400);

  try {
    if (action === 'decide') {
      if (!body.linkId || !body.decision) return errorJson('linkId and decision are required', 400);
      const result = await decideLink(APP_DATA, body.linkId, body.decision, auth.user, body.note);
      return json(result);
    }
    if (action === 'manual_link') {
      if (!body.requestId || !body.poRow) return errorJson('requestId and poRow are required', 400);
      const finalLink = await manualLink(APP_DATA, body.requestId, body.poRow, auth.user);
      return json({ link: finalLink });
    }
    if (action === 'undo_auto') {
      if (!body.linkId) return errorJson('linkId is required', 400);
      const result = await undoAutoLink(APP_DATA, body.linkId, auth.user);
      return json(result);
    }
    return errorJson(`Unknown action '${action}'`, 400);
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
