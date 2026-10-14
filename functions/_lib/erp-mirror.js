// Generic ERP-mirror blob storage, shared by every module that reads
// wholesale ERP exports (PO Progress Tracker, Order Deadlines, Payables &
// Flushout, Last Mile - see the per-module mapping in
// mfpl-edgeone-kv-schema.md). Lives in ob_erp_mirror (env.ERP_MIRROR).
//
// Division of labor: parsing an uploaded .xlsx into row objects happens in
// the admin's browser (the project's existing client-side build already
// does this kind of parsing for the local build's data pipeline) - this
// layer only stores and serves the already-parsed JSON. No server-side xlsx
// parsing is attempted here.
//
// Chunking: the KV value-size cap is still empirically unverified (see
// schema doc - 25MB vs 1MB conflicting numbers). Rather than gamble on one
// giant value per dataset (SO Article Breakup is ~13,000 rows, PO Summary
// ~4,700), every dataset is stored pre-chunked from the start - cheap
// insurance that works regardless of which cap turns out to be real.
//
// KV shapes:
//   erp_meta:{datasetKey}            -> { datasetKey, originalName, bytes,
//                                          rowCount, chunkCount, uploadedAt,
//                                          uploadedBy:{uid,name} }
//   erp_chunk:{datasetKey}:{n}       -> JSON array, one chunk of rows
//
// Meta is written AFTER all chunks (same "data before metadata" ordering as
// the rest of this project), so a reader who sees fresh meta can always find
// every chunk it points to.

import { getJSON, putJSON } from './kv.js';

const CHUNK_SIZE = 2000; // rows per KV value; conservative given the unverified cap

export const DATASET_KEYS = [
  'po_summary',
  'daily_pi_revenue',
  'so_article_breakup',
  'stock_summary_ho',
  'stock_summary_bng',
  'stock_summary_cok',
  'invoiced_os',
  'payment_expenses_report',
  'verticle_statement',
  'dispatch_sheet',
  'standard_upholstery',
  'standard_finishes',
  'standard_stone',
];

export async function uploadDataset(erpKv, { datasetKey, originalName, rows }, actor) {
  if (!DATASET_KEYS.includes(datasetKey)) {
    throw new Error(`datasetKey must be one of: ${DATASET_KEYS.join(', ')}`);
  }
  if (!Array.isArray(rows)) throw new Error('rows must be an array');

  const chunkCount = Math.max(1, Math.ceil(rows.length / CHUNK_SIZE));
  for (let i = 0; i < chunkCount; i++) {
    const chunk = rows.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await putJSON(erpKv, `erp_chunk:${datasetKey}:${i}`, chunk);
  }
  const meta = {
    datasetKey,
    originalName: originalName || null,
    rowCount: rows.length,
    chunkCount,
    uploadedAt: new Date().toISOString(),
    uploadedBy: { uid: actor.uid, name: actor.name },
  };
  // Written last - see file header note on ordering.
  await putJSON(erpKv, `erp_meta:${datasetKey}`, meta);
  return meta;
}

export async function getDatasetMeta(erpKv, datasetKey) {
  return getJSON(erpKv, `erp_meta:${datasetKey}`);
}

export async function listDatasetMeta(erpKv) {
  const metas = [];
  for (const key of DATASET_KEYS) {
    const meta = await getDatasetMeta(erpKv, key);
    metas.push(meta || { datasetKey: key, uploaded: false });
  }
  return metas;
}

export async function getDataset(erpKv, datasetKey) {
  const meta = await getDatasetMeta(erpKv, datasetKey);
  if (!meta) return null;
  const rows = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const chunk = await getJSON(erpKv, `erp_chunk:${datasetKey}:${i}`);
    if (chunk) rows.push(...chunk);
  }
  return { meta, rows };
}
