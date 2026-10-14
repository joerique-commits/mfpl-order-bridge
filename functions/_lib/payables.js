// Payables & Flushout: a pure computed view over ERP-mirrored data, no
// app-native writes (per the per-module mapping in mfpl-edgeone-kv-schema.md).
// Spec: mfpl-payables-flushout-data-sourcing-13oct.md (the decided formulas,
// 13 Oct - authoritative) + mfpl-payables-flushout-layout-12oct.md (box/table
// layout + the two formulas that predate the 13 Oct data-sourcing pass:
// "cost payable on POs yet to raise" and "receivable from open sales orders").
//
// Division of labor, unlike every other module built this session: there is
// NOTHING to store here. Every box and table is recomputed fresh from the
// ERP mirror datasets (via erp-mirror.js) each time this is called, plus a
// cross-module read of Order Deadlines' `neg:{lineId}` records for table 4's
// completion-deadline rollup (reusing po-progress.js's buildLineId so both
// modules agree on the same line identity).
//
// Field-name confidence note: unlike PO Progress Tracker's po-progress.js
// (whose FIELD_MAP is a pure guess), the field names below ARE the literal
// column names named in mfpl-payables-flushout-data-sourcing-13oct.md's "How
// each box/table is sourced now" section (Closing Taxable, CP, Transaction
// Amount Before Tax, Total Collection Wout Tax, PI Cost, Total Amount, Total
// Discount, Net Amount). Still worth confirming casing/spacing against a real
// file once one is visible, but these are considerably more grounded than
// po-progress.js's. Vendor/supplier/PO/SO/date column names are NOT spelled
// out anywhere, so FIELD reuses po-progress.js's same FIELD_MAP convention
// for those four, both for consistency and so a future field-name correction
// in one place covers both modules.

import { getField } from './po-progress.js';
import { getDataset } from './erp-mirror.js';

const F = {
  // From mfpl-payables-flushout-data-sourcing-13oct.md, verbatim column names:
  closingTaxable: 'Closing Taxable', // InvoicedOS, vendor-level opening balance
  cp: 'CP', // PO Summary, pre-GST PO cost
  txnBeforeTax: 'Transaction Amount Before Tax', // Payment Expenses Report
  totalCollectionWoutTax: 'Total Collection Wout Tax', // Daily PI Revenue
  piCost: 'PI Cost', // Daily PI Revenue
  piTaxableAmount: 'PI Taxable Amount', // Daily PI Revenue (validated elsewhere, see mfpl-source-linking-round3.md)
  totalAmount: 'Total Amount', // Dispatch Sheet
  totalDiscount: 'Total Discount', // Dispatch Sheet
  netAmount: 'Net Amount', // Dispatch Sheet (unused by the collectible formula per spec - pre-GST basis used instead)
  // Not named in either doc - best guess, same uncertainty class as po-progress.js's FIELD_MAP:
  vendor: ['Vendor', 'Supplier'],
  creditAmount: ['Credit', 'credit'],
  debitAmount: ['Debit', 'debit'],
  description: ['Description', 'Narration', 'description'],
};

export const DEFAULT_CUTOFF_DATE = '2026-08-31'; // "as of 31 Aug 2026" throughout the spec

