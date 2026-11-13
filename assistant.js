// =====================================================================================
// Order Bridge Assistant — phase 1: the order card; phase 2: team reports; phase 3: AI questions and email drafts (13 Nov 2026).
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
    if (AI.ready && canEmail()) h += mailForm();
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
  { id:'collections', team:'MIS', title:'Collected on SOs dated in a period', sub:'Collected so far, before GST, on sales orders dated in a period (not when the money came in).',
    can:function(){ return can('payables'); },
    controls:[{ id:'range', label:'SO dated', options:[['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['custom', 'Between two dates']] }, { id:'from', label:'From', type:'date', when:'custom' }, { id:'to', label:'To', type:'date', when:'custom' }],
    build:function(o){
      var t = today(), r = o.range || 'month', from, to = t;
      if (r === 'week') from = monday(t); else if (r === 'month') from = t.slice(0, 8) + '01';
      else if (r === 'lastmonth'){ var d = new Date(t.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); from = d.toISOString().slice(0, 10); to = addD(t.slice(0, 8) + '01', -1); }
      else { from = o.from || t.slice(0, 8) + '01'; to = o.to || t; }
      var rows = heads().filter(function(h){ return h.date && h.date >= from && h.date <= to; }).sort(function(a, b){ return (b.collectedExTax || 0) - (a.collectedExTax || 0); }).map(function(h){ return { so:h.so, customer:h.customer, date:h.date, city:h.city, value:+h.value || 0, coll:+h.collectedExTax || 0, bal:Math.max(0, (+h.value || 0) - (+h.collectedExTax || 0)) }; });
      return { cols:[{ k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'date', label:'SO date', kind:'date' }, { k:'city', label:'Site' }, { k:'value', label:'Order value (before GST)', kind:'money' }, { k:'coll', label:'Collected (before GST)', kind:'money' }, { k:'bal', label:'Not yet collected', kind:'money' }], rows:rows, total:['value', 'coll', 'bal'],
        summary:'Sales orders dated ' + fmtD(from) + ' to ' + fmtD(to), note:'This is money collected so far on sales orders dated in the period. For money received in a period, use Collections received.' };
    } },
  { id:'received', team:'MIS', async:true, colsHint:'so (SO), customer (Customer), date (SO date), city (Site), recv (Received in the period before GST), recvGst (Received with GST)', title:'Collections received', sub:'Money received in a period, from the daily record of each sales order\'s collected total.',
    can:function(){ return can('payables'); },
    controls:[{ id:'range', label:'Period', options:[['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['custom', 'Between two dates']] }, { id:'from', label:'From', type:'date', when:'custom' }, { id:'to', label:'To', type:'date', when:'custom' }],
    build:function(o){
      var t = today(), r = o.range || 'week', from, to = t;
      if (r === 'week') from = monday(t); else if (r === 'month') from = t.slice(0, 8) + '01';
      else if (r === 'lastmonth'){ var d0 = new Date(t.slice(0, 8) + '01T00:00:00Z'); d0.setUTCMonth(d0.getUTCMonth() - 1); from = d0.toISOString().slice(0, 10); to = addD(t.slice(0, 8) + '01', -1); }
      else { from = o.from || monday(t); to = o.to || t; }
      var cols = [{ k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'date', label:'SO date', kind:'date' }, { k:'city', label:'Site' }, { k:'was', label:'Collected at the start (before GST)', kind:'money' }, { k:'now', label:'Collected at the end (before GST)', kind:'money' }, { k:'recv', label:'Received in the period (before GST)', kind:'money' }, { k:'recvGst', label:'Received (with GST)', kind:'money' }];
      var iso = function(d){ return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }, key = function(d){ return d.replace(/-/g, ''); };
      return api('/api/assistant/coll').then(function(ix){
        var days = ((ix && ix.days) || []).map(function(x){ return x.day; }).sort();
        var b = days.filter(function(d){ return d <= key(to); }).pop(), a = days.filter(function(d){ return d < key(from); }).pop(), partial = false;
        if (!b) return { cols:cols, rows:[], summary:fmtD(from) + ' to ' + fmtD(to), note:'There is no daily record for this period. Recording started ' + (days.length ? 'on ' + fmtD(iso(days[0])) : 'today, with the next ERP data upload') + '; periods before that cannot be worked out.' };
        if (!a){ a = days[0]; partial = true; }
        if (a === b) return { cols:cols, rows:[], summary:fmtD(from) + ' to ' + fmtD(to), note:'Only one day is on record so far (' + fmtD(iso(b)) + '), so there is nothing to compare it with yet. The figure appears after the next ERP data upload on a later day.' };
        return api('/api/assistant/coll?a=' + a + '&b=' + b).then(function(sn){
          var A = (sn.a || {}).m || {}, B = (sn.b || {}).m || {}, rows = [], gone = 0, late = 0, D = g('DPI_BY_SO') || {};
          Object.keys(A).forEach(function(so){ if (!(so in B)) gone++; });
          Object.keys(B).forEach(function(so){ var h = D[so] || {}, x = A[so];
            if (!x && !(h.date && h.date > iso(a))){ late++; return; }
            x = x || [0, 0]; var dx = B[so][0] - x[0], dg = B[so][1] - x[1]; if (Math.abs(dx) < 0.5 && Math.abs(dg) < 0.5) return;
            rows.push({ so:so, customer:h.customer || '', date:h.date || '', city:h.city || '', was:x[0], now:B[so][0], recv:dx, recvGst:dg }); });
          rows.sort(function(p, q){ return q.recv - p.recv; });
          return { cols:cols, rows:rows, total:['recv', 'recvGst'], summary:'Received between the data of ' + fmtD(iso(a)) + ' and ' + fmtD(iso(b)),
            note:(partial ? 'Recording started on ' + fmtD(iso(a)) + ', so this covers only part of the period you chose. ' : '') + 'Worked out as each sales order\'s collected total at the end less its total at the start. A minus figure is a reversal or correction in the ERP.'
              + (gone ? ' ' + gone + ' sales orders left the data in between and are not counted.' : '') + (late ? ' ' + late + ' older sales orders first appeared in between and are not counted, because their earlier total is unknown.' : '') };
        });
      });
    } },
  { id:'plan', team:'Factory', title:'Weekly plan', sub:'Open factory lines by week, then by readiness C1, C2, C4, C3, C0.',
    can:function(){ return !!call('xCatOn') && can('deadlines'); },
    build:function(){
      var t = today(), w0 = monday(t), buf = +g('DL_BUF') || 5;
      var rows = openRows().map(function(r){ var o = r.o, b = lineBase(r), f = call('effF', o), d, basis;
        if (f){ d = f; basis = 'Factory date'; } else if (o.committedDeadline){ d = addD(o.committedDeadline, -buf); basis = 'Client date − ' + buf + ' days'; } else { d = b.poDate || ''; basis = b.poDate ? 'PO date' : 'No date'; }
        var wk = d ? monday(d) : '', agreed = basis !== 'PO date' && !!d; b.wk = !d ? 'No date' : !agreed ? 'No date agreed yet' : wk < w0 ? 'Before this week' : 'Week of ' + fmtD(wk); b._wk = !d ? '9999' : !agreed ? '9998' : wk < w0 ? '0000' : wk; b.d = d; b.basis = basis; b.c = r.c; b.cat = { t:r.c, cls:catCls(r.c) }; b.jc = (call('xJcInfo', o) || {}).lab || 'No job card'; b.why = call('xCatReason', r) || ''; return b; });
      rows.sort(function(a, b){ return a._wk.localeCompare(b._wk) || CORD.indexOf(a.c) - CORD.indexOf(b.c) || String(a.d).localeCompare(String(b.d)) || a.so.localeCompare(b.so); });
      var n = { f:0, c:0, p:0 }; rows.forEach(function(x){ if (x.basis === 'Factory date') n.f++; else if (/^Client/.test(x.basis)) n.c++; else n.p++; });
      return { cols:[{ k:'wk', label:'Week' }, { k:'d', label:'Date', kind:'date' }, { k:'basis', label:'Sorted by' }, { k:'cat', label:'Readiness', kind:'pill' }, { k:'so', label:'SO', kind:'so' }, { k:'customer', label:'Customer' }, { k:'article', label:'Article' }, { k:'qty', label:'Qty', kind:'num' }, { k:'po', label:'PO', kind:'po' }, { k:'jc', label:'Job card' }, { k:'why', label:'Why' }], rows:rows,
        summary:rows.length + ' open factory lines: ' + n.f + ' sorted by factory date, ' + n.c + ' by client date − ' + buf + ' days, ' + n.p + ' by PO date',
        note:'A line is placed in the week of its agreed factory date. Where there is none yet, the client date less ' + buf + ' days is used. Lines with neither are listed last under "No date agreed yet", by readiness and then oldest PO first. Packed lines are left out.' };
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
var LIMIT = 300, curRep = null, curData = null, seq = 0;
function api(path, opts){ return W.__OB.api(path, opts); }
function showReport(id, opts){
  var rp = repById(id); if (!rp || !rp.can()) return home({ err:true, text:'That report is not available to your team.' });
  opts = opts || {}; var R; try { R = rp.build(opts); } catch(e){ return home({ err:true, text:'Could not build the report: ' + e.message }); }
  if (R && typeof R.then === 'function'){ out.innerHTML = '<div class="card"><p class="note" style="margin:0">Working it out…</p></div>'; var tk = ++seq; return R.then(function(x){ if (tk === seq) paintReport(rp, id, opts, x); }, function(e){ if (tk === seq) home({ err:true, text:'Could not build the report: ' + e.message }); }); }
  paintReport(rp, id, opts, R);
}
function paintReport(rp, id, opts, R, lead){
  cur = null; curRep = { id:id, opts:opts }; curData = R;
  var ctl = (rp.controls || []).filter(function(c){ return !c.when || opts.range === c.when; }).map(function(c){
    return '<label class="ctl">' + esc(c.label) + ' ' + (c.type === 'date' ? '<input type="date" data-ctl="' + c.id + '" value="' + esc(opts[c.id] || '') + '">' : '<select data-ctl="' + c.id + '">' + c.options.map(function(x){ return '<option value="' + x[0] + '"' + ((opts[c.id] || c.options[0][0]) === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select>') + '</label>'; }).join('');
  var tot = R.total && R.rows.length ? '<tr class="tot"><td>' + (R.cols[0].kind === 'num' ? '' : 'Total') + '</td>' + R.cols.slice(1).map(function(c){ return '<td class="' + (c.kind === 'money' || c.kind === 'num' ? 'num' : '') + '">' + (R.total.indexOf(c.k) >= 0 ? esc((c.kind === 'money' ? inr : num)(R.rows.reduce(function(s, r){ return s + (+r[c.k] || 0); }, 0))) : '') + '</td>'; }).join('') + '</tr>' : '';
  out.innerHTML = (lead || '') + '<section class="card"><div class="row"><div class="grow"><h2>' + esc(rp.title) + (R.crumb != null ? ' › ' + esc(R.crumb) : '') + '</h2><div class="sub">' + esc(R.summary || rp.sub) + '</div></div>'
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

// ------------------------------------------------------------------ AI layer (phase 3, 13 Nov 2026)
// The model never sees a real name, amount or phone number and never does arithmetic. The page (a) swaps
// names, numbers, dates and amounts for placeholders like [[C1]], (b) asks the model which look-up to run,
// (c) runs that look-up itself with the functions above, and (d) asks the model to word the result.
// Placeholders are put back here, and anything in the wording that did not come from a placeholder is flagged.
var AI = { ready:false, checked:false, last:null };
var MK = { by:{}, back:{}, n:{} };
function tok(kind, value, show){ if (value == null || value === '') return ''; var k = kind + '|' + value; if (MK.by[k]) return MK.by[k]; MK.n[kind] = (MK.n[kind] || 0) + 1; var t = '[[' + kind + MK.n[kind] + ']]'; MK.by[k] = t; MK.back[t] = show == null ? String(value) : show; return t; }
function tC(v){ return tok('C', v); } function tV(v){ return tok('V', v); } function tP(v){ return tok('P', v); }
function tN(v){ return tok('N', v); } function tD(v){ return v ? tok('D', day(v), fmtD(v)) : ''; } function tA(v){ return tok('A', Math.round(+v || 0), inr(v)); }
function unmask(text, warn){ return String(text || '').replace(/\[\[\s*([A-Z]{1,2}\d+)\s*\]\]/g, function(m, id){ var t = '[[' + id + ']]'; if (t in MK.back) return MK.back[t]; if (warn) warn.push('The draft referred to something that is not in Order Bridge; it was removed.'); return ''; }); }
var NAMES = null;
function nameIndex(){ if (NAMES) return NAMES; var full = {}, words = {}, D = g('DPI_BY_SO') || {}, STOP = /^(THE|AND|PVT|LTD|LLP|PRIVATE|LIMITED|INDIA|HOME|HOMES|OFFICE|PARK|STUDIO|INTERIORS|INTERIOR|DESIGN|DESIGNS|VILLA|VILLAS|PROJECT|PROJECTS|GROUP|HOUSE|ENTERPRISES|ASSOCIATES)$/;
  Object.keys(D).forEach(function(so){ var c = String(D[so].customer || '').trim(); if (c.length < 3) return; full[c.toUpperCase()] = c; c.toUpperCase().split(/[^A-Z]+/).forEach(function(w){ if (w.length >= 4 && !STOP.test(w)) words[w] = 1; }); });
  ((g('X') || {}).poLines || []).forEach(function(l){ var v = String(l.supplier || '').trim(); if (v.length >= 3) full[v.toUpperCase()] = v; });
  return NAMES = { full:Object.keys(full).sort(function(a, b){ return b.length - a.length; }), words:words }; }
function maskText(sIn){   // free text on its way to the model: the user's question, history lines, reasons
  var t = String(sIn || ''), N = nameIndex();
  t = t.replace(/\s+by\s+[A-Z][A-Za-z.]*(\s+[A-Z][A-Za-z.]*){0,3}/g, '').replace(/\s*\((?:[A-Z][a-z.]+\s?){1,4}\)/g, '');
  N.full.forEach(function(nm){ var i; while ((i = t.toUpperCase().indexOf(nm)) >= 0) t = t.slice(0, i) + tC(t.slice(i, i + nm.length)) + t.slice(i + nm.length); });
  t = t.replace(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, function(m){ return /^\d{11,}$/.test(m.replace(/\D/g, '')) && !/^\+?91/.test(m) ? m : tok('T', m); });
  t = t.replace(/(?:₹|Rs\.?|INR)\s?[\d,]+(?:\.\d+)?/gi, function(m){ return tok('A', m, m); });
  t = t.replace(/\b[A-Z]{0,4}-?\d{4,}\b/g, function(m){ return tN(m); });
  t = t.replace(/[A-Za-z]{4,}/g, function(w){ return N.words[w.toUpperCase()] ? tok('W', w) : w; });
  return t;
}
function leak(masked){   // figures or dates in the model's wording that are not placeholders
  var bare = String(masked || '').replace(/\[\[[^\]]*\]\]/g, ' ');
  return /(?:₹|Rs\.?\s?\d|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4,}\b|\b\d{1,3}(?:,\d{2,3})+\b)/i.test(bare);
}
function askModel(sys, prompt, wantJson, logq, did, tries){
  return api('/api/assistant/ask', { body:{ sys:sys, prompt:prompt, json:!!wantJson, q:logq || '', did:did || '' } }).then(function(r){
    if (r && r.ok) return r;
    if (r && r.code === 'again' && (tries || 0) < 4) return askModel(sys, prompt, wantJson, logq, did, (tries || 0) + 1);
    var e = new Error((r && r.error) || 'The AI service did not answer.'); e.code = r && r.code; throw e; });
}
function parseJson(text){ var t = String(text || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim(), a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('The AI reply could not be read.'); return JSON.parse(t.slice(a, b + 1)); }
function colMask(c, R){ return c.kind === 'so' || c.kind === 'po' ? tN : c.kind === 'money' ? tA : c.kind === 'date' ? tD : c.k === 'customer' || c.mask === 'C' ? tC : c.k === 'rep' || c.mask === 'P' ? tP : null; }
function cellFact(c, row){ var v = row[c.k]; if (c.kind === 'pill') v = v ? v.t : ''; if (v == null || v === '') return '-'; var f = colMask(c); if (f) return f(v); if (c.kind === 'num') return num(v); return maskText(String(v)).slice(0, 140); }
function plainVal(c, row){ var v = row[c.k]; if (c.kind === 'pill') v = v ? v.t : ''; return v == null ? '' : v; }
function refine(R, act, title){   // filters, grouping and sorting asked for by the model, done here
  var by = {}; R.cols.forEach(function(c){ by[c.k] = c; }); var rows = R.rows.slice(), said = [];
  (Array.isArray(act.where) ? act.where : []).slice(0, 6).forEach(function(w){ var c = by[w && w.col]; if (!c) return; var val = unmask(String(w.value == null ? '' : w.value)).trim(), op = String(w.op || 'contains');
    var num2 = c.kind === 'money' || c.kind === 'num', cmp = num2 ? parseFloat(String(val).replace(/[^\d.-]/g, '')) : val.toLowerCase();
    if (c.kind === 'date'){ var m = val.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/); if (m) cmp = m[3] + '-' + ('0' + (MON.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase()) + 1)).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
    rows = rows.filter(function(r){ var v = plainVal(c, r), x = num2 ? +v || 0 : String(v).toLowerCase();
      return op === 'is' ? x == cmp : op === 'gt' ? x > cmp : op === 'lt' ? x < cmp : op === 'gte' ? x >= cmp : op === 'lte' ? x <= cmp : String(x).indexOf(cmp) >= 0; });
    said.push(c.label + ' ' + ({ is:'is', gt:'above', lt:'below', gte:'at least', lte:'at most' }[op] || 'contains') + ' "' + val + '"'); });
  var cols = R.cols, total = R.total;
  if (act.group && by[act.group] && !by[act.group].kind || (act.group && by[act.group] && /^(pill|date)$/.test(by[act.group].kind || ''))){ var gc = by[act.group], G = {}, sums = R.cols.filter(function(c){ return c.kind === 'money' || (c.kind === 'num' && c.k !== 'rank'); });
    rows.forEach(function(r){ var k = String(gc.kind === 'date' ? fmtD(plainVal(gc, r)) : plainVal(gc, r)) || '(blank)', a = G[k] = G[k] || { group:k, n:0 }; a.n++; sums.forEach(function(c){ a[c.k] = (a[c.k] || 0) + (+r[c.k] || 0); }); });
    rows = Object.keys(G).map(function(k){ return G[k]; }).sort(function(a, b){ return b.n - a.n; });
    cols = [{ k:'group', label:gc.label, mask:gc.k === 'customer' ? 'C' : gc.k === 'rep' ? 'P' : '' }, { k:'n', label:'Rows', kind:'num' }].concat(sums); total = ['n'].concat(sums.map(function(c){ return c.k; })); by = {}; cols.forEach(function(c){ by[c.k] = c; });
    said.push('grouped by ' + gc.label); }
  if (act.sort && by[act.sort]){ var sc = by[act.sort], dir = act.desc ? -1 : 1; rows.sort(function(a, b){ var x = plainVal(sc, a), y = plainVal(sc, b); return (sc.kind === 'money' || sc.kind === 'num' ? (+x || 0) - (+y || 0) : String(x).localeCompare(String(y))) * dir; }); said.push('sorted by ' + sc.label + (act.desc ? ', largest first' : '')); }
  var lim = Math.round(+act.limit); if (lim > 0 && lim < rows.length){ rows = rows.slice(0, lim); said.push('first ' + lim); }
  return { cols:cols, rows:rows, total:total, note:R.note, summary:(R.summary ? R.summary + '. ' : '') + (said.length ? 'Narrowed: ' + said.join('; ') + '.' : ''), said:said, crumb:R.crumb };
}
function tableFacts(R, title){
  var L = ['Result: ' + title + (R.summary ? ' — ' + maskText(R.summary) : ''), 'Rows in the result: ' + R.rows.length];
  if (R.total) R.cols.forEach(function(c){ if (R.total.indexOf(c.k) >= 0) L.push('Total ' + c.label + ': ' + (c.kind === 'money' ? tA(R.rows.reduce(function(s2, r){ return s2 + (+r[c.k] || 0); }, 0)) : num(R.rows.reduce(function(s2, r){ return s2 + (+r[c.k] || 0); }, 0)))); });
  L.push('Columns: ' + R.cols.map(function(c){ return c.label; }).join(' | '));
  R.rows.slice(0, 25).forEach(function(r){ L.push('- ' + R.cols.map(function(c){ return cellFact(c, r); }).join(' | ')); });
  if (R.rows.length > 25) L.push('(' + (R.rows.length - 25) + ' more rows not listed here; the totals above cover all rows)');
  return L.join('\n');
}
function cardFacts(C, forClient){
  var L = [], see = C.see;
  if (C.kind === 'po'){ L.push('Purchase order ' + tN(C.po) + (forClient ? '' : ', vendor ' + tV(C.head.supplier)) + (C.head.date ? ', dated ' + tD(C.head.date) : '') + (C.sos.length ? ', for sales order ' + C.sos.map(tN).join(', ') : '')); }
  else { L.push('Sales order ' + tN(C.so) + ' for customer ' + tC(C.head.customer) + (C.head.city ? ', site ' + C.head.city : '') + (C.head.date ? ', order date ' + tD(C.head.date) : '') + (C.head.cancelled ? ' (CANCELLED)' : ''));
    if (C.head.po && !forClient) L.push('Purchase orders: ' + C.head.po.label);
    if (C.money) L.push((forClient ? '' : 'Order value before GST ' + tA(C.money.value) + '; collected before GST ' + tA(C.money.collectedExTax) + '; ') + 'balance due with GST ' + tA(C.money.balance)); }
  (C.lines || []).forEach(function(l){ var x = '- Item: ' + num(l.qty) + ' x ' + l.article + '; ' + (forClient ? (l.stageKey === 'po_confirmed' ? 'in production or on order' : 'order being processed') : 'stage: ' + l.stage + (l.po ? '; PO ' + tN(l.po) + (l.poDate ? ' of ' + tD(l.poDate) : '') + (l.supplier ? ' with vendor ' + tV(l.supplier) : '') : '; no PO yet'));
    if (see.deadlines){ if (l.clientDate) x += '; ' + (forClient ? 'date promised to the customer ' : 'client date ') + tD(l.clientDate); if (l.factoryDate) x += '; ' + (forClient ? 'expected ready date ' : 'factory date ') + tD(l.factoryDate); if (l.negotiation && !forClient) x += '; ' + l.negotiation; }
    if (!forClient){ if (l.jobCard) x += '; job card: ' + l.jobCard.stage; if (l.cat) x += '; readiness: ' + (l.cat.packed ? 'packed' : l.cat.c + ' (' + l.cat.label + '), next: ' + (l.cat.next.join(', ') || 'none')); (l.risks || []).forEach(function(r){ x += '; delay risk: ' + maskText(r.text); }); }
    else if (l.cat && l.cat.packed) x += '; packed and ready';
    if (l.spec && l.spec.fabrics.length) x += '; fabric: ' + l.spec.fabrics.join(', '); if (l.spec && l.spec.finishes.length) x += '; finish: ' + l.spec.finishes.join(', ');
    L.push(x); });
  if (!forClient){
    (C.toRaise || []).forEach(function(l){ L.push('- Still to raise a PO: ' + num(l.open) + ' of ' + num(l.qty) + ' ' + l.name); });
    (C.fabric || []).forEach(function(e){ L.push('- Fabric ' + e.name + ' (' + e.qty + ') for ' + e.product + ': ' + e.status); });
    (C.wh || []).forEach(function(a){ L.push('- Packages for ' + a.article + ': ' + a.tagged + ' tagged, ' + a.sent + ' left the factory, ' + a.received + ' at the warehouse'); });
    (C.blocks || []).forEach(function(b){ L.push('- Stock block: ' + b.qty + ' ' + b.article + ' at ' + b.wh + ': ' + b.status); });
    (C.revisions || []).forEach(function(r){ L.push('- SO revision ' + r.id + ': ' + r.status + '. ' + maskText(r.role)); });
  }
  (C.bookings || []).forEach(function(b){ L.push('- ' + b.type + ' booked for ' + tD(b.date) + (b.window ? ' (' + b.window + ')' : '') + ': ' + b.status + (!forClient && b.dd ? '. ' + b.dd.text : '')); });
  if (C.kind === 'so' && see.slots) L.push('Customer site details form: ' + (C.site && C.site.submitted ? 'submitted' : 'not submitted yet'));
  if (!forClient && C.tl) C.tl.slice(-14).forEach(function(e){ L.push('- History ' + tD(e.at) + ': ' + maskText(e.text)); });
  return L.join('\n');
}
function reportMenu(){
  return REPORTS.filter(function(r){ try { return r.can(); } catch(e){ return false; } }).map(function(r){ var cols = r.colsHint;
    if (!cols){ try { var R = r.async ? null : r.build({}); cols = R && R.cols && !R.then ? R.cols.map(function(c){ return c.k + ' (' + c.label + ')'; }).join(', ') : ''; } catch(e){ cols = ''; } r.colsHint = cols || ' '; }
    return '- ' + r.id + ': ' + r.title + '. ' + r.sub + (r.controls ? ' opts: ' + r.controls.filter(function(c){ return c.options; }).map(function(c){ return c.id + ' = ' + c.options.map(function(o){ return o[0]; }).join('|'); }).join('; ') + (r.controls.some(function(c){ return c.type === 'date'; }) ? '; from, to = YYYY-MM-DD with range=custom' : '') : '') + (r.colsHint.trim() ? ' Columns: ' + r.colsHint : ''); }).join('\n');
}
function canEmail(){ var role = (g('state') || {}).role; return can('confirmations') && role !== 'production'; }
function routeSys(){
  return 'You route questions for Order Bridge, a furniture maker\'s order-tracking tool. Reply with ONE JSON object and nothing else.\n'
    + 'Text like [[C1]], [[N2]], [[D3]], [[A4]], [[W5]] stands for a real name, number, date or amount. Copy such placeholders exactly where needed; never invent one and never guess what it stands for.\n'
    + 'Pick one action:\n'
    + '{"action":"order","ref":"<placeholder or words that identify one sales order, PO, job card or customer>"}  for anything about one order\n'
    + '{"action":"report","id":"<report id>","opts":{},"where":[{"col":"<column key>","op":"is|contains|gt|lt|gte|lte","value":"<text, number or placeholder>"}],"group":"<column key or empty>","sort":"<column key or empty>","desc":true,"limit":0}  for lists, counts, totals and planning\n'
    + (canEmail() ? '{"action":"email","ref":"<order placeholder>","about":"<what the email to the customer should say>","tone":"formal|friendly|firm"}  for an email or message draft\n' : '')
    + '{"action":"say","text":"<one or two sentences>"}  only to explain what you can do, or when nothing fits. Never state order facts, numbers or dates in "say".\n'
    + 'Use only these reports and column keys:\n' + reportMenu() + '\n'
    + 'Readiness codes: C0 no job card; C1 raw material confirmed and fabric in; C2 raw material confirmed, fabric pending; C3 raw material not confirmed, fabric pending; C4 raw material not confirmed, fabric in.\n'
    + 'Today is ' + today() + '. The user is in the ' + ((g('ROLES') || {})[(g('state') || {}).role] || {}).label + ' team.';
}
var WRITE_SYS = 'You write short, plain answers for staff of a furniture company, using ONLY the facts given. Text like [[C1]], [[N2]], [[D3]], [[A4]] stands for a real name, number, date or amount: copy the placeholders you need exactly, and never write a date, amount or long number that is not a placeholder. Do no arithmetic; every total you may quote is given. If the facts do not answer the question, say so in one sentence. No greeting, no headings, at most 120 words.';
var EMAIL_SYS = 'You draft an email from a furniture company to its customer, using ONLY the facts given. Reply with ONE JSON object: {"subject":"...","body":"..."}. Text like [[C1]], [[N2]], [[D3]], [[A4]] stands for a real name, number, date or amount: copy the placeholders you need exactly, and never write a date, amount or long number that is not a placeholder. Never mention vendors, purchase orders, costs, job cards, readiness codes or staff names. Start the body with "Dear [[C1]]," using the customer placeholder from the facts, and end with "Regards," followed by the sender placeholder. Keep it under 160 words, plain text with blank lines between paragraphs.';
function answerCard(text, how, used, warns){
  return '<section class="card ans"><h3>Answer</h3>' + warns.map(function(w){ return '<p class="err" style="margin:0 0 6px">' + esc(w) + '</p>'; }).join('') + '<div class="anstext">' + esc(text) + '</div>'
    + '<p class="sub" style="margin:8px 0 0">' + esc(how) + (used ? ' · worded by ' + esc(used.label || used.provider) : '') + '. The table below is the source; the wording can be wrong, the table is not.</p></section>';
}
function fail(e){ var h = '<div class="card"><p class="err" style="margin:0">' + esc(e.message || String(e)) + '</p></div>'; out.innerHTML = h + (cur ? renderCard(cur) : reportList()); }
function askAI(question){
  var tk = ++seq, q = String(question || '').trim(); if (!q) return;
  out.innerHTML = '<div class="card"><p class="note" style="margin:0">Thinking… (the question goes to the AI with names, amounts and phone numbers replaced by placeholders)</p></div>';
  var ctx = AI.last ? '\nPrevious step, for follow-up questions: ' + JSON.stringify(AI.last) : '', open = cur ? '\nThe user is looking at ' + (cur.kind === 'so' ? 'sales order ' + tN(cur.so) : 'PO ' + tN(cur.po)) + '.' : curRep ? '\nThe user is looking at report "' + curRep.id + '".' : '';
  var mq = maskText(q);
  askModel(routeSys(), 'Question: ' + mq + open + ctx, true, q, '').then(function(r){ if (tk !== seq) return;
    var act = parseJson(r.text); AI.last = { action:act.action, id:act.id, ref:act.ref, opts:act.opts, where:act.where, group:act.group, sort:act.sort, desc:act.desc, limit:act.limit };
    if (act.action === 'say') { out.innerHTML = answerCard(unmask(act.text), 'No look-up was run', r, leak(act.text) ? ['This reply contains a figure or date that did not come from Order Bridge. Do not rely on it.'] : []) + reportList(); cur = null; curRep = null; return; }
    if (act.action === 'email'){ if (!canEmail()) throw new Error('Email drafts are not available to your team.'); var ref = find(unmask(String(act.ref || '')) || (cur ? cur.so || cur.po : '')); if (!ref.so && !ref.po) return pickFor(ref, q); if (ref.po){ var cp = buildPo(ref.po); if (!cp || !cp.sos.length) throw new Error('That PO is not tied to a sales order, so there is no customer to write to.'); ref = { so:cp.sos[0] }; } show(ref); return draftEmail(unmask(String(act.about || q)), act.tone || 'formal'); }
    if (act.action === 'order'){ var rf = find(unmask(String(act.ref || '')) || (cur ? cur.so || cur.po : '')); if (!rf.so && !rf.po) return pickFor(rf, q);
      show(rf); var C = cur, body = out.innerHTML; out.insertAdjacentHTML('afterbegin', '<div class="card" id="wait"><p class="note" style="margin:0">Wording the answer…</p></div>');
      return askModel(WRITE_SYS, 'Question: ' + mq + '\n\nFacts:\n' + cardFacts(C, false), false, '', '').then(function(w){ if (tk !== seq || cur !== C) return; var warns = []; var txt = unmask(w.text, warns); if (leak(w.text)) warns.push('This answer contains a figure or date that did not come from Order Bridge. Check it against the order page below.');
        out.innerHTML = answerCard(txt, 'Looked up ' + (C.kind === 'so' ? 'SO ' + C.so : 'PO ' + C.po), w, warns) + body; }); }
    if (act.action === 'report'){ var rp = repById(act.id); if (!rp || !rp.can()) throw new Error('That needs a report your team does not have.');
      var o = {}; (rp.controls || []).forEach(function(c){ var v = act.opts && act.opts[c.id]; if (v == null) return; v = unmask(String(v)); if (c.options ? c.options.some(function(x){ return x[0] === v; }) : /^\d{4}-\d\d-\d\d$/.test(v)) o[c.id] = v; });
      return Promise.resolve(rp.build(o)).then(function(R){ if (tk !== seq) return; var R2 = refine(R, act, rp.title), how = 'Ran the report "' + rp.title + '"' + (R2.said.length ? ', ' + R2.said.join('; ') : '');
        paintReport(rp, rp.id, o, R2, '<div class="card" id="wait"><p class="note" style="margin:0">Wording the answer…</p></div>'); var mine = curData;
        return askModel(WRITE_SYS, 'Question: ' + mq + '\n\nFacts:\n' + tableFacts(R2, rp.title), false, '', '').then(function(w){ if (tk !== seq || curData !== mine) return; var warns = []; var txt = unmask(w.text, warns); if (leak(w.text)) warns.push('This answer contains a figure or date that did not come from Order Bridge. Check it against the table below.');
          var el = document.getElementById('wait'); if (el) el.outerHTML = answerCard(txt, how, w, warns); }); }); }
    throw new Error('The AI did not pick a look-up. Try wording the question differently, or open a report.');
  }).catch(function(e){ if (tk !== seq) return; var el = document.getElementById('wait'); if (el){ el.outerHTML = '<div class="card"><p class="err" style="margin:0">' + esc(e.message) + ' The page below is still correct.</p></div>'; return; } fail(e); });
}
function pickFor(r, q){ if (r.hits && r.hits.length){ cur = null; out.innerHTML = '<div class="card"><h3>Which order do you mean?</h3><ul class="plain">' + r.hits.slice(0, 30).map(function(x){ return '<li><button class="link" type="button" data-' + (x.so ? 'so' : 'po') + '="' + esc(x.so || x.po) + '">' + esc(x.label) + '</button> <span class="sub">' + esc(x.sub) + '</span></li>'; }).join('') + '</ul><p class="note">Open the order, then ask again from its page.</p></div>'; return; } throw new Error('I could not tell which order you mean. Type the SO or PO number, then ask.'); }
function draftEmail(about, tone){
  var C = cur; if (!C || C.kind !== 'so' || !canEmail()) return; var tk = ++seq, box = document.getElementById('mailbox'); if (!box) return;
  box.innerHTML = '<p class="note" style="margin:0">Writing the draft…</p>';
  var me = tok('P', 'me|' + P.user().name, P.user().name || 'Magari Furniture'), facts = cardFacts(C, true);
  askModel(EMAIL_SYS, 'What the email should say: ' + maskText(about) + '\nTone: ' + (/^(formal|friendly|firm)$/.test(tone) ? tone : 'formal') + '\nSender placeholder: ' + me + '\n\nFacts:\n' + facts, true, 'Email draft: ' + about, 'email SO ' + C.so).then(function(r){ if (tk !== seq || cur !== C) return;
    var j = parseJson(r.text), warns = [], sub = unmask(j.subject, warns), body = unmask(j.body, warns); if (leak(j.subject) || leak(j.body)) warns.push('The draft contains a figure or date that did not come from Order Bridge. Check every number and date before sending.');
    box.innerHTML = warns.filter(function(w, i){ return warns.indexOf(w) === i; }).map(function(w){ return '<p class="err" style="margin:0 0 6px">' + esc(w) + '</p>'; }).join('')
      + '<label class="ctl">Subject<input type="text" id="mailSub" value="' + esc(sub) + '" style="width:100%"></label><label class="ctl" style="display:block;margin-top:8px">Email<textarea id="mailBody" rows="12" style="width:100%">' + esc(body) + '</textarea></label>'
      + '<div class="row" style="margin-top:8px"><button type="button" id="mailCopy" class="primary">Copy email</button><button type="button" id="mailAgain">Write it again</button><span class="sub">Worded by ' + esc(r.label || r.provider) + '. Nothing is sent from here.</span></div>'
      + '<details style="margin-top:8px"><summary class="sub">Facts the draft was written from</summary><pre class="facts">' + esc(unmask(facts)) + '</pre></details>';
  }).catch(function(e){ if (tk !== seq) return; box.innerHTML = '<p class="err" style="margin:0">' + esc(e.message) + '</p>'; });
}
function mailForm(){ return '<section class="card"><h3>Email to the customer</h3><div id="mailbox"><label class="ctl" style="display:block">What should it say?<textarea id="mailAbout" rows="2" style="width:100%" placeholder="For example: update on the delivery date, and ask them to fill in the site details form"></textarea></label><div class="row" style="margin-top:8px"><label class="ctl">Tone <select id="mailTone"><option value="formal">Formal</option><option value="friendly">Friendly</option><option value="firm">Firm</option></select></label><button type="button" id="mailGo" class="primary">Draft the email</button><span class="sub">The customer\'s name and all amounts are hidden from the AI and filled in here.</span></div></div></section>'; }

// ------------------------------------------------------------------ settings (admins): keys, order, limits, question log
function settings(msg){
  cur = null; curRep = null; var tk = ++seq; out.innerHTML = '<div class="card"><p class="note" style="margin:0">Loading…</p></div>';
  api('/api/assistant/config').then(function(S){ if (tk === seq) paintSettings(S, msg); }).catch(function(e){ if (tk === seq) home({ err:true, text:e.message }); });
}
function paintSettings(S, msg){
  out.innerHTML = (msg ? '<div class="card"><p class="' + (msg.err ? 'err' : 'note') + '" style="margin:0">' + esc(msg.text) + '</p></div>' : '')
    + '<section class="card"><div class="row"><div class="grow"><h2>AI settings</h2><div class="sub">' + (S.ready ? 'AI questions are on. ' : 'No working key yet, so AI questions are off. Order pages and reports work without one. ') + S.usedToday + ' of ' + S.perDay + ' questions used today.</div></div><button type="button" id="btnHome">Back</button></div>'
    + '<p class="note" style="margin:8px 0 0">Models are tried from the top. A model that hits its free limit rests until the limit resets, and the next one takes over. Keys are stored on the server and never shown again; only the last four characters are.</p></section>'
    + S.providers.map(function(p, i){ return '<section class="card" data-prov="' + p.id + '"><div class="row"><div class="grow"><h3 style="margin:0">' + (i + 1) + '. ' + esc(p.label) + '</h3></div>' + (p.hasKey ? pill('Key ends ' + p.keyEnd, 'good') : pill('No key', 'warn')) + (i ? '<button type="button" data-set="first">Try first</button>' : '') + '</div>'
      + '<div class="kv"><label class="ctl">' + (p.hasKey ? 'Replace the key' : 'Paste the key') + '<input type="password" data-f="key" autocomplete="off" style="width:100%"></label>' + (p.needsUrl ? '<label class="ctl">Service address (https://…/v1)<input type="text" data-f="url" value="' + esc(p.url) + '" style="width:100%"></label>' : '')
      + '<label class="ctl">Models, in order (comma separated)<input type="text" data-f="models" value="' + esc(p.models.join(', ')) + '" style="width:100%"></label><label class="ctl"><input type="checkbox" data-f="on"' + (p.on ? ' checked' : '') + '> Use this service</label></div>'
      + '<div class="row" style="margin-top:8px"><button type="button" class="primary" data-set="save">Save</button><button type="button" data-set="test"' + (p.hasKey ? '' : ' disabled') + '>Test</button>' + (p.hasKey ? '<button type="button" data-set="remove">Forget the key</button>' : '') + '<span class="sub" data-msg></span></div>'
      + (p.rows.length ? '<table style="margin-top:8px"><thead><tr><th>Model</th><th class="num">Answered today</th><th class="num">Failed today</th><th>Resting</th></tr></thead><tbody>' + p.rows.map(function(r){ return '<tr><td>' + esc(r.model) + '</td><td class="num">' + r.ok + '</td><td class="num">' + r.fail + '</td><td>' + (r.resting ? esc(r.resting) + ' until ' + esc(new Date(r.until).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })) : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '') + '</section>'; }).join('')
    + '<section class="card"><h3>Limits</h3><div class="row"><label class="ctl">AI calls per person per day <input type="number" id="limUser" min="1" value="' + S.perUser + '" style="width:90px"></label><label class="ctl">For the whole team per day <input type="number" id="limDay" min="1" value="' + S.perDay + '" style="width:100px"></label><button type="button" id="limSave">Save limits</button><button type="button" id="restClear">Stop resting all models now</button></div><p class="sub" style="margin:6px 0 0">One question usually takes two AI calls: one to choose the look-up, one to word the answer.</p></section>'
    + '<section class="card"><div class="row"><div class="grow"><h3 style="margin:0">Last ' + S.log.length + ' questions</h3></div>' + (S.log.length ? '<button type="button" id="logClear">Clear the list</button>' : '') + '</div>' + (S.log.length ? '<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Question</th><th>Model</th><th>Result</th></tr></thead><tbody>' + S.log.map(function(l){ return '<tr><td style="white-space:nowrap">' + esc(new Date(l.at).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })) + '</td><td>' + esc(l.by) + '<div class="sub">' + esc(l.role) + '</div></td><td>' + esc(l.q) + (l.did ? '<div class="sub">' + esc(l.did) + '</div>' : '') + '</td><td>' + esc(l.model) + '</td><td>' + (l.ok ? 'Answered' : '<span class="err">' + esc(l.err || 'Failed') + '</span>' + (l.detail ? '<div class="sub">' + esc(l.detail) + '</div>' : '')) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="note" style="margin:6px 0 0">No questions yet.</p>') + '</section>';
  P.wide(true); wide = true; var bw = document.getElementById('btnWide'); bw.textContent = 'Narrower'; bw.setAttribute('aria-pressed', 'true');
}
function settingsClick(t){
  var post = function(body, okText){ return api('/api/assistant/config', { body:body }).then(function(S){ refreshAI(); paintSettings(S, okText ? { text:okText } : null); }, function(e){ settings({ err:true, text:e.message }); }); };
  if (t.id === 'limSave') return post({ action:'limits', perUser:document.getElementById('limUser').value, perDay:document.getElementById('limDay').value }, 'Limits saved.'), true;
  if (t.id === 'restClear') return post({ action:'clearRest' }, 'All models can be tried again now.'), true;
  if (t.id === 'logClear') return post({ action:'clearLog' }, 'Question list cleared.'), true;
  var sec = t.closest('[data-prov]'); if (!sec || !t.dataset.set) return false; var id = sec.dataset.prov, f = function(n){ return sec.querySelector('[data-f="' + n + '"]'); };
  if (t.dataset.set === 'save'){ var b = { action:'save', provider:id, key:f('key').value, models:f('models').value.split(',').map(function(x){ return x.trim(); }).filter(Boolean), on:f('on').checked }; if (f('url')) b.url = f('url').value; post(b, 'Saved.'); }
  else if (t.dataset.set === 'remove') post({ action:'remove', provider:id }, 'Key forgotten.');
  else if (t.dataset.set === 'first'){ var ord = [id]; [].forEach.call(out.querySelectorAll('[data-prov]'), function(x){ if (x.dataset.prov !== id) ord.push(x.dataset.prov); }); post({ action:'order', order:ord }, 'Order changed.'); }
  else if (t.dataset.set === 'test'){ var m = sec.querySelector('[data-msg]'); m.textContent = 'Testing…'; api('/api/assistant/config', { body:{ action:'test', provider:id } }).then(function(r){ m.textContent = r.error || (r.models || []).map(function(x){ return x.model + ': ' + x.msg; }).join(' · ') || 'No model to test'; m.className = 'sub' + (r.ok ? '' : ' err'); }, function(e){ m.textContent = e.message; m.className = 'sub err'; }); }
  return true;
}
function refreshAI(){ return api('/api/assistant/ask').then(function(r){ AI.ready = !!(r && r.ready); AI.checked = true; paintAsk(); }, function(){ AI.ready = false; AI.checked = true; paintAsk(); }); }
function paintAsk(){ qEl.placeholder = AI.ready ? 'Ask a question, or type an SO, PO, job card or customer' : 'SO number, PO number, job card or customer name'; var b = document.getElementById('btnSet'); if (b) b.style.display = P.user().ownRole === 'admin' ? '' : 'none'; }
function isQuestion(q){ return /\?/.test(q) || q.trim().split(/\s+/).length >= 4; }

// ------------------------------------------------------------------ page
var cur = null, recent = [], wide = false;
function home(msg){
  cur = null;
  out.innerHTML = (msg ? '<div class="card"><p class="' + (msg.err ? 'err' : 'note') + '" style="margin:0">' + esc(msg.text) + '</p></div>' : '')
    + '<div class="card"><h2>' + (AI.ready ? 'Ask, or find an order' : 'Find an order') + '</h2><p class="note" style="margin:6px 0 0">Type a sales order or PO number (the last few digits are enough), a job card number, or part of a customer name. You get the order on one page: POs, dates, job card stage, fabric, packages, dispatch and history.</p>' + (AI.ready ? '<p class="note" style="margin:6px 0 0">Or ask in your own words, for example "which fabrics is supply still to send?" or "draft a delay email for SO 0128". Every figure comes from Order Bridge; the AI only chooses the look-up and words the answer.</p>' : '') + '</div>'
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
  if (AI.ready && isQuestion(String(q || ''))) return askAI(q);
  var r; try { r = find(q); } catch(e){ return home({ err:true, text:'Could not search: ' + e.message }); }
  if (r.none) return home();
  if (r.so || r.po){ try { return show(r); } catch(e){ return home({ err:true, text:'Could not build the order page: ' + e.message }); } }
  if (!r.hits.length && AI.ready) return askAI(q);
  if (!r.hits.length) return home({ err:true, text:'Nothing found for "' + r.q + '". Check the number, or try part of the customer name.' });
  cur = null;
  out.innerHTML = '<div class="card"><h3>' + r.hits.length + ' matches for "' + esc(r.q) + '"' + (r.hits.length > 40 ? ' (first 40 shown)' : '') + '</h3><ul class="plain">' + r.hits.slice(0, 40).map(function(x){ return '<li><button class="link" type="button" data-' + (x.so ? 'so' : 'po') + '="' + esc(x.so || x.po) + '">' + esc(x.label) + '</button> <span class="sub">' + esc(x.sub) + '</span></li>'; }).join('') + '</ul></div>';
}
document.getElementById('f').addEventListener('submit', function(e){ e.preventDefault(); run(qEl.value); });
out.addEventListener('click', function(e){
  var t = e.target.closest('button'); if (!t) return;
  if (t.dataset.so){ qEl.value = t.dataset.so; return show({ so:t.dataset.so }); }
  if (t.dataset.po){ qEl.value = t.dataset.po; return show({ po:t.dataset.po }); }
  if (t.id === 'mailGo'){ var ab = document.getElementById('mailAbout').value.trim(); if (!ab){ document.getElementById('mailAbout').focus(); return; } return draftEmail(ab, document.getElementById('mailTone').value); }
  if (t.id === 'mailAgain' && cur){ var c0 = cur; show({ so:c0.so }); var mb = document.getElementById('mailbox'); if (mb) mb.scrollIntoView(); return; }
  if (t.id === 'mailCopy'){ var tx = 'Subject: ' + document.getElementById('mailSub').value + '\n\n' + document.getElementById('mailBody').value, dn = function(){ t.textContent = 'Copied'; setTimeout(function(){ t.textContent = 'Copy email'; }, 1500); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tx).then(dn, function(){ fallbackCopy(tx); dn(); }); else { fallbackCopy(tx); dn(); } return; }
  if (settingsClick(t)) return;
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
document.getElementById('btnSet').addEventListener('click', function(){ settings(); });
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') P.close(); });
P.onOpen = function(q){ if (q){ qEl.value = q; run(q); } else qEl.focus(); };
window.__asst = { find:find, buildSo:buildSo, buildPo:buildPo, textOf:textOf, REPORTS:REPORTS, csvOf:csvOf, maskText:maskText, unmask:unmask, leak:leak, cardFacts:cardFacts, tableFacts:tableFacts, refine:refine, MK:MK, AI:AI, routeSys:routeSys };   // for tests
paintAsk(); var hadQ = !!P.pending;
if (P.pending){ var q0 = P.pending; P.pending = null; qEl.value = q0; run(q0); } else { home(); qEl.focus(); }
refreshAI().then(function(){ if (!hadQ && !cur && !curRep && out.querySelector('h2') && /Find an order/.test(out.querySelector('h2').textContent)) home(); });
})();
