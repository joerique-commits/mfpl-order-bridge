// Order Bridge Assistant (13 Nov 2026): text answers from free AI plans, tried in the order set by an admin.
// Same idea as the job card reader (ai-reader.js) but with its own keys, rests, counts and log, so the two
// never use up each other's free allowance. Keys stay in AUTH and are never sent to the page.
//   cfg_asst            -> { providers:{ gemini:{key,models[],on}, groq:{...}, custom:{key,url,models[],on} }, order:[...], perUser, perDay }
//   asst_cool           -> { "<provider>|<model>": { until, why } }
//   asst_use_<yyyymmdd> -> { models:{ id:{ok,fail} }, users:{ uid:n }, total }   (IST day)
//   asst_log            -> last 100 questions [{ at, by, role, q, did, provider, model, ok, ms, err }]
// The page sends prompts in which customer, vendor and staff names, amounts and phone numbers are already
// replaced by placeholders; the question kept in the log is the user's own wording, on our own storage.
import { getJSON, putJSON } from './kv.js';

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'] },
  groq: { label: 'Groq', models: ['qwen/qwen3.8-27b'] },
  custom: { label: 'EdgeOne Models or another OpenAI-style service', models: [], needsUrl: true },
};
export const DEFAULT_ORDER = ['gemini', 'groq', 'custom'];
export const LIMITS = { perUser: 60, perDay: 600 };
const LOG_KEEP = 100;
export const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

export async function loadCfg() {
  const c = (await getJSON(AUTH, 'cfg_asst')) || {};
  c.providers = c.providers || {};
  Object.keys(PROVIDERS).forEach(p => { const x = c.providers[p] = c.providers[p] || {}; if (!Array.isArray(x.models)) x.models = PROVIDERS[p].models.slice(); if (x.on === undefined) x.on = true; });
  c.order = Array.isArray(c.order) && c.order.length ? c.order.filter(p => PROVIDERS[p]) : DEFAULT_ORDER.slice();
  Object.keys(PROVIDERS).forEach(p => { if (!c.order.includes(p)) c.order.push(p); });
  c.perUser = Number(c.perUser) > 0 ? Math.round(Number(c.perUser)) : LIMITS.perUser;
  c.perDay = Number(c.perDay) > 0 ? Math.round(Number(c.perDay)) : LIMITS.perDay;
  return c;
}
export const saveCfg = c => putJSON(AUTH, 'cfg_asst', c);
export function anyReady(cfg) { return cfg.order.some(p => { const P = cfg.providers[p]; return P && P.key && P.on !== false && P.models.length && (p !== 'custom' || P.url); }); }