export function cleanVendorName(raw) {
  if (!raw) return '';
  // Strips a "CODE-->Name" prefix (mfpl-payables-flushout-data-sourcing-13oct.md,
  // assumption 1: "stripping the CODE--> prefix and comparing the plain name").
  const idx = String(raw).indexOf('-->');
  return idx === -1 ? String(raw).trim() : String(raw).slice(idx + 3).trim();
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

function isAfter(dateStr, cutoff) {
  const d = Date.parse(dateStr);
  return !Number.isNaN(d) && d > Date.parse(cutoff);
}

// Date field name is unconfirmed for Payment Expenses Report / Daily PI
// Revenue rows (same uncertainty class as po-progress.js's FIELD_MAP) - tries
// a few plausible headers rather than hardcoding one guess.
function dateOf(row) {
  return row['PO Date'] || row.PODate || row.Date || row.date || row['SO Date'] || row.SODate || null;
}

function vendorOf(row) {
  // po-progress.js's FIELD_MAP (reused here for po/so/article/poDate/qty) has
  // no 'vendor' entry of its own, so vendor/supplier lookup is local to this
  // file rather than routed through getField().
  return cleanVendorName(F.vendor.map((k) => row[k]).find((v) => v !== undefined));
}

// --- Opening balances (InvoicedOS, vendor-level, as of the cutoff, no date
// filter on the file itself - "always included in full, it has no date to
// filter") ---------------------------------------------------------------
export function computeOpeningBalances(invoicedOsRows) {
  const balances = new Map();
  for (const row of invoicedOsRows) {
    const vendor = vendorOf(row);
    if (!vendor) continue;
    const amount = num(row[F.closingTaxable]);
    balances.set(vendor, (balances.get(vendor) || 0) + amount);
  }
  return balances;
}

// --- Table 1: Payable by vendor + the "Payable on open POs" total box ----
// Payable on open POs (per vendor) = opening balance (full, no date filter)
// + PO Summary CP for that vendor's POs dated AFTER cutoff
// - Payment Expenses Report amounts for that vendor dated AFTER cutoff.
// Everything on/before cutoff is already inside the InvoicedOS snapshot.
export function computeVendorPayables(invoicedOsRows, poSummaryRows, paymentRows, cutoffDate = DEFAULT_CUTOFF_DATE) {
  const openingBalances = computeOpeningBalances(invoicedOsRows);
  const vendors = new Map(); // vendor -> { vendor, openingBalance, poValueAllTime, poValuePostCutoff, paidPostCutoff, pos: [{po, poDate, cp, paid, balance}], rolledUpPreCutoffCount }

  const ensure = (vendor) => {
    if (!vendors.has(vendor)) {
      vendors.set(vendor, {
        vendor,
        openingBalance: openingBalances.get(vendor) || 0,
        poValueAllTime: 0,
        poValuePostCutoff: 0,
        paidPostCutoff: 0,
        pos: new Map(), // po -> { po, poDate, cp, paid }
        rolledUpPreCutoffCount: 0,
      });
    }
    return vendors.get(vendor);
  };

  // Seed the vendor list from InvoicedOS too (assumption 1: 4 vendors in the
  // real data don't match any PO Summary supplier at all, but still need a
  // table-1 row carrying their opening balance).
  for (const vendor of openingBalances.keys()) ensure(vendor);

  for (const row of poSummaryRows) {
    const vendor = vendorOf(row);
    if (!vendor) continue;
    const v = ensure(vendor);
    const cp = num(row[F.cp]);
    const po = String(getField(row, 'po'));
    const poDate = getField(row, 'poDate');
    v.poValueAllTime += cp;
    if (poDate && isAfter(poDate, cutoffDate)) {
      v.poValuePostCutoff += cp;
      const entry = v.pos.get(po) || { po, poDate, cp: 0, paid: 0 };
      entry.cp += cp;
      v.pos.set(po, entry);
    } else {
      v.rolledUpPreCutoffCount += 1;
    }
  }

  const orphanPayments = [];
  for (const row of paymentRows) {
    const vendor = vendorOf(row);
    const amount = num(row[F.txnBeforeTax]);
    const date = dateOf(row);
    if (!vendor || !date || !isAfter(date, cutoffDate)) continue;
    const v = ensure(vendor);
    v.paidPostCutoff += amount;
    const po = String(getField(row, 'po') || '');
    if (po && v.pos.has(po)) {
      v.pos.get(po).paid += amount;
    } else if (po) {
      // Payment references a PO not present (yet, or at all) in this PO
      // Summary snapshot - still counted by vendor, footnoted (assumption 2).
      orphanPayments.push({ vendor, po, amount, date });
    }
  }

  const table = [];
  for (const v of vendors.values()) {
    const balance = v.openingBalance + v.poValuePostCutoff - v.paidPostCutoff;
    const pos = Array.from(v.pos.values()).map((p) => ({ ...p, balance: p.cp - p.paid }));
    table.push({
      vendor: v.vendor,
      poValueAllTime: v.poValueAllTime,
      openingBalance: v.openingBalance,
      paidPostCutoff: v.paidPostCutoff,
      balance,
      rolledUpPreCutoffCount: v.rolledUpPreCutoffCount,
      pos,
    });
  }
  table.sort((a, b) => b.balance - a.balance);

  return { table, orphanPayments, totalPayableOnOpenPos: table.reduce((sum, v) => sum + v.balance, 0) };
}

// --- "Total paid to vendors" box: plain sum over the date range, NOT
// restricted to post-cutoff (spec: "independent of the opening-balance
// cutoff logic") ------------------------------------------------------------
export function computeTotalPaidToVendors(paymentRows, { from, to } = {}) {
  let total = 0;
  for (const row of paymentRows) {
    const date = dateOf(row);
    if (from && date && Date.parse(date) < Date.parse(from)) continue;
    if (to && date && Date.parse(date) > Date.parse(to)) continue;
    total += num(row[F.txnBeforeTax]);
  }
  return total;
}

// --- "Total collected" box: Total Collection Wout Tax, dated by SO date
// (no true collection date exists in any file - spec's own caveat) --------
export function computeTotalCollected(dailyPiRows, { from, to } = {}) {
  let total = 0;
  for (const row of dailyPiRows) {
    const date = dateOf(row);
    if (from && date && Date.parse(date) < Date.parse(from)) continue;
    if (to && date && Date.parse(date) > Date.parse(to)) continue;
    total += num(row[F.totalCollectionWoutTax]);
  }
  return total;
}

// --- "Total allocated" box: verticle statement, bucketed by description
// keyword priority (KW > PMC > GST > Vertical Allocations), credit rows
// only, ditto-mark dates forward-filled ------------------------------------
const DITTO_MARKERS = new Set(['', '"', '-', 'do', 'same', 'ditto']);

export function bucketAllocations(verticleRows) {
  let lastDate = null;
  const buckets = { KW: 0, PMC: 0, GST: 0, verticalAllocations: 0 };
  let unreadableDateCount = 0;
  let usableCreditCount = 0;

  for (const row of verticleRows) {
    const rawDate = row.Date ?? row.date ?? '';
    const marker = String(rawDate).trim().toLowerCase();
    let date = DITTO_MARKERS.has(marker) ? lastDate : rawDate;
    if (date && !Number.isNaN(Date.parse(date))) {
      lastDate = date;
    } else if (!DITTO_MARKERS.has(marker)) {
      unreadableDateCount += 1;
      continue; // left out of every total, per spec
    } else if (!lastDate) {
      unreadableDateCount += 1;
      continue; // a ditto mark with nothing above it to forward-fill from
    }

    const credit = num(F.creditAmount.map((k) => row[k]).find((v) => v !== undefined));
    const debit = num(F.debitAmount.map((k) => row[k]).find((v) => v !== undefined));
    if (!credit || credit <= 0 || debit) continue; // "debit rows and zero/blank credits never count"

    const desc = String(F.description.map((k) => row[k]).find((v) => v !== undefined) || '').toUpperCase();
    usableCreditCount += 1;
    if (desc.includes('KW')) buckets.KW += credit;
    else if (desc.includes('PMC')) buckets.PMC += credit;
    else if (desc.includes('GST')) buckets.GST += credit;
    else buckets.verticalAllocations += credit;
  }

  const subtotal = buckets.KW + buckets.PMC;
  const total = subtotal + buckets.GST + buckets.verticalAllocations;
  return { ...buckets, subtotal, total, usableCreditCount, unreadableDateCount };
}

// --- "Cost payable on POs yet to raise" box: per SO, PI Cost minus cost
// already raised (sum of PO Summary CP for that SO's existing POs), floored
// at zero. Formula is named in the 13 Oct doc as carried over unchanged from
// an earlier phase; "cost already raised" itself isn't spelled out further
// there, so this is the most literal reading of "PI Cost minus cost already
// raised" - flagged as an inference, not a confirmed field mapping. ---------
export function computeCostPayableOnPosYetToRaise(dailyPiRows, poSummaryRows) {
  const cpBySo = new Map();
  for (const row of poSummaryRows) {
    const so = String(getField(row, 'so'));
    cpBySo.set(so, (cpBySo.get(so) || 0) + num(row[F.cp]));
  }
  let total = 0;
  const bySo = [];
  for (const row of dailyPiRows) {
    const so = String(getField(row, 'so'));
    const piCost = num(row[F.piCost]);
    const raised = cpBySo.get(so) || 0;
    const remaining = Math.max(0, piCost - raised);
    if (remaining > 0) bySo.push({ so, piCost, raised, remaining });
    total += remaining;
  }
  return { total, bySo };
}

// --- "Receivable from open sales orders" box: NOT formally specified in any
// available doc ("unchanged from the layout pass" - the pre-12-Oct formula
// this refers to isn't in any project doc this build has access to). Most
// defensible literal reading given what IS documented elsewhere (PI Taxable
// Amount = pre-GST SO value, confirmed equal to the real PROFORMA INVOICE's
// NET in mfpl-source-linking-round3.md): per SO, PI Taxable Amount minus
// Total Collection Wout Tax, summed over every SO, floored at zero.
// **Flag for JK**: this is Claude's best inference, not a confirmed formula -
// worth a direct check against whatever the old local build actually shows
// on this box once there's a side-by-side to compare against. -------------
export function computeReceivableFromOpenSOs(dailyPiRows) {
  let total = 0;
  const bySo = [];
  for (const row of dailyPiRows) {
    const so = String(getField(row, 'so'));
    const taxable = num(row[F.piTaxableAmount]);
    const collected = num(row[F.totalCollectionWoutTax]);
    const remaining = Math.max(0, taxable - collected);
    if (remaining > 0) bySo.push({ so, taxable, collected, remaining });
    total += remaining;
  }
  return { total, bySo };
}

// --- Dispatch-collectible formula: built and tested per spec, deliberately
// NOT wired into any screen or box - JK ruled out both placements offered
// and didn't say where it belongs instead (spec: "needs a decision on where
// it belongs before that's the next step"). Exported as a pure function only,
// same as the local build's own `window.__obLm.dispatchCollectible` stance. -
export function dispatchCollectible(dispatchRow, uncollectedShare) {
  const preGstValue = num(dispatchRow[F.totalAmount]) - num(dispatchRow[F.totalDiscount]);
  return preGstValue * uncollectedShare;
}

// --- Table 4: Payables for Flushout --------------------------------------
// Fully-raised SOs (every PO line on the SO exists in PO Summary) whose
// completion deadline is confirmed (ALL-OR-NOTHING: every factory line's
// Order Deadlines negotiation must be 'closed' with a factoryDate; any line
// still open, or zero factory lines at all, blanks the whole SO - mirrors
// the rollup rule in mfpl-payables-flushout-layout-12oct.md). Needs a
// cross-module read of Order Deadlines' neg:{lineId} records, keyed with
// po-progress.js's buildLineId so both modules agree on line identity.
export async function computeFlushoutTable(appDataKv, poSummaryRows, dailyPiRows, vendorPayables, { buildLineId }) {
  const linesBySo = new Map(); // so -> [{po, article, lineId}]
  for (const row of poSummaryRows) {
    const so = String(getField(row, 'so'));
    const po = String(getField(row, 'po'));
    const article = String(getField(row, 'article'));
    const lineId = buildLineId(so, po, article);
    if (!linesBySo.has(so)) linesBySo.set(so, []);
    linesBySo.get(so).push({ po, article, lineId });
  }

  const receivable = computeReceivableFromOpenSOs(dailyPiRows);
  const receivableBySo = new Map(receivable.bySo.map((r) => [r.so, r.remaining]));

  // Build a per-PO balance lookup from the vendor table for the "real
  // per-PO balance for a post-cutoff PO, falling back to gross cost raised
  // for an earlier one" rule.
  const poBalance = new Map(); // po -> balance
  const poCp = new Map(); // po -> gross cp (fallback)
  for (const v of vendorPayables.table) {
    for (const p of v.pos) poBalance.set(p.po, p.balance);
  }
  for (const row of poSummaryRows) {
    const po = String(getField(row, 'po'));
    poCp.set(po, (poCp.get(po) || 0) + num(row[F.cp]));
  }

  const rows = [];
  for (const [so, lines] of linesBySo.entries()) {
    if (lines.length === 0) continue; // zero-factory-line SOs never qualify (12 Oct doc, open item 5)
    let allClosed = true;
    let latestFactoryDate = null;
    for (const line of lines) {
      const neg = await getJSON_(appDataKv, `neg:${line.lineId}`);
      if (!neg || neg.status !== 'closed' || !neg.factoryDate) {
        allClosed = false;
        break;
      }
      if (!latestFactoryDate || Date.parse(neg.factoryDate) > Date.parse(latestFactoryDate)) latestFactoryDate = neg.factoryDate;
    }
    if (!allClosed) continue; // "Yet to be confirmed" - excluded from table 4 entirely (it's a view of CONFIRMED SOs only)

    let payableToVendors = 0;
    for (const line of lines) {
      payableToVendors += poBalance.has(line.po) ? poBalance.get(line.po) : poCp.get(line.po) || 0;
    }

    rows.push({
      so,
      completionDeadline: latestFactoryDate,
      payableToVendors,
      collectibleFromCustomer: receivableBySo.get(so) || 0,
    });
  }
  rows.sort((a, b) => Date.parse(a.completionDeadline) - Date.parse(b.completionDeadline));
  return rows;
}

// Local indirection so this file doesn't need its own kv.js import just for
// one read inside computeFlushoutTable.
async function getJSON_(kv, key) {
  const raw = await kv.get(key, { type: 'text' });
  if (raw === null || raw === undefined) return null;
  return JSON.parse(raw);
}

// --- Top-level aggregator: everything the Payables & Flushout screen needs
// in one call, loading each ERP mirror dataset once. ------------------------
export async function buildPayablesView(appDataKv, erpKv, { buildLineId, cutoffDate = DEFAULT_CUTOFF_DATE, from, to } = {}) {
  const [invoicedOs, poSummary, payments, verticle, dailyPi, dispatch] = await Promise.all([
    getDataset(erpKv, 'invoiced_os'),
    getDataset(erpKv, 'po_summary'),
    getDataset(erpKv, 'payment_expenses_report'),
    getDataset(erpKv, 'verticle_statement'),
    getDataset(erpKv, 'daily_pi_revenue'),
    getDataset(erpKv, 'dispatch_sheet'),
  ]);

  const invoicedOsRows = invoicedOs ? invoicedOs.rows : [];
  const poSummaryRows = poSummary ? poSummary.rows : [];
  const paymentRows = payments ? payments.rows : [];
  const verticleRows = verticle ? verticle.rows : [];
  const dailyPiRows = dailyPi ? dailyPi.rows : [];

  const vendorPayables = computeVendorPayables(invoicedOsRows, poSummaryRows, paymentRows, cutoffDate);
  const allocations = bucketAllocations(verticleRows);
  const costPayableOnPosYetToRaise = computeCostPayableOnPosYetToRaise(dailyPiRows, poSummaryRows);
  const receivable = computeReceivableFromOpenSOs(dailyPiRows);
  const totalCollected = computeTotalCollected(dailyPiRows, { from, to });
  const totalPaidToVendors = computeTotalPaidToVendors(paymentRows, { from, to });

  const flushoutTable = buildLineId ? await computeFlushoutTable(appDataKv, poSummaryRows, dailyPiRows, vendorPayables, { buildLineId }) : [];

  return {
    boxes: {
      payableOnOpenPos: vendorPayables.totalPayableOnOpenPos,
      costPayableOnPosYetToRaise: costPayableOnPosYetToRaise.total,
      receivableFromOpenSos: receivable.total,
      totalCollected,
      totalAllocated: allocations.total,
      totalPaidToVendors,
    },
    table1PayableByVendor: vendorPayables.table,
    table1OrphanPayments: vendorPayables.orphanPayments,
    allocationsBreakdown: allocations,
    table4PayablesForFlushout: flushoutTable,
    datasetsUploaded: {
      invoicedOs: !!invoicedOs,
      poSummary: !!poSummary,
      payments: !!payments,
      verticle: !!verticle,
      dailyPi: !!dailyPi,
      dispatch: !!dispatch,
    },
  };
}

export { F as FIELD_MAP };

