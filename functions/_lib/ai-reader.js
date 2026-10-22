// Job card reader (added 22 Oct 2026): sends one job card photo to a vision AI model and
// returns the card's fields as JSON for a person to check before saving.
//
// Runs on free API plans only, so it falls back through several of them:
// every model in Gemini's list, then Mistral's, then Groq's (order set in Admin). A model
// that answers "too many requests" is skipped until its limit resets; a model the
// account can't use is skipped for a few hours. When everything is used up the page
// says so and the person types the card in as before.
//
// Keys and settings live in the AUTH namespace (never served to the page):
//   cfg_ai          -> { providers: { gemini:{key,models[],on}, mistral:{...}, groq:{...} }, order:[...] }
//   ai_cool         -> { "<provider>|<model>": { until, why } }   models resting after a limit/error
//   ai_use_<yyyymmdd> (IST day) -> { "<provider>|<model>": { ok, fail } }
//   ai_log          -> last 40 calls [{ at, by, provider, model, ok, ms, err }]
// The prompt and the clean-up of the answer are the ones from the Sept/Oct Job Card Station.
import { getJSON, putJSON } from './kv.js';

export const PROVIDERS = {
  // 22 Oct: flash-lite first — on the first day's live scans it answered every time in 2-9 s, while
  // 3.8 / 3.6 Flash were often "high demand" (503) or cut off by EdgeOne at 15 s (504).
  gemini: { label: 'Google Gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'] },
  mistral: { label: 'Mistral', models: ['mistral-medium-latest', 'mistral-small-latest'] },
  groq: { label: 'Groq', models: ['qwen/qwen3.8-27b'] },
};
export const DEFAULT_ORDER = ['gemini', 'mistral', 'groq'];

const STAGES = [
  { key: 'preFrame', label: 'Pre Frame' }, { key: 'postFrame', label: 'Post Frame' },
  { key: 'fabricationQc', label: 'Fabrication QC' }, { key: 'polishingQc', label: 'Polishing - QC' },
  { key: 'upholsteryQc', label: 'Upholstery - QC' }, { key: 'factoryQc', label: 'Factory - QC' },
  { key: 'packing', label: 'Packing' },
];

export function buildPrompt() {
  const stageKeys = STAGES.map(s => s.key).join('", "');
  return (
    'You are reading a photo of a physical "Job Card" from an Indian furniture factory (Magari Furniture Pvt Ltd). ' +
    'It is a printed form filled in partly by hand -- some fields are typed/printed, most are handwritten in pen, ' +
    'and some cells are ticked or signed rather than dated. Handwritten dates on this form use inconsistent formats ' +
    '(e.g. "13-08-26", "3/8/26", "9/9/26") and digits are often ambiguous -- do not guess a digit you cannot see clearly. ' +
    'Dates are day first (Indian format). Read only what is actually marked on the card. Never invent a value.\n\n' +
    'Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:\n' +
    '{\n' +
    '  "jobCardNumber": string,   // the printed serial in the top-right corner e.g. "259". "" if not visible.\n' +
    '  "clientName": string,      // handwritten "Client Name" field\n' +
    '  "cardDate": string,        // handwritten "Date" field near the top, as written, "" if blank\n' +
    '  "deadlineDate": string,    // handwritten deadline / delivery date if the card has one, as written, "" if none\n' +
    '  "workOrderNumber": string, // handwritten "Work Order Number"\n' +
    '  "productCode": string,     // handwritten "Product Code"\n' +
    '  "qty": string,             // handwritten "Qty", as written (keep as string, do not compute)\n' +
    '  "stages": [\n' +
    '    {\n' +
    '      "key": string,              // one of: "' + stageKeys + '" -- match by row position top-to-bottom, there are exactly 7 rows in this order\n' +
    '      "startDate": string,        // handwritten Start Date cell for this row, as written, "" if blank\n' +
    '      "endDate": string,          // handwritten End / Target Date cell for this row, as written, "" if blank\n' +
    '      "supervisorSigned": boolean, // true only if the Supervisor Signature cell for this row has a mark/signature in it\n' +
    '      "managerSigned": boolean     // true only if the Manager / Executive Signature cell for this row has a mark/signature in it\n' +
    '    }\n' +
    '  ],\n' +
    '  "factoryRemarks": string,    // "Factory Remarks" line(s), "" if blank\n' +
    '  "designTeamRemarks": string, // "Design team Remarks" line(s), "" if blank\n' +
    '  "materials": [ { "slNo": string, "material": string, "qty": string } ],  // rows of the "Material Used" table that have anything written, skip fully blank rows\n' +
    '  "uncertainFields": [string]  // field names (dot-path, e.g. "stages.1.startDate") you are genuinely unsure you read correctly. Empty array if nothing is uncertain.\n' +
    '}\n\n' +
    'Rules: always return exactly 7 entries in "stages", one per printed row, in the fixed key order above, even if a row is ' +
    'entirely blank (return "" / false for a blank row, do not omit it). Go row by row down the WHOLE table, left to right -- ' +
    'Start Date, then End / Target Date -- and read every row\'s dates independently of the others; a later row having dates ' +
    'earlier than an earlier row is normal, report what is written, do not "correct" it. Use "" for unreadable/blank text -- ' +
    'never invent a plausible-looking value to fill a gap.\n\n' +
    'Signature cells: mark supervisorSigned/managerSigned true for ANY mark at all in that cell -- a full signature, initials, ' +
    'a scribble, a tick/cross, a circled number, even a single stray pen stroke. Only use false when the cell has no mark of ' +
    'any kind. Do not confuse a signature cell with its neighbouring date cell -- check the column carefully.\n\n' +
    'Be conservative on dates: if a date could be one of two digits, put your best reading in the field and add its path to ' +
    'uncertainFields rather than silently picking one.'
  );
}

