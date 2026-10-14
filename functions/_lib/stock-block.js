// Stock Block Station: hold warehouse stock against an SO+article before a
// PO/fabric delivery catches up, so sales can promise from what's already in
// the warehouse instead of waiting on the factory.
//
// Spec note, unlike every other module this session: there is no dedicated
// spec doc for this one - the per-module mapping table had flagged it
// "blocked on JK" for exactly that reason. On a closer re-read this pass,
// enough of the real behavior turned out to already be written down, just
// scattered rather than collected in its own doc:
//   - mfpl-real-data-build-findings.md ("Current state (5 Oct)" section):
//     "Stock Block: SO -> article (from the SO's POs, or 'other article'
//     searched from the chosen warehouse's stock) -> warehouse (HO/BNG/COK)
//     -> Stock in hand from Stock Summary (+ already-blocked and free).
//     Qty/reason free text. Requests by sales, production (admin); supply
//     approves/rejects/releases. 'Blocked stock by warehouse' lists approved
//     blocks only (article -> SO -> qty)."
//   - mfpl-so-lines-pending-skus.md: "An approved Stock Block for the SO +
//     article (same or base code) counts as covered," and the article picker
//     for this module draws from the SO Article Breakup like PO Progress
//     Tracker's does.
//   - mfpl-notifications-design.md's role map: "Stock block request | Sales,
//     Supply" (level-2 "in your area" audience).
//   - mfpl-real-data-build-findings.md's notifications section: stock blocks
//     are a supply "needs action" to-do, and a requester's own "updates" feed.
// This is enough to build the module's own CRUD + approve/reject/release
// lifecycle with confidence. What's explicitly NOT built from this: the
// "counts as covered" read into PO Progress Tracker's Unmatched queue relies
// on the "same or base article code" matching rule, which lives only in
// JK's local build_from_folder.py (a build-time heuristic over article code
// prefixes) - the same class of client/build-only logic already excluded
// elsewhere this session (OCR, xlsx parsing). po-progress.js's queue does
// NOT currently consult stock-block.js at all; flagged as an open item below
// and in the schema doc, not guessed at here.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   stockblock:{id}                                      -> full record (below)
//   idx:stockblock_by_so:{so}:{id}                        -> id
//   idx:stockblock_by_article_wh:{article}:{warehouse}:{id} -> id
//     (drives both "already blocked" sums and the "Blocked stock by
//     warehouse" view, without a client-side full scan of every request)
//
// record: { id, so, article, warehouse ('ho'|'bng'|'cok'), qty, reason,
//   requestedBy:{uid,name}, requestedAt,
//   status: 'requested'|'approved'|'rejected'|'released',
//   decidedBy, decidedAt, decisionReason,
//   releasedBy, releasedAt }

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId } from './crypto.js';
import { logEvent } from './activity.js';
import { getDataset } from './erp-mirror.js';
import { getField } from './po-progress.js';

async function listIndex(appDataKv, prefix) {
  const ids = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix, cursor });
    for (const entry of page.keys) ids.push(entry.name.slice(entry.name.lastIndexOf(':') + 1));
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  return ids;
}

export const WAREHOUSES = ['ho', 'bng', 'cok'];

function datasetKeyFor(warehouse) {
  const w = String(warehouse || '').toLowerCase();
  if (!WAREHOUSES.includes(w)) throw new Error(`warehouse must be one of: ${WAREHOUSES.join(', ')}`);
  return `stock_summary_${w}`;
}

// Stock Summary's own column names are unconfirmed, same uncertainty class
// as po-progress.js's FIELD_MAP (see that file's header note) - a short
// guess-list, kept local to this module since "qty in hand" isn't a concept
// PO Summary/SO Article Breakup rows carry at all. Reuses po-progress.js's
// getField/FIELD_MAP only for the 'article' key, which the two datasets
// plausibly share a header name for.
const STOCK_QTY_FIELD_NAMES = ['Stock In Hand', 'StockInHand', 'Qty In Hand', 'Stock', 'Closing Stock', 'Available Qty'];

function stockQtyOf(row) {
  for (const name of STOCK_QTY_FIELD_NAMES) {
    if (row[name] !== undefined) return Number(row[name]) || 0;
  }
  return 0;
}

async function getIndexedArticleWh(appDataKv, article, warehouse) {
  return listIndex(appDataKv, `idx:stockblock_by_article_wh:${safeKeyPart(article)}:${safeKeyPart(warehouse)}:`);
}

export async function getRequest(appDataKv, id) {
  return getJSON(appDataKv, `stockblock:${id}`);
}

export async function listRequestsForSo(appDataKv, so) {
  const ids = await listIndex(appDataKv, `idx:stockblock_by_so:${safeKeyPart(so)}:`);
  const records = await Promise.all(ids.map((id) => getRequest(appDataKv, id)));
  return records.filter(Boolean).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}

// "Already blocked" = sum of qty across currently-approved (not yet
// released, not rejected) requests for this article+warehouse - this is
// also exactly what "Blocked stock by warehouse" lists per SO, per spec.
export async function computeAlreadyBlocked(appDataKv, article, warehouse) {
  const ids = await getIndexedArticleWh(appDataKv, article, warehouse);
  const records = await Promise.all(ids.map((id) => getRequest(appDataKv, id)));
  return records.filter((r) => r && r.status === 'approved').reduce((sum, r) => sum + Number(r.qty), 0);
}

