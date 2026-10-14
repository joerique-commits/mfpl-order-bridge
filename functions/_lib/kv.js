// Thin helpers over EdgeOne's KV binding (put/get/delete/list), matching the
// account's project default export style. Every KV value we store is JSON,
// so these wrap the get/put calls to parse/stringify once instead of at
// every call site.
//
// IMPORTANT eventual-consistency note (see mfpl-edgeone-kv-schema.md): the
// edge node that just wrote a key sees it immediately; other edge nodes can
// serve stale reads for up to ~60s. Code that writes then immediately reads
// back its own write (e.g. login writing a session then checking it) is safe
// IF it stays on the same edge node for that request lifecycle - cross-request
// reads shortly after a write elsewhere are NOT guaranteed fresh. None of the
// auth flows below depend on cross-request read-after-write within that window.

export async function getJSON(kv, key) {
  const raw = await kv.get(key, { type: 'text' });
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`KV value at ${key} is not valid JSON: ${e.message}`);
  }
}

export async function putJSON(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

export async function deleteKey(kv, key) {
  await kv.delete(key);
}

export function safeKeyPart(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '_');
}
