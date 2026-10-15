// GET  /api/last-mile/site-details?so={so}                -> { details }   (any signed-in user)
// POST /api/last-mile/site-details  { action, so, ... }    -> { details }
//
// action values:
//   set            sales, admin  - { so, ...fields }  (refused once locked, unless admin)
//   lock           supply, admin - { so }  (called when the first dispatch leaves)
//   reopen         sales, admin  - { so }
//   lift_override  sales, admin  - { so, text }  (3+ words)
//   flag_reconfirm supply, admin - { so }  (lift size changed -> different items flagged)
import { requireRole } from '../../_lib/session.js';
import { getSiteDetails, setSiteDetails, lockSiteDetails, reopenSiteDetails, setLiftFitOverride, flagReconfirmNeeded } from '../../_lib/last-mile.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url);
  const so = url.searchParams.get('so');
  if (!so) return errorJson('so is required', 400);
  const details = await getSiteDetails(APP_DATA, so);
  return json({ details });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { action, so } = body || {};
  if (!action || !so) return errorJson('action and so are required', 400);

  try {
    if (action === 'set') {
      const auth = await requireRole(AUTH, bearerToken(request), ['sales', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      const details = await setSiteDetails(APP_DATA, so, body, auth.user);
      return json({ details });
    }
    if (action === 'lock') {
      const auth = await requireRole(AUTH, bearerToken(request), ['supply', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      const details = await lockSiteDetails(APP_DATA, so);
      return json({ details });
    }
    if (action === 'reopen') {
      const auth = await requireRole(AUTH, bearerToken(request), ['sales', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      const details = await reopenSiteDetails(APP_DATA, so, auth.user);
      return json({ details });
    }
    if (action === 'lift_override') {
      const auth = await requireRole(AUTH, bearerToken(request), ['sales', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      const details = await setLiftFitOverride(APP_DATA, so, body.text, auth.user);
      return json({ details });
    }
    if (action === 'flag_reconfirm') {
      const auth = await requireRole(AUTH, bearerToken(request), ['supply', 'admin']);
      if (!auth.ok) return errorJson(auth.error, auth.status);
      const details = await flagReconfirmNeeded(APP_DATA, so);
      return json({ details });
    }
    return errorJson(`Unknown action '${action}'`, 400);
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
