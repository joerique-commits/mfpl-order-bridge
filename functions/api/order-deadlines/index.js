// GET  /api/order-deadlines?lineId={lineId}                 -> { negotiation }
//      /api/order-deadlines?po={po}                          -> { outerLimit }
// POST /api/order-deadlines  { action, ...fields }           -> { negotiation | outerLimit }
//
// Every GET for a single line runs applyAutoAcceptIfDue first (idempotent -
// the 20-day auto-accept rule is evaluated lazily on read, see
// order-deadlines.js header note; there's no scheduler on free-tier EdgeOne).
//
// action values and the role each requires:
//   get_or_create            any signed-in user
//   factory_propose          production, admin
//   sales_respond            sales, admin
//   factory_respond          production, admin
//   sales_final              sales, admin
//   factory_agree_client_date production, admin
//   withdraw                 any signed-in user (ownership checked in the lib)
//   set_client_date          sales, admin
//   set_po_outer_limit       production, admin
import { requireRole } from '../../_lib/session.js';
import {
  getOrCreateNegotiation,
  applyAutoAcceptIfDue,
  factoryPropose,
  salesRespond,
  factoryRespond,
  salesSetFinal,
  factoryAgreeToClientDate,
  withdrawProposal,
  setClientDate,
  setPoOuterLimit,
  getPoOuterLimit,
} from '../../_lib/order-deadlines.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const ROLE_FOR_ACTION = {
  factory_propose: ['production', 'admin'],
  sales_respond: ['sales', 'admin'],
  factory_respond: ['production', 'admin'],
  sales_final: ['sales', 'admin'],
  factory_agree_client_date: ['production', 'admin'],
  set_client_date: ['sales', 'admin'],
  set_po_outer_limit: ['production', 'admin'],
};

export async function onRequestGet({ request, env }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  const url = new URL(request.url);
  const lineId = url.searchParams.get('lineId');
  const po = url.searchParams.get('po');

  if (po && !lineId) {
    const outerLimit = await getPoOuterLimit(APP_DATA, po);
    return json({ outerLimit });
  }
  if (!lineId) return errorJson('lineId or po is required', 400);

  const existing = await getOrCreateNegotiation(APP_DATA, { lineId, po, so: null, sku: null, poDate: null, clientDate: null });
  const negotiation = await applyAutoAcceptIfDue(APP_DATA, existing);
  return json({ negotiation });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return errorJson(e.message, 400);
  }
  const { action, lineId } = body || {};
  if (!action) return errorJson('action is required', 400);

  if (action === 'get_or_create') {
    const auth = await requireRole(AUTH, bearerToken(request), null);
    if (!auth.ok) return errorJson(auth.error, auth.status);
    if (!lineId) return errorJson('lineId is required', 400);
    const { po, so, sku, poDate, clientDate } = body;
    if (!po || !poDate) return errorJson('po and poDate are required to create a negotiation record', 400);
    const negotiation = await getOrCreateNegotiation(APP_DATA, { lineId, po, so, sku, poDate, clientDate });
    return json({ negotiation }, 201);
  }

  const allowedRoles = ROLE_FOR_ACTION[action];
  if (!allowedRoles && action !== 'withdraw') return errorJson(`Unknown action '${action}'`, 400);

  const auth = await requireRole(AUTH, bearerToken(request), allowedRoles || null);
  if (!auth.ok) return errorJson(auth.error, auth.status);

  try {
    let outerLimit = null;
    if (['factory_propose', 'factory_respond'].includes(action) && body.po) {
      outerLimit = await getPoOuterLimit(APP_DATA, body.po);
    }

    let negotiation;
    switch (action) {
      case 'factory_propose':
        negotiation = await factoryPropose(APP_DATA, { lineId, date: body.date, reason: body.reason }, auth.user, outerLimit);
        break;
      case 'sales_respond':
        negotiation = await salesRespond(APP_DATA, { lineId, accept: !!body.accept, counterDate: body.counterDate }, auth.user);
        break;
      case 'factory_respond':
        negotiation = await factoryRespond(APP_DATA, { lineId, accept: !!body.accept, counterDate: body.counterDate, reason: body.reason }, auth.user, outerLimit);
        break;
      case 'sales_final':
        negotiation = await salesSetFinal(APP_DATA, { lineId, date: body.date }, auth.user);
        break;
      case 'factory_agree_client_date':
        negotiation = await factoryAgreeToClientDate(APP_DATA, lineId, auth.user);
        break;
      case 'withdraw':
        negotiation = await withdrawProposal(APP_DATA, lineId, auth.user);
        break;
      case 'set_client_date':
        negotiation = await setClientDate(APP_DATA, lineId, body.date, auth.user);
        break;
      case 'set_po_outer_limit':
        return json({ outerLimit: await setPoOuterLimit(APP_DATA, body.po, body.outerDate, auth.user) });
      default:
        return errorJson(`Unknown action '${action}'`, 400);
    }
    return json({ negotiation });
  } catch (e) {
    return errorJson(e.message, 409);
  }
}
