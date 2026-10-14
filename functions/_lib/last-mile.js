// Last Mile Ops - spec: mfpl-last-mile-ops-alignment.md (8-9 Oct, slot
// booking + site details + calendar) + mfpl-prints-and-site-form-9oct.md
// (packing list / site form fields). Dispatch Day's own gate (payments,
// COO/Director approval, invoice/e-way) is a separate, much larger piece,
// built in dispatch-day.js, which reads bookings created here.
//
// Scope deliberately NOT built here (all explicitly client-side per spec):
// the OCR reader (pdf.js/Tesseract) that extracts address/mobile/dimensions
// from an SO/PI scan or a handover photo - this layer just stores whatever
// fields the client already extracted, same "store what the client sends"
// pattern as PO Progress Tracker's order_ops.detail. The Calendar tab's
// rendering (daily/weekly/monthly grids, chips, colors) is also client-side;
// listBookingsInRange() below is the data this layer owes that UI, not the
// UI itself.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   slotsettings:config                  -> { windows[], dispatchCapacityPerWindow,
//                                               installCapacityPerWindow, blockedDates[],
//                                               setBy, setAt }
//   sitedetails:{so}                      -> { so, poc, mobile, altPoc, gst, locationPin,
//                                               flat, floor, parking, lift:{type, dims},
//                                               truckAccess, deliveryDays, deliveryHours,
//                                               addressCorrection, notes, requiresReconfirm,
//                                               locked, lockedAt, setBy, setAt }
//   booking:{id}                          -> full booking record (below)
//   idx:booking_by_so:{so}:{id}           -> id
//   idx:booking_by_date:{date}:{id}       -> id   (capacity counting + calendar range reads)
//
// Booking record: {
//   id, type: 'dispatch' | 'installation',
//   so, date, window,                     // window is a plain label from slotsettings.windows
//   items: [{sku, qty}],                  // dispatch only - which SKUs/qty this trip carries
//   installationRequired,                 // dispatch only - spec's "(1) the dispatch carries
//                                          // installation required and a PO" option
//   installationPo,                       // dispatch only - shared with Dispatch Day, see below
//   linkedDispatchBookingId,              // installation only - which dispatch's flagged
//                                          // pieces this visit covers, null for "other products"
//   flaggedTagIds,                        // installation only - the specific warehouse tag ids
//                                          // this visit is for (installationFlag pieces)
//   reason,                               // required if the slot is after the client date, or
//                                          // for an "add another product" (non-flagged) visit
//   status: 'requested' | 'approved' | 'declined' | 'cancelled' |
//           'in_transit' | 'delivered' | 'delivered_installation_pending' |
//           'delivered_installed' | 'installed'   (installation bookings use
//           requested/approved/declined/cancelled/installed only)
//   vendor, trackingLink,                 // dispatch only, added on approval
//   pod: { type: 'photo'|'client_confirmation', photoFields: {date,po,receiver,mobile}|null,
//          reason: null|string, recordedBy, recordedAt } | null,
//   requestedBy, requestedAt, decidedBy, decidedAt, createdAt
// }

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId } from './crypto.js';
import { logEvent } from './activity.js';

const ACTIVE_HOLD_STATUSES = new Set(['requested', 'approved', 'in_transit']);

// --- Slot settings: admin only (9 Oct decision) -----------------------------
const SLOT_DEFAULTS = {
  windows: ['Morning', 'Afternoon', 'Evening'],
  dispatchCapacityPerWindow: 4,
  installCapacityPerWindow: 4,
  blockedDates: [],
};

export async function getSlotSettings(appDataKv) {
  const record = await getJSON(appDataKv, 'slotsettings:config');
  return record || { ...SLOT_DEFAULTS, setBy: null, setAt: null, isDefault: true };
}

export async function setSlotSettings(appDataKv, patch, actor) {
  const current = await getSlotSettings(appDataKv);
  const record = {
    windows: patch.windows || current.windows,
    dispatchCapacityPerWindow: patch.dispatchCapacityPerWindow ?? current.dispatchCapacityPerWindow,
    installCapacityPerWindow: patch.installCapacityPerWindow ?? current.installCapacityPerWindow,
    blockedDates: patch.blockedDates || current.blockedDates,
    setBy: { uid: actor.uid, name: actor.name },
    setAt: new Date().toISOString(),
  };
  await putJSON(appDataKv, 'slotsettings:config', record);
  return record;
}

