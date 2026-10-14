// Order Deadlines negotiation - spec: mfpl-order-deadlines-v2.md.
// Scope per spec: applies only to MFPL factory product lines, PO-confirmed,
// tied to an open DPI SO, PO raised on/after go-live - that filtering happens
// client-side against the ERP mirror (which lines qualify); this module only
// stores and evolves the negotiation STATE for a given line once it exists.
//
// Storage is always the real, unshifted date. The role-shifted display dates
// (client -5/+5 per viewer, spec's table) are presentation-only and are
// deliberately NOT computed here - that's client-side rendering.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   podeadline:{po}   -> { po, outerDate: ISO|null, setBy:{uid,name}, setAt }
//   neg:{lineId}      -> full negotiation record (lineId is caller-supplied,
//                         e.g. "{so}__{po}__{article}" matching PO Progress
//                         Tracker's poconf key, so the two modules can refer
//                         to the same line consistently)
//
// Negotiation record:
//   {
//     id, lineId, po, so, sku,
//     poDate,                 // ISO, snapshotted at creation - needed for the
//                              // 20-day window calc without an extra ERP read
//     clientDate: ISO|null,   // sales input
//     factoryDate: ISO|null,  // closed/binding factory date
//     status: 'open'|'factory_proposed'|'sales_countered'|'closed',
//     round: 0|1|2,           // how many factory proposals have been made
//     proposal: { by, at, date, reason, from } | null,  // pending, awaiting a response
//     deviation: boolean,     // true once closed via the post-window "deviation" path
//     r5: boolean,            // true when factoryDate + 5 > clientDate (flag, not blocking)
//     history: [{ type, by, at, date, reason }],
//     createdAt,
//   }

import { getJSON, putJSON } from './kv.js';
import { randomId } from './crypto.js';
import { logEvent } from './activity.js';

const WINDOW_DAYS = 20;
const DEVIATION_LOCK_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}
function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);
}
function computeR5(factoryDate, clientDate) {
  if (!factoryDate || !clientDate) return false;
  return new Date(addDays(factoryDate, 5)).getTime() > new Date(clientDate).getTime();
}

export async function setPoOuterLimit(appDataKv, po, outerDate, actor) {
  const record = { po, outerDate, setBy: { uid: actor.uid, name: actor.name }, setAt: new Date().toISOString() };
  await putJSON(appDataKv, `podeadline:${po}`, record);
  return record;
}

export async function getPoOuterLimit(appDataKv, po) {
  return getJSON(appDataKv, `podeadline:${po}`);
}

export async function getOrCreateNegotiation(appDataKv, { lineId, po, so, sku, poDate, clientDate }) {
  const existing = await getJSON(appDataKv, `neg:${lineId}`);
  if (existing) return existing;
  const record = {
    id: randomId('neg'),
    lineId,
    po,
    so,
    sku,
    poDate,
    clientDate: clientDate || null,
    factoryDate: null,
    status: 'open',
    round: 0,
    proposal: null,
    deviation: false,
    r5: false,
    history: [],
    createdAt: new Date().toISOString(),
  };
  await putJSON(appDataKv, `neg:${lineId}`, record);
  return record;
}

// Idempotent - safe to call on every read. Mutates and persists if the
// 20-day auto-accept rule now applies; otherwise a no-op. No scheduler
// exists on free-tier EdgeOne (per schema doc), so this is evaluated lazily
// wherever a negotiation record is read, same pattern as the rest of the app.
export async function applyAutoAcceptIfDue(appDataKv, negotiation) {
  if (negotiation.status === 'closed') return negotiation;
  if (negotiation.factoryDate) return negotiation; // already has a factory date, window rule doesn't apply
  if (!negotiation.clientDate) return negotiation; // spec: no client date at day 20 -> stays open
  if (daysBetween(negotiation.poDate, new Date().toISOString()) < WINDOW_DAYS) return negotiation;

  negotiation.factoryDate = addDays(negotiation.clientDate, -5);
  negotiation.status = 'closed';
  negotiation.r5 = false; // auto-accept sets exactly C-5, can't itself trigger the r5 flag
  negotiation.history.push({
    type: 'auto_accept',
    by: null,
    at: new Date().toISOString(),
    date: negotiation.factoryDate,
    reason: `Automatic / System (${WINDOW_DAYS}-day rule)`,
  });
  await putJSON(appDataKv, `neg:${negotiation.lineId}`, negotiation);
  return negotiation;
}

