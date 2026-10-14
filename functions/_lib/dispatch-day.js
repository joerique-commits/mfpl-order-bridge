// Last Mile Ops: Dispatch Day gate - spec: mfpl-dispatch-day.md (9-10 Oct).
// The checks that must clear before a dispatch booking (last-mile.js) can be
// marked dispatched: payments vs balance, a COO/Director approval for any
// shortfall, supply's ERP numbers, and invoice + e-way bill. One record per
// dispatch booking.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   dispatchday:{bookingId}   -> full record (below)
//   idx:dispatchday_by_so:{so}:{bookingId} -> bookingId
//
// Record: {
//   id (= bookingId), so, bookingId,
//   balance: { totalInclGst, collectedSnapshot, otherConfirmedPayments, amount },
//   payments: [{ id, amount, date, mode, details, addedBy, addedAt,
//                status: 'pending'|'confirmed'|'sent_back', sentBackReason,
//                confirmedBy, confirmedAt, reopenedAt }],
//   approval: { token, reason, approvedAmount, createdBy, createdAt, expiresAt,
//               decision: 'pending'|'approved'|'rejected'|'withdrawn',
//               decidedBy, decidedAt, comment,
//               validatedByAccounts, validatedBy, validatedAt } | null,
//   erp: { dispatchSheetNo, dispatchPo, installationPo, enteredBy, enteredAt } | null,
//   invoice: { invoiceNo, ewayBill, ewayNotRequiredReason, enteredBy, enteredAt } | null,
//   override: { by, reason, at } | null,
//   createdBy, createdAt
// }
//
// Balance field-name confidence note: same uncertainty class as
// po-progress.js's FIELD_MAP and payables.js's vendor/date guesses - "total
// (incl. GST)" and "collected" aren't named as literal column headers
// anywhere in the available docs (unlike payables.js's Closing Taxable/CP/
// etc, which ARE spelled out). DPI_FIELD below is a best-guess list of
// plausible headers, flagged as unconfirmed.

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId, randomToken } from './crypto.js';
import { logEvent } from './activity.js';
import { getField } from './po-progress.js';
import { getDataset } from './erp-mirror.js';
import { getBooking } from './last-mile.js';

const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;
const SHORTFALL_THRESHOLD = 1; // "any unpaid amount over ₹1 needs a COO/Director approval"

const DPI_FIELD = {
  totalInclGst: ['Total', 'PI Total', 'Invoice Value', 'Grand Total'],
  collected: ['Collected', 'Total Collection'], // NOT the pre-GST "Total Collection Wout Tax" payables.js uses
};

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

export async function getRecord(appDataKv, bookingId) {
  return getJSON(appDataKv, `dispatchday:${bookingId}`);
}

async function saveRecord(appDataKv, record) {
  await putJSON(appDataKv, `dispatchday:${record.id}`, record);
  await appDataKv.put(`idx:dispatchday_by_so:${safeKeyPart(record.so)}:${record.id}`, record.id);
  return record;
}

// "Prefilled from Daily PI Revenue as total (incl. GST) - collected. It also
// subtracts payments accounts confirmed on other dispatches of the same SO
// after the data build." dataBuildAt is the ERP mirror upload's uploadedAt
// (erp_meta.uploadedAt) - payments confirmed before that are assumed already
// reflected in the snapshot's own "collected" figure.
async function computeBalance(appDataKv, erpKv, so, excludeBookingId) {
  const dpiDataset = await getDataset(erpKv, 'daily_pi_revenue');
  const row = dpiDataset ? dpiDataset.rows.find((r) => String(getField(r, 'so')) === String(so)) : null;
  const totalInclGst = row ? num(DPI_FIELD.totalInclGst.map((k) => row[k]).find((v) => v !== undefined)) : 0;
  const collectedSnapshot = row ? num(DPI_FIELD.collected.map((k) => row[k]).find((v) => v !== undefined)) : 0;
  const dataBuildAt = dpiDataset ? dpiDataset.meta.uploadedAt : null;

  let otherConfirmedPayments = 0;
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix: `idx:dispatchday_by_so:${safeKeyPart(so)}:`, cursor });
    for (const entry of page.keys) {
      const id = entry.name.slice(entry.name.lastIndexOf(':') + 1);
      if (id === excludeBookingId) continue;
      const other = await getRecord(appDataKv, id);
      if (!other) continue;
      for (const p of other.payments || []) {
        if (p.status === 'confirmed' && (!dataBuildAt || Date.parse(p.confirmedAt) > Date.parse(dataBuildAt))) {
          otherConfirmedPayments += p.amount;
        }
      }
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }

  const amount = Math.max(0, totalInclGst - collectedSnapshot - otherConfirmedPayments);
  return { totalInclGst, collectedSnapshot, otherConfirmedPayments, amount };
}