// --- Site details ------------------------------------------------------------
// "The form locks once the first dispatch leaves; sales can reopen it."
export async function getSiteDetails(appDataKv, so) {
  return getJSON(appDataKv, `sitedetails:${safeKeyPart(so)}`);
}

export async function setSiteDetails(appDataKv, so, patch, actor) {
  const existing = (await getSiteDetails(appDataKv, so)) || { so, locked: false, requiresReconfirm: false };
  if (existing.locked && actor.role !== 'sales' && actor.role !== 'admin') {
    throw new Error('Site details are locked - only sales (or admin) can edit after the first dispatch has left');
  }
  const record = { ...existing, ...patch, so, setBy: { uid: actor.uid, name: actor.name }, setAt: new Date().toISOString() };
  await putJSON(appDataKv, `sitedetails:${safeKeyPart(so)}`, record);
  return record;
}

export async function lockSiteDetails(appDataKv, so) {
  const existing = (await getSiteDetails(appDataKv, so)) || { so };
  existing.locked = true;
  existing.lockedAt = new Date().toISOString();
  await putJSON(appDataKv, `sitedetails:${safeKeyPart(so)}`, existing);
  return existing;
}

export async function reopenSiteDetails(appDataKv, so, actor) {
  if (actor.role !== 'sales' && actor.role !== 'admin') throw new Error('Only sales (or admin) can reopen locked site details');
  const existing = (await getSiteDetails(appDataKv, so)) || { so };
  existing.locked = false;
  await putJSON(appDataKv, `sitedetails:${safeKeyPart(so)}`, existing);
  return existing;
}

// A lift-fit override (sales only, 3+ words) - spec: "If the customer's
// lift size changes and different items get flagged, sales must re-confirm."
// This just records the override text and flips a flag a caller can use to
// surface "needs re-confirmation"; the actual re-flagging logic (which items
// now need re-checking against the new lift size) is a client-side concern
// over warehouse tag data, not something this store can determine on its own.
export async function setLiftFitOverride(appDataKv, so, overrideText, actor) {
  if (actor.role !== 'sales' && actor.role !== 'admin') throw new Error('Only sales (or admin) can set a lift-fit override');
  const words = String(overrideText || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) throw new Error('Lift-fit override needs a reason of 3 or more words');
  const existing = (await getSiteDetails(appDataKv, so)) || { so };
  existing.liftFitOverride = { text: overrideText, by: { uid: actor.uid, name: actor.name }, at: new Date().toISOString() };
  existing.requiresReconfirm = false;
  await putJSON(appDataKv, `sitedetails:${safeKeyPart(so)}`, existing);
  return existing;
}

export async function flagReconfirmNeeded(appDataKv, so) {
  const existing = (await getSiteDetails(appDataKv, so)) || { so };
  existing.requiresReconfirm = true;
  await putJSON(appDataKv, `sitedetails:${safeKeyPart(so)}`, existing);
  return existing;
}

// --- Part-quantity holds -----------------------------------------------------
// "Held when the request is made; freed automatically on reject or cancel."
// Computed on the fly from active bookings rather than a separate counter,
// since EdgeOne KV has no atomic increment anyway (schema doc) - a scan over
// the by-SO index is the same cost as maintaining a counter correctly would
// be, without the extra write-consistency risk.
export async function computeHeldQty(appDataKv, so, sku) {
  const bookings = await listBookingsForSo(appDataKv, so);
  let held = 0;
  for (const b of bookings) {
    if (b.type !== 'dispatch' || !ACTIVE_HOLD_STATUSES.has(b.status)) continue;
    for (const item of b.items || []) {
      if (item.sku === sku) held += item.qty;
    }
  }
  return held;
}

// --- Bookings: shared helpers ------------------------------------------------
export async function getBooking(appDataKv, id) {
  return getJSON(appDataKv, `booking:${id}`);
}

export async function listBookingsForSo(appDataKv, so) {
  const bookings = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix: `idx:booking_by_so:${safeKeyPart(so)}:`, cursor });
    for (const entry of page.keys) {
      const id = entry.name.slice(entry.name.lastIndexOf(':') + 1);
      const booking = await getBooking(appDataKv, id);
      if (booking) bookings.push(booking);
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  return bookings;
}

