// =====================================================================================
// Order Bridge Assistant — phase 1: the order card; phase 2: team reports (13 Nov 2026).
// Runs inside the side panel that Order Bridge opens (a same-origin frame). It reads the
// lists and rule functions Order Bridge already holds in memory (parent.__obAsst.get) and
// never saves anything. Every figure and date comes from those functions, so the card
// always agrees with the screens, including what each team is allowed to see.
// =====================================================================================
(function(){
'use strict';
var P = null;
try { P = window.parent && window.parent !== window ? window.parent.__obAsst : null; } catch(e){ P = null; }
var out = document.getElementById('out'), qEl = document.getElementById('q');
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

if (!P){
  out.innerHTML = '<div class="card"><h2>Open the Assistant from Order Bridge</h2><p class="note">Sign in to Order Bridge and choose <b>Assistant</b> in the menu. This page has no data of its own.</p></div>';
  document.getElementById('f').style.display = 'none'; document.getElementById('btnWide').style.display = 'none'; document.getElementById('btnClose').style.display = 'none';
  return;
}
try { var th = window.parent.document.documentElement.dataset.theme; if (th) document.documentElement.dataset.theme = th; } catch(e){}

var g = function(n){ return P.get(n); };
var W = window.parent;
var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtD(s){ var m = String(s || '').match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? (+m[3]) + ' ' + MON[+m[2] - 1] + ' ' + m[1] : ''; }
function day(s){ return String(s || '').slice(0, 10); }
function inr(n){ return '₹' + Math.round(+n || 0).toLocaleString('en-IN'); }
function num(n){ n = +n || 0; return Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(2); }
function call(name){ var f = g(name); if (typeof f !== 'function') return undefined; try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch(e){ return undefined; } }
function can(sec){ return !!call('canViewSection', sec, (g('state') || {}).role); }

var STAGE = { draft:['Draft with sales', ''], submitted:['Sent to supply, PO not raised', 'warn'], po_raised:['Marked raised, waiting for the ERP PO', 'warn'], po_confirmed:['PO raised', 'good'] };
var FAB_ST = { received:['Received at factory', 'good'], in_transit:['In transit', 'warn'], awaiting_dispatch:['Tagged, not sent', 'warn'], no_tag:['No tag yet', 'crit'] };
var PO_ST = { full:['All POs raised', 'good'], part:['Part of the order has POs', 'warn'], nopo:['No PO yet', 'crit'] };
var WHO = { factory:'Factory', supply:'Supply', sales:'Sales' };

// ------------------------------------------------------------------ one PO / SKU line
function lineOf(o, see){
  var L = { id:o.id, so:o.so, article:o.article || '', sku:o.sku || '', qty:+(o.poQty || o.qty) || 0, uom:o.uom || '', po:o.po || '', supplier:o.supplier || '',
    stageKey:o.lifecycle, stage:(STAGE[o.lifecycle] || [o.lifecycle || '', ''])[0], factory:!!call('isFactoryLine', o) };
  L.poDate = o.po ? (call('poDateOf', o) || '') : '';
  if (see.deadlines){
    L.clientDate = o.committedDeadline ? (call('viewC', o.committedDeadline) || '') : '';
    var f = call('effF', o); L.factoryDate = f ? (call('viewF', f) || '') : '';
    L.dateStatus = call('dlStatusOf', o) || '';
    if (o.deadlineNeg && o.deadlineNeg.status) L.negotiation = o.deadlineNeg.status === 'awaiting_sales' ? 'Date change proposed, waiting for sales' : o.deadlineNeg.status === 'awaiting_factory' ? 'Date change proposed, waiting for the factory' : 'Date change under discussion';
    L.risks = (call('lineRisks', o) || []).map(function(r){ return { sev:r.sev === 'critical' ? 'crit' : 'warn', text:r.text }; });
  }
  if (see.jobcards && L.factory && o.lifecycle === 'po_confirmed'){ var j = call('xJcInfo', o); L.jobCard = j ? { card:j.card, stage:j.lab, n:j.n } : { card:'', stage:'No job card yet', n:0 }; }
  if (see.readiness){
    var idx = call('xCatIndex'), r = idx && idx.byLine ? idx.byLine.get(o.id) : null;
    if (r){ var ow = call('xCatOwners', r) || {}, info = (g('XCAT_INFO') || {})[r.c] || {};
      L.cat = r.packed ? { packed:true } : { c:r.c, label:info.label || '', sev:info.sev === 'good' ? 'good' : info.sev === 'warn' ? 'warn' : 'crit', reason:call('xCatReason', r) || '', next:(ow.list || []).map(function(k){ return WHO[k] || k; }), why:ow.why || [] }; }
  }
  if (see.confirmations && o.detail){
    var d = o.detail, fd = g('fabricDisplayName');
    var fabs = (d.fabrics || []).map(function(x){ var n = ''; try { n = fd ? fd(x) : ''; } catch(e){} return n ? n + (x.placement ? ' (' + x.placement + ')' : '') : ''; }).filter(Boolean);
    var fins = (d.finishes || []).map(function(x){ return x.type === 'other' ? x.otherFinishName : x.polishName; }).filter(Boolean);
    if (fabs.length || fins.length) L.spec = { fabrics:fabs, finishes:fins };
  }
  return L;
}

// ------------------------------------------------------------------ sales order card
function buildSo(so){
  var h = (g('DPI_BY_SO') || {})[so]; var lines = ((g('LINES_BY_SO') || {})[so] || []).slice();
  if (!h && !lines.length) return null;
  var see = { confirmations:can('confirmations'), deadlines:can('deadlines'), jobcards:can('jobcards'), fabric:can('fabric'), warehousetag:can('warehousetag'),
    stockblock:can('stockblock'), slots:can('slots'), sorevision:can('sorevision'), payables:can('payables'), readiness:!!call('xCatOn') };
  var C = { kind:'so', so:so, see:see, tl:[] };
  h = h || {};
  C.head = { customer:h.customer || (lines[0] || {}).customer || '', city:h.city || '', date:h.date || '', rep:h.rep || '', vertical:h.vertical || '', cancelled:!!h.cancelled };
  if (h.date) C.tl.push({ at:h.date, text:'Sales order dated ' + fmtD(h.date) });
  if (see.confirmations && h.so){ var ps = call('poStatusOf', h); if (ps) C.head.po = { key:ps.key, label:(PO_ST[ps.key] || [ps.key])[0], cls:(PO_ST[ps.key] || ['', ''])[1], reason:ps.reason || '' }; }
  if (see.payables && h.so) C.money = { value:+h.value || 0, collectedExTax:+h.collectedExTax || 0, total:+h.total || 0, collected:+h.collected || 0, balance:Math.max(0, (+h.total || 0) - (+h.collected || 0)) };

  if (see.confirmations){
    C.lines = lines.map(function(o){ return lineOf(o, see); });
    var seenPo = {};
    lines.forEach(function(o){ var d = o.po ? call('poDateOf', o) : ''; if (o.po && d && !seenPo[o.po]){ seenPo[o.po] = 1; C.tl.push({ at:d, text:'PO ' + o.po + ' raised' + (o.supplier ? ' with ' + o.supplier : '') }); }
      if (o.appNative && o.submittedAt) C.tl.push({ at:o.submittedAt, text:'PO request for ' + (o.article || o.sku) + ' sent to supply' + (o.submittedBy ? ' by ' + o.submittedBy : '') });
      if (see.deadlines && o.productionDeadlineSetAt && o.productionDeadline) C.tl.push({ at:o.productionDeadlineSetAt, text:'Factory date set for ' + (o.article || o.sku) + (o.productionDeadlineSetBy ? ' by ' + o.productionDeadlineSetBy : '') });
      if (see.deadlines) (o.deadlineNegHistory || []).concat(o.deadlineNeg ? [o.deadlineNeg] : []).forEach(function(n){ (n.rounds || []).forEach(function(r){ if (r.at) C.tl.push({ at:r.at, text:(r.side === 'factory' ? 'Factory' : 'Sales') + ' ' + (r.act === 'propose' ? 'proposed a date change' : r.act === 'accept' ? 'accepted the date' : r.act === 'counter' ? 'answered with another date' : (r.act || 'updated the date')) + ' for ' + (o.article || o.sku) + (r.by ? ' (' + r.by + ')' : '') }); }); });
    });
    var prod = call('productLines', so) || [], needs = g('needsPo');
    C.toRaise = prod.map(function(l){ var s = call('soLineState', l); return s && typeof needs === 'function' && needs(s) ? { code:l.code, name:l.name, qty:+l.qty || 0, open:+s.open || 0, uom:l.uom || '' } : null; }).filter(Boolean);
  }
  var pos = {}; lines.forEach(function(o){ if (o.po) pos[o.po] = 1; });

  if (see.jobcards) (g('JOB_CARDS') || []).forEach(function(j){ if (j.linkedPo && pos[j.linkedPo]) (j.scanHistory || []).forEach(function(s, i){ if (s.scannedAt) C.tl.push({ at:s.scannedAt, text:'Job card ' + j.jobCardNumber + (i ? ' scanned again' : ' captured') + (s.scannedBy ? ' by ' + s.scannedBy : '') }); }); });

  if (see.fabric){
    C.fabric = (g('FABRIC_ENTRIES') || []).filter(function(e){ return e.po && pos[e.po]; }).map(function(e){
      var st = call('entryStatus', e) || '';
      C.tl.push({ at:e.addedAt || e.received, text:'Fabric ' + (e.fabricName || e.sku) + ' logged (' + e.id + ')' });
      (e.dispatches || []).forEach(function(d){ if (d.dispatchedAt) C.tl.push({ at:d.dispatchedAt, text:'Fabric ' + (e.fabricName || e.sku) + ' sent to the factory' + (d.challanNo ? ', challan ' + d.challanNo : '') }); });
      (e.receipts || []).forEach(function(d){ if (d.receivedAt) C.tl.push({ at:d.receivedAt, text:'Fabric ' + (e.fabricName || e.sku) + ' received at the factory' }); });
      return { id:e.id, name:e.fabricName || e.sku || '', qty:num(e.qty) + ' ' + (e.unit || ''), product:e.product || '', po:e.po, status:(FAB_ST[st] || [st, ''])[0], cls:(FAB_ST[st] || ['', ''])[1] };
    });
  }
  if (see.warehousetag){
    var by = {};
    (g('WAREHOUSE_TAGS') || []).filter(function(t){ return t.so === so || (t.po && pos[t.po]); }).forEach(function(t){
      var k = t.sku + '|' + t.po, a = by[k] = by[k] || { sku:t.sku, article:t.article || '', po:t.po || '', of:+t.seqTotal || 0, tagged:0, sent:0, received:0, zones:[] };
      a.tagged++; if ((t.dispatches || []).length) a.sent++; if ((t.receipts || []).length) a.received++; if (t.zone && a.zones.indexOf(t.zone) < 0) a.zones.push(t.zone);
      if (t.packedAt) C.tl.push({ at:t.packedAt, text:'Package ' + t.tagNo + ' tagged at the factory (' + (t.article || t.sku) + ')' });
      (t.dispatches || []).forEach(function(d){ if (d.dispatchedAt) C.tl.push({ at:d.dispatchedAt, text:'Package ' + t.tagNo + ' left the factory' }); });
      (t.receipts || []).forEach(function(d){ if (d.receivedAt) C.tl.push({ at:d.receivedAt, text:'Package ' + t.tagNo + ' received at the warehouse' }); });
    });
    C.wh = Object.keys(by).map(function(k){ return by[k]; });
  }
  if (see.stockblock){
    C.blocks = (g('STOCK_BLOCK_REQUESTS') || []).filter(function(r){ return r.so === so; }).map(function(r){
      var d = call('xSbDisp', r), left = call('xSbLeft', r);
      if (r.requestedAt) C.tl.push({ at:r.requestedAt, text:'Stock block requested: ' + num(r.qtyRequested) + ' ' + (r.article || r.sku) + ' at ' + r.warehouse + (r.requestedBy ? ' by ' + r.requestedBy : '') });
      if (r.decidedAt) C.tl.push({ at:r.decidedAt, text:'Stock block ' + r.status + (r.decidedBy ? ' by ' + r.decidedBy : '') });
      return { id:r.id, article:r.article || r.sku, qty:num(r.qtyRequested) + ' ' + (r.uom || ''), wh:r.warehouse, status:r.status === 'approved' && d && !(left > 0) ? 'dispatched to the customer' : r.status, left:r.status === 'approved' ? left : null };
    });
  }
  if (see.slots){
    C.bookings = (g('SLOT_BOOKINGS') || []).filter(function(b){ return b.so === so; }).map(function(b){
      var B = { id:b.id, type:b.type === 'installation' ? 'Installation' : 'Dispatch', date:b.date, window:b.window || '', status:b.status || '', vendor:b.vendor || '', items:(b.items || []).map(function(i){ return num(i.qty) + ' × ' + (i.article || i.sku); }) };
      if (b.type !== 'installation'){ var r = call('ddFor', b.id); B.dd = r ? (call('ddComplete', r) ? { ok:true, text:r.override ? 'Dispatch Day check: cleared by admin' : 'Dispatch Day check: complete' } : { ok:false, text:'Dispatch Day check waiting on: ' + (call('ddMissing', r) || []).join('; ') }) : { ok:false, text:'Dispatch Day check not started' }; }
      if (b.bookedAt) C.tl.push({ at:b.bookedAt, text:B.type + ' booked for ' + fmtD(b.date) + (b.bookedBy ? ' by ' + b.bookedBy : '') });
      if (b.approvedAt) C.tl.push({ at:b.approvedAt, text:B.type + ' booking approved' + (b.approvedBy ? ' by ' + b.approvedBy : '') });
      if (b.dispatchedAt) C.tl.push({ at:b.dispatchedAt, text:'Dispatched' + (b.vendor ? ' with ' + b.vendor : '') });
      if (b.pod && (b.pod.at || b.pod.capturedAt)) C.tl.push({ at:b.pod.at || b.pod.capturedAt, text:'Delivery confirmed (proof of delivery recorded)' });
      return B;
    });
    var sd = W.__obLm && W.__obLm.sites ? (W.__obLm.sites() || {})[so] : null;
    C.site = sd ? { submitted:!!sd.submittedAt, at:sd.submittedAt || sd.createdAt || '' } : null;
    if (sd && sd.submittedAt) C.tl.push({ at:sd.submittedAt, text:'Customer site details submitted' });
  }
  if (see.sorevision){
    C.revisions = (g('SO_REVISION_REQUESTS') || []).filter(function(r){ return r.so === so || (r.newSos || []).some(function(n){ return n.so === so; }); }).map(function(r){
      if (r.requestedAt) C.tl.push({ at:r.requestedAt, text:'SO revision ' + r.id + ' requested' + (r.requestedBy ? ' by ' + r.requestedBy : '') });
      return { id:r.id, status:String(r.status || '').replace(/_/g, ' '), role:r.so === so ? 'This SO is being replaced by ' + ((r.newSos || []).map(function(n){ return n.so; }).join(', ') || 'a new SO') : 'This SO replaces ' + r.so };
    });
  }
  C.tl = C.tl.filter(function(e){ return e.at; }).sort(function(a, b){ return day(a.at) === day(b.at) ? String(a.at).localeCompare(String(b.at)) : day(a.at).localeCompare(day(b.at)); });
  return C;
}

// ------------------------------------------------------------------ purchase order card
function buildPo(po){
  var pl = (g('POL_BY_PO') || {})[po] || []; var lines = (g('ORDERS') || []).filter(function(o){ return o.po === po; });
  if (!pl.length && !lines.length) return null;
  var see = { confirmations:can('confirmations'), deadlines:can('deadlines'), jobcards:can('jobcards'), fabric:can('fabric'), readiness:!!call('xCatOn') };
  var f = pl[0] || {};
  var C = { kind:'po', po:po, see:see, head:{ supplier:f.supplier || (lines[0] || {}).supplier || '', date:f.poDate || '', customer:f.customer || (lines[0] || {}).customer || '' } };
  var sos = {}; lines.forEach(function(o){ if (o.so) sos[o.so] = 1; }); pl.forEach(function(l){ var s = l.linkSo || l.so; if (s && (g('DPI_BY_SO') || {})[s]) sos[s] = 1; });
  C.sos = Object.keys(sos);
  if (see.confirmations){
    C.lines = lines.map(function(o){ return lineOf(o, see); });
    var have = {}; lines.forEach(function(o){ have[o.sku] = 1; });
    C.other = pl.filter(function(l){ return !have[l.code]; }).map(function(l){ return { code:l.code, name:l.name, qty:num(l.qty) + ' ' + (l.uom || '') }; });
  }
  if (see.fabric) C.fabric = (g('FABRIC_ENTRIES') || []).filter(function(e){ return e.po === po || e.furnishingsPo === po; }).map(function(e){ var st = call('entryStatus', e) || '';
    return { id:e.id, name:e.fabricName || e.sku || '', qty:num(e.qty) + ' ' + (e.unit || ''), product:e.product || '', po:e.po, status:(FAB_ST[st] || [st, ''])[0], cls:(FAB_ST[st] || ['', ''])[1] }; });
  return C;
}

// ------------------------------------------------------------------ find
function find(q){
  q = String(q || '').trim(); if (!q) return { none:true };
  var D = g('DPI_BY_SO') || {}, PL = g('POL_BY_PO') || {}, digits = q.replace(/[\s-]/g, '');
  var hits = [];
  if (/^\d{4,}$/.test(digits)){
    if (D[digits] || (g('LINES_BY_SO') || {})[digits]) return { so:digits };
    if (PL[digits]) return { po:digits };
    Object.keys(D).forEach(function(so){ if (so.slice(-digits.length) === digits) hits.push({ so:so, label:'SO ' + so, sub:D[so].customer || '' }); });
    Object.keys(PL).forEach(function(po){ if (po.slice(-digits.length) === digits) hits.push({ po:po, label:'PO ' + po, sub:(PL[po][0] || {}).supplier || '' }); });
  }
  if (can('jobcards')) (g('JOB_CARDS') || []).forEach(function(j){ if (j.linkedPo && String(j.jobCardNumber || '').toLowerCase() === q.toLowerCase()) hits.push({ po:j.linkedPo, label:'PO ' + j.linkedPo, sub:'Job card ' + j.jobCardNumber }); });
  if (!hits.length && q.length >= 3){ var ql = q.toLowerCase();
    Object.keys(D).forEach(function(so){ var h = D[so]; if (!h.ic && String(h.customer || '').toLowerCase().indexOf(ql) >= 0) hits.push({ so:so, label:'SO ' + so, sub:(h.customer || '') + (h.date ? ' · ' + fmtD(h.date) : '') + (h.cancelled ? ' · cancelled' : ''), date:h.date || '' }); });
    hits.sort(function(a, b){ return (b.date || '').localeCompare(a.date || ''); });
  }
  if (hits.length === 1) return hits[0].so ? { so:hits[0].so } : { po:hits[0].po };
  return { hits:hits, q:q };
}

// ------------------------------------------------------------------ render
function pill(t, cls){ return '<span class="pill ' + (cls || '') + '">' + esc(t) + '</span>'; }
function linesTable(C){
  var see = C.see, L = C.lines || [];
  if (!L.length) return '<p class="note">No SKU lines yet.</p>';
  return L.map(function(l){
    var kv = [];
    if (C.kind === 'so') kv.push(['PO', l.po ? '<button class="link" type="button" data-po="' + esc(l.po) + '">' + esc(l.po) + '</button><div class="sub">' + esc(fmtD(l.poDate)) + (l.supplier ? ' · ' + esc(l.supplier) : '') + '</div>' : '<span class="sub">No PO yet</span>']);
    if (see.deadlines){
      kv.push(['Client date', l.clientDate ? esc(fmtD(l.clientDate)) : '<span class="sub">Not set</span>']);
      kv.push(['Factory date', (l.factoryDate ? esc(fmtD(l.factoryDate)) : '<span class="sub">' + (l.dateStatus === 'awaiting' ? 'Awaiting factory' : 'Not a factory line') + '</span>') + (l.negotiation ? '<div class="sub">' + esc(l.negotiation) + '</div>' : '')]);
    }
    if (see.jobcards && l.jobCard) kv.push(['Job card', esc(l.jobCard.stage) + (l.jobCard.card ? '<div class="sub">Card ' + esc(l.jobCard.card) + (l.jobCard.n > 1 ? ' · least advanced of ' + l.jobCard.n : '') + '</div>' : '')]);
    if (see.readiness && l.cat) kv.push(['Readiness', l.cat.packed ? pill('Packed', 'good') : pill(l.cat.c + ' · ' + l.cat.label, l.cat.sev) + '<div class="sub">' + esc(l.cat.reason) + '</div>' + (l.cat.next.length ? '<div class="sub">Next: ' + esc(l.cat.next.join(', ')) + '</div>' : '')]);
    if (l.spec && l.spec.fabrics.length) kv.push(['Fabric', esc(l.spec.fabrics.join('; '))]);
    if (l.spec && l.spec.finishes.length) kv.push(['Finish', esc(l.spec.finishes.join('; '))]);
    return '<div class="line"><div class="row"><div class="grow"><b>' + esc(l.article) + '</b> <span class="sub">' + esc(l.sku) + ' · ' + esc(num(l.qty)) + ' ' + esc(l.uom) + '</span></div>' + pill(l.stage, (STAGE[l.stageKey] || ['', ''])[1])
      + (see.confirmations ? '<button class="link" type="button" data-line="' + esc(l.id) + '">Open line</button>' : '') + '</div>'
      + '<div class="kv">' + kv.map(function(x){ return '<div><span>' + esc(x[0]) + '</span>' + x[1] + '</div>'; }).join('') + '</div>'
      + (l.risks || []).map(function(r){ return '<div class="sub ' + (r.sev === 'crit' ? 'err' : 'warnt') + '" style="margin-top:6px">Delay risk: ' + esc(r.text) + '</div>'; }).join('') + '</div>';
  }).join('');
}
function fabricTable(F){ return '<div class="scroll"><table><thead><tr><th>Tag</th><th>Fabric</th><th>Qty</th><th>For</th><th>Status</th></tr></thead><tbody>' + F.map(function(e){ return '<tr><td>' + esc(e.id) + '</td><td>' + esc(e.name) + '</td><td>' + esc(e.qty) + '</td><td>' + esc(e.product) + '<div class="sub">PO ' + esc(e.po) + '</div></td><td>' + pill(e.status, e.cls) + '</td></tr>'; }).join('') + '</tbody></table></div>'; }
function sec(title, body){ return '<section class="card"><h3>' + esc(title) + '</h3>' + body + '</section>'; }

function renderCard(C){
  var h = '';
  if (C.kind === 'so'){
    var H = C.head, kv = [['Customer', H.customer], ['Site', H.city], ['SO date', fmtD(H.date)], ['Sales rep', H.rep], ['Vertical', H.vertical]].filter(function(x){ return x[1]; });
    if (C.money) kv.push(['Order value (before GST)', inr(C.money.value)], ['Collected (before GST)', inr(C.money.collectedExTax)], ['Balance due (with GST)', inr(C.money.balance)]);
    h += '<section class="card"><div class="row"><div class="grow"><h2>SO ' + esc(C.so) + '</h2><div class="sub">' + esc(H.customer) + '</div></div>' + (H.cancelled ? pill('Cancelled', 'crit') : '') + (H.po ? pill(H.po.label, H.po.cls) : '') + '<button type="button" id="btnCopy">Copy as text</button></div>'
      + (H.po && H.po.reason ? '<div class="sub" style="margin-top:4px">' + esc(H.po.reason) + '</div>' : '') + '<div class="kv">' + kv.map(function(x){ return '<div><span>' + esc(x[0]) + '</span>' + esc(x[1]) + '</div>'; }).join('') + '</div></section>';
    if (C.lines) h += sec('SKU lines and POs', linesTable(C));
    if (C.toRaise && C.toRaise.length) h += sec('Still to raise a PO', '<table><thead><tr><th>Article</th><th class="num">SO qty</th><th class="num">Open qty</th></tr></thead><tbody>' + C.toRaise.map(function(l){ return '<tr><td><b>' + esc(l.name) + '</b><div class="sub">' + esc(l.code) + '</div></td><td class="num">' + esc(num(l.qty)) + ' ' + esc(l.uom) + '</td><td class="num">' + esc(num(l.open)) + '</td></tr>'; }).join('') + '</tbody></table>');
    if (C.fabric && C.fabric.length) h += sec('Fabric tags', fabricTable(C.fabric));
    if (C.wh && C.wh.length) h += sec('Finished goods packages', '<table><thead><tr><th>Article</th><th class="num">Tagged</th><th class="num">Left factory</th><th class="num">At warehouse</th><th>Zone</th></tr></thead><tbody>' + C.wh.map(function(a){ return '<tr><td><b>' + esc(a.article) + '</b><div class="sub">' + esc(a.sku) + (a.po ? ' · PO ' + esc(a.po) : '') + '</div></td><td class="num">' + a.tagged + (a.of ? ' of ' + a.of : '') + '</td><td class="num">' + a.sent + '</td><td class="num">' + a.received + '</td><td>' + esc(a.zones.join(', ')) + '</td></tr>'; }).join('') + '</tbody></table>');
    if (C.blocks && C.blocks.length) h += sec('Stock blocks', '<ul class="plain">' + C.blocks.map(function(b){ return '<li>' + esc(b.qty) + ' ' + esc(b.article) + ' at ' + esc(b.wh) + ' ' + pill(b.status, b.status === 'approved' || /dispatched/.test(b.status) ? 'good' : b.status === 'rejected' ? 'crit' : 'warn') + (b.left > 0 ? ' <span class="sub">' + esc(num(b.left)) + ' still blocked</span>' : '') + '</li>'; }).join('') + '</ul>');
    if (C.see.slots) h += sec('Dispatch and installation', (C.bookings.length ? '<ul class="plain">' + C.bookings.map(function(b){ return '<li><b>' + esc(b.type) + '</b> on ' + esc(fmtD(b.date)) + (b.window ? ', ' + esc(b.window) : '') + ' ' + pill(b.status, /dispatched|delivered|completed|installed/.test(b.status) ? 'good' : /rejected|cancelled|declined/.test(b.status) ? 'crit' : 'warn') + (b.vendor ? ' <span class="sub">' + esc(b.vendor) + '</span>' : '')
      + (b.items.length ? '<div class="sub">' + esc(b.items.join(', ')) + '</div>' : '') + (b.dd ? '<div class="sub ' + (b.dd.ok ? '' : 'err') + '">' + esc(b.dd.text) + '</div>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="note">Nothing booked yet.</p>')
      + '<p class="sub" style="margin:8px 0 0">Customer site details: ' + (C.site && C.site.submitted ? 'submitted ' + esc(fmtD(C.site.at)) : C.site ? 'started, not submitted' : 'not filled in') + '</p>');
    if (C.revisions && C.revisions.length) h += sec('SO revisions', '<ul class="plain">' + C.revisions.map(function(r){ return '<li><b>' + esc(r.id) + '</b> ' + pill(r.status, /approved|completed/.test(r.status) ? 'good' : /rejected/.test(r.status) ? 'crit' : 'warn') + '<div class="sub">' + esc(r.role) + '</div></li>'; }).join('') + '</ul>');
    if (C.tl.length) h += sec('History', '<table><tbody>' + C.tl.map(function(e){ return '<tr><td style="white-space:nowrap;width:1%">' + esc(fmtD(e.at)) + '</td><td>' + esc(e.text) + '</td></tr>'; }).join('') + '</tbody></table>');
  } else {
    h += '<section class="card"><div class="row"><div class="grow"><h2>PO ' + esc(C.po) + '</h2><div class="sub">' + esc(C.head.supplier) + '</div></div><button type="button" id="btnCopy">Copy as text</button></div><div class="kv">'
      + [['PO date', fmtD(C.head.date)], ['Customer', C.head.customer]].filter(function(x){ return x[1]; }).map(function(x){ return '<div><span>' + esc(x[0]) + '</span>' + esc(x[1]) + '</div>'; }).join('')
      + '<div><span>Sales order</span>' + (C.sos.length ? C.sos.map(function(s){ return '<button class="link" type="button" data-so="' + esc(s) + '">' + esc(s) + '</button>'; }).join(', ') : 'Not tied to a sales order') + '</div></div></section>';
    if (C.lines) h += sec('Lines on this PO', linesTable(C) + (C.other.length ? '<p class="sub" style="margin:8px 0 0">Also on this PO: ' + esc(C.other.map(function(l){ return l.qty + ' ' + l.name; }).join('; ')) + '</p>' : ''));
    if (C.fabric && C.fabric.length) h += sec('Fabric tags', fabricTable(C.fabric));
  }
  var hid = hiddenNote(C); if (hid) h += '<p class="note">' + esc(hid) + '</p>';
  return h;
}
function hiddenNote(C){
  var names = { confirmations:'PO Progress Tracker', deadlines:'Order Deadlines', jobcards:'Job Card Station', fabric:'Furnishings Tag Station', warehousetag:'Warehouse Tag Station', stockblock:'Stock Block Station', slots:'Last Mile Ops', sorevision:'SO Revision Request', payables:'Payables' };
  var off = Object.keys(names).filter(function(k){ return k in C.see && !C.see[k]; }).map(function(k){ return names[k]; });
  return off.length ? 'Not shown, because your team does not have these sections: ' + off.join(', ') + '.' : '';
}

// ------------------------------------------------------------------ plain text (Copy as text)
function textOf(C){
  var T = [];
  function lineTxt(l){ var s = '- ' + num(l.qty) + ' ' + l.uom + ' ' + l.article + ' (' + l.sku + ')' + (C.kind === 'so' ? (l.po ? ', PO ' + l.po + (l.poDate ? ' of ' + fmtD(l.poDate) : '') : ', no PO yet') : '') + ': ' + l.stage;
    if (C.see.deadlines) s += (l.clientDate ? '; client date ' + fmtD(l.clientDate) : '') + (l.factoryDate ? '; factory date ' + fmtD(l.factoryDate) : '') + (l.negotiation ? '; ' + l.negotiation.toLowerCase() : '');
    if (l.jobCard) s += '; job card: ' + l.jobCard.stage; if (l.cat) s += '; readiness: ' + (l.cat.packed ? 'packed' : l.cat.c + ' (' + l.cat.label + ')'); return s; }
  if (C.kind === 'so'){
    T.push('SO ' + C.so + ' - ' + C.head.customer + (C.head.cancelled ? ' (CANCELLED)' : ''));
    T.push([C.head.city && 'Site: ' + C.head.city, C.head.date && 'SO date: ' + fmtD(C.head.date), C.head.rep && 'Sales rep: ' + C.head.rep].filter(Boolean).join(' | '));
    if (C.head.po) T.push('PO status: ' + C.head.po.label + (C.head.po.reason ? ' (' + C.head.po.reason + ')' : ''));
    if (C.money) T.push('Order value (before GST): ' + inr(C.money.value) + ' | Collected (before GST): ' + inr(C.money.collectedExTax) + ' | Balance due (with GST): ' + inr(C.money.balance));
    if (C.lines && C.lines.length){ T.push('', 'SKU lines:'); C.lines.forEach(function(l){ T.push(lineTxt(l)); }); }
    if (C.toRaise && C.toRaise.length){ T.push('', 'Still to raise a PO:'); C.toRaise.forEach(function(l){ T.push('- ' + num(l.open) + ' of ' + num(l.qty) + ' ' + l.name + ' (' + l.code + ')'); }); }
    if (C.fabric && C.fabric.length){ T.push('', 'Fabric:'); C.fabric.forEach(function(e){ T.push('- ' + e.name + ', ' + e.qty + ', for ' + e.product + ': ' + e.status); }); }
    if (C.wh && C.wh.length){ T.push('', 'Finished goods packages:'); C.wh.forEach(function(a){ T.push('- ' + a.article + ': ' + a.tagged + (a.of ? ' of ' + a.of : '') + ' tagged, ' + a.sent + ' left the factory, ' + a.received + ' at the warehouse'); }); }
    if (C.blocks && C.blocks.length){ T.push('', 'Stock blocks:'); C.blocks.forEach(function(b){ T.push('- ' + b.qty + ' ' + b.article + ' at ' + b.wh + ': ' + b.status); }); }
    if (C.bookings && C.bookings.length){ T.push('', 'Dispatch and installation:'); C.bookings.forEach(function(b){ T.push('- ' + b.type + ' on ' + fmtD(b.date) + (b.window ? ', ' + b.window : '') + ': ' + b.status + (b.dd ? ' (' + b.dd.text + ')' : '')); }); }
    if (C.revisions && C.revisions.length){ T.push('', 'SO revisions:'); C.revisions.forEach(function(r){ T.push('- ' + r.id + ': ' + r.status + '. ' + r.role); }); }
    if (C.tl.length){ T.push('', 'History:'); C.tl.forEach(function(e){ T.push('- ' + fmtD(e.at) + ': ' + e.text); }); }
  } else {
    T.push('PO ' + C.po + ' - ' + C.head.supplier); T.push([C.head.date && 'PO date: ' + fmtD(C.head.date), C.head.customer && 'Customer: ' + C.head.customer, C.sos.length && 'SO: ' + C.sos.join(', ')].filter(Boolean).join(' | '));
    if (C.lines && C.lines.length){ T.push('', 'Lines:'); C.lines.forEach(function(l){ T.push(lineTxt(l)); }); }
    if (C.fabric && C.fabric.length){ T.push('', 'Fabric:'); C.fabric.forEach(function(e){ T.push('- ' + e.name + ', ' + e.qty + ': ' + e.status); }); }
  }
  return T.join('\n');
}

// ------------------------------------------------------------------ reports (phase 2, 13 Nov 2026)
// Each report is worked out here from the lists and rules Order Bridge already holds. Nothing is estimated.
var CORD = ['C1', 'C2', 'C4', 'C3', 'C0'];   // weekly plan order inside a week (JK, 11 Nov)
function addD(d, n){ return call('addD', d, n) || ''; }
function today(){ return call('todayStr') || new Date().toISOString().slice(0, 10); }
function monday(d){ var x = new Date(d + 'T00:00:00Z'); return addD(d, -((x.getUTCDay() + 6) % 7)); }
function heads(){ var D = g('DPI_BY_SO') || {}; return Object.keys(D).map(function(k){ return D[k]; }).filter(function(h){ return !h.cancelled && !h.ic; }); }
function headOf(so){ return (g('DPI_BY_SO') || {})[so] || {}; }
function openRows(){ var idx = call('xCatIndex'), out = []; if (idx && idx.byLine) idx.byLine.forEach(function(r){ if (!r.packed) out.push(r); }); return out; }
function catLabel(c){ return c + ' · ' + (((g('XCAT_INFO') || {})[c] || {}).label || ''); }
function catCls(c){ var s = ((g('XCAT_INFO') || {})[c] || {}).sev; return s === 'good' ? 'good' : s === 'warn' ? 'warn' : 'crit'; }
function lineBase(r){ var o = r.o; return { so:o.so, customer:headOf(o.so).customer || o.customer || '', article:o.article || '', sku:o.sku || '', qty:+(o.poQty || o.qty) || 0, po:o.po, poDate:call('poDateOf', o) || '' }; }
function dispatchedSos(){ var m = {}; ((g('X') || {}).dispatches || []).forEach(function(d){ if (!/cancel|reject/i.test(d.status || '')) m[d.so] = (m[d.so] || 0) + (+d.grossPreGst || 0); }); return m; }
function soStage(h, ctx){
  var bs = ctx.book[h.so] || [];
  if (bs.some(function(b){ return /delivered|completed/.test(b.status); })) return 'Delivered';
  if (ctx.disp[h.so] || bs.some(function(b){ return b.status === 'dispatched'; })) return 'Dispatched';
  var ps = call('poStatusOf', h) || {};
  if (ps.key === 'nopo') return 'No PO yet';
  if (ps.key === 'part') return 'Part of the POs raised';
  if (ctx.cat){ var c = ctx.cat.soCat[h.so]; if (c) return 'In production · ' + catLabel(c); if (ctx.packed[h.so]) return 'Packed, not dispatched'; return 'POs raised · no open factory line'; }
  return 'POs raised';
}
var STAGE_SORT = ['No PO yet', 'Part of the POs raised', 'In production · C0', 'In production · C3', 'In production · C4', 'In production · C2', 'In production · C1', 'POs raised', 'Packed, not dispatched', 'Dispatched', 'Delivered'];
function stageRank(s){ for (var i = 0; i < STAGE_SORT.length; i++) if (s.indexOf(STAGE_SORT[i]) === 0) return i; return 50; }

var REPORTS = [
  { id:'orders', team:'MIS', title:'Orders and values', sub:'Open sales orders by stage, vertical, site or sales rep, with value and collections before GST.',
    can:function(){ return can('payables') && can('confirmations'); },
    controls:[{ id:'by', label:'Group by', options:[['stage', 'Stage'], ['vertical', 'Vertical'], ['city', 'Site'], ['rep', 'Sales rep']] }],
    build:function(o){
      var by = o.by || 'stage', idx = call('xCatOn') ? call('xCatIndex') : null, ctx = { cat:idx, disp:dispatchedSos(), book:{}, packed:{} };
      (g('SLOT_BOOKINGS') || []).forEach(function(b){ if (b.type === 'dispatch') (ctx.book[b.so] = ctx.book[b.so] || []).push(b); });
      if (idx) idx.byLine.forEach(function(r){ if (r.packed) ctx.packed[r.o.so] = 1; });
      var keyOf = function(h){ return by === 'stage' ? soStage(h, ctx) : (h[by] || '(blank)'); };
      var H = heads();
      if (o.drill != null){
        var rows = H.filter(function(h){ return keyOf(h) === o.drill; }).sort(function(a, b){ return (b.value || 0) - (a.value || 0); }).map(function(h){ return { so:h.so, customer:h.customer, date:h.date, city:h.city, rep:h.rep, value:+h.value || 0, coll:+h.collectedExTax || 0, bal:Math.max(0, (+h.value || 0) - (+h.collectedExTax || 0)) }; });
        return { crumb:o.drill, cols:[{ k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'date', label:'SO date', kind:'date' }, { k:'city', label:'Site' }, { k:'rep', label:'Sales rep' }, { k:'value', label:'Order value (before GST)', kind:'money' }, { k:'coll', label:'Collected (before GST)', kind:'money' }, { k:'bal', label:'Not yet collected', kind:'money' }], rows:rows, total:['value', 'coll', 'bal'] };
      }
      var G = {}; H.forEach(function(h){ var k = keyOf(h), a = G[k] = G[k] || { group:k, n:0, value:0, coll:0, bal:0, _drill:k }; a.n++; a.value += +h.value || 0; a.coll += +h.collectedExTax || 0; a.bal += Math.max(0, (+h.value || 0) - (+h.collectedExTax || 0)); });
      var rows2 = Object.keys(G).map(function(k){ return G[k]; }).sort(by === 'stage' ? function(a, b){ return stageRank(a.group) - stageRank(b.group) || a.group.localeCompare(b.group); } : function(a, b){ return b.value - a.value; });
      return { cols:[{ k:'group', label:(this.controls[0].options.filter(function(x){ return x[0] === by; })[0] || [])[1], kind:'drill' }, { k:'n', label:'Sales orders', kind:'num' }, { k:'value', label:'Order value (before GST)', kind:'money' }, { k:'coll', label:'Collected (before GST)', kind:'money' }, { k:'bal', label:'Not yet collected', kind:'money' }], rows:rows2, total:['n', 'value', 'coll', 'bal'],
        note:'Open sales orders only (cancelled and inter-company left out). Click a row for its sales orders.' + (by === 'stage' && !idx ? ' Production readiness is not shown to your team, so orders in production appear as "POs raised".' : '') };
    } },
  { id:'collections', team:'MIS', title:'Collections by SO date', sub:'Collected before GST on sales orders dated in a period.',
    can:function(){ return can('payables'); },
    controls:[{ id:'range', label:'SO dated', options:[['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['custom', 'Between two dates']] }, { id:'from', label:'From', type:'date', when:'custom' }, { id:'to', label:'To', type:'date', when:'custom' }],
    build:function(o){
      var t = today(), r = o.range || 'month', from, to = t;
      if (r === 'week') from = monday(t); else if (r === 'month') from = t.slice(0, 8) + '01';
      else if (r === 'lastmonth'){ var d = new Date(t.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); from = d.toISOString().slice(0, 10); to = addD(t.slice(0, 8) + '01', -1); }
      else { from = o.from || t.slice(0, 8) + '01'; to = o.to || t; }
      var rows = heads().filter(function(h){ return h.date && h.date >= from && h.date <= to; }).sort(function(a, b){ return (b.collectedExTax || 0) - (a.collectedExTax || 0); }).map(function(h){ return { so:h.so, customer:h.customer, date:h.date, city:h.city, value:+h.value || 0, coll:+h.collectedExTax || 0, bal:Math.max(0, (+h.value || 0) - (+h.collectedExTax || 0)) }; });
      return { cols:[{ k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'date', label:'SO date', kind:'date' }, { k:'city', label:'Site' }, { k:'value', label:'Order value (before GST)', kind:'money' }, { k:'coll', label:'Collected (before GST)', kind:'money' }, { k:'bal', label:'Not yet collected', kind:'money' }], rows:rows, total:['value', 'coll', 'bal'],
        summary:'Sales orders dated ' + fmtD(from) + ' to ' + fmtD(to), note:'This is money collected so far on sales orders dated in the period. It is not "money received in the period": the ERP exports carry no collection dates.' };
    } },
  { id:'plan', team:'Factory', title:'Weekly plan', sub:'Open factory lines by week, then by readiness C1, C2, C4, C3, C0.',
    can:function(){ return !!call('xCatOn') && can('deadlines'); },
    build:function(){
      var t = today(), w0 = monday(t), buf = +g('DL_BUF') || 5;
      var rows = openRows().map(function(r){ var o = r.o, b = lineBase(r), f = call('effF', o), d, basis;
        if (f){ d = f; basis = 'Factory date'; } else if (o.committedDeadline){ d = addD(o.committedDeadline, -buf); basis = 'Client date − ' + buf + ' days'; } else { d = b.poDate || ''; basis = b.poDate ? 'PO date' : 'No date'; }
        var wk = d ? monday(d) : ''; b.wk = !d ? 'No date' : wk < w0 ? 'Before this week' : 'Week of ' + fmtD(wk); b._wk = !d ? '9999' : wk < w0 ? '0000' : wk; b.d = d; b.basis = basis; b.c = r.c; b.cat = { t:r.c, cls:catCls(r.c) }; b.jc = (call('xJcInfo', o) || {}).lab || 'No job card'; b.why = call('xCatReason', r) || ''; return b; });
      rows.sort(function(a, b){ return a._wk.localeCompare(b._wk) || CORD.indexOf(a.c) - CORD.indexOf(b.c) || String(a.d).localeCompare(String(b.d)) || a.so.localeCompare(b.so); });
      var n = { f:0, c:0, p:0 }; rows.forEach(function(x){ if (x.basis === 'Factory date') n.f++; else if (/^Client/.test(x.basis)) n.c++; else n.p++; });
      return { cols:[{ k:'wk', label:'Week' }, { k:'d', label:'Date', kind:'date' }, { k:'basis', label:'Sorted by' }, { k:'cat', label:'Readiness', kind:'pill' }, { k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'article', label:'Article' }, { k:'qty', label:'Qty', kind:'num' }, { k:'po', label:'PO', kind:'po' }, { k:'jc', label:'Job card' }, { k:'why', label:'Why' }], rows:rows,
        summary:rows.length + ' open factory lines: ' + n.f + ' sorted by factory date, ' + n.c + ' by client date − ' + buf + ' days, ' + n.p + ' by PO date',
        note:'A line is placed by its agreed factory date. Where there is none yet, by the client date less ' + buf + ' days, and failing that by its PO date. Packed lines are left out.' };
    } },
  { id:'rm', team:'Factory', title:'Raw material pending', sub:'Open factory lines whose job card does not confirm raw material (C3, C4).',
    can:function(){ return !!call('xCatOn') && can('jobcards'); },
    build:function(){
      var rows = openRows().filter(function(r){ return r.c === 'C3' || r.c === 'C4'; }).map(function(r){ var b = lineBase(r); b.cat = { t:r.c, cls:catCls(r.c) }; b.card = r.jc ? r.jc.jobCardNumber : ''; b.jc = (call('xJcInfo', r.o) || {}).lab || ''; b.fab = r.fab.ok ? 'Fabric in' : 'Fabric pending'; return b; })
        .sort(function(a, b){ return String(a.poDate).localeCompare(String(b.poDate)) || a.so.localeCompare(b.so); });
      return { cols:[{ k:'cat', label:'Readiness', kind:'pill' }, { k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'article', label:'Article' }, { k:'qty', label:'Qty', kind:'num' }, { k:'po', label:'PO', kind:'po' }, { k:'poDate', label:'PO date', kind:'date' }, { k:'card', label:'Job card' }, { k:'jc', label:'Stage' }, { k:'fab', label:'Fabric' }], rows:rows,
        note:'Oldest PO first. Lines with no job card at all (C0) are not listed here; see the weekly plan.' };
    } },
  { id:'fabric', team:'Factory and Supply', title:'Fabric pending', sub:'Fabric not yet received at the factory, and who has to act (C2, C3).',
    can:function(){ return !!call('xCatOn') && can('fabric'); },
    build:function(){
      var ST = { in_transit:['In transit', 'Factory to confirm receipt'], awaiting_dispatch:['Tagged, not sent', 'Supply to send'], no_tag:['No tag yet', 'Supply to log'] }, rows = [];
      openRows().filter(function(r){ return r.c === 'C2' || r.c === 'C3'; }).forEach(function(r){ var b = lineBase(r);
        if (r.fab.note) rows.push(Object.assign({}, b, { cat:{ t:r.c, cls:catCls(r.c) }, fabric:'(fabric details missing)', status:r.fab.note, next:'Sales to fill in the fabric', tag:'' }));
        (r.fab.items || []).forEach(function(i){ if (i.status === 'received') return; var s = ST[i.status] || [i.status, '']; rows.push(Object.assign({}, b, { cat:{ t:r.c, cls:catCls(r.c) }, fabric:i.name || i.sku, status:s[0], next:s[1], tag:i.tag || '' })); }); });
      rows.sort(function(a, b){ return a.next.localeCompare(b.next) || String(a.poDate).localeCompare(String(b.poDate)) || a.so.localeCompare(b.so); });
      var n = {}; rows.forEach(function(x){ var k = x.next.split(' ')[0]; n[k] = (n[k] || 0) + 1; });
      return { cols:[{ k:'next', label:'Next step' }, { k:'fabric', label:'Fabric' }, { k:'status', label:'Status' }, { k:'tag', label:'Tag' }, { k:'cat', label:'Readiness', kind:'pill' }, { k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'article', label:'For article' }, { k:'po', label:'PO', kind:'po' }, { k:'poDate', label:'PO date', kind:'date' }], rows:rows,
        summary:rows.length + ' fabric items pending' + (rows.length ? ': ' + Object.keys(n).map(function(k){ return n[k] + ' with ' + k; }).join(', ') : '') };
    } },
  { id:'flush', team:'Supply', title:'Easiest orders to flush out', sub:'Fully raised sales orders, fewest factory lines not ready first.',
    can:function(){ return !!call('xCatOn') && can('payables'); },
    build:function(){
      var idx = call('xCatIndex'), disp = dispatchedSos(), per = {};
      idx.byLine.forEach(function(r){ var a = per[r.o.so] = per[r.o.so] || { lines:0, notReady:0, worst:'' }; a.lines++; if (!r.packed && r.c !== 'C1'){ a.notReady++; if (!a.worst || CORD.indexOf(r.c) > CORD.indexOf(a.worst)) a.worst = r.c; } });
      var rows = heads().filter(function(h){ return (call('poStatusOf', h) || {}).key === 'full' && (+h.value || 0) - (disp[h.so] || 0) > 0.5; }).map(function(h){ var a = per[h.so] || { lines:0, notReady:0, worst:'' };
        return { so:h.so, customer:h.customer, city:h.city, lines:a.lines, notReady:a.notReady, cat:a.lines ? (a.notReady ? { t:idx.soCat[h.so] || a.worst, cls:catCls(idx.soCat[h.so] || a.worst) } : { t:'Ready', cls:'good' }) : { t:'No factory line', cls:'' }, bal:Math.max(0, (+h.total || 0) - (+h.collected || 0)), rem:Math.max(0, (+h.value || 0) - (disp[h.so] || 0)) }; })
        .sort(function(a, b){ return a.notReady - b.notReady || b.bal - a.bal || a.so.localeCompare(b.so); });
      rows.forEach(function(x, i){ x.rank = i + 1; });
      return { cols:[{ k:'rank', label:'#', kind:'num' }, { k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'city', label:'Site' }, { k:'lines', label:'Factory lines', kind:'num' }, { k:'notReady', label:'Not ready', kind:'num' }, { k:'cat', label:'Worst line', kind:'pill' }, { k:'bal', label:'Balance collectible (with GST)', kind:'money' }, { k:'rem', label:'Still to dispatch (before GST)', kind:'money' }], rows:rows, total:['bal', 'rem'],
        summary:rows.length + ' fully raised sales orders with something still to dispatch; ' + rows.filter(function(x){ return !x.notReady; }).length + ' have no factory line waiting',
        note:'Ready means the line is C1 or packed. Ties go to the larger balance collectible. Sales orders with no factory line (bought-in items) count as nothing waiting; check their stock before promising a date.' };
    } },
  { id:'flushweek', team:'Supply', title:'Flushout value by week', sub:'Value expected to flush out each week, from dispatch bookings and factory dates.',
    can:function(){ return (g('state') || {}).role === 'admin' && can('payables'); },
    build:function(o){
      var pr = call('xProjCompute') || { items:[], today:today() }, w0 = monday(pr.today), it = pr.items.filter(function(i){ return i.kind === 'flush'; });
      var keyOf = function(i){ return !i.date ? 'No date yet' : i.overdue ? 'Overdue (due now)' : 'Week of ' + fmtD(monday(i.date)); }, ord = function(i){ return !i.date ? '9999' : i.overdue ? '0000' : monday(i.date); };
      if (o.drill != null){ var rs = it.filter(function(i){ return keyOf(i) === o.drill; }).sort(function(a, b){ return b.amount - a.amount; }).map(function(i){ return { so:i.so, customer:headOf(i.so).customer || '', po:i.po, date:i.date || '', amount:i.amount, basis:i.basis }; });
        return { crumb:o.drill, cols:[{ k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'po', label:'PO(s)' }, { k:'date', label:'Expected', kind:'date' }, { k:'amount', label:'Flushout value (before GST)', kind:'money' }, { k:'basis', label:'Based on' }], rows:rs, total:['amount'] }; }
      var G = {}; it.forEach(function(i){ var k = keyOf(i), a = G[k] = G[k] || { group:k, _o:ord(i), _drill:k, sos:{}, amount:0 }; a.sos[i.so] = 1; a.amount += i.amount; });
      var rows = Object.keys(G).map(function(k){ G[k].n = Object.keys(G[k].sos).length; return G[k]; }).sort(function(a, b){ return a._o.localeCompare(b._o); });
      return { cols:[{ k:'group', label:'Week', kind:'drill' }, { k:'n', label:'Sales orders', kind:'num' }, { k:'amount', label:'Flushout value (before GST)', kind:'money' }], rows:rows, total:['amount'],
        note:'Same figures as Payables & Flushout › Projection Analysis: value still to dispatch, dated by the dispatch booking, or the factory date plus 5 working days. A line with neither falls under "No date yet". Click a row for its sales orders.' };
    } },
  { id:'deviations', team:'Sales', title:'Deadline deviations', sub:'Lines where the factory date is later than the client date, or a date change is open.',
    can:function(){ return can('deadlines'); },
    build:function(){
      var rows = [], dl = g('PO_DL') || {};
      (g('ORDERS') || []).forEach(function(o){ if (!o.po || o.lifecycle !== 'po_confirmed' || !call('factoryLine', o) || headOf(o.so).cancelled) return;
        var f = call('effF', o), fv = f ? call('viewF', f) : '', cv = o.committedDeadline ? call('viewC', o.committedDeadline) : '';
        var neg = o.deadlineNeg || (dl[o.po] || {}).neg, hist = (o.deadlineNegHistory || []).length + (((dl[o.po] || {}).negHistory || []).length);
        var late = fv && cv && fv > cv ? Math.round((Date.parse(fv) - Date.parse(cv)) / 864e5) : 0;
        if (!late && !neg && !hist) return;
        rows.push({ so:o.so, customer:headOf(o.so).customer || o.customer || '', article:o.article || '', po:o.po, cv:cv, fv:fv, late:late, status:neg ? (neg.status === 'awaiting_sales' ? 'Waiting for sales to answer' : neg.status === 'awaiting_factory' ? 'Waiting for the factory to answer' : 'Under discussion') : late ? 'Agreed later than the client date' : 'Date change settled', rounds:hist + (neg ? 1 : 0) }); });
      rows.sort(function(a, b){ return (a.status.indexOf('Waiting') === 0 ? 0 : 1) - (b.status.indexOf('Waiting') === 0 ? 0 : 1) || b.late - a.late || a.so.localeCompare(b.so); });
      return { cols:[{ k:'status', label:'Status' }, { k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'article', label:'Article' }, { k:'po', label:'PO', kind:'po' }, { k:'cv', label:'Client date', kind:'date' }, { k:'fv', label:'Factory date', kind:'date' }, { k:'late', label:'Days late', kind:'num' }, { k:'rounds', label:'Date changes', kind:'num' }], rows:rows,
        summary:rows.length + ' lines: ' + rows.filter(function(x){ return x.status.indexOf('Waiting') === 0; }).length + ' with a date change open, ' + rows.filter(function(x){ return x.late > 0; }).length + ' later than the client date',
        note:'Dates are shown the way your team sees them in Order Deadlines.' };
    } },
];
function repById(id){ for (var i = 0; i < REPORTS.length; i++) if (REPORTS[i].id === id) return REPORTS[i]; return null; }
function cellHtml(c, row){
  var v = row[c.k];
  if (c.kind === 'so') return '<button class="link" type="button" data-so="' + esc(v) + '">' + esc(v) + '</button>';
  if (c.kind === 'po') return v ? '<button class="link" type="button" data-po="' + esc(v) + '">' + esc(v) + '</button>' : '';
  if (c.kind === 'drill') return '<button class="link" type="button" data-drill="' + esc(row._drill) + '">' + esc(v) + '</button>';
  if (c.kind === 'date') return esc(fmtD(v));
  if (c.kind === 'money') return esc(inr(v));
  if (c.kind === 'num') return esc(num(v));
  if (c.kind === 'pill') return v ? pill(v.t, v.cls) : '';
  return esc(v);
}
function cellCsv(c, row){ var v = row[c.k]; if (c.kind === 'pill') v = v ? v.t : ''; if (c.kind === 'money') v = Math.round(+v || 0); if (v == null) v = '';
  v = String(v); if (/^\d{11,}$/.test(v)) return '"=""' + v + '"""'; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csvOf(R){ var q = function(v){ return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; return [R.cols.map(function(c){ return q(c.label); }).join(',')].concat(R.rows.map(function(r){ return R.cols.map(function(c){ return cellCsv(c, r); }).join(','); })).join('\r\n'); }
var LIMIT = 300, curRep = null, curData = null;
function showReport(id, opts){
  var rp = repById(id); if (!rp || !rp.can()) return home({ err:true, text:'That report is not available to your team.' });
  opts = opts || {}; var R; try { R = rp.build(opts); } catch(e){ return home({ err:true, text:'Could not build the report: ' + e.message }); }
  cur = null; curRep = { id:id, opts:opts }; curData = R;
  var ctl = (rp.controls || []).filter(function(c){ return !c.when || opts.range === c.when; }).map(function(c){
    return '<label class="ctl">' + esc(c.label) + ' ' + (c.type === 'date' ? '<input type="date" data-ctl="' + c.id + '" value="' + esc(opts[c.id] || '') + '">' : '<select data-ctl="' + c.id + '">' + c.options.map(function(x){ return '<option value="' + x[0] + '"' + ((opts[c.id] || c.options[0][0]) === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select>') + '</label>'; }).join('');
  var tot = R.total && R.rows.length ? '<tr class="tot"><td>' + (R.cols[0].kind === 'num' ? '' : 'Total') + '</td>' + R.cols.slice(1).map(function(c){ return '<td class="' + (c.kind === 'money' || c.kind === 'num' ? 'num' : '') + '">' + (R.total.indexOf(c.k) >= 0 ? esc((c.kind === 'money' ? inr : num)(R.rows.reduce(function(s, r){ return s + (+r[c.k] || 0); }, 0))) : '') + '</td>'; }).join('') + '</tr>' : '';
  out.innerHTML = '<section class="card"><div class="row"><div class="grow"><h2>' + esc(rp.title) + (R.crumb != null ? ' › ' + esc(R.crumb) : '') + '</h2><div class="sub">' + esc(R.summary || rp.sub) + '</div></div>'
    + (R.crumb != null ? '<button type="button" id="btnUp">Back to the groups</button>' : '') + '<button type="button" id="btnCsv">Download CSV</button><button type="button" id="btnHome">All reports</button></div>'
    + (ctl && R.crumb == null ? '<div class="row" style="margin-top:10px">' + ctl + '</div>' : '') + '</section>'
    + '<section class="card">' + (R.rows.length ? '<div class="scroll"><table><thead><tr>' + R.cols.map(function(c){ return '<th class="' + (c.kind === 'money' || c.kind === 'num' ? 'num' : '') + '">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + R.rows.slice(0, LIMIT).map(function(r){ return '<tr>' + R.cols.map(function(c){ return '<td class="' + (c.kind === 'money' || c.kind === 'num' ? 'num' : '') + '">' + cellHtml(c, r) + '</td>'; }).join('') + '</tr>'; }).join('') + tot + '</tbody></table></div>'
      + (R.rows.length > LIMIT ? '<p class="note">Showing the first ' + LIMIT + ' of ' + R.rows.length + ' rows. The total and the CSV cover all of them.</p>' : '') : '<p class="note" style="margin:0">Nothing to show.</p>') + '</section>'
    + (R.note ? '<p class="note">' + esc(R.note) + '</p>' : '');
  out.scrollTop = 0; P.wide(true); wide = true; var bw = document.getElementById('btnWide'); bw.textContent = 'Narrower'; bw.setAttribute('aria-pressed', 'true');
  footData();
}
function footData(){ var meta = (g('X') || {}).builtAt; document.getElementById('foot').textContent = 'Read-only. ERP data as of ' + (fmtD(meta) || 'the last upload') + '; work saved in Order Bridge is live.'; }
function download(name, text){ var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type:'text/csv;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500); }

// ------------------------------------------------------------------ page
var cur = null, recent = [], wide = false;
function home(msg){
  cur = null;
  out.innerHTML = (msg ? '<div class="card"><p class="' + (msg.err ? 'err' : 'note') + '" style="margin:0">' + esc(msg.text) + '</p></div>' : '')
    + '<div class="card"><h2>Find an order</h2><p class="note" style="margin:6px 0 0">Type a sales order or PO number (the last few digits are enough), a job card number, or part of a customer name. You get the order on one page: POs, dates, job card stage, fabric, packages, dispatch and history.</p></div>'
    + reportList()
    + (recent.length ? '<div class="card"><h3>Looked at in this session</h3><ul class="plain">' + recent.map(function(r){ return '<li><button class="link" type="button" data-' + (r.so ? 'so' : 'po') + '="' + esc(r.so || r.po) + '">' + esc((r.so ? 'SO ' : 'PO ') + (r.so || r.po)) + '</button> <span class="sub">' + esc(r.sub) + '</span></li>'; }).join('') + '</ul></div>' : '');
}
function reportList(){
  var av = REPORTS.filter(function(r){ try { return r.can(); } catch(e){ return false; } }); if (!av.length) return '';
  return '<div class="card"><h3>Reports</h3><ul class="plain">' + av.map(function(r){ return '<li><button class="link" type="button" data-report="' + r.id + '">' + esc(r.title) + '</button> <span class="pill">' + esc(r.team) + '</span><div class="sub">' + esc(r.sub) + '</div></li>'; }).join('') + '</ul></div>';
}
function show(ref){
  var C = ref.so ? buildSo(ref.so) : buildPo(ref.po);
  if (!C) return home({ err:true, text:'Nothing found for ' + (ref.so || ref.po) + '.' });
  cur = C; curRep = null; curData = null; out.innerHTML = renderCard(C); out.scrollTop = 0;
  var key = ref.so || ref.po; recent = recent.filter(function(r){ return (r.so || r.po) !== key; });
  recent.unshift({ so:ref.so, po:ref.po, sub:ref.so ? C.head.customer : C.head.supplier }); recent = recent.slice(0, 8);
  footData();
}
function run(q){
  if (!P.can()) return home({ err:true, text:'The Assistant is not switched on for your team.' });
  var r; try { r = find(q); } catch(e){ return home({ err:true, text:'Could not search: ' + e.message }); }
  if (r.none) return home();
  if (r.so || r.po){ try { return show(r); } catch(e){ return home({ err:true, text:'Could not build the order page: ' + e.message }); } }
  if (!r.hits.length) return home({ err:true, text:'Nothing found for "' + r.q + '". Check the number, or try part of the customer name.' });
  cur = null;
  out.innerHTML = '<div class="card"><h3>' + r.hits.length + ' matches for "' + esc(r.q) + '"' + (r.hits.length > 40 ? ' (first 40 shown)' : '') + '</h3><ul class="plain">' + r.hits.slice(0, 40).map(function(x){ return '<li><button class="link" type="button" data-' + (x.so ? 'so' : 'po') + '="' + esc(x.so || x.po) + '">' + esc(x.label) + '</button> <span class="sub">' + esc(x.sub) + '</span></li>'; }).join('') + '</ul></div>';
}
document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault(); run(qEl.value); });
out.addEventListener('click', function(e){
  var t = e.target.closest('button'); if (!t) return;
  if (t.dataset.so){ qEl.value = t.dataset.so; return show({ so:t.dataset.so }); }
  if (t.dataset.po){ qEl.value = t.dataset.po; return show({ po:t.dataset.po }); }
  if (t.dataset.report) return showReport(t.dataset.report, {});
  if (t.dataset.drill != null && curRep) return showReport(curRep.id, Object.assign({}, curRep.opts, { drill:t.dataset.drill }));
  if (t.id === 'btnUp' && curRep){ var o2 = Object.assign({}, curRep.opts); delete o2.drill; return showReport(curRep.id, o2); }
  if (t.id === 'btnHome') return home();
  if (t.id === 'btnCsv' && curRep && curData) return download('order-bridge-' + curRep.id + (curData.crumb != null ? '-' + String(curData.crumb).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30) : '') + '-' + today() + '.csv', csvOf(curData));
  if (t.dataset.line){ P.nav({ module:'confirmations', openOrderId:t.dataset.line }); return; }
  if (t.id === 'btnCopy' && cur){ var txt = textOf(cur), done = function(){ t.textContent = 'Copied'; setTimeout(function(){ t.textContent = 'Copy as text'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function(){ fallbackCopy(txt); done(); }); else { fallbackCopy(txt); done(); } }
});
function fallbackCopy(txt){ var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(e){} ta.remove(); }
out.addEventListener('change', function(e){ var c = e.target.dataset && e.target.dataset.ctl; if (!c || !curRep) return; var o = Object.assign({}, curRep.opts); o[c] = e.target.value; delete o.drill; showReport(curRep.id, o); });
document.getElementById('btnWide').addEventListener('click', function(){ wide = !wide; P.wide(wide); this.textContent = wide ? 'Narrower' : 'Wider'; this.setAttribute('aria-pressed', wide ? 'true' : 'false'); });
document.getElementById('btnClose').addEventListener('click', function(){ P.close(); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') P.close(); });
P.onOpen = function(q){ if (q){ qEl.value = q; run(q); } else qEl.focus(); };
window.__asst = { find:find, buildSo:buildSo, buildPo:buildPo, textOf:textOf, REPORTS:REPORTS, csvOf:csvOf };   // for tests
if (P.pending){ var q0 = P.pending; P.pending = null; qEl.value = q0; run(q0); } else { home(); qEl.focus(); }
})();
