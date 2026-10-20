// Customer site-details form - the only endpoint open without a login.
// GET  /api/public/site?so=<SO>&k=<token>  -> { so, header:{so,customer,date}|null, site:<record>|null, ver }
// POST /api/public/site?so=<SO>&k=<token>  { fields:{...} } -> { site }
// k must equal HMAC(linkKey, 'site|' + so) (see _lib/store.js) - the page puts it in every form link.
// The customer can only read their own form and submit its fields; a locked form is refused.
import { json, errorJson } from '../../_lib/http.js';
import { getJSON, putJSON } from '../../_lib/kv.js';
import { getLinkKey, linkToken, bucketKey, siteBucket, SITE_STORE } from '../../_lib/store.js';

async function check(request) {
  const url = new URL(request.url);
  const so = url.searchParams.get('so') || '', k = url.searchParams.get('k') || '';
  if (!so || so.length > 60 || !/^[0-9a-f]{20}$/.test(k)) return { err: errorJson('This link is not valid.', 403) };
  const expect = await linkToken(await getLinkKey(APP_DATA), 'site', so);
  if (expect !== k) return { err: errorJson('This link is not valid.', 403) };
  return { so };
}

export async function onRequestGet({ request }) {
  const c = await check(request); if (c.err) return c.err;
  const doc = (await getJSON(APP_DATA, bucketKey(SITE_STORE, siteBucket(c.so)))) || { recs: {} };
  const rec = (doc.recs || {})[c.so] || null;
  let header = null;
  const meta = await getJSON(ERP_MIRROR, 'obdata_meta');
  if (meta) { const pub = await getJSON(ERP_MIRROR, 'obdata_pub_' + meta.id); header = (pub && pub[c.so]) || null; }
  return json({ so: c.so, header, site: rec ? rec.v : null, ver: rec ? rec.ver : 0 });
}

export async function onRequestPost({ request }) {
  const c = await check(request); if (c.err) return c.err;
  let body; try { body = await request.json(); } catch (e) { return errorJson('Body must be JSON', 400); }
  const raw = (body && body.fields) || {};
  const fields = {};
  Object.keys(raw).slice(0, 60).forEach(key => { if (/^[A-Za-z0-9_]{1,40}$/.test(key)) fields[key] = String(raw[key] == null ? '' : raw[key]).slice(0, 2000); });
  const bkey = bucketKey(SITE_STORE, siteBucket(c.so));
  const doc = (await getJSON(APP_DATA, bkey)) || { recs: {} };
  doc.recs = doc.recs || {};
  const cur = doc.recs[c.so];
  if (cur && cur.v && cur.v.lockedAt) return errorJson('This form is locked - please contact Magari to make changes.', 409);
  const now = new Date().toISOString();
  const v = Object.assign({}, cur ? cur.v : { so: c.so, createdAt: now, createdBy: '(link opened directly)' }, { fields, submittedAt: now });
  doc.recs[c.so] = { v, ver: (cur ? cur.ver : 0) + 1, c: cur ? cur.c : Date.now(), by: 'customer', at: now };
  await putJSON(APP_DATA, bkey, doc);
  return json({ site: v, ver: doc.recs[c.so].ver });
}
