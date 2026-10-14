// GET  /api/dispatch-day?bookingId={id}           -> { record }   (any signed-in user)
// POST /api/dispatch-day  { action, bookingId, ...fields } -> { record | approval }
//
// action values and the role each requires (see mfpl-dispatch-day.md "Roles"):
//   start              sales, admin            - { so, bookingId }
//   add_payment        sales, admin             - { bookingId, amount, date, mode, details? }
//   remove_payment     sales, admin             - { bookingId, paymentId }
//   submit_payments    sales, admin             - { bookingId }
//   reopen_payment     sales, admin             - { bookingId, paymentId }
//   confirm_payment    accounts, admin          - { bookingId, paymentId }
//   send_payment_back  accounts, admin          - { bookingId, paymentId, reason }
//   create_approval    sales, admin             - { bookingId, reason }  (3+ words)
//   withdraw_approval  sales, admin             - { bookingId }
//   decide_approval    approver, admin          - { bookingId, token, decision, comment? }
//   validate_approval  accounts, admin          - { bookingId }
//   enter_erp          supply, admin            - { bookingId, dispatchSheetNo, dispatchPo, installationPo? }
//   enter_invoice_eway accounts, admin          - { bookingId, invoiceNo, ewayBill?, ewayNotRequiredReason? }
//   override           admin                    - { bookingId, reason }  (3+ words)
import { requireRole } from '../../_lib/session.js';
import {
  getRecord,
  startRecord,
  addPayment,
  removePayment,
  submitPayments,
  reopenPayment,
  confirmPaymentReceipt,
  sendPaymentBack,
  createApprovalLink,
  withdrawApprovalLink,
  decideApproval,
  validateApproval,
  enterErpNumbers,
  enterInvoiceEway,
  overrideGate,
  isReadyToDispatch,
} from '../../_lib/dispatch-day.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const ROLE_FOR_ACTION = {
  start: ['sales', 'admin'],
  add_payment: ['sales', 'admin'],
  remove_payment: ['sales', 'admin'],
  submit_payments: ['sales', 'admin'],
  reopen_payment: ['sales', 'admin'],
  confirm_payment: ['accounts', 'admin'],
  send_payment_back: ['accounts', 'admin'],
  create_approval: ['sales', 'admin'],
  withdraw_approval: ['sales', 'admin'],
  decide_approval: ['approver', 'admin'],
  validate_approval: ['accounts', 'admin'],
  enter_erp: ['supply', 'admin'],
  enter_invoice_eway: ['accounts', 'admin'],
  override: ['admin'],
};

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(env.AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const url = new URL(request.url);
  const bookingId = url.searchParams.get('bookingId');
  if (!bookingId) return errorJson('bookingId is required', 400);
  const record = await getRecord(env.APP_DATA, bookingId);
  if (!record) return json({ record: null });
  return json({ record, gate: isReadyToDispatch(record) });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { action, bookingId } = body || {};
  if (!action) return errorJson('action is required', 400);
  const allowedRoles = ROLE_FOR_ACTION[action];
  if (!allowedRoles) return errorJson(`Unknown action '${action}'`, 400);

  const auth = await requireRole(env.AUTH, bearerToken(request), allowedRoles);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  try {
    switch (action) {
      case 'start':
        return json({ record: await startRecord(env.APP_DATA, env.ERP_MIRROR, { so: body.so, bookingId }, auth.user) }, 201);
      case 'add_payment':
        return json({ payment: await addPayment(env.APP_DATA, bookingId, body, auth.user) }, 201);
      case 'remove_payment':
        return json({ record: await removePayment(env.APP_DATA, bookingId, body.paymentId, auth.user) });
      case 'submit_payments':
        return json({ record: await submitPayments(env.APP_DATA, bookingId, auth.user) });
      case 'reopen_payment':
        return json({ record: await reopenPayment(env.APP_DATA, bookingId, body.paymentId, auth.user) });
      case 'confirm_payment':
        return json({ record: await confirmPaymentReceipt(env.APP_DATA, bookingId, body.paymentId, auth.user) });
      case 'send_payment_back':
        return json({ record: await sendPaymentBack(env.APP_DATA, bookingId, body.paymentId, body.reason, auth.user) });
      case 'create_approval':
        return json({ approval: await createApprovalLink(env.APP_DATA, bookingId, body.reason, auth.user) }, 201);
      case 'withdraw_approval':
        return json({ record: await withdrawApprovalLink(env.APP_DATA, bookingId, auth.user) });
      case 'decide_approval':
        return json({ record: await decideApproval(env.APP_DATA, bookingId, body.token, body.decision, body.comment, auth.user) });
      case 'validate_approval':
        return json({ record: await validateApproval(env.APP_DATA, bookingId, auth.user) });
      case 'enter_erp':
        return json({ record: await enterErpNumbers(env.APP_DATA, bookingId, body, auth.user) });
      case 'enter_invoice_eway':
        return json({ record: await enterInvoiceEway(env.APP_DATA, bookingId, body, auth.user) });
      case 'override':
        return json({ record: await overrideGate(env.APP_DATA, bookingId, body.reason, auth.user) });
      default:
        return errorJson(`Unknown action '${action}'`, 400);
    }
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
