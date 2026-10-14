// PO Progress Tracker: PO requests, order ops, and ERP source-data linking.
// Spec: mfpl-source-linking-round3.md (the authoritative decided behavior,
// 9 Oct) + mfpl-order-lifecycle-platform-spec.md (original module framing) +
// mfpl-po-progress-standard-materials-13oct.md (the o.detail shape - fabrics/
// finishes/stoneType arrays, used here unchanged for order-ops detail).
//
// This is the most structurally uncertain module built so far, flagged
// explicitly rather than guessed past: the local build's PO Summary / SO
// Article Breakup ERP mirror datasets are opaque JSON rows parsed client-side
// by code (`build_from_folder.py`) that lives only on JK's device, not in
// this workspace - the EXACT column/field names in those rows are unknown
// here. FIELD_MAP below is a best-guess, centralized, and overridable at the
// top of this file specifically so it's a one-line fix once real column
// names are visible (either from a real deploy, or from JK sharing the
// actual header row). Every lookup in this file goes through getField() so
// nothing else needs to change when FIELD_MAP is corrected.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   po_request:{id}                      -> full request object (below)
//   idx:po_request_by_so:{so}:{id}        -> id
//   order_ops:{lineId}                    -> { lineId, so, po, article,
//                                               committedDate, detail, setBy, setAt }
//   po_link:{id}                          -> full link object (below)
//   idx:po_link_by_so:{so}:{id}           -> id
//   idx:po_link_by_line:{lineId}:{id}     -> id
//
// lineId is always `{so}__{po}__{article}` (safeKeyPart'd per segment),
// matching the existing stable-across-rebuilds convention from
// mfpl-source-linking-round3.md ("SO__PO__ARTICLE, which is stable across
// rebuilds") and reused by Order Deadlines' `neg:{lineId}`.
//
// po_request: { id, so, article, sku, qty, requestedBy:{uid,name}, requestedAt,
//   committedDateOption: '45'|'60'|'75'|'90'|'120'|'custom', committedDate (ISO date),
//   detail (optional, same shape as order_ops.detail, null if not filled in yet),
//   knownPos: [poNumber,...]  (PO numbers already on this SO+Article when raised),
//   rejectedPos: [poNumber,...] (candidates supply has explicitly rejected/ignored -
//     excluded from future automatic matching so a dismissed candidate doesn't
//     keep reappearing every refresh),
//   status: 'open' | 'raised' | 'linked' | 'archived',
//     'open'     = not yet marked raised in ERP
//     'raised'   = supply clicked "Mark PO raised in ERP"; eligible for matching
//     'linked'   = matched (auto or manual) to a real PO line; terminal
//     'archived' = same as linked, kept distinct per spec wording ("the
//                  request is archived") - requests move to 'archived' once
//                  linked, 'linked' is not used as a separate value (see
//                  decideLink/linkRequestToLine: they set 'archived' directly;
//                  'linked' is reserved here only for forward documentation).
//   raisedBy, raisedAt, linkedLineId, linkedAt, linkedVia: 'auto'|'manual'|'confirmed' }
//
// po_link: { id, requestId, lineId, so, po, article,
//   matchType: 'auto' | 'suggested' | 'manual',
//   decision: 'confirmed' | 'rejected' | 'ignored' | 'undone' | null (pending),
//   qtyMismatch: bool, qtyRequested, qtyOnPo,
//   flagged: bool, flagReason: string|null,
//   decidedBy, decidedAt, createdAt }

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId } from './crypto.js';
import { logEvent } from './activity.js';
import { getDataset } from './erp-mirror.js';

// --- Field-name mapping over opaque ERP mirror rows (see header note) -----
const FIELD_MAP = {
  so: ['SO', 'so', 'SO Number', 'SO_Number'],
  po: ['PO', 'po', 'PO Number', 'PO_Number'],
  article: ['Article', 'article', 'Article Code', 'Article_Code'],
  sku: ['SKU', 'sku'],
  qty: ['Qty', 'qty', 'Quantity'],
  poDate: ['PO Date', 'PODate', 'po_date'],
  supplier: ['Supplier', 'supplier', 'Vendor'],
};

