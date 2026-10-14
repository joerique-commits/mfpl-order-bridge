// GET /api/last-mile/capacity?date={date}  -> { capacity }   (any signed-in user)
// Per-day dispatch/installation slot usage vs configured capacity, plus
// whether the date is blocked - the "D 1/4 . I 0/4" line on the Calendar tab.
import { requireRole } from '../../_lib/session.js';
import { getCapacityForDate } from '../../_lib/last-mile.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date) return errorJson('date is required', 400);
  const capacity = await getCapacityForDate(env.APP_DATA, date);
  return json({ capacity });
}
