// GET  /api/last-mile/bookings?so={so}                     -> { bookings }  (any signed-in user)
//      /api/last-mile/bookings?from={date}&to={date}        -> { bookings }  (Calendar tab data;
//      capped at 366 days per spec; declined/cancelled bookings are excluded)
// POST /api/last-mile/bookings  { action, ...fields }       -> { booking }
//
// action values and the role each requires:
//   request_dispatch          sales, admin
//   approve_dispatch          supply, admin   - { id, vendor, trackingLink? }
//   decline_dispatch          supply, admin   - { id, reason? }
//   cancel_dispatch           sales, supply, admin - { id, reason? }
//   mark_dispatched           supply, admin   - { id }  (HARD GATE: Dispatch Day record
//                             must be ready, or an admin override must be on file - see
//                             dispatch-day.js. Checked here, not just left to the client.)
//   record_pod                supply, admin   - { id, pod: {...}, hasFlaggedInstallation? }
//   mark_installed_same_visit supply, admin   - { id }
//   request_installation      sales, admin
//   approve_installation      supply, admin   - { id }
//   decline_installation      supply, admin   - { id, reason? }
//   cancel_installation       sales, supply, admin - { id, reason? }
//   mark_installed            supply, admin   - { id }
import { requireRole } from '../../_lib/session.js';
import {
  listBookingsForSo,
  listBookingsInRange,
  requestDispatchBooking,
  approveDispatchBooking,
  declineDispatchBooking,
  cancelDispatchBooking,
  markDispatched,
  recordPod,
  markInstalledOnSameVisit,
  requestInstallationVisit,
  approveInstallationVisit,
  declineInstallationVisit,
  cancelInstallationVisit,
  markInstalled,
} from '../../_lib/last-mile.js';
import { getRecord as getDispatchDayRecord, isReadyToDispatch } from '../../_lib/dispatch-day.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const ROLE_FOR_ACTION = {
  request_dispatch: ['sales', 'admin'],
  approve_dispatch: ['supply', 'admin'],
  decline_dispatch: ['supply', 'admin'],
  cancel_dispatch: ['sales', 'supply', 'admin'],
  mark_dispatched: ['supply', 'admin'],
  record_pod: ['supply', 'admin'],
  mark_installed_same_visit: ['supply', 'admin'],
  request_installation: ['sales', 'admin'],
  approve_installation: ['supply', 'admin'],
  decline_installation: ['supply', 'admin'],
  cancel_installation: ['sales', 'supply', 'admin'],
  mark_installed: ['supply', 'admin'],
};

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const so = url.searchParams.get('so');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  try {
    if (so) {
      const bookings = await listBookingsForSo(env.APP_DATA, so);
      return json({ bookings });
    }
    if (from && to) {
      const bookings = await listBookingsInRange(env.APP_DATA, from, to);
      return json({ bookings });
    }
    return errorJson('so, or from and to, is required', 400);
  } catch (e) {
    return errorJson(e.message, 400);
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { action } = body || {};
  if (!action) return errorJson('action is required', 400);
  const allowedRoles = ROLE_FOR_ACTION[action];
  if (!allowedRoles) return errorJson(`Unknown action '${action}'`, 400);

  const auth = await requireRole(env.AUTH, bearerToken(request), allowedRoles);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  try {
    switch (action) {
      case 'request_dispatch': {
        const booking = await requestDispatchBooking(env.APP_DATA, body, auth.user, { clientDate: body.clientDate });
        return json({ booking }, 201);
      }
      case 'approve_dispatch':
        return json({ booking: await approveDispatchBooking(env.APP_DATA, body.id, body, auth.user) });
      case 'decline_dispatch':
        return json({ booking: await declineDispatchBooking(env.APP_DATA, body.id, auth.user, body.reason) });
      case 'cancel_dispatch':
        return json({ booking: await cancelDispatchBooking(env.APP_DATA, body.id, auth.user, body.reason) });
      case 'mark_dispatched': {
        const ddRecord = await getDispatchDayRecord(env.APP_DATA, body.id);
        const gate = ddRecord ? isReadyToDispatch(ddRecord) : { ready: false, reason: 'no Dispatch Day record exists for this booking yet' };
        if (!gate.ready) return errorJson(`Dispatch Day checks pending: ${gate.reason}`, 409);
        return json({ booking: await markDispatched(env.APP_DATA, body.id, auth.user) });
      }
      case 'record_pod':
        return json({ booking: await recordPod(env.APP_DATA, body.id, body.pod, auth.user, { hasFlaggedInstallation: !!body.hasFlaggedInstallation }) });
      case 'mark_installed_same_visit':
        return json({ booking: await markInstalledOnSameVisit(env.APP_DATA, body.id, auth.user) });
      case 'request_installation': {
        const booking = await requestInstallationVisit(env.APP_DATA, body, auth.user);
        return json({ booking }, 201);
      }
      case 'approve_installation':
        return json({ booking: await approveInstallationVisit(env.APP_DATA, body.id, auth.user) });
      case 'decline_installation':
        return json({ booking: await declineInstallationVisit(env.APP_DATA, body.id, auth.user, body.reason) });
      case 'cancel_installation':
        return json({ booking: await cancelInstallationVisit(env.APP_DATA, body.id, auth.user, body.reason) });
      case 'mark_installed':
        return json({ booking: await markInstalled(env.APP_DATA, body.id, auth.user) });
      default:
        return errorJson(`Unknown action '${action}'`, 400);
    }
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