function getField(row, key) {
  for (const name of FIELD_MAP[key] || [key]) {
    if (row[name] !== undefined) return row[name];
  }
  return undefined;
}

export function buildLineId(so, po, article) {
  return `${safeKeyPart(so)}__${safeKeyPart(po)}__${safeKeyPart(article)}`;
}

const COMMITTED_DAYS = { 45: 45, 60: 60, 75: 75, 90: 90, 120: 120 };

export function computeCommittedDate(option, fromDate, customDate) {
  if (option === 'custom') {
    if (!customDate) throw new Error('customDate is required when committedDateOption is custom');
    return customDate;
  }
  const days = COMMITTED_DAYS[option];
  if (!days) throw new Error(`committedDateOption must be one of 45/60/75/90/120/custom, got ${option}`);
  const base = new Date(fromDate);
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

// Per the ±5 buffer rule (never shown to sales/factory as a number, always
// computed): factory sees the client's committed date minus 5 days.
export function factoryDateFor(committedDate) {
  const d = new Date(committedDate);
  d.setDate(d.getDate() - 5);
  return d.toISOString().slice(0, 10);
}

// --- PO Requests ------------------------------------------------------------

export async function createRequest(appDataKv, input, actor) {
  const required = ['so', 'article', 'sku', 'qty', 'committedDateOption'];
  for (const field of required) {
    if (!input[field] && input[field] !== 0) throw new Error(`${field} is required`);
  }
  const now = new Date().toISOString();
  const committedDate = computeCommittedDate(input.committedDateOption, now, input.customDate);
  const id = randomId('poreq');
  const request = {
    id,
    so: input.so,
    article: input.article,
    sku: input.sku,
    qty: input.qty,
    requestedBy: { uid: actor.uid, name: actor.name },
    requestedAt: now,
    committedDateOption: input.committedDateOption,
    committedDate,
    detail: input.detail || null,
    knownPos: Array.isArray(input.knownPos) ? input.knownPos.map(String) : [],
    rejectedPos: [],
    status: 'open',
    raisedBy: null,
    raisedAt: null,
    linkedLineId: null,
    linkedAt: null,
    linkedVia: null,
  };
  await putJSON(appDataKv, `po_request:${id}`, request);
  await appDataKv.put(`idx:po_request_by_so:${safeKeyPart(input.so)}:${id}`, id);

  await logEvent(appDataKv, {
    recordType: 'po_request',
    recordId: id,
    so: input.so,
    title: `PO request raised for ${input.so} / ${input.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: null, to: 'open' }],
    roles: ['supply'],
    participants: [],
    exceptions: false,
  });

  return request;
}

export async function getRequest(appDataKv, id) {
  return getJSON(appDataKv, `po_request:${id}`);
}

export async function listRequests(appDataKv, { status, so } = {}) {
  const prefix = so ? `idx:po_request_by_so:${safeKeyPart(so)}:` : 'po_request:';
  const results = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix, cursor });
    for (const entry of page.keys) {
      const id = so ? entry.name.slice(entry.name.lastIndexOf(':') + 1) : entry.name.slice('po_request:'.length);
      const req = await getJSON(appDataKv, `po_request:${id}`);
      if (req && (!status || req.status === status)) results.push(req);
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  results.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  return results;
}

export async function markRaised(appDataKv, requestId, actor) {
  const request = await getRequest(appDataKv, requestId);
  if (!request) throw new Error(`Request ${requestId} not found`);
  if (request.status !== 'open') throw new Error(`Request ${requestId} is not open (status: ${request.status})`);
  request.status = 'raised';
  request.raisedBy = { uid: actor.uid, name: actor.name };
  request.raisedAt = new Date().toISOString();
  await putJSON(appDataKv, `po_request:${requestId}`, request);

  await logEvent(appDataKv, {
    recordType: 'po_request',
    recordId: requestId,
    so: request.so,
    title: `PO marked raised in ERP for ${request.so} / ${request.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'open', to: 'raised' }],
    roles: ['supply'],
    participants: [request.requestedBy.uid].filter((uid) => uid !== actor.uid),
    exceptions: false,
  });

  return request;
}