// "Sales pick the SO, then its booked slot" - one record per dispatch booking.
export async function startRecord(appDataKv, erpKv, { so, bookingId }, actor) {
  const existing = await getRecord(appDataKv, bookingId);
  if (existing) return existing;

  const booking = await getBooking(appDataKv, bookingId);
  if (!booking) throw new Error(`Dispatch booking ${bookingId} not found`);
  if (booking.type !== 'dispatch') throw new Error(`Booking ${bookingId} is not a dispatch booking`);

  const balance = await computeBalance(appDataKv, erpKv, so, bookingId);
  const record = {
    id: bookingId,
    so,
    bookingId,
    balance,
    payments: [],
    approval: null,
    erp: null,
    invoice: null,
    override: null,
    createdBy: { uid: actor.uid, name: actor.name },
    createdAt: new Date().toISOString(),
  };
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so,
    title: `Dispatch Day record started for ${so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: null, to: 'started' }],
    roles: ['accounts', 'supply'],
    participants: [],
    exceptions: false,
  });

  return record;
}

// --- Payments (sales) --------------------------------------------------------
export async function addPayment(appDataKv, bookingId, input, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  const required = ['amount', 'date', 'mode'];
  for (const field of required) {
    if (!input[field] && input[field] !== 0) throw new Error(`${field} is required`);
  }
  const payment = {
    id: randomId('pay'),
    amount: input.amount,
    date: input.date,
    mode: input.mode,
    details: input.details || null,
    addedBy: { uid: actor.uid, name: actor.name },
    addedAt: new Date().toISOString(),
    status: 'pending',
    sentBackReason: null,
    confirmedBy: null,
    confirmedAt: null,
  };
  record.payments.push(payment);
  await saveRecord(appDataKv, record);
  return payment;
}

export async function removePayment(appDataKv, bookingId, paymentId, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  const payment = record.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.status === 'confirmed') throw new Error('Cannot remove a confirmed payment - reopen it first');
  record.payments = record.payments.filter((p) => p.id !== paymentId);
  await saveRecord(appDataKv, record);
  return record;
}

// "With nothing received there is no submit; the record points to the
// approval instead." submitPayments just marks every pending payment as
// awaiting accounts' confirmation (notification purposes) - the actual
// confirm/send-back decision is accounts' own action below.
export async function submitPayments(appDataKv, bookingId, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  if (record.payments.length === 0) throw new Error('Nothing to submit - with no payment recorded, use the approval route instead');
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Payment submitted for accounts' review on ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'payments', from: null, to: 'submitted' }],
    roles: ['accounts'],
    participants: [],
    exceptions: false,
  });

  return record;
}

// --- Accounts: confirm / send back / validate approval -----------------------
export async function confirmPaymentReceipt(appDataKv, bookingId, paymentId, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  const payment = record.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  payment.status = 'confirmed';
  payment.confirmedBy = { uid: actor.uid, name: actor.name };
  payment.confirmedAt = new Date().toISOString();
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Payment receipt confirmed for ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'payment', from: 'pending', to: 'confirmed' }],
    roles: ['sales', 'supply'],
    participants: [],
    exceptions: false,
  });

  return record;
}

export async function sendPaymentBack(appDataKv, bookingId, paymentId, reason, actor) {
  if (!reason) throw new Error('A reason is required to send a payment back');
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  const payment = record.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  payment.status = 'sent_back';
  payment.sentBackReason = reason;
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Payment sent back for ${record.so}: ${reason}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'payment', from: 'pending', to: 'sent_back' }],
    roles: ['sales'],
    participants: [],
    exceptions: true,
  });

  return record;
}

export async function reopenPayment(appDataKv, bookingId, paymentId, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  const payment = record.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error(`Payment ${paymentId} not found`);
  if (payment.status !== 'confirmed') throw new Error('Only a confirmed payment can be reopened');
  payment.status = 'pending';
  payment.reopenedAt = new Date().toISOString();
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Confirmed payment reopened for ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'payment', from: 'confirmed', to: 'pending' }],
    roles: ['accounts'],
    participants: [],
    exceptions: false,
  });

  return record;
}

function confirmedTotal(record) {
  return record.payments.filter((p) => p.status === 'confirmed').reduce((sum, p) => sum + p.amount, 0);
}
function shortfall(record) {
  return Math.max(0, record.balance.amount - confirmedTotal(record));
}

export async function createApprovalLink(appDataKv, bookingId, reason, actor) {
  if (wordCount(reason) < 3) throw new Error('A reason of 3 or more words is required');
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  const amount = shortfall(record);
  if (amount <= SHORTFALL_THRESHOLD) throw new Error('No approval is needed - the unpaid amount is at or below ₹1');

  const now = Date.now();
  record.approval = {
    token: randomToken(),
    reason,
    approvedAmount: null,
    createdBy: { uid: actor.uid, name: actor.name },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    decision: 'pending',
    decidedBy: null,
    decidedAt: null,
    comment: null,
    validatedByAccounts: false,
    validatedBy: null,
    validatedAt: null,
    requestedAmount: amount,
  };
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Approval link created for ${record.so} (shortfall ₹${amount})`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'approval', from: null, to: 'pending' }],
    roles: ['approver', 'accounts'],
    participants: [],
    exceptions: false,
  });

  return record.approval;
}