// Calendar tab's data source - every booking whose date falls in [from, to].
// Walks the by-date index day by day rather than scanning every booking,
// since the index is already date-prefixed for exactly this purpose. Capped
// at 366 days per spec ("Ranges are capped at 366 days").
export async function listBookingsInRange(appDataKv, from, to) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new Error('from/to must be valid dates');
  if ((toMs - fromMs) / (24 * 60 * 60 * 1000) > 366) throw new Error('Range is capped at 366 days');

  const bookings = [];
  for (let ms = fromMs; ms <= toMs; ms += 24 * 60 * 60 * 1000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    let cursor;
    let done = false;
    while (!done) {
      const page = await appDataKv.list({ prefix: `idx:booking_by_date:${date}:`, cursor });
      for (const entry of page.keys) {
        const id = entry.name.slice(entry.name.lastIndexOf(':') + 1);
        const booking = await getBooking(appDataKv, id);
        // "Declined and cancelled bookings are hidden" (calendar spec)
        if (booking && booking.status !== 'declined' && booking.status !== 'cancelled') bookings.push(booking);
      }
      cursor = page.cursor;
      done = !page.hasMore || !cursor;
    }
  }
  return bookings;
}

export async function getCapacityForDate(appDataKv, date) {
  const settings = await getSlotSettings(appDataKv);
  const dayBookings = await listBookingsInRange(appDataKv, date, date);
  const dispatchCount = dayBookings.filter((b) => b.type === 'dispatch' && ACTIVE_HOLD_STATUSES.has(b.status)).length;
  const installCount = dayBookings.filter((b) => b.type === 'installation' && ACTIVE_HOLD_STATUSES.has(b.status)).length;
  return {
    date,
    dispatch: { used: dispatchCount, capacity: settings.dispatchCapacityPerWindow },
    installation: { used: installCount, capacity: settings.installCapacityPerWindow },
    blocked: (settings.blockedDates || []).includes(date),
  };
}

async function assertSlotAvailable(appDataKv, date, window, kind) {
  const settings = await getSlotSettings(appDataKv);
  if ((settings.blockedDates || []).includes(date)) throw new Error(`${date} is a blocked date`);
  const capacity = await getCapacityForDate(appDataKv, date);
  const bucket = kind === 'dispatch' ? capacity.dispatch : capacity.installation;
  if (bucket.used >= bucket.capacity) throw new Error(`No ${kind} capacity left on ${date} (${bucket.used}/${bucket.capacity})`);
}

async function saveBooking(appDataKv, booking) {
  await putJSON(appDataKv, `booking:${booking.id}`, booking);
  await appDataKv.put(`idx:booking_by_so:${safeKeyPart(booking.so)}:${booking.id}`, booking.id);
  await appDataKv.put(`idx:booking_by_date:${booking.date}:${booking.id}`, booking.id);
  return booking;
}

// --- Dispatch bookings --------------------------------------------------------
// "Slot after client date: allowed with a reason." Caller passes
// clientDate (from Order Deadlines) so this lib doesn't need its own
// cross-module read for a single comparison.
export async function requestDispatchBooking(appDataKv, input, actor, { clientDate } = {}) {
  const required = ['so', 'date', 'window', 'items'];
  for (const field of required) {
    if (!input[field]) throw new Error(`${field} is required`);
  }
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('At least one item is required');

  if (clientDate && Date.parse(input.date) > Date.parse(clientDate) && !input.reason) {
    throw new Error('A reason is required when booking a slot after the client date');
  }

  await assertSlotAvailable(appDataKv, input.date, input.window, 'dispatch');

  const booking = {
    id: randomId('bk'),
    type: 'dispatch',
    so: input.so,
    date: input.date,
    window: input.window,
    items: input.items,
    installationRequired: !!input.installationRequired,
    installationPo: input.installationPo || null,
    reason: input.reason || null,
    status: 'requested',
    vendor: null,
    trackingLink: null,
    pod: null,
    requestedBy: { uid: actor.uid, name: actor.name },
    requestedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_dispatch_booking',
    recordId: booking.id,
    so: input.so,
    title: `Dispatch slot requested for ${input.so}: ${input.date} (${input.window})`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: null, to: 'requested' }],
    roles: ['supply'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

// "Supply approves it and adds the vendor plus a tracking link or POC."
export async function approveDispatchBooking(appDataKv, id, { vendor, trackingLink }, actor) {
  const booking = await getBooking(appDataKv, id);
  if (!booking) throw new Error(`Booking ${id} not found`);
  if (booking.type !== 'dispatch') throw new Error(`Booking ${id} is not a dispatch booking`);
  if (booking.status !== 'requested') throw new Error(`Booking ${id} is not awaiting approval (status: ${booking.status})`);
  if (!vendor) throw new Error('vendor is required to approve a dispatch booking');

  booking.status = 'approved';
  booking.vendor = vendor;
  booking.trackingLink = trackingLink || null;
  booking.decidedBy = { uid: actor.uid, name: actor.name };
  booking.decidedAt = new Date().toISOString();
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_dispatch_booking',
    recordId: id,
    so: booking.so,
    title: `Dispatch slot approved for ${booking.so}: ${booking.date} (${booking.window})`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'requested', to: 'approved' }],
    roles: ['sales'],
    participants: [booking.requestedBy.uid].filter((uid) => uid !== actor.uid),
    exceptions: false,
  });

  return booking;
}

