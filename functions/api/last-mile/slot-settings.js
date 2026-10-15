// GET  /api/last-mile/slot-settings           -> { settings }   (any signed-in user -
//      booking forms for every role need the configured windows/capacity/blocked dates)
// POST /api/last-mile/slot-settings { windows?, dispatchCapacityPerWindow?,
//      installCapacityPerWindow?, blockedDates? } -> { settings }   (admin only,
//      per mfpl-last-mile-ops-alignment.md's 9 Oct decision: "Admin only since 9 Oct")
import { requireRole } from '../../_lib/session.js';
import { getSlotSettings, setSlotSettings } from '../../_lib/last-mile.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const settings = await getSlotSettings(APP_DATA);
  return json({ settings });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), ['admin']);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const settings = await setSlotSettings(APP_DATA, body, auth.user);
  return json({ settings });
}
