// SO Revision Request - core data model and server-side rule enforcement.
// Spec: mfpl-so-revision-director-approval.md (COO/Director approval) and
// mfpl-so-lines-pending-skus.md. Built against ob_app_data (env.APP_DATA).
//
// KV shapes:
//   sorevreq:{id}                      -> full request object (below)
//   idx:sorev_by_so:{soNumber}:{id}    -> id   (old SO -> requests referencing it;
//                                                "old SO already on another open
//                                                request" check)
//   idx:sorev_newso:{soNumber}:{id}    -> id   (new SO -> requests referencing it;
//                                                "new SO already the new SO on
//                                                another non-rejected request"
//                                                check)
//
// Both index kinds are written for every version of a request (initial submit
// AND every resubmission after a send-back, since a send-back keeps the same
// request id but starts a fresh approval round with possibly different new
// SOs) - stale entries from a superseded round are left in place and are
// harmless because the uniqueness checks below re-read the *current* request
// behind each index entry and only count it if that request is still in an
// "open" status.
//
// ASSUMPTIONS made here that aren't spelled out in the spec doc and should be
// confirmed with JK before this is treated as final:
//   - "open" (for the old-SO and new-SO uniqueness checks) = status in
//     OPEN_STATUSES below (awaiting_approval, pending, sent_back) - i.e.
//     anything short of approved-and-completed or rejected.
//   - Post-approval supply/accounts sign-off is modeled as
//     `checks: { supply: {...}, accounts: {...} }`, each {done, by, at, note}.
//     Status becomes 'completed' once both are done. The spec doc names these
//     checks ("PO cancellation (supply)", "value/advance checks (accounts)")
//     but doesn't give their exact field shape.

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId, randomToken } from './crypto.js';
import { logEvent } from './activity.js';

const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours, per spec
export const OPEN_STATUSES = ['awaiting_approval', 'pending', 'sent_back'];
const REASON_TYPES = [
  'quantity_change',
  'additional_discount',
  'design_change_new_sku',
  'client_detail_change',
  'split_into_multiple_sos',
  'other',
];

function newApprovalRound() {
  return {
    token: randomToken(),
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    decision: null,
    by: null,
    at: null,
    comments: null,
  };
}

async function requestsForIndex(appDataKv, prefix) {
  const ids = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix, cursor });
    for (const entry of page.keys) ids.push(entry.name.slice(entry.name.lastIndexOf(':') + 1));
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  // de-dupe (multiple rounds on the same request write the same index prefix
  // more than once)
  return Array.from(new Set(ids));
}

async function isSoOpenElsewhere(appDataKv, indexPrefix, soNumber, excludeId) {
  const ids = await requestsForIndex(appDataKv, `${indexPrefix}${safeKeyPart(soNumber)}:`);
  for (const id of ids) {
    if (id === excludeId) continue;
    const req = await getJSON(appDataKv, `sorevreq:${id}`);
    if (req && OPEN_STATUSES.includes(req.status)) return req;
  }
  return null;
}

// Validates the blocking rules from the spec. Returns null if OK, or a
// human-readable error string.
export async function validateSoRevision(appDataKv, { oldSo, newSos }, { excludeId = null } = {}) {
  if (!oldSo) return 'Old SO is required';
  if (!Array.isArray(newSos) || newSos.length === 0) return 'At least one new SO is required';

  const newSoNumbers = newSos.map((s) => s.so);
  if (newSoNumbers.some((so) => so === oldSo)) return 'A new SO cannot be the same as the old SO';
  if (new Set(newSoNumbers).size !== newSoNumbers.length) return 'The same new SO was entered more than once';

  const oldOpen = await isSoOpenElsewhere(appDataKv, 'idx:sorev_by_so:', oldSo, excludeId);
  if (oldOpen) return `Old SO ${oldSo} is already on another open revision request (${oldOpen.id})`;

  for (const so of newSoNumbers) {
    const openElsewhere = await isSoOpenElsewhere(appDataKv, 'idx:sorev_newso:', so, excludeId);
    if (openElsewhere) return `New SO ${so} is already the new SO on another open revision request (${openElsewhere.id})`;
  }
  return null;
}

async function writeIndexes(appDataKv, request) {
  await appDataKv.put(`idx:sorev_by_so:${safeKeyPart(request.oldSo)}:${request.id}`, request.id);
  for (const s of request.newSos) {
    await appDataKv.put(`idx:sorev_newso:${safeKeyPart(s.so)}:${request.id}`, request.id);
  }
}