async function readError(resp) {
  let msg = '';
  try { const t = await resp.text(); try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.message || t; } catch (e) { msg = t; } } catch (e) {}
  msg = typeof msg === 'string' ? msg : JSON.stringify(msg);
  if (/^\s*<(!doctype|html)/i.test(msg)) msg = resp.status === 504 ? 'Timed out (no answer within 15 s)' : `HTTP ${resp.status} error page`;
  return (msg || `HTTP ${resp.status}`).slice(0, 300);
}
async function callGemini(key, model, sys, user, wantJson) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: Object.assign({ temperature: 0.2, maxOutputTokens: 1500 }, wantJson ? { responseMimeType: 'application/json' } : {}) }),
  });
  if (!resp.ok) return { ok: false, http: resp.status, msg: await readError(resp) };
  const j = await resp.json(); const c = (j.candidates || [])[0];
  if (!c) return { ok: false, http: 502, msg: 'Empty reply.' };
  const text = ((c.content && c.content.parts) || []).map(p => p.text || '').join('');
  return text ? { ok: true, text } : { ok: false, http: 502, msg: `No text (${c.finishReason || 'empty'}).` };
}
async function callOpenAIStyle(url, key, model, sys, user, wantJson) {
  const resp = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(Object.assign({ model, temperature: 0.2, max_tokens: 1500, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }, wantJson ? { response_format: { type: 'json_object' } } : {})),
  });
  if (!resp.ok) return { ok: false, http: resp.status, msg: await readError(resp) };
  const j = await resp.json(); const m = j.choices && j.choices[0] && j.choices[0].message;
  const text = m ? (typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('')) : '';
  return text ? { ok: true, text: String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim() } : { ok: false, http: 502, msg: 'Empty reply.' };
}
export function chatUrl(u) { u = String(u || '').trim().replace(/\/+$/, ''); if (!u) return ''; return /\/chat\/completions$/.test(u) ? u : u + '/chat/completions'; }
function callProvider(p, P, model, sys, user, wantJson) {
  if (p === 'gemini') return callGemini(P.key, model, sys, user, wantJson);
  if (p === 'groq') return callOpenAIStyle('https://api.groq.com/openai/v1/chat/completions', P.key, model, sys, user, wantJson);
  if (p === 'custom') return callOpenAIStyle(chatUrl(P.url), P.key, model, sys, user, wantJson);
  return Promise.resolve({ ok: false, http: 400, msg: 'Unknown provider' });
}
function nextReset(p, now) {
  const d = new Date(now); const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), p === 'gemini' ? 8 : 0, 5));
  if (r.getTime() <= now) r.setUTCDate(r.getUTCDate() + 1);
  return r.getTime();
}
function restFor(p, http, msg, now) {
  const m = String(msg || '').toLowerCase();
  if (http === 429) {
    if (/per ?day|perday|daily|requests per day|quota.*day|day.*quota|exceeded your current quota|free.*(token|quota).*(used|exhaust)/.test(m)) return { until: nextReset(p, now), why: 'Daily free limit used up' };
    return { until: now + 65e3, why: 'Per-minute limit, resting a minute' };
  }
  if (http === 401 || http === 403 || /api key not valid|invalid api key|api_key_invalid|unauthori[sz]ed/.test(m)) return { until: now + 30 * 60e3, why: 'Key refused (check the key)', all: true };
  if (http === 402) return { until: now + 6 * 3600e3, why: 'Free allowance used up', all: true };
  if (http === 404 || (http === 400 && /model|not found|not supported|does not exist|invalid model/.test(m))) return { until: now + 6 * 3600e3, why: 'Model not available on this key' };
  if (http === 503 || http === 504) return { until: now + 10 * 60e3, why: http === 503 ? 'Busy, resting 10 minutes' : 'Too slow (timed out), resting 10 minutes' };
  if (http >= 500) return { until: now + 2 * 60e3, why: 'Service error, resting 2 minutes' };
  return null;
}

// One question. Tries models in order but stops starting new ones after ~8 s, so the function stays inside
// EdgeOne's time limit; the page then asks again and the chain carries on from the models now resting.
export async function ask({ sys, user, wantJson, who, log }) {
  const cfg = await loadCfg();
  if (!anyReady(cfg)) return { ok: false, code: 'nokey', error: 'No AI key has been added yet. An admin can add one under Assistant › Settings.' };
  const day = 'asst_use_' + istDay();
  const use = (await getJSON(AUTH, day)) || {}; use.models = use.models || {}; use.users = use.users || {}; use.total = use.total || 0;
  if (use.total >= cfg.perDay) return { ok: false, code: 'daycap', error: `Today's limit of ${cfg.perDay} AI questions for the whole team is used up. Order pages and reports still work.` };
  if ((use.users[who.uid] || 0) >= cfg.perUser) return { ok: false, code: 'usercap', error: `You have used today's ${cfg.perUser} AI questions. Order pages and reports still work.` };
  const cool = (await getJSON(AUTH, 'asst_cool')) || {};
  const start = Date.now(); let coolChanged = false, more = false, last = '', out = null, used = null;
  outer: for (const p of cfg.order) {
    const P = cfg.providers[p];
    if (!P || !P.key || P.on === false || (p === 'custom' && !P.url)) continue;
    if (cool[p + '|*'] && cool[p + '|*'].until > Date.now()) { last = last || cool[p + '|*'].why; continue; }
    for (const model of P.models) {
      const id = p + '|' + model;
      if (cool[id] && cool[id].until > Date.now()) { last = last || cool[id].why; continue; }
      if (Date.now() - start > 8000) { more = true; break outer; }
      const t0 = Date.now(); let r;
      try { r = await callProvider(p, P, model, sys, user, wantJson); } catch (e) { r = { ok: false, http: 503, msg: 'Could not reach the service' }; }
      const m = use.models[id] = use.models[id] || { ok: 0, fail: 0 }; m[r.ok ? 'ok' : 'fail']++;
      if (r.ok) { out = r.text; used = { provider: p, model, label: PROVIDERS[p].label, ms: Date.now() - t0 }; break outer; }
      last = `${PROVIDERS[p].label}: ${r.msg}`;
      const rest = restFor(p, r.http, r.msg, Date.now());
      if (rest) { cool[rest.all ? p + '|*' : id] = { until: rest.until, why: rest.why, at: Date.now() }; coolChanged = true; if (rest.all) break; }
    }
  }
  if (out) { use.total++; use.users[who.uid] = (use.users[who.uid] || 0) + 1; }
  await putJSON(AUTH, day, use);
  if (coolChanged) await putJSON(AUTH, 'asst_cool', cool);
  if (log && (out || !more)) {
    const l = (await getJSON(AUTH, 'asst_log')) || [];
    l.unshift({ at: new Date().toISOString(), by: who.name || who.email, role: who.role, q: String(log.q || '').slice(0, 300), did: String(log.did || '').slice(0, 120), provider: used ? used.provider : '', model: used ? used.model : '', ok: !!out, ms: Date.now() - start, err: out ? '' : String(last).slice(0, 160) });
    await putJSON(AUTH, 'asst_log', l.slice(0, LOG_KEEP));
  }
  if (out) return { ok: true, text: out, provider: used.provider, model: used.model, label: used.label };
  if (more) return { ok: false, code: 'again', error: 'Still trying other models' };
  return { ok: false, code: 'resting', error: 'No AI model could answer just now' + (last ? ' (' + last + ')' : '') + '. Order pages and reports still work; try the question again in a few minutes.' };
}