function assertWithinOuterLimit(outerLimit, date) {
  if (outerLimit && outerLimit.outerDate && new Date(date).getTime() > new Date(outerLimit.outerDate).getTime()) {
    throw new Error(`Date ${date} is later than the PO's outer limit (${outerLimit.outerDate})`);
  }
}

// Factory proposes a date. role 'production' = factory in this app's role
// vocabulary (see admin/users.js); 'admin' may always propose, bypassing the
// 20-day window per spec ("Admin can propose any time, even after the date").
export async function factoryPropose(appDataKv, { lineId, date, reason }, actor, outerLimit) {
  if (!reason) throw new Error('A reason is required to propose a date');
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  if (neg.status === 'closed' && !neg.factoryDate) throw new Error('Cannot propose on a closed line with no factory date'); // shouldn't happen
  if (neg.status === 'factory_proposed') throw new Error('A factory proposal is already pending');

  assertWithinOuterLimit(outerLimit, date);

  const withinWindow = daysBetween(neg.poDate, new Date().toISOString()) <= WINDOW_DAYS;
  const isDeviationRequest = neg.status === 'closed'; // proposing again after a prior closure = a deviation request
  if (isDeviationRequest) {
    if (actor.role !== 'admin' && !withinWindow) {
      // Post-window deviation is allowed, UNLESS within the 10-day lock of the confirmed date.
      const daysToConfirmed = daysBetween(new Date().toISOString(), neg.factoryDate);
      if (daysToConfirmed <= DEVIATION_LOCK_DAYS) {
        throw new Error(`Deviation requests are blocked within ${DEVIATION_LOCK_DAYS} days of the confirmed date`);
      }
    }
  } else if (!withinWindow && actor.role !== 'admin') {
    // First-time proposal past the 20-day window, by a non-admin: spec doesn't
    // explicitly forbid this (it only describes the deviation path for
    // *after* the window), but a still-open line past day 20 should have
    // already been auto-accepted by applyAutoAcceptIfDue if a client date
    // exists. If it hasn't (no client date yet), factory proposing late is
    // allowed - nothing in the spec blocks it.
  }

  const round = isDeviationRequest ? 1 : neg.round + 1; // a deviation request restarts the round count
  if (round > 2) throw new Error('Factory has already made its second proposal for this round');

  neg.status = 'factory_proposed';
  neg.round = round;
  neg.proposal = { by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date, reason, from: neg.factoryDate };
  if (isDeviationRequest) neg.deviation = true;
  neg.history.push({ type: 'factory_proposed', by: neg.proposal.by, at: neg.proposal.at, date, reason });
  await putJSON(appDataKv, `neg:${lineId}`, neg);

  await logEvent(appDataKv, {
    recordType: 'order_deadline',
    recordId: lineId,
    so: neg.so,
    title: `Factory proposed a date for PO ${neg.po} / ${neg.sku}: ${date}`,
    by: neg.proposal.by,
    changes: [{ field: 'factoryDate (proposed)', from: neg.factoryDate, to: date }],
    roles: ['sales', 'supply', 'production'],
    participants: [],
    exceptions: isDeviationRequest,
  });

  return neg;
}

