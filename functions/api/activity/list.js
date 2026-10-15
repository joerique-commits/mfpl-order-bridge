// GET /api/activity/list  -> { yourActivity: [...], inYourArea: [...] }
// "Your activity" (level 1) = events where you're a participant.
// "In your area" (level 2) = events visible to your role (admin sees all,
// via the 'admin' fan-out every event gets - see activity.js).
// Both are already filtered to the last 30 days by listByRole/listByParticipant.
import { requireRole } from '../../_lib/session.js';
import { listByRole, listByParticipant } from '../../_lib/activity.js';
import { json, errorJson, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const [inYourArea, yourActivity] = await Promise.all([
    listByRole(APP_DATA, auth.user.role),
    listByParticipant(APP_DATA, auth.user.uid),
  ]);

  return json({ yourActivity, inYourArea });
}
