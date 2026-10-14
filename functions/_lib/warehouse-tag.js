// Warehouse Tag Station - spec: mfpl-real-data-build-findings.md ("Warehouse
// Tag intake" section) + mfpl-prints-and-site-form-9oct.md ("Warehouse Tag
// Station (factory dispatch)" section).
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   wtag:{tagId}                                  -> full tag record
//   idx:wtag_by_po_sku:{po}:{sku}:{tagId}          -> tagId  (drives qty-sequence
//                                                     allocation: "next unused
//                                                     number, hard block on
//                                                     repeats, stops at total")
//   idx:wtag_by_so_sku:{so}:{sku}:{tagId}          -> tagId  (Last Mile's "tags
//                                                     to pick" - all received
//                                                     tags for an SO+SKU, in
//                                                     tag-number order)
//   wchallan:{challanId}                           -> { id, batchNo, tagIds[],
//                                                        vehicleNo, driverName,
//                                                        dispatchedBy, dispatchedAt }
//
// Tag record: { id, po, sku, articleName, so, customer, qtySeq, qtyTotal,
//   packets, createdBy, createdAt, dispatch: {challanId, batchNo, dispatchedBy,
//   dispatchedAt} | null, receipt: {receivedBy, receivedAt} | null }
//
// tagId is a plain random id (randomId('wtag')), NOT required to be
// sequential/pretty by either spec doc (unlike Furnishings Tag Station's
// printed TAG-#### number, which the UI reference explicitly calls out as
// sequential) - this sidesteps the KV counter race-condition question
// entirely for this module, since nothing here depends on tag IDs being in
// order. qtySeq (the "piece n of N" print field) is the number that must be
// unique and gap-free per PO+SKU, and that's handled by scanning the by-PO+SKU
// index for already-used sequence numbers, same race caveat as Furnishings'
// counter (low-concurrency internal tool, best-effort not a hard guarantee).
//
// Challan id is DC-YYYYMMDD-HHMMSS from the dispatch timestamp specifically
// because the spec says batch numbers (WDP-xxx) are random and can repeat,
// so they can't be the key - "one batch = one Confirm Dispatch: the same
// batch number plus the same timestamp" means the batch number is recorded
// on the challan/tags but the challan's own identity is the timestamp.

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { randomId } from './crypto.js';
import { logEvent } from './activity.js';

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

async function nextUnusedSequence(appDataKv, po, sku, qtyTotal) {
  const ids = await listIndex(appDataKv, `idx:wtag_by_po_sku:${safeKeyPart(po)}:${safeKeyPart(sku)}:`);
  const used = new Set();
  for (const id of ids) {
    const tag = await getJSON(appDataKv, `wtag:${id}`);
    if (tag) used.add(tag.qtySeq);
  }
  for (let n = 1; n <= qtyTotal; n++) {
    if (!used.has(n)) return n;
  }
  throw new Error(`All ${qtyTotal} pieces for ${po} / ${sku} have already been tagged`);
}

// "Installation required" flag, per piece - mfpl-last-mile-ops-alignment.md:
// "A tick at warehouse intake, per piece, carried forward to the next piece
// of the same SKU on the PO." If the caller doesn't explicitly say whether
// this piece needs installation, look up the most recent (highest qtySeq)
// existing tag for the same PO+SKU and reuse its flag - the carry-forward
// the spec describes. Defaults to false for the very first piece of a
// PO+SKU with nothing to carry from.
async function carryForwardInstallationFlag(appDataKv, po, sku) {
  const ids = await listIndex(appDataKv, `idx:wtag_by_po_sku:${safeKeyPart(po)}:${safeKeyPart(sku)}:`);
  let latest = null;
  for (const id of ids) {
    const tag = await getJSON(appDataKv, `wtag:${id}`);
    if (tag && (!latest || tag.qtySeq > latest.qtySeq)) latest = tag;
  }
  return latest ? !!latest.installationFlag : false;
}

// Pure hint helper (spec: "A hint shows when the SO has an installation
// charge or the product name looks like a bed, console, dining table,
// centre table, vanity or mirror") - the hint itself is a client-side UI
// nudge, exported here only so both the client and any future server
// validation share one keyword list rather than two.
const INSTALLATION_HINT_KEYWORDS = ['bed', 'console', 'dining table', 'centre table', 'center table', 'vanity', 'mirror'];
export function installationFlagHint(articleName, soHasInstallationCharge) {
  if (soHasInstallationCharge) return true;
  const name = String(articleName || '').toLowerCase();
  return INSTALLATION_HINT_KEYWORDS.some((kw) => name.includes(kw));
}