// --- Order ops (committed date + detail on an actual PO line) --------------

export async function getOrderOps(appDataKv, lineId) {
  return getJSON(appDataKv, `order_ops:${lineId}`);
}

export async function setOrderOps(appDataKv, lineId, patch, actor) {
  const { so, po, article } = patch;
  const existing = (await getOrderOps(appDataKv, lineId)) || { lineId, so, po, article, committedDate: null, detail: null };
  if (patch.committedDate !== undefined) existing.committedDate = patch.committedDate;
  if (patch.detail !== undefined) existing.detail = patch.detail;
  existing.setBy = { uid: actor.uid, name: actor.name };
  existing.setAt = new Date().toISOString();
  await putJSON(appDataKv, `order_ops:${lineId}`, existing);

  await logEvent(appDataKv, {
    recordType: 'order_ops',
    recordId: lineId,
    so: existing.so,
    title: `Order details updated for ${existing.so} / ${existing.po} / ${existing.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'detail', from: null, to: 'updated' }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return existing;
}

// --- Linking a request to a real PO line (shared by auto/confirm/manual) ---

async function finalizeLink(appDataKv, request, lineId, poRow, via, actor) {
  const lineParts = { so: request.so, po: String(getField(poRow, 'po')), article: request.article };
  await setOrderOps(appDataKv, lineId, { ...lineParts, committedDate: request.committedDate, detail: request.detail }, actor || request.requestedBy);

  request.status = 'archived';
  request.linkedLineId = lineId;
  request.linkedAt = new Date().toISOString();
  request.linkedVia = via;
  await putJSON(appDataKv, `po_request:${request.id}`, request);

  const link = {
    id: randomId('polink'),
    requestId: request.id,
    lineId,
    so: request.so,
    po: lineParts.po,
    article: request.article,
    matchType: via === 'confirmed' ? 'suggested' : via, // keep 'suggested' as the matchType even once confirmed, decision carries the outcome
    decision: via === 'confirmed' ? 'confirmed' : via === 'manual' ? 'confirmed' : 'confirmed',
    qtyMismatch: Number(getField(poRow, 'qty')) !== Number(request.qty),
    qtyRequested: request.qty,
    qtyOnPo: getField(poRow, 'qty'),
    flagged: false,
    flagReason: null,
    decidedBy: actor ? { uid: actor.uid, name: actor.name } : null,
    decidedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  // Auto-links are stored with matchType 'auto' (undo-able per spec); manual
  // and confirmed-suggestion links are stored as their own matchType so the
  // Unmatched queue's "recent automatic links" vs "recent manual links"
  // sections (mfpl-source-linking-round3.md) can tell them apart.
  link.matchType = via;
  await putJSON(appDataKv, `po_link:${link.id}`, link);
  await appDataKv.put(`idx:po_link_by_so:${safeKeyPart(request.so)}:${link.id}`, link.id);
  await appDataKv.put(`idx:po_link_by_line:${lineId}:${link.id}`, link.id);

  await logEvent(appDataKv, {
    recordType: 'po_link',
    recordId: link.id,
    so: request.so,
    title: `PO request linked (${via}): ${request.so} / ${lineParts.po} / ${request.article}${link.qtyMismatch ? ' - quantity mismatch flagged' : ''}`,
    by: actor ? { uid: actor.uid, name: actor.name, role: actor.role } : { uid: 'system', name: 'System', role: 'system' },
    changes: [{ field: 'status', from: 'raised', to: 'archived' }],
    roles: ['supply', 'sales'],
    participants: [request.requestedBy.uid].filter((uid) => !actor || uid !== actor.uid),
    exceptions: link.qtyMismatch,
  });

  return link;
}

// --- The matching engine -----------------------------------------------

// erpRows: { poSummary: [...], soArticleBreakup: [...] } - already-loaded
// row arrays (caller fetches via getDataset once and reuses across every
// request being evaluated, rather than re-fetching per request).
export async function evaluateRequest(appDataKv, erpRows, request) {
  if (request.status !== 'raised') return { outcome: 'skipped', requestId: request.id };

  const excluded = new Set([...(request.knownPos || []), ...(request.rejectedPos || [])].map(String));
  const candidates = erpRows.poSummary.filter(
    (r) => String(getField(r, 'so')) === String(request.so) && String(getField(r, 'article')) === String(request.article) && !excluded.has(String(getField(r, 'po')))
  );

  if (candidates.length === 0) {
    return { outcome: 'not_found', requestId: request.id };
  }

  let unique = candidates.length === 1 ? candidates : null;
  if (!unique && candidates.length > 1) {
    const sameQty = candidates.filter((c) => Number(getField(c, 'qty')) === Number(request.qty));
    if (sameQty.length === 1) unique = sameQty;
  }

  if (unique) {
    const poRow = unique[0];
    const lineId = buildLineId(request.so, getField(poRow, 'po'), request.article);
    const link = await finalizeLink(appDataKv, request, lineId, poRow, 'auto', null);
    return { outcome: 'auto_linked', requestId: request.id, lineId, linkId: link.id };
  }

  // Ambiguous (multiple candidates, no quantity tiebreaker) -> a loose-match
  // suggestion per candidate, for supply to confirm or reject. Only create a
  // suggestion if one doesn't already exist for this request+po pair, so
  // re-running the matcher doesn't spawn duplicate suggestion rows.
  const created = [];
  for (const poRow of candidates) {
    const po = String(getField(poRow, 'po'));
    const lineId = buildLineId(request.so, po, request.article);
    const existingId = await findLinkIdForRequestAndPo(appDataKv, request.id, po);
    if (existingId) continue;
    const link = {
      id: randomId('polink'),
      requestId: request.id,
      lineId,
      so: request.so,
      po,
      article: request.article,
      matchType: 'suggested',
      decision: null,
      qtyMismatch: Number(getField(poRow, 'qty')) !== Number(request.qty),
      qtyRequested: request.qty,
      qtyOnPo: getField(poRow, 'qty'),
      flagged: false,
      flagReason: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    await putJSON(appDataKv, `po_link:${link.id}`, link);
    await appDataKv.put(`idx:po_link_by_so:${safeKeyPart(request.so)}:${link.id}`, link.id);
    await appDataKv.put(`idx:po_link_by_line:${lineId}:${link.id}`, link.id);
    created.push(link);
  }
  return { outcome: created.length ? 'suggested' : 'already_suggested', requestId: request.id, links: created };
}

async function findLinkIdForRequestAndPo(appDataKv, requestId, po) {
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix: 'po_link:', cursor });
    for (const entry of page.keys) {
      const link = await getJSON(appDataKv, entry.name);
      if (link && link.requestId === requestId && link.po === po) return link.id;
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  return null;
}

// Loads both datasets once (admin-uploaded via the ERP mirror layer) and
// evaluates every 'raised' request against them. Call this on-demand (e.g.
// when the Unmatched queue is opened) rather than on a schedule - matches
// the "evaluated lazily on every read" pattern used by Order Deadlines'
// 20-day auto-accept, since there's no server-side scheduler on EdgeOne.
export async function runMatching(appDataKv, erpKv) {
  const [poSummaryDs, soBreakupDs] = await Promise.all([getDataset(erpKv, 'po_summary'), getDataset(erpKv, 'so_article_breakup')]);
  const erpRows = { poSummary: poSummaryDs ? poSummaryDs.rows : [], soArticleBreakup: soBreakupDs ? soBreakupDs.rows : [] };

  const raised = await listRequests(appDataKv, { status: 'raised' });
  const results = [];
  for (const request of raised) {
    results.push(await evaluateRequest(appDataKv, erpRows, request));
  }
  return { results, erpRows };
}

// --- Supply deciding on a suggested loose-match link ------------------------

export async function decideLink(appDataKv, linkId, decision, actor, note) {
  if (!['confirmed', 'rejected', 'ignored'].includes(decision)) throw new Error('decision must be confirmed, rejected or ignored');
  const link = await getJSON(appDataKv, `po_link:${linkId}`);
  if (!link) throw new Error(`Link ${linkId} not found`);
  if (link.matchType !== 'suggested' || link.decision !== null) {
    throw new Error(`Link ${linkId} is not a pending suggestion (matchType: ${link.matchType}, decision: ${link.decision})`);
  }

  if (decision === 'confirmed') {
    const request = await getRequest(appDataKv, link.requestId);
    if (!request) throw new Error(`Request ${link.requestId} for link ${linkId} not found`);
    const poRow = { PO: link.po, Qty: link.qtyOnPo };
    // finalizeLink creates a *new* po_link row; mark this suggestion resolved
    // and point it at that new row rather than double-writing order_ops.
    const finalLink = await finalizeLink(appDataKv, request, link.lineId, poRow, 'confirmed', actor);
    link.decision = 'confirmed';
    link.decidedBy = { uid: actor.uid, name: actor.name };
    link.decidedAt = new Date().toISOString();
    link.note = note || null;
    link.resolvedInto = finalLink.id;
    await putJSON(appDataKv, `po_link:${linkId}`, link);
    return { link, finalLink };
  }

  // rejected or ignored: dismiss this specific PO candidate so future
  // matching runs don't keep re-suggesting it, but leave the request open
  // for a different candidate or a manual link.
  link.decision = decision;
  link.decidedBy = { uid: actor.uid, name: actor.name };
  link.decidedAt = new Date().toISOString();
  link.note = note || null;
  await putJSON(appDataKv, `po_link:${linkId}`, link);

  const request = await getRequest(appDataKv, link.requestId);
  if (request && !request.rejectedPos.includes(link.po)) {
    request.rejectedPos.push(link.po);
    await putJSON(appDataKv, `po_request:${request.id}`, request);
  }

  await logEvent(appDataKv, {
    recordType: 'po_link',
    recordId: linkId,
    so: link.so,
    title: `Loose match ${decision}: ${link.so} / ${link.po} / ${link.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'decision', from: null, to: decision }],
    roles: ['supply'],
    participants: [],
    exceptions: false,
  });

  return { link };
}

