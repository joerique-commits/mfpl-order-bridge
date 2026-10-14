// Furnishings Tag Station - spec: furnishings-tag-station-ui-reference.md
// (captured from the real, in-production tool at magariupholsterytagstation.edgeone.dev).
// Order Bridge's rebuild skips that tool's "who's doing this" identity-gate
// modal and uses the already-logged-in Order Bridge user instead (per the
// doc's own "Notes for the Order Bridge rebuild" section) - everything else
// (field order/behavior, duplicate-SKU warning, Intake/Dispatch/Receiving/
// Logbook split) is matched as closely as practical.
//
// KV shapes, in ob_app_data (env.APP_DATA):
//   ftag:{tagId}                                  -> full tag record
//   ftag_counter                                  -> { next: N }  (sequential TAG-#### numbering)
//   idx:ftag_by_po:{poKind}:{poNumber}:{tagId}     -> tagId   (poKind: 'furnishings' | 'furniture';
//                                                     drives the duplicate-SKU-on-PO warning)
//   fchallan:{challanId}                           -> { id, tagIds[], destination, dispatchedBy, dispatchedAt }
//
// Tag record: { id, furnishingsPo, material, sku, qty, unit, dateReceived,
//   furniturePo, furnitureProduct, furnitureProductCode, customer, notes,
//   loggedBy:{uid,name}, loggedAt,
//   dispatch: {challanId, destination, dispatchedBy, dispatchedAt} | null,
//   receipt: {receivedBy, receivedAt} | null }
//
// Sequential numbering caveat: EdgeOne KV has no atomic increment and no
// multi-key transactions (schema doc), so the counter read-increment-write
// below has a real race under concurrent intakes - two requests landing at
// the same moment could compute the same "next" number. Mitigated (not
// eliminated) by checking the target key doesn't already exist before
// committing and retrying forward if it does; this is a best-effort scheme
// appropriate for a low-concurrency internal tool (one warehouse operator
// typically working Intake at a time), not a guarantee. Worth revisiting if
// this ever becomes a real bottleneck or correctness issue in practice.

import { getJSON, putJSON, safeKeyPart } from './kv.js';
import { logEvent } from './activity.js';

function pad4(n) {
  return String(n).padStart(4, '0');
}

async function nextTagId(appDataKv) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = (await getJSON(appDataKv, 'ftag_counter')) || { next: 1 };
    const candidate = `TAG-${pad4(counter.next)}`;
    await putJSON(appDataKv, 'ftag_counter', { next: counter.next + 1 });
    const collision = await getJSON(appDataKv, `ftag:${candidate}`);
    if (!collision) return candidate;
  }
  throw new Error('Could not allocate a tag number after 5 attempts - unexpectedly high contention');
}

export async function findDuplicateSkuOnPo(appDataKv, poKind, poNumber, sku) {
  if (!poNumber) return [];
  const prefix = `idx:ftag_by_po:${poKind}:${safeKeyPart(poNumber)}:`;
  const ids = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix, cursor });
    for (const entry of page.keys) ids.push(entry.name.slice(entry.name.lastIndexOf(':') + 1));
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  const matches = [];
  for (const id of ids) {
    const tag = await getJSON(appDataKv, `ftag:${id}`);
    if (tag && tag.sku === sku) matches.push(tag);
  }
  return matches;
}

export async function createIntake(appDataKv, input, actor) {
  const required = ['furnishingsPo', 'material', 'sku', 'qty', 'unit', 'furniturePo', 'furnitureProduct', 'customer'];
  for (const field of required) {
    if (!input[field] && input[field] !== 0) throw new Error(`${field} is required`);
  }

  const id = await nextTagId(appDataKv);
  const tag = {
    id,
    furnishingsPo: input.furnishingsPo,
    material: input.material,
    sku: input.sku,
    qty: input.qty,
    unit: input.unit,
    dateReceived: input.dateReceived || new Date().toISOString().slice(0, 10),
    furniturePo: input.furniturePo,
    furnitureProduct: input.furnitureProduct,
    furnitureProductCode: input.furnitureProductCode || null,
    customer: input.customer,
    notes: input.notes || null,
    loggedBy: { uid: actor.uid, name: actor.name },
    loggedAt: new Date().toISOString(),
    dispatch: null,
    receipt: null,
  };
  await putJSON(appDataKv, `ftag:${id}`, tag);
  await appDataKv.put(`idx:ftag_by_po:furnishings:${safeKeyPart(input.furnishingsPo)}:${id}`, id);
  await appDataKv.put(`idx:ftag_by_po:furniture:${safeKeyPart(input.furniturePo)}:${id}`, id);

  await logEvent(appDataKv, {
    recordType: 'furnishings_tag',
    recordId: id,
    so: null,
    title: `Furnishings intake logged: ${input.material} (${input.sku}) -> ${id}`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'tag', from: null, to: id }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return tag;
}

export async function getTag(appDataKv, tagId) {
  return getJSON(appDataKv, `ftag:${tagId}`);
}

export async function listTags(appDataKv) {
  const tags = [];
  let cursor;
  let done = false;
  while (!done) {
    const page = await appDataKv.list({ prefix: 'ftag:', cursor });
    for (const entry of page.keys) {
      const tag = await getJSON(appDataKv, entry.name);
      if (tag) tags.push(tag);
    }
    cursor = page.cursor;
    done = !page.hasMore || !cursor;
  }
  tags.sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : -1));
  return tags;
}

export async function createChallan(appDataKv, { tagIds, destination }, actor) {
  if (!Array.isArray(tagIds) || tagIds.length === 0) throw new Error('At least one tag is required');
  const tags = [];
  for (const id of tagIds) {
    const tag = await getTag(appDataKv, id);
    if (!tag) throw new Error(`Tag ${id} not found`);
    if (tag.dispatch) throw new Error(`Tag ${id} is already dispatched (challan ${tag.dispatch.challanId})`);
    tags.push(tag);
  }

  const challanId = `FDC-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const challan = {
    id: challanId,
    tagIds,
    destination: destination || null,
    dispatchedBy: { uid: actor.uid, name: actor.name },
    dispatchedAt: new Date().toISOString(),
  };
  await putJSON(appDataKv, `fchallan:${challanId}`, challan);

  for (const tag of tags) {
    tag.dispatch = { challanId, destination: challan.destination, dispatchedBy: challan.dispatchedBy, dispatchedAt: challan.dispatchedAt };
    await putJSON(appDataKv, `ftag:${tag.id}`, tag);
  }

  await logEvent(appDataKv, {
    recordType: 'furnishings_tag',
    recordId: challanId,
    so: null,
    title: `Furnishings dispatch: ${tagIds.length} tag(s) on challan ${challanId}`,
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
    if (!tag.dispatch) throw new Error(`Tag ${id} has not been dispatched yet`);
    if (tag.receipt) throw new Error(`Tag ${id} has already been received`);
    tag.receipt = { receivedBy: { uid: actor.uid, name: actor.name }, receivedAt: new Date().toISOString() };
    await putJSON(appDataKv, `ftag:${id}`, tag);
    updated.push(tag);
  }

  await logEvent(appDataKv, {
    recordType: 'furnishings_tag',
    recordId: tagIds.join(','),
    so: null,
    title: `Furnishings receipt confirmed: ${tagIds.length} tag(s)`,
    by: { uid: actor.uid, name: actor.name, role: actor.role },
    changes: [{ field: 'receipt', from: null, to: 'confirmed' }],
    roles: ['supply', 'production'],
    participants: [],
    exceptions: false,
  });

  return updated;
}