// Sales responds to a pending factory proposal: accept, or counter with
// their own date (becomes the pending proposal for factory's turn).
export async function salesRespond(appDataKv, { lineId, accept, counterDate }, actor) {
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  if (neg.status !== 'factory_proposed') throw new Error(`Nothing pending for sales to respond to (status '${neg.status}')`);

  if (accept) {
    neg.factoryDate = neg.proposal.date;
    neg.status = 'closed';
    neg.r5 = computeR5(neg.factoryDate, neg.clientDate);
    neg.history.push({ type: 'sales_accepted', by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date: neg.factoryDate });
    neg.proposal = null;
  } else {
    if (!counterDate) throw new Error('counterDate is required when rejecting a factory proposal');
    if (neg.round >= 2) throw new Error("Sales must either accept or set a final binding date - factory's second proposal can't be countered again");
    neg.status = 'sales_countered';
    neg.proposal = { by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date: counterDate, reason: null, from: neg.proposal.date };
    neg.history.push({ type: 'sales_countered', by: neg.proposal.by, at: neg.proposal.at, date: counterDate });
  }
  await putJSON(appDataKv, `neg:${lineId}`, neg);

  await logEvent(appDataKv, {
    recordType: 'order_deadline',
    recordId: lineId,
    so: neg.so,
    title: accept ? `Sales accepted the factory date for PO ${neg.po} / ${neg.sku}` : `Sales countered for PO ${neg.po} / ${neg.sku}: ${counterDate}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'factory_proposed', to: neg.status }],
    roles: ['sales', 'supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return neg;
}

// Factory's turn after a sales counter: accept sales' date, or make their
// one allowed second proposal (must differ from sales' date).
export async function factoryRespond(appDataKv, { lineId, accept, counterDate, reason }, actor, outerLimit) {
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  if (neg.status !== 'sales_countered') throw new Error(`Nothing pending for factory to respond to (status '${neg.status}')`);

  if (accept) {
    neg.factoryDate = neg.proposal.date;
    neg.status = 'closed';
    neg.r5 = computeR5(neg.factoryDate, neg.clientDate);
    neg.history.push({ type: 'factory_accepted', by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date: neg.factoryDate });
    neg.proposal = null;
  } else {
    if (!counterDate) throw new Error('counterDate is required');
    if (counterDate === neg.proposal.date) throw new Error("Factory's second proposal must differ from sales' date");
    assertWithinOuterLimit(outerLimit, counterDate);
    neg.round = 2;
    neg.status = 'factory_proposed';
    neg.proposal = { by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date: counterDate, reason: reason || null, from: neg.proposal.date };
    neg.history.push({ type: 'factory_proposed', by: neg.proposal.by, at: neg.proposal.at, date: counterDate, reason });
  }
  await putJSON(appDataKv, `neg:${lineId}`, neg);
  return neg;
}

// Sales sets the final date unilaterally - binding, ends negotiation
// regardless of where it was.
export async function salesSetFinal(appDataKv, { lineId, date }, actor) {
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  neg.factoryDate = date;
  neg.status = 'closed';
  neg.proposal = null;
  neg.r5 = computeR5(neg.factoryDate, neg.clientDate);
  neg.history.push({ type: 'sales_final', by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date });
  await putJSON(appDataKv, `neg:${lineId}`, neg);
  return neg;
}

// "Agree to the client dates (-5)" shortcut - factory closes immediately at
// clientDate - 5, bypassing negotiation. Usable for a single SKU; a whole-PO
// version is just this called once per line on the caller's side (no
// separate server concept needed - each line is independent state here).
export async function factoryAgreeToClientDate(appDataKv, lineId, actor) {
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  if (!neg.clientDate) throw new Error('No client date set on this line yet');
  neg.factoryDate = addDays(neg.clientDate, -5);
  neg.status = 'closed';
  neg.proposal = null;
  neg.r5 = false;
  neg.history.push({ type: 'factory_agreed_to_client_date', by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date: neg.factoryDate });
  await putJSON(appDataKv, `neg:${lineId}`, neg);
  return neg;
}

// Proposer withdraws a pending proposal - reverts to 'open' (if it was the
// first proposal) or back to 'sales_countered'/etc as appropriate. Simplest
// correct behavior: withdrawing always reverts to whatever status existed
// immediately before the pending proposal, which is recoverable from the
// proposal's `from` field plus the round count.
export async function withdrawProposal(appDataKv, lineId, actor) {
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  if (!neg.proposal) throw new Error('Nothing pending to withdraw');
  if (neg.proposal.by.uid !== actor.uid && actor.role !== 'admin') {
    throw new Error('Only the proposer (or admin) can withdraw a pending proposal');
  }

  const wasFirstEverProposal = neg.round === 1 && neg.status === 'factory_proposed' && !neg.history.some((h) => h.type === 'sales_countered');
  neg.history.push({ type: 'withdrawn', by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date: neg.proposal.date });
  if (wasFirstEverProposal) {
    neg.status = 'open';
    neg.round = 0;
  } else {
    // Withdrawing a counter or a second proposal reverts to the state the
    // *other* side's prior proposal left things in.
    neg.status = neg.round === 2 ? 'sales_countered' : 'factory_proposed';
  }
  neg.proposal = null;
  await putJSON(appDataKv, `neg:${lineId}`, neg);
  return neg;
}

// Sales edits the client date directly (not through negotiation). Per spec:
// doesn't touch factoryDate, just recomputes the r5 flag.
export async function setClientDate(appDataKv, lineId, date, actor) {
  const neg = await getJSON(appDataKv, `neg:${lineId}`);
  if (!neg) throw new Error('Negotiation record not found');
  neg.clientDate = date;
  neg.r5 = computeR5(neg.factoryDate, neg.clientDate);
  neg.history.push({ type: 'client_date_set', by: { uid: actor.uid, name: actor.name, role: actor.role }, at: new Date().toISOString(), date });
  await putJSON(appDataKv, `neg:${lineId}`, neg);
  return neg;
}