export async function withdrawApprovalLink(appDataKv, bookingId, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record || !record.approval) throw new Error('No approval link to withdraw');
  if (record.approval.decision !== 'pending') throw new Error('Only a pending approval can be withdrawn');
  record.approval.decision = 'withdrawn';
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Approval link withdrawn for ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'approval', from: 'pending', to: 'withdrawn' }],
    roles: ['approver', 'accounts'],
    participants: [],
    exceptions: false,
  });

  return record;
}

export async function decideApproval(appDataKv, bookingId, token, decision, comment, actor) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const record = await getRecord(appDataKv, bookingId);
  if (!record || !record.approval) throw new Error('No approval pending for this record');
  if (record.approval.token !== token) throw new Error('Invalid or stale approval token');
  if (record.approval.decision !== 'pending') throw new Error(`Approval already ${record.approval.decision}`);
  if (Date.parse(record.approval.expiresAt) < Date.now()) throw new Error('Approval link has expired');
  if (decision === 'rejected' && !comment) throw new Error('A comment is required to reject');

  record.approval.decision = decision;
  record.approval.decidedBy = { uid: actor.uid, name: actor.name };
  record.approval.decidedAt = new Date().toISOString();
  record.approval.comment = comment || null;
  if (decision === 'approved') record.approval.approvedAmount = record.approval.requestedAmount;
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Dispatch approval ${decision} for ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'approval', from: 'pending', to: decision }],
    roles: ['sales', 'accounts', 'supply'],
    participants: [],
    exceptions: decision === 'rejected',
  });

  return record;
}

export async function validateApproval(appDataKv, bookingId, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record || !record.approval) throw new Error('No approval to validate');
  if (record.approval.decision !== 'approved') throw new Error('Only an approved approval can be validated');
  record.approval.validatedByAccounts = true;
  record.approval.validatedBy = { uid: actor.uid, name: actor.name };
  record.approval.validatedAt = new Date().toISOString();
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Approval validated by accounts for ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'approval.validatedByAccounts', from: false, to: true }],
    roles: ['sales', 'supply'],
    participants: [],
    exceptions: false,
  });

  return record;
}

