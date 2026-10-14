// Tiny app-wide settings store - admin-only writes, used by multiple modules
// (PO Progress Tracker and Order Deadlines both scope to lines whose PO was
// "raised on/after the go-live date, default 1 Sep 2026" - mfpl-order-
// deadlines-v2.md). Deliberately generic (get/set by key) rather than one
// endpoint per setting, since this is expected to grow.
//
// KV shape, in ob_app_data (env.APP_DATA):
//   settings:{key} -> { key, value, setBy:{uid,name}, setAt }

import { getJSON, putJSON, safeKeyPart } from './kv.js';

const DEFAULTS = {
  golive_date: '2026-09-01',
};

export async function getSetting(appDataKv, key) {
  const record = await getJSON(appDataKv, `settings:${safeKeyPart(key)}`);
  if (record) return record;
  if (key in DEFAULTS) return { key, value: DEFAULTS[key], setBy: null, setAt: null, isDefault: true };
  return null;
}

export async function setSetting(appDataKv, key, value, actor) {
  const record = { key, value, setBy: { uid: actor.uid, name: actor.name }, setAt: new Date().toISOString() };
  await putJSON(appDataKv, `settings:${safeKeyPart(key)}`, record);
  return record;
}