const toStr = v => (v === undefined || v === null ? '' : String(v).trim());
const toBool = v => v === true || v === 'true' || v === 1;

// Day-first handwritten dates -> ISO, only when unambiguous; otherwise '' and the raw text is kept.
export function parseDateToISO(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (!m) return '';
  let [, d, mo, y] = m;
  if (Number(mo) > 12 && Number(d) <= 12) [d, mo] = [mo, d];
  if (y.length === 2) y = '20' + y;
  if (y.length !== 4) return '';
  d = d.padStart(2, '0'); mo = mo.padStart(2, '0');
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${y}-${mo}-${d}` : '';
}

export function normalizeExtracted(data) {
  data = data && typeof data === 'object' ? data : {};
  const byKey = {};
  (Array.isArray(data.stages) ? data.stages : []).forEach((s, i) => { if (s && typeof s === 'object') byKey[s.key || (STAGES[i] && STAGES[i].key)] = s; });
  const stages = STAGES.map(def => {
    const s = byKey[def.key] || {};
    return { key: def.key, label: def.label, startDateRaw: toStr(s.startDate), startDateISO: parseDateToISO(s.startDate),
      endDateRaw: toStr(s.endDate), endDateISO: parseDateToISO(s.endDate), supervisorSigned: toBool(s.supervisorSigned), managerSigned: toBool(s.managerSigned) };
  });
  const materials = (Array.isArray(data.materials) ? data.materials : []).slice(0, 20)
    .map(m => ({ slNo: toStr(m && m.slNo), material: toStr(m && m.material), qty: toStr(m && m.qty) }))
    .filter(m => m.material || m.qty);
  return {
    jobCardNumber: toStr(data.jobCardNumber), clientName: toStr(data.clientName),
    cardDateRaw: toStr(data.cardDate), cardDateISO: parseDateToISO(data.cardDate),
    deadlineDateRaw: toStr(data.deadlineDate), deadlineDateISO: parseDateToISO(data.deadlineDate),
    workOrderNumber: toStr(data.workOrderNumber), productCode: toStr(data.productCode), qty: toStr(data.qty),
    stages, factoryRemarks: toStr(data.factoryRemarks), designTeamRemarks: toStr(data.designTeamRemarks), materials,
    uncertainFields: Array.isArray(data.uncertainFields) ? data.uncertainFields.map(toStr).filter(Boolean) : [],
  };
}

export function extractJson(text) {
  if (!text) throw new Error('empty reply');
  let s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b < a) throw new Error('reply was not JSON');
  return JSON.parse(s.slice(a, b + 1));
}

// ---------------------------------------------------------------- provider calls
// Each returns { ok:true, text } or { ok:false, http, msg }.
async function readError(resp) {
  let msg = '';
  try { const t = await resp.text(); try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.message || t; } catch (e) { msg = t; } } catch (e) {}
  msg = String(msg || '');
  if (/^\s*<(!doctype|html)/i.test(msg)) msg = resp.status === 504 ? 'Timed out (no answer within 15 s)' : `HTTP ${resp.status} error page`;
  return (msg || `HTTP ${resp.status}`).slice(0, 300);
}

async function callGemini(key, model, prompt, img) {
  const parts = [];
  if (img) parts.push({ inline_data: { mime_type: img.mediaType, data: img.data } });
  parts.push({ text: prompt });
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
  });
  if (!resp.ok) return { ok: false, http: resp.status, msg: await readError(resp) };
  const j = await resp.json();
  const c = (j.candidates || [])[0];
  if (!c) return { ok: false, http: 502, msg: (j.promptFeedback && j.promptFeedback.blockReason) ? 'The model declined this photo.' : 'Empty reply.' };
  if (c.finishReason && !['STOP', 'MAX_TOKENS'].includes(c.finishReason)) return { ok: false, http: 502, msg: `Reading stopped (${c.finishReason}).` };
  return { ok: true, text: ((c.content && c.content.parts) || []).map(p => p.text || '').join('\n') };
}

// Mistral and Groq both take the OpenAI chat format.
async function callOpenAIStyle(url, key, model, prompt, img) {
  const content = [{ type: 'text', text: prompt }];
  if (img) content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
  const resp = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 4096, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }),
  });
  if (!resp.ok) return { ok: false, http: resp.status, msg: await readError(resp) };
  const j = await resp.json();
  const m = j.choices && j.choices[0] && j.choices[0].message;
  const text = m ? (typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('\n')) : '';
  return text ? { ok: true, text } : { ok: false, http: 502, msg: 'Empty reply.' };
}

function callProvider(p, key, model, prompt, img) {
  if (p === 'gemini') return callGemini(key, model, prompt, img);
  if (p === 'mistral') return callOpenAIStyle('https://api.mistral.ai/v1/chat/completions', key, model, prompt, img);
  if (p === 'groq') return callOpenAIStyle('https://api.groq.com/openai/v1/chat/completions', key, model, prompt, img);
  return Promise.resolve({ ok: false, http: 400, msg: 'Unknown provider' });
}

// ---------------------------------------------------------------- config, rests, usage
export async function loadCfg() {
  const c = (await getJSON(AUTH, 'cfg_ai')) || {};
  c.providers = c.providers || {};
  const OLD_DEFAULTS = { gemini: 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite' };
  Object.keys(PROVIDERS).forEach(p => { const x = c.providers[p] = c.providers[p] || {}; if (!Array.isArray(x.models) || !x.models.length || x.models.join(',') === OLD_DEFAULTS[p]) x.models = PROVIDERS[p].models.slice(); if (x.on === undefined) x.on = true; });
  c.order = Array.isArray(c.order) && c.order.length ? c.order.filter(p => PROVIDERS[p]) : DEFAULT_ORDER.slice();
  Object.keys(PROVIDERS).forEach(p => { if (!c.order.includes(p)) c.order.push(p); });
  return c;
}
export const saveCfg = c => putJSON(AUTH, 'cfg_ai', c);

export const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
// Gemini's daily count resets at midnight US Pacific (07:00-08:00 UTC); use 08:00 UTC to be safe.
// Mistral / Groq: assume midnight UTC.
function nextReset(p, now) {
  const d = new Date(now); const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), p === 'gemini' ? 8 : 0, 5));
  if (r.getTime() <= now) r.setUTCDate(r.getUTCDate() + 1);
  return r.getTime();
}
// How long to rest a model after a failed call, and why (shown in Admin).
function restFor(p, http, msg, now) {
  const m = String(msg || '').toLowerCase();
  if (http === 429) {
    if (/per ?day|perday|daily|requests per day|quota.*day|day.*quota|exceeded your current quota/.test(m)) return { until: nextReset(p, now), why: 'Daily free limit used up' };
    return { until: now + 65e3, why: 'Per-minute limit — resting a minute' };
  }
  if (http === 401 || http === 403 || /api key not valid|invalid api key|api_key_invalid|unauthori[sz]ed/.test(m)) return { until: now + 30 * 60e3, why: 'Key refused (check the key)', all: true };
  if (http === 404 || (http === 400 && /model|not found|not supported|does not exist|invalid model/.test(m))) return { until: now + 6 * 3600e3, why: 'Model not available on this key' };
  if (http === 503 || http === 504) return { until: now + 10 * 60e3, why: http === 503 ? 'Busy (high demand) — resting 10 minutes' : 'Too slow (timed out) — resting 10 minutes' };
  if (http >= 500) return { until: now + 2 * 60e3, why: 'Service error — resting 2 minutes' };
  return null;
}

async function bumpUsage(id, ok) {
  const k = 'ai_use_' + istDay();
  const u = (await getJSON(AUTH, k)) || {};
  const r = u[id] = u[id] || { ok: 0, fail: 0 }; r[ok ? 'ok' : 'fail']++;
  await putJSON(AUTH, k, u);
}
async function logCall(e) {
  const l = (await getJSON(AUTH, 'ai_log')) || [];
  l.unshift(e); await putJSON(AUTH, 'ai_log', l.slice(0, 40));
}

// Try the chain. Gives up after ~55 s in total so the page never waits forever.
export async function readCard(img, by) {
  const cfg = await loadCfg();
  const cool = (await getJSON(AUTH, 'ai_cool')) || {};
  const prompt = buildPrompt();
  const start = Date.now(); const tried = [];
  let coolChanged = false, anyKey = false;
  for (const p of cfg.order) {
    const P = cfg.providers[p];
    if (!P || !P.key || P.on === false) continue;
    anyKey = true;
    for (const model of P.models) {
      const id = p + '|' + model;
      if (cool[id] && cool[id].until > Date.now()) { tried.push({ id, skipped: cool[id].why }); continue; }
      if (cool[p + '|*'] && cool[p + '|*'].until > Date.now()) { tried.push({ id, skipped: cool[p + '|*'].why }); continue; }
      if (Date.now() - start > 55e3) break;
      const t0 = Date.now();
      let r;
      try { r = await callProvider(p, P.key, model, prompt, img); } catch (e) { r = { ok: false, http: 503, msg: 'Could not reach the service' }; }
      let out = null;
      if (r.ok) { try { out = normalizeExtracted(extractJson(r.text)); } catch (e) { r = { ok: false, http: 502, msg: 'Reply could not be read (' + e.message + ')' }; } }
      const ms = Date.now() - t0;
      await bumpUsage(id, !!out);
      await logCall({ at: new Date().toISOString(), by, provider: p, model, ok: !!out, ms, err: out ? '' : `${r.http}: ${r.msg}`.slice(0, 200) });
      if (out) { if (coolChanged) await putJSON(AUTH, 'ai_cool', cool); return { ok: true, result: out, provider: p, model, label: PROVIDERS[p].label, tried }; }
      tried.push({ id, http: r.http, msg: r.msg });
      const rest = restFor(p, r.http, r.msg, Date.now());
      if (rest) { cool[rest.all ? p + '|*' : id] = { until: rest.until, why: rest.why, at: Date.now() }; coolChanged = true; if (rest.all) break; }
    }
  }
  if (coolChanged) await putJSON(AUTH, 'ai_cool', cool);
  return { ok: false, notConfigured: !anyKey, tried };
}

// Admin "Test" button: a tiny text-only request to the first model that isn't resting.
export async function testProvider(p) {
  const cfg = await loadCfg(); const P = cfg.providers[p];
  if (!P || !P.key) return { ok: false, msg: 'No key saved.' };
  const out = [];
  for (const model of P.models) {
    const t0 = Date.now();
    let r; try { r = await callProvider(p, P.key, model, 'Reply with exactly this JSON and nothing else: {"ok": true}', null); } catch (e) { r = { ok: false, http: 503, msg: 'Could not reach the service' }; }
    let good = false; if (r.ok) { try { good = extractJson(r.text).ok === true; } catch (e) {} }
    out.push({ model, ok: good, ms: Date.now() - t0, msg: good ? 'Works' : (r.ok ? 'Answered, but not as expected' : `${r.http}: ${r.msg}`) });
  }
  return { ok: out.some(x => x.ok), models: out };
}

export async function status() {
  const cfg = await loadCfg();
  const cool = (await getJSON(AUTH, 'ai_cool')) || {};
  const use = (await getJSON(AUTH, 'ai_use_' + istDay())) || {};
  const log = (await getJSON(AUTH, 'ai_log')) || [];
  const now = Date.now();
  const providers = cfg.order.map(p => {
    const P = cfg.providers[p];
    return { id: p, label: PROVIDERS[p].label, hasKey: !!P.key, keyEnd: P.key ? P.key.slice(-4) : '', on: P.on !== false, models: P.models, defaults: PROVIDERS[p].models,
      rows: P.models.map(m => { const id = p + '|' + m; const c = cool[id] && cool[id].until > now ? cool[id] : (cool[p + '|*'] && cool[p + '|*'].until > now ? cool[p + '|*'] : null);
        return { model: m, ok: (use[id] || {}).ok || 0, fail: (use[id] || {}).fail || 0, resting: c ? c.why : '', until: c ? new Date(c.until).toISOString() : '' }; }) };
  });
  return { providers, order: cfg.order, log: log.slice(0, 15) };
}
