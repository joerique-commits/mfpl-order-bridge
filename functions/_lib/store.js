// Order Bridge shared store (APP_DATA namespace) — added 20 Oct 2026 for the online
// version of the LOCAL-DATA page. The page keeps writing its data through its own
// localStorage helpers; a small shim in the page turns each change into
// record-level saves against this store.
//
// KV keys (letters/digits/underscore only - EdgeOne KV rule):
//   b_<store>__<bucket>  -> {"recs":{ <recordKey>: { v, ver, c, by, at } }}
//                           shared records. <store> is the page's localStorage key
//                           (e.g. ob_order_ops); records are grouped into buckets so a
//                           page load reads tens of KV values, not thousands.
//   u_<uid>__<store>     -> { v, at }   per-user values (inbox read marks etc.)
//   cfg_linkkey          -> random secret used to sign customer form links
//
// Version check: every record carries ver. A save sends the ver it was based on;
// if the stored ver differs, that record is refused and returned as a conflict.
// KV has no compare-and-swap and is eventually consistent across edge nodes
// (up to ~60s), so this limits simultaneous edits rather than eliminating them.
import { getJSON, putJSON } from './kv.js';

export const STORE_RE = /^ob_[A-Za-z0-9_]{1,60}$/;
export const BUCKET_RE = /^[A-Za-z0-9_]{1,80}$/;
export const ACT_STORE = 'ob_activity';
export const ACT_KEEP_DAYS = 31;

export const bucketKey = (store, bk) => `b_${store}__${bk}`;
export const userKey = (uid, store) => `u_${String(uid).replace(/[^A-Za-z0-9_]/g, '_')}__${store}`;

// Same hash the page uses to pick a bucket for keyed stores ('h' + djb2(key) % n).
export function djb2(s) { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; }
export const SITE_STORE = 'ob_site_details', SITE_BUCKETS = 16;
export const siteBucket = so => 'h' + (djb2(so) % SITE_BUCKETS);

