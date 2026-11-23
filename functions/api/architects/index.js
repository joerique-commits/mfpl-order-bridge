// Architects / designers / middlemen who are paid a commission on an SO (23 Nov 2026, JK).
// Kept apart from the shared stores because they hold bank account and PAN numbers: every signed-in user loads the
// shared stores, but only this endpoint hands out these records, and it masks them unless the caller may see them.
//
//   arch_<id>  one record per person;  arch_ix  { ids:[...] } (changes only when someone is added)
//
// GET  /api/architects                      any signed-in user. Full bank account and PAN for accounts, admin and the
//                                            person who entered the current bank details; everyone else sees the last 4.
// POST /api/architects { action:'save', arch }   sales, accounts, admin. New or changed bank details / PAN → unverified.
//                                                 Bank fields left out (or masked) keep the stored values.
// POST /api/architects { action:'verify', id, sig }  accounts, admin. sig = the bankSig the verifier was shown, so a
//                                                 change made in between can't be verified unseen.
import { requireRole } from '../../_lib/session.js';
import { getJSON, putJSON, safeKeyPart } from '../../_lib/kv.js';
import { json, errorJson, readJsonBody, bearerToken } from '../../_lib/http.js';

const IX = 'arch_ix', key = id => `arch_${safeKeyPart(id)}`;
const FULL_ROLES = ['accounts', 'admin'], EDIT_ROLES = ['sales', 'accounts', 'admin'], VERIFY_ROLES = ['accounts', 'admin'];
const RE = {
  mobile: /^[6-9]\d{9}$/,
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  acct: /^\d{9,18}$/,
  gstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
};
const clean = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 300);
const up = v => clean(v).toUpperCase().replace(/\s/g, '');
const last4 = v => (v ? '••••' + String(v).slice(-4) : '');
const bankSig = a => [a.acct, a.ifsc, a.bankName, a.branch, a.pan].join('|');
function sigHash(s){ let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }

function view(a, user){
  const full = FULL_ROLES.includes(user.role) || (a.bankByUid && a.bankByUid === user.uid);
  const o = { id:a.id, name:a.name, kind:a.kind, firm:a.firm, mobile:a.mobile, address:a.address, state:a.state, gstin:a.gstin,
    ifsc:a.ifsc, bankName:a.bankName, branch:a.branch, verified:a.verified || null, bankAt:a.bankAt, bankBy:a.bankBy,
    createdAt:a.createdAt, createdBy:a.createdBy, updatedAt:a.updatedAt, updatedBy:a.updatedBy, log:(a.log || []).slice(-30),
    full, acct:full ? a.acct : last4(a.acct), pan:full ? a.pan : last4(a.pan), acctLast4:String(a.acct || '').slice(-4), sig:sigHash(bankSig(a)) };
  return o;
}
async function loadAll(){
  const ix = (await getJSON(APP_DATA, IX).catch(() => null)) || { ids:[] };
  const recs = await Promise.all(ix.ids.map(id => getJSON(APP_DATA, key(id)).catch(() => null)));
  return { ix, recs:recs.filter(Boolean) };
}