// "Blocked stock by warehouse" view: approved blocks only, article -> SO -> qty.
export async function listBlockedByWarehouse(appDataKv, warehouse) {
  // No by-warehouse-only index exists (requests are indexed by article+
  // warehouse, not warehouse alone) - this scans every stockblock record.
  // Acceptable at this data volume (one internal tool's own requests, not an
  // ERP mirror); revisit with a dedicated by-warehouse index if it grows.
  const allIds = await listIndex(appDataKv, 'stockblock:');
  const records = (await Promise.all(allIds.map((id) => getRequest(appDataKv, id))))
    .filter((r) => r && r.status === 'approved' && String(r.warehouse).toLowerCase() === String(warehouse).toLowerCase());

  const byArticle = {};
  for (const r of records) {
    byArticle[r.article] = byArticle[r.article] || {};
    byArticle[r.article][r.so] = (byArticle[r.article][r.so] || 0) + Number(r.qty);
  }
  return byArticle;
}

// Stock in hand + already-blocked + free, for the request form (spec: "Stock
// in hand from Stock Summary (+ already-blocked and free)").
export async function getStockPosition(erpKv, appDataKv, article, warehouse) {
  const dataset = await getDataset(erpKv, datasetKeyFor(warehouse));
  let stockInHand = 0;
  if (dataset) {
    const row = dataset.rows.find((r) => String(getField(r, 'article')) === String(article));
    if (row) stockInHand = stockQtyOf(row);
  }
  const alreadyBlocked = await computeAlreadyBlocked(appDataKv, article, warehouse);
  return { article, warehouse, stockInHand, alreadyBlocked, free: Math.max(0, stockInHand - alreadyBlocked) };
}

export async function createRequest(appDataKv, input, actor) {
  const required = ['so', 'article', 'warehouse', 'qty'];
  for (const field of required) {
    if (!input[field] && input[field] !== 0) throw new Error(`${field} is required`);
  }
  datasetKeyFor(input.warehouse); // throws if not ho/bng/cok
  const id = randomId('sblock');
  const now = new Date().toISOString();
  const record = {
    id,
    so: input.so,
    article: input.article,
    warehouse: String(input.warehouse).toLowerCase(),
    qty: Number(input.qty),
    reason: input.reason || '',
    requestedBy: { uid: actor.uid, name: actor.name },
    requestedAt: now,
    status: 'requested',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    releasedBy: null,
    releasedAt: null,
  };
  await putJSON(appDataKv, `stockblock:${id}`, record);
  await appDataKv.put(`idx:stockblock_by_so:${safeKeyPart(input.so)}:${id}`, id);
  await appDataKv.put(`idx:stockblock_by_article_wh:${safeKeyPart(input.article)}:${safeKeyPart(record.warehouse)}:${id}`, id);

  await logEvent(appDataKv, {
    recordType: 'stock_block',
    recordId: id,
    so: input.so,
    title: `Stock block requested for ${input.so} / ${input.article} (${record.warehouse.toUpperCase()})`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: null, to: 'requested' }],
    roles: ['supply'],
    participants: [],
    exceptions: true, // "new ... stock block request" is in the admin exceptions filter
  });

  return record;
}

export async function decide(appDataKv, id, decision, reason, actor) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error("decision must be 'approved' or 'rejected'");
  const record = await getRequest(appDataKv, id);
  if (!record) throw new Error(`Stock block request ${id} not found`);
  if (record.status !== 'requested') throw new Error(`Only a 'requested' block can be decided (current status: ${record.status})`);

  record.status = decision;
  record.decidedBy = { uid: actor.uid, name: actor.name };
  record.decidedAt = new Date().toISOString();
  record.decisionReason = reason || null;
  await putJSON(appDataKv, `stockblock:${id}`, record);

  await logEvent(appDataKv, {
    recordType: 'stock_block',
    recordId: id,
    so: record.so,
    title: `Stock block ${decision} for ${record.so} / ${record.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'requested', to: decision }],
    roles: ['supply'],
    participants: [record.requestedBy.uid],
    exceptions: decision === 'rejected',
  });

  return record;
}

// Supply releases an approved block, freeing the stock back for other use -
// per spec, "supply approves/rejects/releases."
export async function release(appDataKv, id, actor) {
  const record = await getRequest(appDataKv, id);
  if (!record) throw new Error(`Stock block request ${id} not found`);
  if (record.status !== 'approved') throw new Error(`Only an 'approved' block can be released (current status: ${record.status})`);

  record.status = 'released';
  record.releasedBy = { uid: actor.uid, name: actor.name };
  record.releasedAt = new Date().toISOString();
  await putJSON(appDataKv, `stockblock:${id}`, record);

  await logEvent(appDataKv, {
    recordType: 'stock_block',
    recordId: id,
    so: record.so,
    title: `Stock block released for ${record.so} / ${record.article}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'status', from: 'approved', to: 'released' }],
    roles: ['supply'],
    participants: [record.requestedBy.uid],
    exceptions: false,
  });

  return record;
}

// Per mfpl-so-lines-pending-skus.md: "An approved Stock Block for the SO +
// article ... counts as covered." Exact-article-code only here (see header
// note on why "same or base code" isn't implemented) - exposed so a future
// caller (po-progress.js's queue, or the client) can use it without
// duplicating the approved-only filter.
export async function isCoveredByApprovedBlock(appDataKv, so, article) {
  const requests = await listRequestsForSo(appDataKv, so);
  return requests.some((r) => r.status === 'approved' && String(r.article) === String(article));
}
