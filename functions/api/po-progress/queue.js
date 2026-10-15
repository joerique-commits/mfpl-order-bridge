// GET /api/po-progress/queue  -> { queue }   (supply, admin)
//
// Runs the matching engine fresh (auto-links what it can, creates/keeps
// loose-match suggestions for the rest) and returns every Unmatched-queue
// section from mfpl-source-linking-round3.md. See po-progress.js's
// getUnmatchedQueue() header note for the fidelity caveat on sections 3-5
// (SO/PO orphan detection depends on an ERP row date field whose real name
// isn't confirmed yet).
import { requireRole } from '../../_lib/session.js';
import { getUnmatchedQueue } from '../../_lib/po-progress.js';
import { getSetting } from '../../_lib/settings.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['supply', 'admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const golive = await getSetting(APP_DATA, 'golive_date');
  const queue = await getUnmatchedQueue(APP_DATA, ERP_MIRROR, golive ? golive.value : null);
  return json({ queue });
}