// Supply manually links a request straight to a specific PO number, bypassing
// suggestions entirely - "Supply's manual link wins over later matching"
// (mfpl-source-linking-round3.md). Caller supplies the PO row it looked up
// from PO Summary (so this lib doesn't need its own dataset-lookup path for
// a one-off manual pick).
export async function manualLink(appDataKv, requestId, poRow, actor) {
  const request = await getRequest(appDataKv, requestId);
  if (!request) throw new Error(`Request ${requestId} not found`);
  if (request.status !== 'raised' && request.status !== 'open') {
    throw new Error(`Request ${requestId} is already ${request.status}`);
  }
  const lineId = buildLineId(request.so, getField(poRow, 'po'), request.article);
  return finalizeLink(appDataKv, request, lineId, poRow, 'manual', actor);
}

// Undo an automatic link - spec explicitly calls this out ("recent automatic
// links (with undo)"), scoped to matchType 'auto' only; manual/confirmed
// links aren't undoable from the queue (supply already made a deliberate
// choice there).
export async function undoAutoLink(appDataKv, linkId, actor) {
  const link = await getJSON(appDataKv, `po_link:${linkId}`);
  if (!link) throw new Error(`Link ${linkId} not found`);
  if (link.matchType !== 'auto') throw new Error(`Link ${linkId} is not an automatic link (matchType: ${link.matchType})`);

  link.decision = 'undone';
  link.decidedBy = { uid: actor.uid, name: actor.name };
  link.decidedAt = new Date().toISOString();
  await putJSON(appDataKv, `po_link:${linkId}`, link);

  const request = await getRequest(appDataKv, link.requestId);
  if (request) {
    request.status = 'raised';
    request.linkedLineId = null;
    request.linkedAt = null;
    request.linkedVia = null;
    if (!request.rejectedPos.includes(link.po)) request.rejectedPos.push(link.po);
    await putJSON(appDataKv, `po_request:${request.id}`, request);
  }

  await logEvent(appDataKv, {
    recordType: 'po_link',
    recordId: linkId,
    so: link.so,
    title: `Automatic link undone: ${link.so} / ${link.po} / ${link.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'decision', from: 'confirmed', to: 'undone' }],
    roles: ['supply'],
    participants: [],
    exceptions: false,
  });

  return { link, request };
}

// --- Unmatched queue (computed fresh each time, nothing pre-stored) --------

async function listAllLinks(appDataKv) {
  const links = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix: 'po_link:', cursor });
    for (const entry of page.keys) {
      const link = await getJSON(appDataKv, entry.name);
      if (link) links.push(link);
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  return links;
}

const RECENT_LINK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // same 30-day window as the activity log

// Builds every Unmatched-queue section from mfpl-source-linking-round3.md.
// Runs matching first so "requests waiting" / "loose matches" reflect the
// current ERP mirror snapshot. goliveDate scopes the SO-since-go-live
// sections per the spec ("Covers SOs dated on or after the go-live date").
// NOTE on fidelity: sections 3-5 below (SKU/PO orphans) depend on each SO
// Article Breakup / PO Summary row carrying an SO date for go-live scoping,
// which isn't confirmed to exist under a known field name yet (see FIELD_MAP
// note) - rows without a recognizable date are included rather than silently
// dropped, so nothing goes missing from the queue, but this may over-include
// pre-go-live rows until the real field name is confirmed.
export async function getUnmatchedQueue(appDataKv, erpKv, goliveDate) {
  const { erpRows } = await runMatching(appDataKv, erpKv);
  const links = await listAllLinks(appDataKv);
  const goliveMs = goliveDate ? Date.parse(goliveDate) : -Infinity;

  const sinceGoLive = (row) => {
    const raw = row.SODate || row['SO Date'] || getField(row, 'poDate');
    if (!raw) return true; // can't tell - include rather than drop, see note above
    const ms = Date.parse(raw);
    return Number.isNaN(ms) || ms >= goliveMs;
  };

  const requestsWaiting = await listRequests(appDataKv, { status: 'raised' });

  const looseMatches = links.filter((l) => l.matchType === 'suggested' && l.decision === null);

  // SO+article combos with no PO at all, restricted to SOs that also have at
  // least one PO line this pass couldn't place on any SO article (the pairing
  // the spec describes: "SO SKUs with no PO on SOs that have unmatched PO lines").
  const poKeysBySo = new Map(); // so -> Set of "article" that have a PO
  for (const row of erpRows.poSummary) {
    const so = String(getField(row, 'so'));
    const article = String(getField(row, 'article'));
    if (!poKeysBySo.has(so)) poKeysBySo.set(so, new Set());
    poKeysBySo.get(so).add(article);
  }
  const soArticleKeysWithPo = new Set(erpRows.poSummary.map((r) => `${getField(r, 'so')}::${getField(r, 'article')}`));
  const poLinesWithNoSkuBySo = new Map(); // so -> count of orphan PO lines
  const poLinesWithNoSku = erpRows.poSummary.filter((row) => {
    if (!sinceGoLive(row)) return false;
    const key = `${getField(row, 'so')}::${getField(row, 'article')}`;
    const hasSoLine = erpRows.soArticleBreakup.some((s) => `${getField(s, 'so')}::${getField(s, 'article')}` === key);
    if (!hasSoLine) {
      const so = String(getField(row, 'so'));
      poLinesWithNoSkuBySo.set(so, (poLinesWithNoSkuBySo.get(so) || 0) + 1);
      return true;
    }
    return false;
  });

  const soSkusWithNoPo = erpRows.soArticleBreakup.filter((row) => {
    if (!sinceGoLive(row)) return false;
    const so = String(getField(row, 'so'));
    const article = String(getField(row, 'article'));
    const hasPo = soArticleKeysWithPo.has(`${so}::${article}`);
    return !hasPo && poLinesWithNoSkuBySo.has(so);
  });

  const soSet = new Set(erpRows.soArticleBreakup.map((r) => String(getField(r, 'so'))));
  const poLinesWithNoSo = erpRows.poSummary.filter((row) => sinceGoLive(row) && !soSet.has(String(getField(row, 'so'))));

  // Quantity above SO quantity, among lines that ARE linked.
  const qtyOverages = [];
  for (const link of links) {
    if (!['auto', 'manual', 'suggested'].includes(link.matchType)) continue;
    if (link.decision !== 'confirmed' && link.matchType !== 'auto') continue;
    if (link.qtyMismatch && Number(link.qtyOnPo) > Number(link.qtyRequested)) qtyOverages.push(link);
  }

  // Broken links: a confirmed/auto/manual link whose PO row or SO+article row
  // has since disappeared from the current ERP mirror snapshot entirely.
  const poRowExists = new Set(erpRows.poSummary.map((r) => `${getField(r, 'so')}::${getField(r, 'po')}::${getField(r, 'article')}`));
  const soRowExists = new Set(erpRows.soArticleBreakup.map((r) => `${getField(r, 'so')}::${getField(r, 'article')}`));
  const brokenLinks = links.filter((l) => {
    const isLive = (l.matchType === 'auto' || l.matchType === 'manual' || l.decision === 'confirmed') && l.decision !== 'undone' && l.decision !== 'rejected' && l.decision !== 'ignored';
    if (!isLive) return false;
    const poKey = `${l.so}::${l.po}::${l.article}`;
    const soKey = `${l.so}::${l.article}`;
    return !poRowExists.has(poKey) || !soRowExists.has(soKey);
  });
  for (const l of brokenLinks) {
    l.flagged = true;
    l.flagReason = !poRowExists.has(`${l.so}::${l.po}::${l.article}`) ? 'PO line no longer in PO Summary' : 'SO/article no longer in SO Article Breakup';
  }

  const now = Date.now();
  const recentAutoLinks = links.filter((l) => l.matchType === 'auto' && l.decision !== 'undone' && now - Date.parse(l.createdAt) <= RECENT_LINK_WINDOW_MS);
  const recentManualLinks = links.filter((l) => l.matchType === 'manual' && now - Date.parse(l.createdAt) <= RECENT_LINK_WINDOW_MS);

  return {
    requestsWaiting,
    looseMatches,
    soSkusWithNoPo,
    poLinesWithNoSku,
    poLinesWithNoSo,
    qtyOverages,
    brokenLinks,
    recentAutoLinks,
    recentManualLinks,
    todoCount:
      requestsWaiting.length +
      looseMatches.length +
      soSkusWithNoPo.length +
      poLinesWithNoSku.length +
      poLinesWithNoSo.length +
      qtyOverages.length +
      brokenLinks.length,
  };
}

export { getField, FIELD_MAP };