export async function testProvider(p) {
  const cfg = await loadCfg(); const P = cfg.providers[p];
  if (!P || !P.key) return { ok: false, models: [], error: 'No key saved' };
  if (p === 'custom' && !P.url) return { ok: false, models: [], error: 'No service address saved' };
  const outp = [];
  for (const model of P.models.slice(0, 4)) {
    const t0 = Date.now(); let r; try { r = await callProvider(p, P, model, 'You reply with JSON only.', 'Reply with exactly this JSON and nothing else: {"ok": true}', true); } catch (e) { r = { ok: false, http: 503, msg: 'Could not reach the service' }; }
    const good = r.ok && /"ok"\s*:\s*true/.test(r.text);
    outp.push({ model, ok: good, ms: Date.now() - t0, msg: good ? 'Works' : (r.ok ? 'Answered, but not as expected' : `${r.http}: ${r.msg}`) });
    if (Date.now() - t0 > 9000) break;
  }
  return { ok: outp.some(x => x.ok), models: outp };
}

export async function status(full) {
  const cfg = await loadCfg();
  const use = (await getJSON(AUTH, 'asst_use_' + istDay())) || {}; const cool = (await getJSON(AUTH, 'asst_cool')) || {}; const now = Date.now();
  const base = { ready: anyReady(cfg), perUser: cfg.perUser, perDay: cfg.perDay, usedToday: use.total || 0 };
  if (!full) return base;
  const providers = cfg.order.map(p => { const P = cfg.providers[p];
    return { id: p, label: PROVIDERS[p].label, needsUrl: !!PROVIDERS[p].needsUrl, url: P.url || '', hasKey: !!P.key, keyEnd: P.key ? P.key.slice(-4) : '', on: P.on !== false, models: P.models, defaults: PROVIDERS[p].models,
      rows: P.models.map(m => { const id = p + '|' + m; const c = cool[id] && cool[id].until > now ? cool[id] : (cool[p + '|*'] && cool[p + '|*'].until > now ? cool[p + '|*'] : null);
        return { model: m, ok: ((use.models || {})[id] || {}).ok || 0, fail: ((use.models || {})[id] || {}).fail || 0, resting: c ? c.why : '', until: c ? new Date(c.until).toISOString() : '' }; }) }; });
  return Object.assign(base, { providers, order: cfg.order, users: use.users || {}, log: ((await getJSON(AUTH, 'asst_log')) || []).slice(0, LOG_KEEP) });
}