export async function createIntake(appDataKv, input, actor) {
  const required = ['po', 'sku', 'articleName', 'so', 'customer', 'qtyTotal'];
  for (const field of required) {
    if (!input[field] && input[field] !== 0) throw new Error(`${field} is required`);
  }
  if (input.qtyTotal < 1) throw new Error('qtyTotal must be at least 1');

  const qtySeq = await nextUnusedSequence(appDataKv, input.po, input.sku, input.qtyTotal);
  const id = randomId('wtag');
  const installationFlag = typeof input.installationFlag === 'boolean' ? input.installationFlag : await carryForwardInstallationFlag(appDataKv, input.po, input.sku);
  const tag = {
    id,
    po: input.po,
    sku: input.sku,
    articleName: input.articleName,
    so: input.so,
    customer: input.customer,
    qtySeq,
    qtyTotal: input.qtyTotal,
    packets: input.packets || 1,
    installationFlag,
    createdBy: { uid: actor.uid, name: actor.name },
    createdAt: new Date().toISOString(),
    dispatch: null,
    receipt: null,
  };
  await putJSON(appDataKv, `wtag:${id}`, tag);
  await appDataKv.put(`idx:wtag_by_po_sku:${safeKeyPart(input.po)}:${safeKeyPart(input.sku)}:${id}`, id);
  await appDataKv.put(`idx:wtag_by_so_sku:${safeKeyPart(input.so)}:${safeKeyPart(input.sku)}:${id}`, id);

  await logEvent(appDataKv, {
    recordType: 'warehouse_tag',
    recordId: id,
    so: input.so,
    title: `Warehouse tag created: ${input.articleName} (${input.sku}) piece ${qtySeq} of ${input.qtyTotal}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'tag', from: null, to: id }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return tag;
}

export async function getTag(appDataKv, tagId) {
  return getJSON(appDataKv, `wtag:${tagId}`);
}

// Supply or the factory can correct the carried-forward flag on a specific
// tag - spec: "every change is logged." Does NOT retroactively touch other
// pieces; the carry-forward only applies going forward to the *next* new
// intake for that PO+SKU.
export async function setInstallationFlag(appDataKv, tagId, flag, actor) {
  const tag = await getTag(appDataKv, tagId);
  if (!tag) throw new Error(`Tag ${tagId} not found`);
  const from = !!tag.installationFlag;
  tag.installationFlag = !!flag;
  await putJSON(appDataKv, `wtag:${tagId}`, tag);

  await logEvent(appDataKv, {
    recordType: 'warehouse_tag',
    recordId: tagId,
    so: tag.so,
    title: `Installation flag ${tag.installationFlag ? 'set' : 'cleared'} on ${tag.articleName} (${tag.sku}) piece ${tag.qtySeq}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'installationFlag', from, to: tag.installationFlag }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return tag;
}

export async function listTags(appDataKv) {
  const tags = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix: 'wtag:', cursor });
    for (const entry of page.keys) {
      const tag = await getJSON(appDataKv, entry.name);
      if (tag) tags.push(tag);
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  tags.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return tags;
}

// "Tags to pick": every RECEIVED tag for an SO+SKU, in tag-number (qtySeq)
// order - the actual list Last Mile's packing-list print draws from
// (mfpl-prints-and-site-form-9oct.md: "From warehouse tags that have been
// received at the warehouse for that SO + SKU, in tag-number order").
export async function tagsToPick(appDataKv, so, sku) {
  const ids = await listIndex(appDataKv, `idx:wtag_by_so_sku:${safeKeyPart(so)}:${safeKeyPart(sku)}:`);
  const tags = [];
  for (const id of ids) {
    const tag = await getJSON(appDataKv, `wtag:${id}`);
    if (tag && tag.receipt) tags.push(tag);
  }
  tags.sort((a, b) => a.qtySeq - b.qtySeq);
  return tags;
}

export async function createChallan(appDataKv, { tagIds, batchNo, vehicleNo, driverName }, actor) {
  if (!Array.isArray(tagIds) || tagIds.length === 0) throw new Error('At least one tag is required');
  const tags = [];
  for (const id of tagIds) {
    const tag = await getTag(appDataKv, id);
    if (!tag) throw new Error(`Tag ${id} not found`);
    if (tag.dispatch) throw new Error(`Tag ${id} is already dispatched (challan ${tag.dispatch.challanId})`);
    tags.push(tag);
  }

  const challanId = `DC-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const challan = {
    id: challanId,
    batchNo: batchNo || null,
    tagIds,
    vehicleNo: vehicleNo || null,
    driverName: driverName || null,
    dispatchedBy: { uid: actor.uid, name: actor.name },
    dispatchedAt: new Date().toISOString(),
  };
  await putJSON(appDataKv, `wchallan:${challanId}`, challan);

  for (const tag of tags) {
    tag.dispatch = { challanId, batchNo: challan.batchNo, dispatchedBy: challan.dispatchedBy, dispatchedAt: challan.dispatchedAt };
    await putJSON(appDataKv, `wtag:${tag.id}`, tag);
  }

  await logEvent(appDataKv, {
    recordType: 'warehouse_tag',
    recordId: challanId,
    so: null,
    title: `Warehouse dispatch: ${tagIds.length} tag(s) on challan ${challanId}${batchNo ? ` (batch ${batchNo})` : ''}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'dispatch', from: null, to: challanId }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return challan;
}

export async function confirmReceipt(appDataKv, { tagIds }, actor) {
  if (!Array.isArray(tagIds) || tagIds.length === 0) throw new Error('At least one tag is required');
  const updated = [];
  for (const id of tagIds) {
    const tag = await getTag(appDataKv, id);
    if (!tag) throw new Error(`Tag ${id} not found`);
    if (tag.receipt) throw new Error(`Tag ${id} has already been received`);
    // Note: unlike Furnishings Tag Station, Warehouse Tag Station's receipt
    // step doesn't strictly require a prior dispatch in every spec'd flow
    // (e.g. receiving straight at the warehouse after intake) - not blocking
    // on tag.dispatch here is intentional, not an oversight.
    tag.receipt = { receivedBy: { uid: actor.uid, name: actor.name }, receivedAt: new Date().toISOString() };
    await putJSON(appDataKv, `wtag:${id}`, tag);
    updated.push(tag);
  }

  await logEvent(appDataKv, {
    recordType: 'warehouse_tag',
    recordId: tagIds.join(','),
    so: null,
    title: `Warehouse receipt confirmed: ${tagIds.length} tag(s)`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'receipt', from: null, to: 'confirmed' }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return updated;
}