export async function enterErpNumbers(appDataKv, bookingId, { dispatchSheetNo, dispatchPo, installationPo }, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  if (!dispatchSheetNo || !dispatchPo) throw new Error('dispatchSheetNo and dispatchPo are required');
  record.erp = { dispatchSheetNo, dispatchPo, installationPo: installationPo || null, enteredBy: { uid: actor.uid, name: actor.name }, enteredAt: new Date().toISOString() };
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Supply entered ERP numbers for ${record.so}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'erp', from: null, to: dispatchSheetNo }],
    roles: ['accounts', 'sales'],
    participants: [],
    exceptions: false,
  });

  return record;
}

const EWAY_RE = /^\d{12}$/;

export async function enterInvoiceEway(appDataKv, bookingId, { invoiceNo, ewayBill, ewayNotRequiredReason }, actor) {
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  if (!invoiceNo) throw new Error('invoiceNo is always required');
  if (ewayBill && !EWAY_RE.test(ewayBill)) throw new Error('ewayBill must be exactly 12 digits');
  if (!ewayBill && !ewayNotRequiredReason) throw new Error('Either a 12-digit ewayBill or ewayNotRequiredReason is required');

  const paymentOrApprovalRoute = checkPaymentRoute(record);
  if (!paymentOrApprovalRoute.ok) throw new Error(`Cannot enter invoice/e-way yet: ${paymentOrApprovalRoute.reason}`);
  if (!record.erp) throw new Error("Cannot enter invoice/e-way yet: supply's ERP numbers aren't in");

  record.invoice = { invoiceNo, ewayBill: ewayBill || null, ewayNotRequiredReason: ewayBill ? null : ewayNotRequiredReason, enteredBy: { uid: actor.uid, name: actor.name }, enteredAt: new Date().toISOString() };
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Invoice/e-way entered for ${record.so}: ${invoiceNo}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'invoice', from: null, to: invoiceNo }],
    roles: ['supply'],
    participants: [],
    exceptions: true,
  });

  return record;
}

function checkPaymentRoute(record) {
  const confirmed = confirmedTotal(record);
  const remaining = Math.max(0, record.balance.amount - confirmed);

  if (remaining <= SHORTFALL_THRESHOLD) {
    return { ok: true, route: 'fully_paid' };
  }
  if (!record.approval || record.approval.decision !== 'approved' || !record.approval.validatedByAccounts) {
    return { ok: false, reason: `₹${remaining} unpaid and no validated approval covers it yet`, route: confirmed === 0 ? 'pay_on_delivery' : 'part_paid' };
  }
  if (remaining > record.approval.approvedAmount) {
    return { ok: false, reason: `the unpaid amount (₹${remaining}) has grown past the approved amount (₹${record.approval.approvedAmount}) - a new approval is needed`, route: confirmed === 0 ? 'pay_on_delivery' : 'part_paid' };
  }
  return { ok: true, route: confirmed === 0 ? 'pay_on_delivery' : 'part_paid' };
}

export function isReadyToDispatch(record) {
  if (record.override) return { ready: true, via: 'admin_override' };

  const paymentRoute = checkPaymentRoute(record);
  if (!paymentRoute.ok) return { ready: false, reason: paymentRoute.reason };

  if (!record.erp) return { ready: false, reason: "supply's ERP numbers (dispatch sheet no., dispatch PO) aren't in yet" };
  if (!record.invoice) return { ready: false, reason: 'invoice/e-way bill not entered yet' };

  return { ready: true, via: paymentRoute.route };
}

export async function overrideGate(appDataKv, bookingId, reason, actor) {
  if (actor.role !== 'admin') throw new Error('Only admin can override the Dispatch Day gate');
  if (wordCount(reason) < 3) throw new Error('A reason of 3 or more words is required');
  const record = await getRecord(appDataKv, bookingId);
  if (!record) throw new Error(`Dispatch Day record ${bookingId} not found`);
  record.override = { by: { uid: actor.uid, name: actor.name }, reason, at: new Date().toISOString() };
  await saveRecord(appDataKv, record);

  await logEvent(appDataKv, {
    recordType: 'dispatch_day',
    recordId: bookingId,
    so: record.so,
    title: `Admin override used on Dispatch Day gate for ${record.so}: ${reason}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'override', from: null, to: reason }],
    roles: ['sales', 'supply', 'accounts'],
    participants: [],
    exceptions: true,
  });

  return record;
}

export { shortfall, confirmedTotal };