// Shared decline/cancel path for both booking types - frees the held
// quantity automatically, per spec, simply by changing status (computeHeldQty
// only counts ACTIVE_HOLD_STATUSES, so there's nothing further to "free").
async function endBooking(appDataKv, id, newStatus, actor, reason) {
  const booking = await getBooking(appDataKv, id);
  if (!booking) throw new Error(`Booking ${id} not found`);
  if (!ACTIVE_HOLD_STATUSES.has(booking.status)) throw new Error(`Booking ${id} is already ${booking.status}`);
  const from = booking.status;
  booking.status = newStatus;
  booking.decidedBy = { uid: actor.uid, name: actor.name };
  booking.decidedAt = new Date().toISOString();
  if (reason) booking.declineReason = reason;
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: booking.type === 'dispatch' ? 'lm_dispatch_booking' : 'lm_installation_booking',
    recordId: id,
    so: booking.so,
    title: `${booking.type === 'dispatch' ? 'Dispatch' : 'Installation'} booking ${newStatus} for ${booking.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from, to: newStatus }],
    roles: ['sales', 'supply'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

export async function declineDispatchBooking(appDataKv, id, actor, reason) {
  return endBooking(appDataKv, id, 'declined', actor, reason);
}
export async function cancelDispatchBooking(appDataKv, id, actor, reason) {
  return endBooking(appDataKv, id, 'cancelled', actor, reason);
}

// "Mark dispatched" - this lib only flips the status; the actual HARD GATE
// (every Dispatch Day check cleared) is enforced by the caller (the
// endpoint), which calls dispatch-day.js's isReadyToDispatch() first. Kept
// separate so last-mile.js has no dependency on dispatch-day.js.
export async function markDispatched(appDataKv, id, actor) {
  const booking = await getBooking(appDataKv, id);
  if (!booking) throw new Error(`Booking ${id} not found`);
  if (booking.type !== 'dispatch') throw new Error(`Booking ${id} is not a dispatch booking`);
  if (booking.status !== 'approved') throw new Error(`Booking ${id} must be approved before it can be dispatched (status: ${booking.status})`);

  booking.status = 'in_transit';
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_dispatch_booking',
    recordId: id,
    so: booking.so,
    title: `Dispatch marked in transit for ${booking.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'approved', to: 'in_transit' }],
    roles: ['sales'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

// POD: "Either a handover photo (OCR reads date/PO/receiver/mobile where it
// can) or 'POD received from client' plus a reason." hasFlaggedInstallation
// tells this call whether to land on 'delivered_installation_pending' or
// 'delivered' - the caller works that out from the booking's items against
// warehouse tags' installationFlag (a cross-module read this lib doesn't do
// on its own, consistent with keeping last-mile.js's own dependencies thin).
export async function recordPod(appDataKv, id, pod, actor, { hasFlaggedInstallation = false } = {}) {
  const booking = await getBooking(appDataKv, id);
  if (!booking) throw new Error(`Booking ${id} not found`);
  if (booking.status !== 'in_transit') throw new Error(`Booking ${id} is not in transit (status: ${booking.status})`);
  if (pod.type === 'client_confirmation' && !pod.reason) throw new Error('A reason is required for "POD received from client"');

  booking.pod = { ...pod, recordedBy: { uid: actor.uid, name: actor.name }, recordedAt: new Date().toISOString() };
  booking.status = hasFlaggedInstallation ? 'delivered_installation_pending' : 'delivered';
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_dispatch_booking',
    recordId: id,
    so: booking.so,
    title: `POD recorded for ${booking.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'in_transit', to: booking.status }],
    roles: ['sales', 'supply'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

// "Installed on the same visit" shortcut - supply can close out the
// installation-pending status directly without a separate installation
// booking, per the status-flow note ("or supply clicked 'Installed on the
// same visit'").
export async function markInstalledOnSameVisit(appDataKv, dispatchBookingId, actor) {
  const booking = await getBooking(appDataKv, dispatchBookingId);
  if (!booking) throw new Error(`Booking ${dispatchBookingId} not found`);
  if (booking.status !== 'delivered_installation_pending') throw new Error(`Booking ${dispatchBookingId} is not awaiting installation (status: ${booking.status})`);

  booking.status = 'delivered_installed';
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_dispatch_booking',
    recordId: dispatchBookingId,
    so: booking.so,
    title: `Installed on the same visit for ${booking.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'delivered_installation_pending', to: 'delivered_installed' }],
    roles: ['sales', 'supply'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

// --- Installation visit bookings ---------------------------------------------
// "Only flagged pieces on an approved dispatch can be booked. The visit date
// must be on or after that dispatch date (same day is OK). Non-flagged
// 'other' products are not tied to a dispatch" (but need a reason, per the
// listing rule: "'Add another product' shows the rest and needs a reason").
export async function requestInstallationVisit(appDataKv, input, actor) {
  const required = ['so', 'date', 'window'];
  for (const field of required) {
    if (!input[field]) throw new Error(`${field} is required`);
  }

  if (input.linkedDispatchBookingId) {
    const dispatch = await getBooking(appDataKv, input.linkedDispatchBookingId);
    if (!dispatch) throw new Error('Linked dispatch booking not found');
    if (dispatch.type !== 'dispatch' || dispatch.status === 'requested' || dispatch.status === 'declined' || dispatch.status === 'cancelled') {
      throw new Error('Flagged pieces can only be booked for installation against an approved (or further-along) dispatch');
    }
    if (Date.parse(input.date) < Date.parse(dispatch.date)) {
      throw new Error("The installation visit date must be on or after the dispatch's date");
    }
  } else if (!input.reason) {
    throw new Error('A reason is required for an installation visit not tied to a flagged dispatch piece ("add another product")');
  }

  await assertSlotAvailable(appDataKv, input.date, input.window, 'installation');

  const booking = {
    id: randomId('bk'),
    type: 'installation',
    so: input.so,
    date: input.date,
    window: input.window,
    linkedDispatchBookingId: input.linkedDispatchBookingId || null,
    flaggedTagIds: input.flaggedTagIds || [],
    reason: input.reason || null,
    status: 'requested',
    requestedBy: { uid: actor.uid, name: actor.name },
    requestedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  };
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_installation_booking',
    recordId: booking.id,
    so: input.so,
    title: `Installation visit requested for ${input.so}: ${input.date} (${input.window})`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: null, to: 'requested' }],
    roles: ['supply'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

export async function approveInstallationVisit(appDataKv, id, actor) {
  const booking = await getBooking(appDataKv, id);
  if (!booking) throw new Error(`Booking ${id} not found`);
  if (booking.type !== 'installation') throw new Error(`Booking ${id} is not an installation booking`);
  if (booking.status !== 'requested') throw new Error(`Booking ${id} is not awaiting approval (status: ${booking.status})`);

  booking.status = 'approved';
  booking.decidedBy = { uid: actor.uid, name: actor.name };
  booking.decidedAt = new Date().toISOString();
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_installation_booking',
    recordId: id,
    so: booking.so,
    title: `Installation visit approved for ${booking.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'requested', to: 'approved' }],
    roles: ['sales'],
    participants: [booking.requestedBy.uid].filter((uid) => uid !== actor.uid),
    exceptions: false,
  });

  return booking;
}

export async function declineInstallationVisit(appDataKv, id, actor, reason) {
  return endBooking(appDataKv, id, 'declined', actor, reason);
}
export async function cancelInstallationVisit(appDataKv, id, actor, reason) {
  return endBooking(appDataKv, id, 'cancelled', actor, reason);
}

export async function markInstalled(appDataKv, id, actor) {
  const booking = await getBooking(appDataKv, id);
  if (!booking) throw new Error(`Booking ${id} not found`);
  if (booking.type !== 'installation') throw new Error(`Booking ${id} is not an installation booking`);
  if (booking.status !== 'approved') throw new Error(`Booking ${id} must be approved before it can be marked installed (status: ${booking.status})`);

  booking.status = 'installed';
  await saveBooking(appDataKv, booking);

  await logEvent(appDataKv, {
    recordType: 'lm_installation_booking',
    recordId: id,
    so: booking.so,
    title: `Installation visit completed for ${booking.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'approved', to: 'installed' }],
    roles: ['sales'],
    participants: [],
    exceptions: false,
  });

  return booking;
}

export { ACTIVE_HOLD_STATUSES };