export async function listKeys(kv, prefix) {
  const out = []; let cursor;
  for (let guard = 0; guard < 400; guard++) {
    const page = await kv.list(cursor ? { prefix, limit: 256, cursor } : { prefix, limit: 256 });
    (page.keys || []).forEach(e => out.push(e.key || e.name));
    if (page.complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

async function getTextMany(kv, keys) {
  const vals = new Array(keys.length);
  for (let i = 0; i < keys.length; i += 100) {
    const part = keys.slice(i, i + 100);
    const got = await Promise.all(part.map(k => kv.get(k, { type: 'text' })));
    got.forEach((v, j) => { vals[i + j] = v; });
  }
  return vals;
}

// Old activity buckets (bucket name starts with d<yyyymmdd>) are skipped and pruned.
function actBucketTooOld(key) {
  const m = key.match(/^b_ob_activity__d(\d{8})_/); if (!m) return false;
  const cut = new Date(Date.now() - ACT_KEEP_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  return m[1] < cut;
}

// Returns the whole store as a JSON string without parsing the stored values.
export async function loadAllRaw(kv, uid) {
  const all = await listKeys(kv, 'b_');
  const old = all.filter(actBucketTooOld);
  const keys = all.filter(k => !actBucketTooOld(k));
  const uPrefix = userKey(uid, '');
  const ukeys = await listKeys(kv, uPrefix);
  const [vals, uvals] = await Promise.all([getTextMany(kv, keys), getTextMany(kv, ukeys)]);
  const parts = [];
  keys.forEach((k, i) => { if (vals[i]) parts.push(JSON.stringify(k) + ':' + vals[i]); });
  const uparts = [];
  ukeys.forEach((k, i) => { if (uvals[i]) uparts.push(JSON.stringify(k.slice(uPrefix.length)) + ':' + uvals[i]); });
  if (old.length) { try { await Promise.all(old.slice(0, 50).map(k => kv.delete(k))); } catch (e) {} }
  return '{"b":{' + parts.join(',') + '},"u":{' + uparts.join(',') + '}}';
}

// changes: [{ s, bk, k, v (null = delete), ver, c }]
export async function applyChanges(kv, changes, actor) {
  const byBucket = new Map();
  for (const ch of changes) {
    if (!ch || !STORE_RE.test(ch.s || '') || !BUCKET_RE.test(ch.bk || '') || typeof ch.k !== 'string' || !ch.k || ch.k.length > 300) {
      throw new Error('Bad change: ' + JSON.stringify(ch).slice(0, 200));
    }
    const key = bucketKey(ch.s, ch.bk);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(ch);
  }
  const ok = [], conflicts = [];
  const now = new Date().toISOString();
  for (const [key, list] of byBucket) {
    const doc = (await getJSON(kv, key)) || { recs: {} };
    doc.recs = doc.recs || {};
    let dirty = false;
    for (const ch of list) {
      const cur = doc.recs[ch.k];
      const curVer = cur ? cur.ver : 0;
      if ((ch.ver || 0) !== curVer) { conflicts.push({ s: ch.s, bk: ch.bk, k: ch.k, cur: cur || null }); continue; }
      if (ch.v === null || ch.v === undefined) {
        if (cur) { delete doc.recs[ch.k]; dirty = true; }
        ok.push({ s: ch.s, bk: ch.bk, k: ch.k, ver: 0 });
      } else {
        doc.recs[ch.k] = { v: ch.v, ver: curVer + 1, c: cur ? cur.c : (Number(ch.c) || Date.now()), by: actor, at: now };
        dirty = true;
        ok.push({ s: ch.s, bk: ch.bk, k: ch.k, ver: curVer + 1 });
      }
    }
    if (dirty) {
      if (Object.keys(doc.recs).length) await putJSON(kv, key, doc); else await kv.delete(key);
    }
  }
  return { ok, conflicts };
}

export async function getLinkKey(kv) {
  let k = await kv.get('cfg_linkkey', { type: 'text' });
  if (!k) {
    const b = crypto.getRandomValues(new Uint8Array(24));
    k = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    await kv.put('cfg_linkkey', k);
  }
  return k;
}

// Token in customer form links: first 20 hex chars of HMAC-SHA256(linkKey, kind|id).
// Plain-JS SHA-256 on purpose: EdgeOne's WebCrypto is picky about algorithm arguments
// (importKey needs bare strings, see crypto.js), and the page computes the same token
// synchronously with the same code.
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(m) {
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = m.length, n = ((l + 9 + 63) >> 6) << 6, b = new Uint8Array(n); b.set(m); b[l] = 0x80;
  const dv = new DataView(b.buffer), bits = l * 8; dv.setUint32(n - 4, bits >>> 0); dv.setUint32(n - 8, Math.floor(bits / 4294967296));
  const w = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const x = w[i-15], y = w[i-2]; w[i] = (w[i-16] + (rotr(x,7) ^ rotr(x,18) ^ (x >>> 3)) + w[i-7] + (rotr(y,17) ^ rotr(y,19) ^ (y >>> 10))) >>> 0; }
    let [a, c1, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & c1) ^ (a & c) ^ (c1 & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = c1; c1 = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + c1) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32), odv = new DataView(out.buffer); H.forEach((v, j) => odv.setUint32(j * 4, v)); return out;
}
function hmac(key, msg) {
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64); k.set(key);
  const ip = new Uint8Array(64 + msg.length), op = new Uint8Array(96);
  for (let i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
  ip.set(msg, 64); op.set(sha256(ip), 64); return sha256(op);
}
export async function linkToken(linkKey, kind, id) {
  const enc = new TextEncoder();
  return Array.from(hmac(enc.encode(linkKey), enc.encode(kind + '|' + id)), x => x.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

// Optional gzip for big responses: the page asks with ?gz=1 and falls back to a plain request if
// anything about the compressed reply fails. Plain response when CompressionStream is missing.
export function maybeGzip(request, text, headers) {
  const want = new URL(request.url).searchParams.get('gz') === '1';
  if (want && typeof CompressionStream === 'function') {
    try {
      const body = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(body, { status: 200, headers: Object.assign({}, headers, { 'content-encoding': 'gzip', 'x-ob-gz': '1' }) });
    } catch (e) {}
  }
  return new Response(text, { status: 200, headers });
}