export async function onRequestGet({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  const { recs } = await loadAll();
  return json({ architects:recs.map(a => view(a, auth.user)).sort((a, b) => a.name.localeCompare(b.name)) });
}

export async function onRequestPost({ request }) {
  const auth = await requireRole(AUTH, bearerToken(request), null);
  if (!auth.ok) return errorJson(auth.error, auth.status);
  let body; try { body = await readJsonBody(request); } catch (e) { return errorJson(e.message, 400); }
  const me = auth.user, who = me.name || me.email, now = new Date().toISOString();

  if (body && body.action === 'verify') {
    if (!VERIFY_ROLES.includes(me.role)) return errorJson('Only accounts or admin can verify bank details', 403);
    const a = await getJSON(APP_DATA, key(body.id)).catch(() => null);
    if (!a) return errorJson('Not found', 404);
    if (sigHash(bankSig(a)) !== body.sig) return errorJson('The bank details changed since you opened them. Reload and check again.', 409);
    if (a.bankByUid && a.bankByUid === me.uid && me.role !== 'admin') return errorJson('Someone other than the person who entered the bank details must verify them', 403);
    a.verified = { by:who, uid:me.uid, at:now, sig:body.sig };
    (a.log = a.log || []).push({ at:now, by:who, text:'Bank details verified' });
    await putJSON(APP_DATA, key(a.id), a);
    return json({ ok:true, architect:view(a, me) });
  }

  if (!body || body.action !== 'save' || !body.arch) return errorJson('action and arch are required', 400);
  if (!EDIT_ROLES.includes(me.role)) return errorJson('Only sales, accounts or admin can add or change these details', 403);
  const x = body.arch, isNew = !x.id;
  const old = isNew ? null : await getJSON(APP_DATA, key(x.id)).catch(() => null);
  if (!isNew && !old) return errorJson('Not found', 404);
  const a = old ? JSON.parse(JSON.stringify(old)) : { id:'AR-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(), createdAt:now, createdBy:who, createdByUid:me.uid, log:[] };
  a.name = clean(x.name); a.kind = ['architect', 'designer', 'middleman', 'other'].includes(x.kind) ? x.kind : 'architect';
  a.firm = clean(x.firm); a.mobile = String(x.mobile || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  a.address = clean(x.address); a.state = clean(x.state); a.gstin = up(x.gstin);
  const errs = [];
  if (a.name.length < 3) errs.push('name');
  if (!RE.mobile.test(a.mobile)) errs.push('mobile (10 digits)');
  if (a.address.length < 8) errs.push('address');
  if (a.state.length < 2) errs.push('state');
  if (a.gstin && !RE.gstin.test(a.gstin)) errs.push('GSTIN (15 characters)');
  // bank fields: a masked or empty value keeps what is stored
  const keepOr = (v, k) => { const s = up(v); return !s || s.includes('•') ? (old ? old[k] : '') : s; };
  const nb = { acct:keepOr(x.acct, 'acct'), ifsc:keepOr(x.ifsc, 'ifsc'), pan:keepOr(x.pan, 'pan'), bankName:clean(x.bankName) || (old ? old.bankName : ''), branch:clean(x.branch) || (old ? old.branch : '') };
  if (x.acct && !String(x.acct).includes('•') && up(x.acct) !== up(x.acct2)) errs.push('bank account numbers don’t match');
  if (!RE.acct.test(nb.acct)) errs.push('bank account (9–18 digits)');
  if (!RE.ifsc.test(nb.ifsc)) errs.push('IFSC (11 characters, 5th is 0)');
  if (!RE.pan.test(nb.pan)) errs.push('PAN (e.g. ABCDE1234F)');
  if (nb.bankName.length < 3) errs.push('bank name');
  if (nb.branch.length < 2) errs.push('branch');
  if (errs.length) return errorJson('Check: ' + errs.join(', '), 400);
  if (a.gstin && a.gstin.slice(2, 12) !== nb.pan) return errorJson('The GSTIN doesn’t contain this PAN', 400);
  // the same PAN or account on another record is almost always a duplicate (or a wrong number)
  const { ix, recs } = await loadAll();
  const dup = recs.find(r => r.id !== a.id && (r.pan === nb.pan || r.acct === nb.acct));
  if (dup) return errorJson(`This PAN or bank account is already saved for ${dup.name}. Pick them from the list instead.`, 409);
  const bankChanged = !old || bankSig(old) !== bankSig(nb);
  Object.assign(a, nb);
  if (bankChanged) {
    a.verified = null; a.bankAt = now; a.bankBy = who; a.bankByUid = me.uid;
    a.log.push({ at:now, by:who, text:old ? `Bank details / PAN changed (account ${last4(old.acct)} → ${last4(nb.acct)}, IFSC ${old.ifsc} → ${nb.ifsc}) — to verify` : `Added (account ${last4(nb.acct)}, IFSC ${nb.ifsc}) — to verify` });
  } else a.log.push({ at:now, by:who, text:'Contact details updated' });
  a.updatedAt = now; a.updatedBy = who; a.log = a.log.slice(-60);
  await putJSON(APP_DATA, key(a.id), a);
  if (isNew) { ix.ids = [...new Set([...(ix.ids || []), a.id])]; await putJSON(APP_DATA, IX, ix); }
  return json({ ok:true, architect:view(a, me) });
}