// input: { oldSo, customer, currentOrderValue, newSos: [{so, customer, value, city, date, pos}],
//          clientMismatch, reasonType, background }
export async function createSoRevision(appDataKv, input, actor) {
  if (!REASON_TYPES.includes(input.reasonType)) {
    throw new Error(`reasonType must be one of: ${REASON_TYPES.join(', ')}`);
  }
  if (!input.background) throw new Error('Background details are required for every reason');

  const error = await validateSoRevision(appDataKv, { oldSo: input.oldSo, newSos: input.newSos });
  if (error) throw new Error(error);

  const id = randomId('sorev');
  const revisedOrderValue = input.newSos.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  const request = {
    id,
    oldSo: input.oldSo,
    customer: input.customer,
    currentOrderValue: input.currentOrderValue,
    newSos: input.newSos,
    revisedOrderValue,
    clientMismatch: !!input.clientMismatch,
    reasonType: input.reasonType,
    background: input.background,
    status: 'awaiting_approval',
    approval: newApprovalRound(),
    checks: { supply: null, accounts: null },
    createdBy: { uid: actor.uid, name: actor.name, role: actor.role },
    createdAt: new Date().toISOString(),
  };
  await putJSON(appDataKv, `sorevreq:${id}`, request);
  await writeIndexes(appDataKv, request);

  await logEvent(appDataKv, {
    recordType: 'so_revision',
    recordId: id,
    so: `${input.oldSo} -> ${input.newSos.map((s) => s.so).join(', ')}`,
    title: `SO revision requested: ${input.oldSo} -> ${input.newSos.map((s) => s.so).join(', ')}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: null, to: 'awaiting_approval' }],
    roles: ['sales', 'supply', 'accounts'],
    participants: [], // creator is the only participant so far, and shouldn't be notified of their own action
    exceptions: true, // "new SO revision" is in the admin exceptions filter
  });

  return request;
}

export async function getSoRevision(appDataKv, id) {
  return getJSON(appDataKv, `sorevreq:${id}`);
}

export async function listSoRevisions(appDataKv) {
  const page = [];
  let cursor;
  let done = false;
  while (!done) {
    const res = await appDataKv.list({ prefix: 'sorevreq:', cursor });
    for (const entry of res.keys) {
      const req = await getJSON(appDataKv, entry.name);
      if (req) page.push(req);
    }
    cursor = res.cursor;
    done = !res.hasMore || !cursor;
  }
  page.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return page;
}

// decision: 'approved' | 'sent_back' | 'rejected'
export async function decideSoRevision(appDataKv, { id, token, decision, comments }, approver) {
  const request = await getSoRevision(appDataKv, id);
  if (!request) throw new Error('Revision request not found');
  if (request.status !== 'awaiting_approval') throw new Error(`Request is '${request.status}', not awaiting approval`);
  if (request.approval.token !== token) throw new Error('This approval link is no longer valid (a newer round exists)');
  if (new Date(request.approval.expiresAt).getTime() <= Date.now()) throw new Error('This approval link has expired');
  if (['sent_back', 'rejected'].includes(decision) && !comments) {
    throw new Error('A comment is required to send back or reject');
  }

  const statusAfter = decision === 'approved' ? 'pending' : decision === 'sent_back' ? 'sent_back' : 'rejected';
  request.status = statusAfter;
  request.approval.decision = decision;
  request.approval.by = { uid: approver.uid, name: approver.name, role: approver.role, title: approver.title || null };
  request.approval.at = new Date().toISOString();
  request.approval.comments = comments || null;
  await putJSON(appDataKv, `sorevreq:${id}`, request);

  await logEvent(appDataKv, {
    recordType: 'so_revision',
    recordId: id,
    so: `${request.oldSo} -> ${request.newSos.map((s) => s.so).join(', ')}`,
    title: `SO revision ${decision.replace('_', ' ')}: ${request.oldSo} -> ${request.newSos.map((s) => s.so).join(', ')}`,
    by: { uid: approver.uid, name: approver.name, role: approver.role },
    changes: [{ field: 'status', from: 'awaiting_approval', to: statusAfter }],
    roles: ['sales', 'supply', 'accounts'],
    participants: [request.createdBy.uid],
    exceptions: true,
  });

  return request;
}

// Sales resubmits after a send-back: same request id, fresh approval round.
export async function resubmitSoRevision(appDataKv, id, input, actor) {
  const request = await getSoRevision(appDataKv, id);
  if (!request) throw new Error('Revision request not found');
  if (request.status !== 'sent_back') throw new Error(`Request is '${request.status}', not sent back`);

  const error = await validateSoRevision(appDataKv, { oldSo: request.oldSo, newSos: input.newSos }, { excludeId: id });
  if (error) throw new Error(error);

  request.newSos = input.newSos;
  request.revisedOrderValue = input.newSos.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  request.clientMismatch = !!input.clientMismatch;
  request.reasonType = input.reasonType || request.reasonType;
  request.background = input.background || request.background;
  request.status = 'awaiting_approval';
  request.approval = newApprovalRound(); // old link stops working - new token
  await putJSON(appDataKv, `sorevreq:${id}`, request);
  await writeIndexes(appDataKv, request); // fresh new-SO entries if they changed

  await logEvent(appDataKv, {
    recordType: 'so_revision',
    recordId: id,
    so: `${request.oldSo} -> ${request.newSos.map((s) => s.so).join(', ')}`,
    title: `SO revision resubmitted for approval: ${request.oldSo}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'sent_back', to: 'awaiting_approval' }],
    roles: ['sales', 'supply', 'accounts'],
    participants: [],
    exceptions: true,
  });

  return request;
}

// area: 'supply' | 'accounts'
export async function checkSoRevision(appDataKv, { id, area, note }, actor) {
  if (!['supply', 'accounts'].includes(area)) throw new Error("area must be 'supply' or 'accounts'");
  const request = await getSoRevision(appDataKv, id);
  if (!request) throw new Error('Revision request not found');
  if (request.status !== 'pending') throw new Error(`Request is '${request.status}', not pending supply/accounts checks`);

  request.checks[area] = { done: true, by: { uid: actor.uid, name: actor.name }, at: new Date().toISOString(), note: note || null };
  if (request.checks.supply?.done && request.checks.accounts?.done) {
    request.status = 'completed';
  }
  await putJSON(appDataKv, `sorevreq:${id}`, request);

  await logEvent(appDataKv, {
    recordType: 'so_revision',
    recordId: id,
    so: `${request.oldSo} -> ${request.newSos.map((s) => s.so).join(', ')}`,
    title: `SO revision ${area} check done: ${request.oldSo}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: `checks.${area}.done`, from: false, to: true }],
    roles: ['sales', 'supply', 'accounts'],
    participants: [request.createdBy.uid],
    exceptions: request.status === 'completed',
  });

  return request;
}
