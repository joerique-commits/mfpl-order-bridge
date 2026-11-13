// =====================================================================================
// Order Bridge Assistant — phase 1: the order card (13 Nov 2026).
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

// ------------------------------------------------------------------ page
var cur = null, recent = [];
function home(msg){
  cur = null;
  out.innerHTML = (msg ? '<div class="card"><p class="' + (msg.err ? 'err' : 'note') + '" style="margin:0">' + esc(msg.text) + '</p></div>' : '')
    + '<div class="card"><h2>Find an order</h2><p class="note" style="margin:6px 0 0">Type a sales order or PO number (the last few digits are enough), a job card number, or part of a customer name. You get the order on one page: POs, dates, job card stage, fabric, packages, dispatch and history.</p></div>'
    + (recent.length ? '<div class="card"><h3>Looked at in this session</h3><ul class="plain">' + recent.map(function(r){ return '<li><button class="link" type="button" data-' + (r.so ? 'so' : 'po') + '="' + esc(r.so || r.po) + '">' + esc((r.so ? 'SO ' : 'PO ') + (r.so || r.po)) + '</button> <span class="sub">' + esc(r.sub) + '</span></li>'; }).join('') + '</ul></div>' : '');
}
function show(ref){
  var C = ref.so ? buildSo(ref.so) : buildPo(ref.po);
  if (!C) return home({ err:true, text:'Nothing found for ' + (ref.so || ref.po) + '.' });
  cur = C; out.innerHTML = renderCard(C); out.scrollTop = 0;
  var key = ref.so || ref.po; recent = recent.filter(function(r){ return (r.so || r.po) !== key; });
  recent.unshift({ so:ref.so, po:ref.po, sub:ref.so ? C.head.customer : C.head.supplier }); recent = recent.slice(0, 8);
  var meta = (g('X') || {}).builtAt; document.getElementById('foot').textContent = 'Read-only. ERP data as of ' + (fmtD(meta) || 'the last upload') + '; work saved in Order Bridge is live.';
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
  if (t.dataset.line){ P.nav({ module:'confirmations', openOrderId:t.dataset.line }); return; }
  if (t.id === 'btnCopy' && cur){ var txt = textOf(cur), done = function(){ t.textContent = 'Copied'; setTimeout(function(){ t.textContent = 'Copy as text'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function(){ fallbackCopy(txt); done(); }); else { fallbackCopy(txt); done(); } }
});
function fallbackCopy(txt){ var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch(e){} ta.remove(); }
var wide = false;
document.getElementById('btnWide').addEventListener('click', function(){ wide = !wide; P.wide(wide); this.textContent = wide ? 'Narrower' : 'Wider'; this.setAttribute('aria-pressed', wide ? 'true' : 'false'); });
document.getElementById('btnClose').addEventListener('click', function(){ P.close(); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') P.close(); });
P.onOpen = function(q){ if (q){ qEl.value = q; run(q); } else qEl.focus(); };
window.__asst = { find:find, buildSo:buildSo, buildPo:buildPo, textOf:textOf };   // for tests
if (P.pending){ var q0 = P.pending; P.pending = null; qEl.value = q0; run(q0); } else { home(); qEl.focus(); }
})();
